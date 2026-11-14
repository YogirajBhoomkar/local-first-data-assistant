import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RuleClassifier, loadConfig, type ChatModelPort, type GenerateRequest, type GenerateResult, type TurnEvent,
} from "@lf/core";
import { DuckDbEngine } from "@lf/engine";
import { MockModelAdapter } from "@lf/models";
import { TableAgent, EgressLog } from "./index.js";

const FIXTURES = resolve(import.meta.dirname, "../../engine/test/fixtures");
const KEY = "sk-secret-do-not-log";
const sys = (r: GenerateRequest) => r.system ?? "";

const sqlReply = (sql: string, confidence = 0.95, needsEscalation = false) => ({
  object: { sql, tables: [], confidence, needsEscalation, reason: "test" },
});

/** Local mock: SQL prompt answered by `sqlFor`, everything else with sensible defaults. */
function localMock(sqlFor: (req: GenerateRequest) => ReturnType<typeof sqlReply>, classify = { type: "aggregate", confidence: 0.9 }) {
  return new MockModelAdapter([
    { match: (r) => sys(r).includes("Classify the user"), reply: { object: classify } },
    { match: (r) => sys(r).includes("You write one DuckDB SQL"), reply: sqlFor },
    { match: (r) => sys(r).includes("Answer the question in 1 to 3"), reply: { text: "Local answer." } },
    { match: (r) => sys(r).includes("Suggest up to 3"), reply: { object: { items: ["How many claims are open?", "Show t_unknown_table rows"] } } },
  ], "local-mock");
}

class RemoteSpy implements ChatModelPort {
  calls: GenerateRequest[] = [];
  pendingSeenBeforeCall: boolean[] = [];
  constructor(private readonly log: EgressLog, private readonly script: (r: GenerateRequest, n: number) => Partial<GenerateResult>) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.pendingSeenBeforeCall.push((await this.log.readAll()).some((r) => r.outcome === "pending"));
    this.calls.push(req);
    const out = this.script(req, this.calls.length);
    return { usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 1, modelId: "remote-spy", ...out };
  }
  async *stream() { /* unused */ }
  async health() { return { ok: true, modelId: "remote-spy", detail: "" }; }
}

describe("TableAgent", () => {
  const cache = mkdtempSync(join(tmpdir(), "lf-agent-"));
  const engine = new DuckDbEngine({ cacheDir: cache, maxResultRows: 100 });
  beforeAll(async () => {
    await engine.registerFiles(await engine.scanFolder(FIXTURES));
  }, 60000);
  afterAll(async () => {
    await engine.close();
    rmSync(cache, { recursive: true, force: true });
  });

  let n = 0;
  function make(opts: {
    local?: ChatModelPort | null;
    overrides?: Record<string, unknown>;
    remote?: (log: EgressLog) => RemoteSpy;
  }) {
    const dir = join(cache, `run${++n}`);
    const config = loadConfig({}, {
      cacheDir: dir,
      remoteModel: { baseUrl: "https://private.example.internal/v1", model: "big", apiKey: KEY },
      privacy: { confirmBeforeSend: false },
      ...opts.overrides,
    });
    const log = new EgressLog(dir);
    const remote = opts.remote?.(log);
    const agent = new TableAgent({
      config, engine, local: opts.local === undefined ? null : opts.local, classifier: new RuleClassifier(), maskKey: "mk",
      ...(remote ? { remoteFactory: () => remote } : {}), confirmTimeoutMs: 2000,
    });
    return { agent, log, remote, config };
  }
  async function collect(agent: TableAgent, question: string, history: { role: "user" | "assistant"; text: string }[] = [], onEvent?: (e: TurnEvent) => void) {
    const events: TurnEvent[] = [];
    for await (const e of agent.ask({ turnId: `t${++n}`, question, history, context: { folderSelected: true } })) {
      events.push(e);
      onEvent?.(e);
    }
    const final = events.find((e) => e.type === "final");
    return { events, final: final as Extract<TurnEvent, { type: "final" }> | undefined };
  }
  const routes = (ev: TurnEvent[]) => ev.filter((e): e is Extract<TurnEvent, { type: "route" }> => e.type === "route");

  it("simple question stays local and sends nothing", async () => {
    const local = localMock(() => sqlReply("SELECT COUNT(*) AS n FROM t_policies"));
    const { agent, log } = make({ local, remote: (l) => new RemoteSpy(l, () => { throw new Error("remote must not be called"); }) });
    const { events, final } = await collect(agent, "How many policies are there?");
    expect(routes(events)[0]).toMatchObject({ route: "local", layer: 4 });
    expect(final!.route.route).toBe("local");
    expect(final!.answer).toContain("Local answer");
    expect(final!.table!.rowCount).toBe(1);
    expect(final!.chart!.type).toBe("table");
    expect(final!.sql).toEqual(["SELECT COUNT(*) AS n FROM t_policies"]);
    expect(final!.filesUsed).toEqual(["policies"]);
    expect(await log.readAll()).toHaveLength(0);
    // suggestions: the item naming an unknown table is dropped
    const sug = events.find((e) => e.type === "suggestions") as { items: string[] };
    expect(sug.items).toEqual(["How many claims are open?"]);
  });

  it("join escalates at layer 2 and the remote writes SQL that runs locally", async () => {
    const local = localMock(() => { throw new Error("local SQL must not be asked"); });
    const { agent, log, remote } = make({
      local,
      remote: (l) => new RemoteSpy(l, () => ({ object: { sql: ["SELECT SUM(c.paid_amount) AS s FROM t_claims c JOIN t_policies p ON c.policy_id = p.policy_id WHERE p.region = 'EMEA'"], explanation: "join" } })),
    });
    const { events, final } = await collect(agent, "What is the total paid amount on claims for each policy region premium?");
    expect(routes(events)[0]).toMatchObject({ route: "remote", layer: 2 });
    expect(routes(events)[0]!.reasons.join(" ")).toMatch(/tables/);
    expect(final!.table!.rowCount).toBe(1);
    expect(final!.filesUsed.sort()).toEqual(["claims", "policies"]);
    const recs = await log.readAll();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ purpose: "write-sql", outcome: "sent", approvedBy: "auto" });
    expect(remote!.pendingSeenBeforeCall).toEqual([true]);
  });

  it("'why' escalates at layer 2; remote also writes the answer from results (rows level)", async () => {
    const { agent, log } = make({
      local: localMock(() => sqlReply("SELECT 1")),
      remote: (l) => new RemoteSpy(l, (r) =>
        sys(r).includes("You write DuckDB SQL")
          ? { object: { sql: ["SELECT region, SUM(premium_amount) AS p FROM t_policies GROUP BY 1"], explanation: "" } }
          : { text: "EMEA is higher because of volume." }),
    });
    const { events, final } = await collect(agent, "Why is premium higher in some regions?");
    expect(routes(events)[0]).toMatchObject({ route: "remote", layer: 2 });
    expect(routes(events)[0]!.reasons.join(" ")).toMatch(/high|effort/);
    expect(routes(events)[0]!.reasons.join(" ")).toMatch(/"why"/);
    expect(final!.answer).toContain("EMEA is higher");
    const purposes = (await log.readAll()).map((r) => r.purpose);
    expect(purposes).toEqual(["write-sql", "answer-from-results"]);
  });

  it("level 'schema' never sends values: the answer is written locally", async () => {
    const { agent, log } = make({
      local: localMock(() => sqlReply("SELECT 1")),
      overrides: { privacy: { confirmBeforeSend: false, tabularLevel: "schema" } },
      remote: (l) => new RemoteSpy(l, (r) => {
        const body = JSON.stringify(r.messages);
        expect(body).not.toMatch(/BRK-|sampleRows|profile/);
        return { object: { sql: ["SELECT region, SUM(premium_amount) AS p FROM t_policies GROUP BY 1"], explanation: "" } };
      }),
    });
    const { final } = await collect(agent, "Why is premium higher in some regions?");
    expect(final!.answer).toContain("Local answer");
    const recs = await log.readAll();
    expect(recs.map((r) => r.purpose)).toEqual(["write-sql"]);
    expect(final!.answer).toBeDefined();
  });

  it("low confidence escalates at layer 5", async () => {
    const { agent } = make({
      local: localMock(() => sqlReply("SELECT COUNT(*) FROM t_policies", 0.3)),
      remote: (l) => new RemoteSpy(l, () => ({ object: { sql: ["SELECT COUNT(*) AS n FROM t_policies"], explanation: "" } })),
    });
    const { events, final } = await collect(agent, "How many policies are there?");
    const r = routes(events);
    expect(r[0]).toMatchObject({ route: "local" });
    expect(r.at(-1)).toMatchObject({ route: "remote", layer: 5 });
    expect(r.at(-1)!.reasons.join(" ")).toMatch(/low model confidence/);
    expect(final!.route.attempts).toBeGreaterThanOrEqual(2);
  });

  it("disagreement between two generations escalates", async () => {
    const local = localMock((req) => sqlReply(req.temperature > 0 ? "SELECT COUNT(*) FROM t_claims" : "SELECT COUNT(*) FROM t_policies"));
    const { agent } = make({ local, remote: (l) => new RemoteSpy(l, () => ({ object: { sql: ["SELECT COUNT(*) AS n FROM t_policies"], explanation: "" } })) });
    const { events } = await collect(agent, "How many claims were paid compared to last year?");
    expect(routes(events).at(-1)!.reasons.join(" ")).toMatch(/disagree/);
    expect(routes(events).at(-1)!.route).toBe("remote");
  });

  it("low effort uses ONE local generation (no second confirmation call)", async () => {
    let sqlCalls = 0;
    const local = localMock(() => { sqlCalls++; return sqlReply("SELECT COUNT(*) AS n FROM t_policies"); });
    const { agent } = make({ local });
    const { events, final } = await collect(agent, "How many policies are there?");
    expect(sqlCalls).toBe(1);
    expect(final!.route.route).toBe("local");
    const eff = events.find((e) => e.type === "trace" && e.step === "effort") as Extract<TurnEvent, { type: "trace" }>;
    expect(eff.data).toMatchObject({ level: "low" });
    expect(routes(events)[0]!.reasons.join(" ")).toMatch(/low effort: one local generation/);
  });

  it("medium effort asks for a second generation to confirm", async () => {
    let sqlCalls = 0;
    const local = localMock(() => { sqlCalls++; return sqlReply("SELECT COUNT(*) AS n FROM t_claims"); });
    const { agent } = make({ local });
    const { events } = await collect(agent, "How many claims were paid compared to last year?");
    expect(sqlCalls).toBe(2);
    const eff = events.find((e) => e.type === "trace" && e.step === "effort") as Extract<TurnEvent, { type: "trace" }>;
    expect(eff.data).toMatchObject({ level: "medium" });
  });

  it("high effort goes straight to the remote model: the local model is never asked for SQL", async () => {
    let sqlCalls = 0;
    const local = localMock(() => { sqlCalls++; return sqlReply("SELECT 1"); });
    const { agent } = make({ local, remote: (l) => new RemoteSpy(l, () => ({ object: { sql: ["SELECT COUNT(*) AS n FROM t_policies"], explanation: "" } })) });
    const { events } = await collect(agent, "Why is the claims count what it is, and what should we do about it?");
    expect(sqlCalls).toBe(0);
    expect(routes(events)[0]).toMatchObject({ route: "remote" });
    expect(routes(events)[0]!.reasons.join(" ")).toMatch(/straight to the remote model/);
  });

  it("near-tied tables (premium exists in several) raise the effort to high", async () => {
    const { agent } = make({
      local: localMock(() => sqlReply("SELECT 1")),
      remote: (l) => new RemoteSpy(l, () => ({ object: { sql: ["SELECT SUM(premium_amount) AS s FROM t_policies"], explanation: "" } })),
    });
    const { events } = await collect(agent, "What is the total premium for the EMEA region?");
    const eff = events.find((e) => e.type === "trace" && e.step === "effort") as Extract<TurnEvent, { type: "trace" }>;
    expect((eff.data!.signals as { name: string }[]).map((x) => x.name)).toContain("ambiguous-table");
    expect(routes(events)[0]).toMatchObject({ route: "remote" });
  });

  it("a decision model (Laya) adds signals and its outage never breaks the turn", async () => {
    const mkAgent = (decide: () => Promise<unknown>) => {
      const dir = join(cache, `dm${++n}`);
      const config = loadConfig({}, { cacheDir: dir, remoteModel: { baseUrl: "https://x.example/v1", model: "m", apiKey: "k" }, privacy: { confirmBeforeSend: false } });
      return new TableAgent({
        config, engine, local: localMock(() => sqlReply("SELECT COUNT(*) AS n FROM t_policies")), classifier: new RuleClassifier(), maskKey: "k",
        decision: { decide } as never,
        remoteFactory: () => new RemoteSpy(new EgressLog(dir), () => ({ object: { sql: ["SELECT COUNT(*) AS n FROM t_policies"], explanation: "" } })),
      });
    };
    const high = await collect(mkAgent(async () => ({ needsReasoning: 0.95, multiStep: 0.9 })), "How many policies are there?");
    expect(routes(high.events)[0]).toMatchObject({ route: "remote", layer: 3 });
    expect(high.events.some((e) => e.type === "trace" && e.step === "decision-model" && e.status === "done")).toBe(true);
    const down = await collect(mkAgent(async () => { throw new Error("connection refused"); }), "How many policies are there?");
    expect(down.events.some((e) => e.type === "trace" && e.step === "decision-model" && e.status === "error")).toBe(true);
    expect(down.final!.route.route).toBe("local"); // falls back to the free rule signals
  });

  it("a SQL error is retried once with the error, then escalates", async () => {
    let calls = 0;
    const local = localMock((req) => {
      if (req.temperature === 0) calls++;
      return sqlReply("SELECT nope FROM t_policies");
    });
    const { agent } = make({ local, remote: (l) => new RemoteSpy(l, () => ({ object: { sql: ["SELECT 1 AS n"], explanation: "" } })) });
    const { events } = await collect(agent, "How many policies are there?");
    expect(calls).toBe(2);
    expect(routes(events).at(-1)!.reasons.join(" ")).toMatch(/SQL failed/);
  });

  it("remote disabled: hard question stays local and returns a clear partial message", async () => {
    const { agent, log } = make({
      local: localMock(() => sqlReply("", 0.1, true)),
      overrides: { remoteModel: { enabled: false } },
    });
    const { events, final } = await collect(agent, "Why is premium higher in some regions?");
    expect(routes(events)[0]).toMatchObject({ route: "local", layer: 1 });
    expect(final!.route.route).toBe("local");
    expect(final!.answer).toMatch(/remote model is turned off/);
    expect(final!.table).toBeUndefined();
    expect(await log.readAll()).toHaveLength(0);
  });

  it("remote-sql mode skips local SQL generation", async () => {
    let localSqlCalls = 0;
    const local = localMock(() => { localSqlCalls++; return sqlReply("SELECT 1"); });
    const { agent } = make({
      local, overrides: { routing: { mode: "remote-sql" } },
      remote: (l) => new RemoteSpy(l, () => ({ object: { sql: ["SELECT COUNT(*) AS n FROM t_policies"], explanation: "" } })),
    });
    const { events, final } = await collect(agent, "How many policies are there?");
    expect(routes(events)[0]).toMatchObject({ route: "remote", layer: 0 });
    expect(localSqlCalls).toBe(0);
    expect(final!.table!.rowCount).toBe(1);
  });

  it("no local model: remote-only mode still works, answer from a template", async () => {
    const { agent } = make({
      local: null,
      remote: (l) => new RemoteSpy(l, () => ({ object: { sql: ["SELECT COUNT(*) AS n FROM t_policies"], explanation: "" } })),
    });
    const { events, final } = await collect(agent, "How many policies are there?");
    expect(routes(events)[0]!.reasons).toContain("no local model available");
    expect(final!.answer).toMatch(/^n: [\d,]+\./);
  });

  it("repairs the remote SQL once, sending only the SQL and the error", async () => {
    const { agent, remote } = make({
      local: null,
      remote: (l) => new RemoteSpy(l, (_r, n) => ({ object: { sql: [n === 1 ? "SELECT nope FROM t_policies" : "SELECT COUNT(*) AS n FROM t_policies"], explanation: "" } })),
    });
    const { final } = await collect(agent, "How many policies are there?");
    expect(final!.table!.rowCount).toBe(1);
    expect(remote!.calls).toHaveLength(2);
    expect(remote!.calls[1]!.messages[0]!.content).toContain("repair");
  });

  it("confirm: approved send goes out, cancelled send stays local, both are logged", async () => {
    const mk = () => make({
      local: localMock(() => sqlReply("SELECT COUNT(*) AS n FROM t_policies")),
      overrides: { privacy: { confirmBeforeSend: true } },
      remote: (l) => new RemoteSpy(l, () => ({ object: { sql: ["SELECT COUNT(*) AS n FROM t_policies"], explanation: "" } })),
    });
    const q = "Show premium by region and claims paid by cause";
    const a = mk();
    const ra = await collect(a.agent, q, [], (e) => { if (e.type === "confirm") a.agent.confirm(e.egressId, true); });
    expect(ra.events.some((e) => e.type === "confirm")).toBe(true);
    expect(a.remote!.calls).toHaveLength(1);
    expect((await a.log.readAll())[0]).toMatchObject({ outcome: "sent", approvedBy: "user" });

    const c = mk();
    const rc = await collect(c.agent, q, [], (e) => { if (e.type === "confirm") c.agent.confirm(e.egressId, false); });
    expect(c.remote!.calls).toHaveLength(0);
    expect((await c.log.readAll())[0]).toMatchObject({ outcome: "cancelled", approvedBy: "none" });
    expect(rc.final!.answer).toMatch(/cancelled/);
    expect(rc.final!.table).toBeDefined(); // answered locally instead
  });

  it("no confirm answer within the timeout cancels the send", async () => {
    const { agent, log, remote } = make({
      local: null,
      overrides: { privacy: { confirmBeforeSend: true } },
      remote: (l) => new RemoteSpy(l, () => ({ object: { sql: ["SELECT 1 AS n"], explanation: "" } })),
    });
    const { final } = await collect(agent, "How many policies?");
    expect(remote!.calls).toHaveLength(0);
    expect((await log.readAll())[0]!.outcome).toBe("cancelled");
    expect(final!.answer).toMatch(/cancelled/);
  }, 10000);

  it("the API key and remote URL never appear in the egress log, and the log is append-only JSONL", async () => {
    const { agent, log } = make({
      local: null,
      overrides: { privacy: { confirmBeforeSend: false, logFullPayload: true } },
      remote: (l) => new RemoteSpy(l, () => ({ object: { sql: ["SELECT COUNT(*) AS n FROM t_policies"], explanation: "" } })),
    });
    await collect(agent, "How many policies?");
    const raw = readFileSync(log.file, "utf8");
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain("private.example");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2); // pending + sent
    expect(JSON.parse(lines[0]!).outcome).toBe("pending");
    expect(JSON.parse(lines[1]!).outcome).toBe("sent");
    expect(JSON.parse(lines[1]!).payload).toBeDefined(); // full payload only because logFullPayload=true
    expect(JSON.parse(lines[1]!).payloadSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("without logFullPayload the payload is not stored", async () => {
    const { agent, log } = make({
      local: null,
      remote: (l) => new RemoteSpy(l, () => ({ object: { sql: ["SELECT 1 AS n"], explanation: "" } })),
    });
    await collect(agent, "How many policies?");
    expect((await log.readAll())[0]!.payload).toBeUndefined();
  });

  it("only the last N turns of history reach the prompt, and no result rows", async () => {
    const seen: string[] = [];
    const local = localMock((req) => { seen.push(req.messages[0]!.content); return sqlReply("SELECT COUNT(*) AS n FROM t_policies"); });
    const { agent } = make({ local, overrides: { history: { turns: 1 } } });
    const history = [
      { role: "user" as const, text: "OLD QUESTION" }, { role: "assistant" as const, text: "OLD ANSWER" },
      { role: "user" as const, text: "RECENT QUESTION" }, { role: "assistant" as const, text: "RECENT ANSWER" },
    ];
    await collect(agent, "How many policies are there?", history);
    expect(seen[0]).toContain("RECENT QUESTION");
    expect(seen[0]).not.toContain("OLD QUESTION");
  });

  it("errors clearly without a folder or without any model", async () => {
    const a = make({ local: null, overrides: { remoteModel: { enabled: false } } });
    expect((await collect(a.agent, "x")).events[0]).toMatchObject({ type: "error", code: "NO_MODEL" });
    const events: TurnEvent[] = [];
    for await (const e of a.agent.ask({ turnId: "t", question: "x", history: [], context: { folderSelected: false } })) events.push(e);
    expect(events[0]).toMatchObject({ code: "NO_FOLDER" });
  });

  it("exposes an agent card", () => {
    const { agent } = make({ local: null });
    expect(agent.card().capabilities).toContain("table-qa");
    expect(agent.card().dataPolicy).toMatch(/Files stay on this machine/);
  });
});
