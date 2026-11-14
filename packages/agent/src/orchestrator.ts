import {
  EngineError,
  chooseChart,
  hardRules,
  resultHash,
  routeForType,
  verifyResult,
  type AgentCard,
  type AgentContract,
  type AskRequest,
  type ChatModelPort,
  type ColumnProfile,
  type DocumentStorePort,
  type Config,
  type DataEnginePort,
  type QueryResult,
  type QuestionClassifier,
  type RouteDecision,
  type SchemaInput,
  type TableSchema,
  type TurnEvent,
} from "@lf/core";
import { localAnswer, suggestFollowUps, templateAnswer } from "./answer.js";
import { EgressLog } from "./gate/egress-log.js";
import { gateNote, PrivacyGate, type GateResult } from "./gate/gate.js";
import { docFlow, docPlan } from "./doc-flow.js";
import { buildLocalSqlRequest, parseLocalSql } from "./prompts/local-sql.js";
import { parseRemoteSql } from "./prompts/remote.js";
import { pruneSchema, type PruneResult } from "./pruning.js";

export interface TableAgentDeps {
  config: Config;
  engine: DataEnginePort;
  /** null = no local model on this machine (remote-only mode). */
  local: ChatModelPort | null;
  classifier: QuestionClassifier;
  maskKey: string;
  /** Optional document index (PDF and PPTX). */
  docs?: DocumentStorePort;
  remoteFactory?: (config: Config) => ChatModelPort;
  confirmTimeoutMs?: number;
  version?: string;
}

interface LocalOutcome {
  ok: boolean;
  result?: QueryResult;
  sql?: string;
  attempts: number;
  reasons: string[];
}

const REASONING = /\b(why|explain|compare|insight|trend|recommend|forecast|predict|root cause)\b/i;

export class TableAgent implements AgentContract {
  private readonly gate: PrivacyGate;
  readonly log: EgressLog;
  private readonly pending = new Map<string, (ok: boolean) => void>();
  private profiles: Record<string, ColumnProfile[]> = {};

  constructor(private readonly d: TableAgentDeps) {
    this.log = new EgressLog(d.config.cacheDir);
    this.gate = new PrivacyGate({
      config: d.config,
      log: this.log,
      maskKey: d.maskKey,
      waitForConfirm: (id) => this.waitForConfirm(id),
      ...(d.remoteFactory ? { remoteFactory: d.remoteFactory } : {}),
    });
  }

  card(): AgentCard {
    return {
      name: "local-first-table-agent",
      version: this.d.version ?? "0.3.0",
      description: "Answers questions over local CSV, Excel and Parquet files; escalates hard questions through a privacy gate.",
      capabilities: ["table-qa", "sql", "charts", "followups"],
      dataPolicy: `Files stay on this machine. Remote model sees only what the privacy level allows (${this.d.config.privacy.tabularLevel}); every send is logged.`,
    };
  }

  confirm(egressId: string, approved: boolean): void {
    this.pending.get(egressId)?.(approved);
    this.pending.delete(egressId);
  }

  private waitForConfirm(id: string): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
      }, this.d.confirmTimeoutMs ?? 5 * 60_000);
      this.pending.set(id, (ok) => {
        clearTimeout(t);
        resolve(ok);
      });
    });
  }

  ask(req: AskRequest, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
    return this.run(req, signal, false);
  }

  /** Routing decision only (layers 1-3). Nothing is run and nothing is sent to the remote model. */
  async explainRoute(question: string, history: AskRequest["history"] = []): Promise<TurnEvent[]> {
    const events: TurnEvent[] = [];
    for await (const e of this.run({ turnId: "explain", question, history, context: { folderSelected: true } }, undefined, true)) events.push(e);
    return events;
  }

  private async *run(req: AskRequest, signal: AbortSignal | undefined, routeOnly: boolean): AsyncGenerator<TurnEvent> {
    const { config } = this.d;
    const rcfg = config.routing;
    const cancelled = () => !!signal?.aborted;
    if (!req.context.folderSelected) {
      yield { type: "error", code: "NO_FOLDER", message: "Select a data folder first." };
      return;
    }
    const history = req.history.slice(-config.history.turns * 2);
    const schemas = this.d.engine.getSchemas();
    const docAliases = this.d.docs?.aliases() ?? [];
    if (schemas.length === 0 && docAliases.length === 0) {
      yield { type: "error", code: "NO_TABLES", message: "No tables or documents are available from this folder." };
      return;
    }
    const remoteOk = this.gate.available();
    const localOk = !!this.d.local;
    if (!remoteOk && !localOk) {
      yield { type: "error", code: "NO_MODEL", message: "No local model is installed and no remote model is configured." };
      return;
    }

    // ---- schema + pruning
    yield { type: "trace", step: "schema", status: "start", detail: "Finding the tables and columns this question needs" };
    for (const s of schemas) if (!this.profiles[s.tableName]) this.profiles[s.tableName] = await this.d.engine.profile(s.tableName);
    const pruned = pruneSchema(req.question, schemas, this.profiles, { synonyms: config.pruning.synonyms, maxColumnsPerTable: config.pruning.maxColumnsPerTable });
    yield { type: "trace", step: "schema", status: "done", detail: `${pruned.tablesNeeded.length} table(s), ${pruned.totalColumnsInScope} columns in scope` };

    // ---- documents or tables?
    if (docAliases.length > 0) {
      const plan = await docPlan(req.question, schemas, pruned, this.d.docs!);
      if (plan.path !== "table") {
        yield* docFlow({ config, docs: this.d.docs!, local: this.d.local, gate: this.gate }, req, plan, pruned, history, signal, routeOnly);
        return;
      }
    }

    // ---- routing, layer by layer
    const reasons: string[] = [];
    let route: "local" | "remote" = "local";
    let layer = 1;
    let qType = "other";
    const hard = hardRules({ question: req.question, tablesNeeded: pruned.tablesNeeded.length, columnsInScope: pruned.totalColumnsInScope }, rcfg);

    if (!remoteOk) {
      reasons.push("remote model is disabled or not configured: staying local");
      if (hard.escalate) reasons.push(...hard.reasons.map((r) => `would escalate: ${r}`));
    } else if (rcfg.mode === "remote-sql") {
      route = "remote";
      layer = 0;
      reasons.push("routing mode is remote-sql");
    } else if (hard.escalate) {
      route = "remote";
      layer = 2;
      reasons.push(...hard.reasons);
    } else if (!localOk) {
      route = "remote";
      layer = 2;
      reasons.push("no local model available");
    } else {
      yield { type: "trace", step: "classify", status: "start", detail: "Classifying the question" };
      const c = await this.d.classifier.classify(req.question, history);
      qType = c.type;
      yield { type: "trace", step: "classify", status: "done", detail: `${c.type} (confidence ${c.confidence.toFixed(2)})` };
      if (c.confidence < 0.5) {
        route = "remote";
        layer = 3;
        reasons.push(`classifier unsure (${c.confidence.toFixed(2)})`);
      } else if (routeForType(c.type, rcfg) === "remote") {
        route = "remote";
        layer = 3;
        reasons.push(`question type "${c.type}" routes to the remote model`);
      } else {
        layer = 4;
        reasons.push(`question type "${c.type}" can be answered locally`);
      }
    }
    yield { type: "route", route, layer, reasons: [...reasons] };
    if (routeOnly) return;
    if (cancelled()) return yield* this.cancelledEvent();

    let decision: RouteDecision = { route, layer, reasons, attempts: 0 };
    let result: QueryResult | undefined;
    let sql: string[] = [];
    let answer: string | undefined;
    const notes: string[] = [];

    // ---- local attempt (layers 4-6)
    if (route === "local") {
      const out: LocalOutcome = yield* this.localAttempt(req, pruned, history, signal);
      decision.attempts = out.attempts;
      if (out.ok && out.result) {
        result = out.result;
        sql = [out.sql!];
      } else if (remoteOk) {
        route = "remote";
        layer = 5;
        reasons.push(...out.reasons, "escalating after failed local attempt");
        decision = { route, layer, reasons, attempts: out.attempts };
        yield { type: "route", route, layer, reasons: [...reasons] };
      } else {
        reasons.push(...out.reasons);
        notes.push(
          "I could not answer this reliably on this laptop, and the remote model is turned off or not configured, so nothing was sent anywhere.",
          out.reasons.length ? `What went wrong: ${out.reasons.join("; ")}.` : "",
        );
      }
    }

    // ---- remote flows (A: remote writes SQL, then B or C for the answer)
    let remoteAnswered = false;
    if (route === "remote" && !result) {
      const flow = yield* this.remoteSql(req, schemas, pruned, history, signal);
      if (flow.ok && flow.results.length) {
        result = flow.results[0]!;
        sql = flow.sql;
        decision.attempts += flow.rounds;
        // B: remote writes the answer only when reasoning over values is needed and the policy allows it.
        const needsReasoning = REASONING.test(req.question) || qType === "explain";
        if (needsReasoning && config.privacy.tabularLevel === "rows") {
          const g: GateResult = yield* this.gate.send(
            { purpose: "answer-from-results", question: req.question, history, results: result, resultTables: pruned.tablesNeeded },
            req.turnId,
            undefined,
            signal,
          );
          if (g.status === "sent" && g.result.text) {
            answer = g.unmask(g.result.text.trim());
            remoteAnswered = true;
          } else {
            notes.push(this.gateNote(g));
          }
        }
      } else {
        notes.push(flow.ok ? "The remote SQL returned no results." : flow.message);
        // Cancelled or failed: try to keep it local.
        if (localOk && decision.attempts === 0) {
          const out: LocalOutcome = yield* this.localAttempt(req, pruned, history, signal);
          decision.attempts = out.attempts;
          if (out.ok && out.result) {
            result = out.result;
            sql = [out.sql!];
            decision = { ...decision, route: "local", reasons: [...reasons, "answered locally because the remote step did not complete"] };
            yield { type: "route", route: "local", layer: 6, reasons: decision.reasons };
          }
        }
      }
    }
    if (cancelled()) return yield* this.cancelledEvent();

    // ---- answer text (C when the remote did not write it)
    if (result && answer === undefined) {
      yield { type: "trace", step: "answer", status: "start", detail: localOk ? "Writing the answer locally" : "Writing the answer from a template" };
      answer = await localAnswer(this.d.local, req.question, result);
      yield { type: "trace", step: "answer", status: "done", detail: remoteAnswered ? "remote" : "local" };
    }
    if (result && notes.filter(Boolean).length) answer = `${answer}\n\n${notes.filter(Boolean).join(" ")}`;
    if (!result) answer = notes.filter(Boolean).join(" ") || "I could not answer this question.";

    for (const w of answer!.split(/(?<=\s)/).reduce<string[]>((acc, cur, i) => {
      if (i % 4 === 0) acc.push(cur);
      else acc[acc.length - 1] += cur;
      return acc;
    }, []))
      yield { type: "text", delta: w };

    const usedTables = new Set<string>();
    for (const s of sql) for (const m of s.toLowerCase().match(/\bt_[a-z0-9_]+/g) ?? []) usedTables.add(m);
    const filesUsed = schemas.filter((s) => usedTables.has(s.tableName.toLowerCase())).map((s) => s.fileAlias);

    yield {
      type: "final",
      answer: answer!,
      ...(result ? { table: result, chart: chooseChart(result, req.question), sql } : {}),
      route: { ...decision, route: decision.route },
      filesUsed,
    };
    if (!cancelled()) {
      const items = await suggestFollowUps(this.d.local, req.question, schemas.filter((s) => usedTables.has(s.tableName.toLowerCase())).concat(schemas).slice(0, 2));
      if (items.length) yield { type: "suggestions", items };
    }
  }

  private gateNote(g: GateResult): string {
    return gateNote(g);
  }

  private *cancelledEvent(): Generator<TurnEvent> {
    yield { type: "error", code: "CANCELLED", message: "The question was cancelled." };
  }

  // ---------------------------------------------------------------- local path
  private async *localAttempt(
    req: AskRequest,
    pruned: PruneResult,
    history: AskRequest["history"],
    signal?: AbortSignal,
  ): AsyncGenerator<TurnEvent, LocalOutcome> {
    const { config, local, engine } = this.d;
    const rcfg = config.routing;
    const reasons: string[] = [];
    if (!local) return { ok: false, attempts: 0, reasons: ["no local model"] };
    let prevErr: string | undefined;
    let attempts = 0;
    const run = async (sql: string): Promise<QueryResult> =>
      engine.runReadOnlySql(sql, signal ? { signal } : {});

    while (attempts < rcfg.maxLocalAttempts) {
      if (signal?.aborted) break;
      attempts++;
      yield { type: "trace", step: "local-sql", status: "start", detail: `Local model writes SQL (attempt ${attempts})` };
      let out;
      try {
        const r = await local.generate({ ...buildLocalSqlRequest(req.question, pruned, { history, ...(prevErr ? { previousError: prevErr } : {}) }), ...(signal ? { signal } : {}) });
        out = parseLocalSql(r.object ?? (r.text ? safeJson(r.text) : null));
      } catch (e) {
        reasons.push(`local model error: ${(e as Error).message.slice(0, 120)}`);
        yield { type: "trace", step: "local-sql", status: "error", detail: "local model failed" };
        break;
      }
      if (!out) {
        reasons.push("local model returned invalid output");
        prevErr = "Reply with valid JSON in the required shape.";
        yield { type: "trace", step: "local-sql", status: "error", detail: reasons.at(-1)! };
        continue;
      }
      if (out.needsEscalation || !out.sql.trim()) {
        reasons.push(`local model asked to escalate${out.reason ? `: ${out.reason}` : ""}`);
        yield { type: "trace", step: "local-sql", status: "skip", detail: reasons.at(-1)! };
        return { ok: false, attempts, reasons };
      }
      let result: QueryResult;
      try {
        result = await run(out.sql);
      } catch (e) {
        const msg = e instanceof EngineError ? `${e.code}: ${e.message}` : (e as Error).message;
        reasons.push(`SQL failed (${msg.slice(0, 120)})`);
        prevErr = msg;
        yield { type: "trace", step: "verify", status: "error", detail: reasons.at(-1)! };
        continue;
      }
      const failures = verifyResult({ result, confidence: out.confidence, minConfidence: rcfg.minConfidence });
      if (failures.length) {
        reasons.push(...failures);
        prevErr = failures.join("; ");
        yield { type: "trace", step: "verify", status: "error", detail: failures.join("; ") };
        continue;
      }
      if (rcfg.requireAgreement) {
        let agree = false;
        try {
          const r2 = await local.generate({ ...buildLocalSqlRequest(req.question, pruned, { temperature: 0.3, history }), ...(signal ? { signal } : {}) });
          const o2 = parseLocalSql(r2.object ?? (r2.text ? safeJson(r2.text) : null));
          if (o2?.sql.trim()) agree = resultHash(await run(o2.sql)) === resultHash(result);
        } catch {
          agree = false;
        }
        if (!agree) {
          reasons.push("two generations disagree");
          prevErr = "Two attempts gave different results; be more careful and precise.";
          yield { type: "trace", step: "verify", status: "error", detail: "second generation disagrees" };
          continue;
        }
      }
      yield { type: "trace", step: "verify", status: "done", detail: `${result.rowCount} row(s), checks passed` };
      return { ok: true, result, sql: out.sql, attempts, reasons };
    }
    return { ok: false, attempts, reasons };
  }

  // --------------------------------------------------------------- remote path
  private async *remoteSql(
    req: AskRequest,
    schemas: TableSchema[],
    pruned: PruneResult,
    history: AskRequest["history"],
    signal?: AbortSignal,
  ): AsyncGenerator<TurnEvent, { ok: true; results: QueryResult[]; sql: string[]; rounds: number } | { ok: false; message: string }> {
    const { engine, config } = this.d;
    // The remote model sees the schema (names and types) of EVERY registered table so it can pick the right
    // ones itself; profiles and sample rows are only attached for the tables the router thought relevant.
    const tables: SchemaInput[] = [];
    for (const t of schemas) {
      const needed = pruned.tablesNeeded.includes(t.tableName);
      const cols = (needed ? t.columns : t.columns.slice(0, 60)).map((c) => ({ name: c.name, type: c.type }));
      const input: SchemaInput = { tableName: t.tableName, columns: cols };
      if (needed) {
        const prof = this.profiles[t.tableName];
        if (prof) input.profiles = prof.filter((p) => cols.some((c) => c.name === p.name));
        if (config.privacy.tabularLevel === "rows") {
          try {
            input.sample = await engine.sampleRows(t.tableName, 20, cols.map((c) => c.name));
          } catch {
            /* sample is optional */
          }
        }
      }
      tables.push(input);
    }

    let repair: { sql: string[]; error: string } | undefined;
    for (let round = 1; round <= 2; round++) {
      yield { type: "trace", step: "remote-sql", status: "start", detail: round === 1 ? "Asking the remote model to write SQL (schema only)" : "Asking the remote model to repair its SQL (no data sent)" };
      const g: GateResult = yield* this.gate.send(
        { purpose: "write-sql", question: req.question, history, tables, ...(repair ? { repair } : {}) },
        req.turnId,
        undefined,
        signal,
      );
      if (g.status !== "sent") return { ok: false, message: this.gateNote(g) };
      const parsed = parseRemoteSql(g.result.object ?? (g.result.text ? safeJson(g.result.text) : null));
      if (!parsed) return { ok: false, message: "The remote model did not return usable SQL." };
      const queries = parsed.sql.map((s) => g.unmask(s));
      const results: QueryResult[] = [];
      let failure: string | undefined;
      for (const q of queries) {
        try {
          results.push(await engine.runReadOnlySql(q, signal ? { signal } : {}));
        } catch (e) {
          failure = e instanceof EngineError ? `${e.code}: ${e.message}` : (e as Error).message;
          break;
        }
      }
      if (!failure) {
        yield { type: "trace", step: "remote-sql", status: "done", detail: `${queries.length} quer${queries.length === 1 ? "y" : "ies"} ran locally` };
        const ordered = results.some((r) => r.rowCount > 0) ? [...results].sort((a, b) => Number(b.rowCount > 0) - Number(a.rowCount > 0)) : results;
        const primaryIdx = results.indexOf(ordered[0]!);
        return { ok: true, results: ordered, sql: [queries[primaryIdx]!, ...queries.filter((_, i) => i !== primaryIdx)], rounds: round };
      }
      yield { type: "trace", step: "remote-sql", status: "error", detail: `Query failed locally: ${failure.slice(0, 120)}` };
      repair = { sql: queries, error: failure };
    }
    return { ok: false, message: `The SQL written by the remote model could not run: ${repair?.error ?? "unknown error"}.` };
  }
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export { templateAnswer };
