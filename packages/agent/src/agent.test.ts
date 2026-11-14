import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type ColumnProfile, type QueryResult, type TableSchema } from "@lf/core";
import { DuckDbEngine } from "@lf/engine";
import { MockModelAdapter } from "@lf/models";
import { isOrdered, resultsMatch } from "./compare.js";
import { buildLocalSqlRequest, parseLocalSql } from "./prompts/local-sql.js";
import { pruneSchema, stem } from "./pruning.js";
import { recommend, renderReport, runBench, type EvalQuestion, type ModelStats } from "./bench.js";

const FIXTURES = resolve(import.meta.dirname, "../../engine/test/fixtures");
const QUESTIONS: EvalQuestion[] = readFileSync(resolve(import.meta.dirname, "../../../eval/questions.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const synonyms = loadConfig({}).pruning.synonyms;

const col = (name: string, type = "VARCHAR") => ({ name, type });
const policies: TableSchema = {
  tableName: "t_policies", fileAlias: "policies", rowCountEstimate: 10,
  columns: [col("policy_id"), col("line_of_business"), col("region"), col("inception_date", "DATE"), col("expiry_date", "DATE"), col("currency"), col("limit_amount", "DOUBLE"), col("premium_amount", "DOUBLE"), col("broker_code"), col("status"), col("x1"), col("x2"), col("x3"), col("x4")],
};
const claims: TableSchema = {
  tableName: "t_claims", fileAlias: "claims", rowCountEstimate: 10,
  columns: [col("claim_id"), col("policy_id"), col("loss_date", "DATE"), col("reported_date", "DATE"), col("cause"), col("paid_amount", "DOUBLE"), col("reserve_amount", "DOUBLE"), col("status")],
};

describe("pruneSchema", () => {
  it("stems simply", () => {
    expect(stem("policies")).toBe("policy");
    expect(stem("claims")).toBe("claim");
    expect(stem("grouped")).toBe("group");
  });
  it("picks the right table and always keeps id and date columns", () => {
    const r = pruneSchema("What is the total premium by region?", [policies, claims], {}, { synonyms });
    expect(r.tablesNeeded).toEqual(["t_policies"]);
    const cols = r.tables.find((t) => t.tableName === "t_policies")!.columns.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["premium_amount", "region", "policy_id", "inception_date", "expiry_date"]));
    expect(cols).not.toContain("x4");
    expect(cols.length).toBeLessThanOrEqual(12);
  });
  it("uses synonyms", () => {
    const r = pruneSchema("total revenue", [policies], {}, { synonyms });
    expect(r.tables[0]!.columns.map((c) => c.name)).toContain("premium_amount");
  });
  it("uses value overlap from profiles", () => {
    const prof: Record<string, ColumnProfile[]> = {
      t_claims: [{ name: "cause", type: "VARCHAR", nullFraction: 0, distinctEstimate: 3, topValues: [{ value: "flood", count: 3 }] }],
    };
    const r = pruneSchema("any flood last year", [policies, claims], prof, { synonyms });
    expect(r.tablesNeeded[0]).toBe("t_claims");
  });
  it("matches profile values as whole words only (country code 'us' is not in 'cause')", () => {
    const prof: Record<string, ColumnProfile[]> = {
      t_claims: [{ name: "country", type: "VARCHAR", nullFraction: 0, distinctEstimate: 2, topValues: [{ value: "US", count: 3 }] }],
    };
    const r = pruneSchema("claims by cause", [policies, { ...claims, columns: [...claims.columns, col("country")] }], prof, { synonyms });
    expect(r.tables.find((t) => t.tableName === "t_claims")!.columns.find((c) => c.name === "country")?.score ?? 0).toBe(0);
  });
  it("needs a second table only for words the first table cannot explain", () => {
    const one = pruneSchema("How many policies are there?", [policies, claims], {}, { synonyms });
    expect(one.tablesNeeded).toEqual(["t_policies"]);
  });
  it("flags multi-table questions", () => {
    const r = pruneSchema("paid claims amount per policy premium", [policies, claims], {}, { synonyms });
    expect(r.tablesNeeded).toHaveLength(2);
  });
  it("is deterministic and keeps at least 5 columns", () => {
    const a = pruneSchema("hello", [claims], {}, { synonyms });
    expect(a).toEqual(pruneSchema("hello", [claims], {}, { synonyms }));
    expect(a.tables[0]!.columns.length).toBeGreaterThanOrEqual(5);
  });
});

describe("prompt", () => {
  it("is short and contains the schema and question", () => {
    const pruned = pruneSchema("count policies", [policies], {}, { synonyms });
    const req = buildLocalSqlRequest("count policies", pruned);
    expect(req.system!.length).toBeLessThan(2000);
    expect(req.messages[0]!.content).toContain("t_policies(");
    expect(req.messages[0]!.content).toContain("count policies");
    expect(req.responseSchema).toBeDefined();
  });
  it("adds the previous error on a retry", () => {
    const pruned = pruneSchema("x", [claims], {}, { synonyms });
    expect(buildLocalSqlRequest("x", pruned, { previousError: "boom" }).messages[0]!.content).toContain("boom");
  });
  it("validates model output", () => {
    expect(parseLocalSql({ sql: "SELECT 1", tables: [], confidence: 0.9, needsEscalation: false, reason: "" })).not.toBeNull();
    expect(parseLocalSql({ sql: 1 })).toBeNull();
    expect(parseLocalSql(null)).toBeNull();
  });
});

describe("resultsMatch", () => {
  const mk = (rows: unknown[][]): QueryResult => ({ columns: rows[0]!.map((_, i) => ({ name: `c${i}`, type: "" })), rows, rowCount: rows.length, truncated: false, elapsedMs: 0 });
  it("ignores order unless ordered", () => {
    expect(resultsMatch(mk([["a", 1], ["b", 2]]), mk([["b", 2], ["a", 1]]))).toBe(true);
    expect(resultsMatch(mk([["a", 1], ["b", 2]]), mk([["b", 2], ["a", 1]]), true)).toBe(false);
  });
  it("uses numeric tolerance and compares numeric strings", () => {
    expect(resultsMatch(mk([[1.0000000001]]), mk([["1"]]))).toBe(true);
    expect(resultsMatch(mk([[1]]), mk([[1.01]]))).toBe(false);
  });
  it("rejects different shapes", () => {
    expect(resultsMatch(mk([[1], [2]]), mk([[1]]))).toBe(false);
    expect(resultsMatch(mk([[1, 2]]), mk([[1]]))).toBe(false);
  });
  it("detects ordering questions", () => {
    expect(isOrdered("SELECT a FROM t ORDER BY a")).toBe(true);
    expect(isOrdered("SELECT a FROM t")).toBe(false);
  });
});

describe("recommend", () => {
  const st = (model: string, acc: number, p90: number): ModelStats => ({ model, simpleAccuracy: acc, sqlErrorRate: 0, validJsonRate: 1, meanLatencyMs: 0, p90LatencyMs: p90, wrongConfidenceRateHard: 0, runAgreement: 1, simpleCalls: 1, hardCalls: 1, tokens: 0 });
  it("picks the larger model only with +10 points and p90 < 15 s", () => {
    expect(recommend([st("small", 0.7, 2000), st("large", 0.82, 9000)])).toMatch(/Use large/);
    expect(recommend([st("small", 0.7, 2000), st("large", 0.75, 9000)])).toMatch(/Use small/);
    expect(recommend([st("small", 0.7, 2000), st("large", 0.9, 20000)])).toMatch(/Use small/);
  });
  it("falls back to remote-sql under 60%", () => {
    expect(recommend([st("small", 0.5, 1), st("large", 0.55, 1)])).toMatch(/remote-sql/);
  });
});

describe("bench harness with a mock model", () => {
  const cache = mkdtempSync(join(tmpdir(), "lf-bench-"));
  const engine = new DuckDbEngine({ cacheDir: cache });
  let schemas: TableSchema[] = [];
  beforeAll(async () => {
    schemas = await engine.registerFiles(await engine.scanFolder(FIXTURES));
  }, 60000);
  afterAll(async () => {
    await engine.close();
    rmSync(cache, { recursive: true, force: true });
  });

  const oracle = () =>
    new MockModelAdapter([
      {
        match: (req) => QUESTIONS.some((q) => req.messages[0]!.content.includes(`Q: ${q.question}`)),
        reply: (req) => {
          const q = QUESTIONS.find((x) => req.messages[0]!.content.includes(`Q: ${x.question}`))!;
          return q.label === "simple" && q.expected.type === "sql"
            ? { object: { sql: q.expected.value, tables: [], confidence: 0.95, needsEscalation: false, reason: "ref" } }
            : { object: { sql: "", tables: [], confidence: 0.2, needsEscalation: true, reason: "hard" } };
        },
      },
    ], "oracle");
  const careless = () =>
    new MockModelAdapter([{ match: /./, reply: { object: { sql: "SELECT 42", tables: [], confidence: 0.99, needsEscalation: false, reason: "sure" } } }], "careless");

  it("scores a perfect model at 100% and a careless one near 0 with wrong-confidence on hard", async () => {
    const r = await runBench({ engine, schemas, models: [{ name: "oracle", port: oracle() }, { name: "careless", port: careless() }], questions: QUESTIONS, runs: 2 });
    const [o, c] = r.stats;
    expect(o!.simpleAccuracy).toBe(1);
    expect(o!.wrongConfidenceRateHard).toBe(0);
    expect(o!.runAgreement).toBe(1);
    expect(c!.simpleAccuracy).toBeLessThan(0.2);
    expect(c!.wrongConfidenceRateHard).toBeGreaterThan(0.8);
    const md = renderReport(r, "test machine", { runs: 2, date: "2026-01-01" });
    expect(md.indexOf("Decision rule")).toBeLessThan(md.indexOf("Results"));
    expect(md).toContain("oracle");
  }, 120000);
});
