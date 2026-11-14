import { createHash } from "node:crypto";
import {
  EngineError,
  type ChatModelPort,
  type ColumnProfile,
  type DataEnginePort,
  type QueryResult,
  type TableSchema,
} from "@lf/core";
import { isOrdered, resultsMatch } from "./compare.js";
import { buildLocalSqlRequest, parseLocalSql } from "./prompts/local-sql.js";
import { pruneSchema, type PruneOptions } from "./pruning.js";

export interface EvalQuestion {
  id: string;
  kind: "table" | "doc";
  files: string[];
  question: string;
  label: "simple" | "hard";
  expected: { type: "sql" | "value" | "contains" | "manual"; value: unknown };
  notes: string;
}

export interface CallRecord {
  questionId: string;
  run: number;
  validJson: boolean;
  guardPassed: boolean;
  ran: boolean;
  correct: boolean;
  needsEscalation: boolean | null;
  confidence: number | null;
  latencyMs: number;
  tokens: number;
  resultHash: string;
  error?: string;
}

export interface ModelStats {
  model: string;
  simpleAccuracy: number;
  sqlErrorRate: number;
  validJsonRate: number;
  meanLatencyMs: number;
  p90LatencyMs: number;
  wrongConfidenceRateHard: number;
  runAgreement: number;
  simpleCalls: number;
  hardCalls: number;
  tokens: number;
}

export interface BenchResult {
  stats: ModelStats[];
  calls: Record<string, { simple: CallRecord[]; hard: CallRecord[] }>;
}

export interface BenchInput {
  engine: DataEnginePort;
  schemas: TableSchema[];
  profiles?: Record<string, ColumnProfile[]>;
  models: { name: string; port: ChatModelPort }[];
  questions: EvalQuestion[];
  runs: number;
  prune?: PruneOptions;
  onProgress?: (msg: string) => void;
}

const percentile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const hashRows = (r: QueryResult) =>
  createHash("sha1")
    .update(JSON.stringify([...r.rows.map((x) => x.map((c) => (typeof c === "number" ? +c.toPrecision(9) : String(c))))].map((x) => JSON.stringify(x)).sort()))
    .digest("hex")
    .slice(0, 10);

async function oneCall(i: BenchInput, port: ChatModelPort, q: EvalQuestion, run: number): Promise<CallRecord> {
  const rec: CallRecord = {
    questionId: q.id, run, validJson: false, guardPassed: false, ran: false, correct: false,
    needsEscalation: null, confidence: null, latencyMs: 0, tokens: 0, resultHash: "ERR",
  };
  const pruned = pruneSchema(q.question, i.schemas, i.profiles, i.prune);
  const req = buildLocalSqlRequest(q.question, pruned, { temperature: run === 0 ? 0 : 0.3 });
  const t0 = Date.now();
  let out;
  try {
    const r = await port.generate(req);
    rec.latencyMs = r.latencyMs || Date.now() - t0;
    rec.tokens = r.usage.promptTokens + r.usage.completionTokens;
    out = parseLocalSql(r.object ?? (r.text ? safeJson(r.text) : null));
  } catch (e) {
    rec.latencyMs = Date.now() - t0;
    rec.error = (e as Error).message.slice(0, 200);
    return rec;
  }
  if (!out) {
    rec.error = "invalid JSON shape";
    return rec;
  }
  rec.validJson = true;
  rec.needsEscalation = out.needsEscalation;
  rec.confidence = out.confidence;
  if (!out.sql.trim()) {
    rec.guardPassed = true;
    return rec;
  }
  let actual: QueryResult;
  try {
    actual = await i.engine.runReadOnlySql(out.sql);
    rec.guardPassed = true;
    rec.ran = true;
  } catch (e) {
    rec.guardPassed = !(e instanceof EngineError && e.code === "FORBIDDEN");
    rec.error = (e as Error).message.slice(0, 200);
    return rec;
  }
  rec.resultHash = hashRows(actual);
  if (q.expected.type === "sql") {
    const ref = String(q.expected.value);
    try {
      const expected = await i.engine.runReadOnlySql(ref);
      rec.correct = resultsMatch(expected, actual, isOrdered(ref));
    } catch (e) {
      rec.error = `reference SQL failed: ${(e as Error).message.slice(0, 100)}`;
    }
  }
  return rec;
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export async function runBench(i: BenchInput): Promise<BenchResult> {
  const simple = i.questions.filter((q) => q.kind === "table" && q.label === "simple");
  const hard = i.questions.filter((q) => q.kind === "table" && q.label === "hard");
  const result: BenchResult = { stats: [], calls: {} };

  for (const m of i.models) {
    const s: CallRecord[] = [];
    const h: CallRecord[] = [];
    for (const q of simple) {
      for (let r = 0; r < i.runs; r++) s.push(await oneCall(i, m.port, q, r));
      i.onProgress?.(`${m.name}: ${q.id}`);
    }
    for (const q of hard) {
      h.push(await oneCall(i, m.port, q, 0));
      i.onProgress?.(`${m.name}: ${q.id} (hard)`);
    }
    result.calls[m.name] = { simple: s, hard: h };

    let agree = 0;
    for (const q of simple) {
      const hs = new Set(s.filter((c) => c.questionId === q.id).map((c) => c.resultHash));
      if (hs.size === 1) agree++;
    }
    const lat = [...s, ...h].map((c) => c.latencyMs);
    result.stats.push({
      model: m.name,
      simpleAccuracy: s.length ? s.filter((c) => c.correct).length / s.length : 0,
      sqlErrorRate: s.length ? s.filter((c) => c.validJson && !c.ran && c.needsEscalation !== true).length / s.length : 0,
      validJsonRate: s.length ? s.filter((c) => c.validJson).length / s.length : 0,
      meanLatencyMs: mean(lat),
      p90LatencyMs: percentile(lat, 0.9),
      wrongConfidenceRateHard: h.length ? h.filter((c) => c.needsEscalation === false && !c.correct).length / h.length : 0,
      runAgreement: simple.length ? agree / simple.length : 0,
      simpleCalls: s.length,
      hardCalls: h.length,
      tokens: [...s, ...h].reduce((n, c) => n + c.tokens, 0),
    });
  }
  return result;
}

/** The decision rule is fixed here, before any number is computed. */
export const RECOMMENDATION_RULE =
  "Choose the larger model only if it is at least 10 points more accurate on simple questions AND its p90 latency is under 15 seconds on this machine; otherwise choose the smaller one. If neither reaches 60% accuracy on simple questions, recommend remote-SQL mode (the remote model writes SQL from the schema; the local model only classifies and summarises).";

export function recommend(stats: ModelStats[]): string {
  if (stats.length === 0) return "No models were benchmarked.";
  if (stats.every((s) => s.simpleAccuracy < 0.6)) return "remote-sql mode: no model reached 60% accuracy on simple questions.";
  const [small, large] = stats;
  if (!large || !small) return `Use ${stats[0]!.model} (only model benchmarked${stats[0]!.simpleAccuracy < 0.6 ? ", below 60% accuracy" : ""}).`;
  if (small.simpleAccuracy < 0.6 && large.simpleAccuracy >= 0.6) return `Use ${large.model} (the smaller model is below 60%).`;
  if (large.simpleAccuracy - small.simpleAccuracy >= 0.1 && large.p90LatencyMs < 15000)
    return `Use ${large.model} (+${((large.simpleAccuracy - small.simpleAccuracy) * 100).toFixed(1)} points, p90 ${(large.p90LatencyMs / 1000).toFixed(1)} s).`;
  return `Use ${small.model} (the larger model did not meet both conditions).`;
}

export function renderReport(r: BenchResult, machine: string, meta: { runs: number; date: string }): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const rows = r.stats
    .map((s) => `| ${s.model} | ${pct(s.simpleAccuracy)} | ${pct(s.sqlErrorRate)} | ${pct(s.validJsonRate)} | ${(s.meanLatencyMs / 1000).toFixed(2)} s | ${(s.p90LatencyMs / 1000).toFixed(2)} s | ${pct(s.wrongConfidenceRateHard)} | ${pct(s.runAgreement)} |`)
    .join("\n");
  return `# Model benchmark ${meta.date}

## Machine
\`\`\`
${machine}
\`\`\`

## Decision rule (fixed before running)
${RECOMMENDATION_RULE}

## Results (${meta.runs} runs per simple question, hard questions once)
| model | simple accuracy | SQL error rate | valid JSON | mean latency | p90 latency | wrong-confidence on hard | run agreement |
|---|---|---|---|---|---|---|---|
${rows}

## Recommendation
${recommend(r.stats)}
`;
}
