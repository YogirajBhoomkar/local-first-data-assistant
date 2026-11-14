import type { AgentContract, DataEnginePort, EgressRecord, TurnEvent } from "@lf/core";
import { isOrdered, resultsMatch } from "./compare.js";
import type { EvalQuestion } from "./bench.js";

export interface E2eRow {
  id: string;
  label: "simple" | "hard";
  question: string;
  route: "local" | "remote" | "none";
  layer: number;
  reasons: string[];
  correct: boolean | null; // null = cannot be graded automatically
  bytesSent: number;
  sends: { purpose: string; outcome: string; bytes: number; tables: string[]; columns: number; rows: number }[];
  ms: number;
  error?: string;
}

export interface E2eSummary {
  total: number;
  graded: number;
  accuracy: number;
  accuracySimple: number;
  accuracyHard: number;
  localShare: number;
  remoteShare: number;
  meanBytesSent: number;
  wrongLocal: number;
  p50Ms: number;
  p90Ms: number;
}

export interface EgressReader {
  readAll(): Promise<EgressRecord[]>;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
};

export async function runE2e(i: {
  agent: AgentContract;
  engine: DataEnginePort;
  log: EgressReader;
  questions: EvalQuestion[];
  onProgress?: (m: string) => void;
}): Promise<{ rows: E2eRow[]; summary: E2eSummary }> {
  const rows: E2eRow[] = [];
  for (const q of i.questions.filter((x) => x.kind === "table")) {
    const t0 = Date.now();
    const events: TurnEvent[] = [];
    try {
      for await (const e of i.agent.ask({ turnId: q.id, question: q.question, history: [], context: { folderSelected: true } })) {
        events.push(e);
        if (e.type === "confirm") i.agent.confirm(e.egressId, true); // evaluation runs unattended
      }
    } catch (e) {
      events.push({ type: "error", code: "EXCEPTION", message: (e as Error).message });
    }
    const ms = Date.now() - t0;
    const final = events.find((e) => e.type === "final") as Extract<TurnEvent, { type: "final" }> | undefined;
    const err = events.find((e) => e.type === "error") as Extract<TurnEvent, { type: "error" }> | undefined;
    let correct: boolean | null = null;
    if (q.expected.type === "sql") {
      if (!final?.table) correct = false;
      else {
        try {
          const ref = String(q.expected.value);
          correct = resultsMatch(await i.engine.runReadOnlySql(ref), final.table, isOrdered(ref));
        } catch {
          correct = null;
        }
      }
    }
    const sends = (await i.log.readAll())
      .filter((r) => r.turnId === q.id)
      .map((r) => ({ purpose: r.purpose, outcome: r.outcome, bytes: r.byteSize, tables: r.tables, columns: r.columns.length, rows: r.rowCount }));
    const sentBytes = sends.filter((s) => s.outcome === "sent").reduce((n, s) => n + s.bytes, 0);
    rows.push({
      id: q.id, label: q.label, question: q.question,
      route: final ? final.route.route : "none", layer: final?.route.layer ?? -1, reasons: final?.route.reasons ?? [],
      correct, bytesSent: sentBytes, sends, ms, ...(err ? { error: `${err.code}: ${err.message}` } : {}),
    });
    i.onProgress?.(`${q.id} ${final?.route.route ?? "none"} ${correct === null ? "ungraded" : correct ? "ok" : "WRONG"}`);
  }

  const graded = rows.filter((r) => r.correct !== null);
  const acc = (xs: E2eRow[]) => (xs.length ? xs.filter((r) => r.correct).length / xs.length : 0);
  const summary: E2eSummary = {
    total: rows.length,
    graded: graded.length,
    accuracy: acc(graded),
    accuracySimple: acc(graded.filter((r) => r.label === "simple")),
    accuracyHard: acc(graded.filter((r) => r.label === "hard")),
    localShare: rows.length ? rows.filter((r) => r.route === "local").length / rows.length : 0,
    remoteShare: rows.length ? rows.filter((r) => r.route === "remote").length / rows.length : 0,
    meanBytesSent: rows.length ? rows.reduce((n, r) => n + r.bytesSent, 0) / rows.length : 0,
    wrongLocal: rows.filter((r) => r.route === "local" && r.correct === false).length,
    p50Ms: pct(rows.map((r) => r.ms), 0.5),
    p90Ms: pct(rows.map((r) => r.ms), 0.9),
  };
  return { rows, summary };
}

export function renderE2eReport(
  r: { rows: E2eRow[]; summary: E2eSummary },
  meta: { date: string; machine: string; mode: string; localModel: string; note?: string },
): string {
  const p = (x: number) => `${(x * 100).toFixed(1)}%`;
  const s = r.summary;
  const lines = r.rows.map((x) =>
    `| ${x.id} | ${x.label} | ${x.route} (L${x.layer}) | ${x.correct === null ? "n/a" : x.correct ? "yes" : "NO"} | ${x.bytesSent} | ${x.ms} | ${x.reasons.join("; ").replace(/\|/g, "/") || "-"} | ${x.sends.map((m) => `${m.purpose}/${m.outcome}: ${m.tables.join(",")} ${m.columns} cols ${m.rows} rows ${m.bytes} B`).join("; ") || "nothing sent"} |`,
  );
  return `# End-to-end evaluation ${meta.date}
${meta.note ? `\n> ${meta.note}\n` : ""}
## Setup
- routing mode: ${meta.mode}; local model: ${meta.localModel}
\`\`\`
${meta.machine}
\`\`\`

## Summary
| metric | value |
|---|---|
| questions | ${s.total} (${s.graded} graded automatically) |
| accuracy (graded) | ${p(s.accuracy)} (simple ${p(s.accuracySimple)}, hard ${p(s.accuracyHard)}) |
| answered locally / sent out | ${p(s.localShare)} / ${p(s.remoteShare)} |
| mean bytes sent per question | ${s.meanBytesSent.toFixed(0)} |
| wrong-local (answered locally and wrong) | ${s.wrongLocal} |
| time p50 / p90 | ${s.p50Ms} ms / ${s.p90Ms} ms |

## Per question
| id | label | route | correct | bytes sent | ms | reasons | exactly what was sent |
|---|---|---|---|---|---|---|---|
${lines.join("\n")}
`;
}
