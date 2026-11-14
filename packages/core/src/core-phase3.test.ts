import { describe, expect, it } from "vitest";
import {
  buildPacket, chooseChart, hardRules, loadConfig, remoteAvailable, resultHash, RuleClassifier,
  routeForType, verifyResult, DecisionModelClassifier, type QueryResult,
} from "./index.js";

const cfg = loadConfig({});
const qr = (cols: [string, string][], rows: unknown[][], truncated = false): QueryResult => ({
  columns: cols.map(([name, type]) => ({ name, type })), rows, rowCount: rows.length, truncated, elapsedMs: 1,
});

describe("router layers", () => {
  it("policy: remote needs enabled, url, model and key", () => {
    expect(remoteAvailable(cfg)).toBe(false);
    const c = loadConfig({ LF_REMOTE_BASE_URL: "https://x", LF_REMOTE_MODEL: "m", LF_REMOTE_API_KEY: "k" });
    expect(remoteAvailable(c)).toBe(true);
    expect(remoteAvailable(loadConfig({ LF_REMOTE_BASE_URL: "https://x", LF_REMOTE_MODEL: "m", LF_REMOTE_API_KEY: "k" }, { remoteModel: { enabled: false } }))).toBe(false);
  });
  it("hard rules: simple stays local", () => expect(hardRules({ question: "How many policies?", tablesNeeded: 1, columnsInScope: 10 }, cfg.routing).escalate).toBe(false));
  it("hard rules: join (two tables) escalates", () => {
    const r = hardRules({ question: "paid claims by region", tablesNeeded: 2, columnsInScope: 10 }, cfg.routing);
    expect(r.escalate).toBe(true);
    expect(r.reasons[0]).toMatch(/2 tables/);
  });
  it("hard rules: keywords escalate, whole words only", () => {
    expect(hardRules({ question: "Why is premium up?", tablesNeeded: 1, columnsInScope: 5 }, cfg.routing).reasons).toContain('keyword "why"');
    expect(hardRules({ question: "Show whyte region", tablesNeeded: 1, columnsInScope: 5 }, cfg.routing).escalate).toBe(false);
  });
  it("hard rules: too many columns", () =>
    expect(hardRules({ question: "x y", tablesNeeded: 1, columnsInScope: 41 }, cfg.routing).escalate).toBe(true));
  it("rule classifier types questions and typeRoutes route them", async () => {
    const c = new RuleClassifier();
    expect((await c.classify("How many open claims?")).type).toBe("aggregate");
    expect((await c.classify("Top 5 brokers by premium")).type).toBe("topn");
    expect((await c.classify("premium per region")).type).toBe("groupby");
    expect((await c.classify("Explain the spike")).type).toBe("explain");
    expect(routeForType("aggregate", cfg.routing)).toBe("local");
    expect(routeForType("join", cfg.routing)).toBe("remote");
    expect(routeForType("other", cfg.routing)).toBe("remote");
  });
  it("decision model classifier is only a stub", async () => {
    await expect(new DecisionModelClassifier().classify()).rejects.toThrow(/stub/);
  });
  it("verify: failures are reported with reasons", () => {
    expect(verifyResult({ result: qr([["n", "BIGINT"]], [[5]]), confidence: 0.9, minConfidence: 0.6 })).toEqual([]);
    expect(verifyResult({ result: qr([["n", "BIGINT"]], []), confidence: 0.9, minConfidence: 0.6 })[0]).toMatch(/no rows/);
    expect(verifyResult({ result: qr([["n", "BIGINT"]], [[null]]), confidence: 0.9, minConfidence: 0.6 })[0]).toMatch(/all null/);
    expect(verifyResult({ result: qr([["n", "BIGINT"]], [[1]]), confidence: 0.4, minConfidence: 0.6 })[0]).toMatch(/low model confidence/);
    expect(verifyResult({ result: null, confidence: 1, minConfidence: 0.6 })).toHaveLength(1);
  });
  it("resultHash ignores row order and numeric formatting", () => {
    expect(resultHash(qr([["a", "T"], ["b", "T"]], [["x", 1], ["y", 2]]))).toBe(resultHash(qr([["a", "T"], ["b", "T"]], [["y", "2"], ["x", 1.0]])));
    expect(resultHash(qr([["a", "T"]], [[1]]))).not.toBe(resultHash(qr([["a", "T"]], [[2]])));
  });
});

describe("chooseChart", () => {
  it("dates -> line", () =>
    expect(chooseChart(qr([["d", "DATE"], ["n", "BIGINT"]], [["2024-01-01", 1], ["2024-01-02", 2]]), "claims by day")).toMatchObject({ type: "line", x: "d", y: "n" }));
  it("one category + one number -> bar", () =>
    expect(chooseChart(qr([["region", "VARCHAR"], ["n", "BIGINT"]], [["A", 1], ["B", 2], ["C", 3]]), "policies per region").type).toBe("bar"));
  it("pie only when <= 6 slices and the question asks for share", () => {
    const small = qr([["r", "VARCHAR"], ["n", "BIGINT"]], [["A", 1], ["B", 2]]);
    expect(chooseChart(small, "share of policies by region").type).toBe("pie");
    expect(chooseChart(small, "policies by region").type).toBe("bar");
    const big = qr([["r", "VARCHAR"], ["n", "BIGINT"]], Array.from({ length: 8 }, (_, i) => [`r${i}`, i]));
    expect(chooseChart(big, "share of policies by region").type).toBe("bar");
  });
  it("single value or no rows -> table", () => {
    expect(chooseChart(qr([["n", "BIGINT"]], [[5]]), "how many").type).toBe("table");
    expect(chooseChart(qr([["n", "BIGINT"], ["m", "BIGINT"]], []), "x").type).toBe("table");
  });
  it("two numbers -> scatter; numeric strings count as numbers", () => {
    expect(chooseChart(qr([["a", "DOUBLE"], ["b", "DOUBLE"]], [[1, 2], [3, 4]]), "a vs b").type).toBe("scatter");
    expect(chooseChart(qr([["r", "VARCHAR"], ["n", "VARCHAR"]], [["A", "1"], ["B", "2"]]), "x").type).toBe("bar");
  });
  it("very long results -> table", () =>
    expect(chooseChart(qr([["r", "VARCHAR"], ["n", "BIGINT"]], Array.from({ length: 300 }, (_, i) => [`r${i}`, i])), "x").type).toBe("table"));
});

describe("buildPacket (privacy rules)", () => {
  const priv = (o: Record<string, unknown> = {}) => loadConfig({}, { privacy: o }).privacy;
  const schema = [{
    tableName: "t_policies",
    columns: [{ name: "policy_id", type: "VARCHAR" }, { name: "broker_code", type: "VARCHAR" }, { name: "premium", type: "DOUBLE" }, { name: "ssn", type: "VARCHAR" }],
    profiles: [{ name: "broker_code", type: "VARCHAR", nullFraction: 0, distinctEstimate: 2, topValues: [{ value: "BRK-001", count: 3 }] }, { name: "premium", type: "DOUBLE", nullFraction: 0, distinctEstimate: 9, min: 1, max: 9 }],
    sample: qr([["policy_id", "VARCHAR"], ["broker_code", "VARCHAR"], ["premium", "DOUBLE"], ["ssn", "VARCHAR"]], [["P1", "BRK-001", 5, "123"]]),
  }];
  const base = { question: "q", history: [] };

  it("write-sql at level schema sends only names and types", () => {
    const b = buildPacket({ ...base, purpose: "write-sql", tables: schema }, priv({ tabularLevel: "schema" }), "k");
    const s = JSON.stringify(b.packet!.payload);
    expect(s).toContain("premium");
    expect(s).not.toContain("BRK-001");
    expect(s).not.toContain("sampleRows");
    expect(s).not.toContain("profile");
  });
  it("aggregates adds profiles, rows adds up to 20 sample rows", () => {
    const a = JSON.stringify(buildPacket({ ...base, purpose: "write-sql", tables: schema }, priv({ tabularLevel: "aggregates" }), "k").packet!.payload);
    expect(a).toContain("BRK-001");
    expect(a).not.toContain("sampleRows");
    const r = JSON.stringify(buildPacket({ ...base, purpose: "write-sql", tables: schema }, priv({ tabularLevel: "rows" }), "k").packet!.payload);
    expect(r).toContain("sampleRows");
  });
  it("deny columns are removed everywhere", () => {
    const b = buildPacket({ ...base, purpose: "write-sql", tables: schema }, priv({ denyColumns: ["^ssn$"] }), "k");
    expect(JSON.stringify(b.packet!.payload)).not.toMatch(/ssn|123/);
    expect(b.packet!.columns).not.toContain("t_policies.ssn");
  });
  it("mask columns become stable tokens and map back locally", () => {
    const p = priv({ maskColumns: ["broker"] });
    const a = buildPacket({ ...base, purpose: "write-sql", tables: schema }, p, "key1");
    const b = buildPacket({ ...base, purpose: "write-sql", tables: schema }, p, "key1");
    const c = buildPacket({ ...base, purpose: "write-sql", tables: schema }, p, "key2");
    const sa = JSON.stringify(a.packet!.payload);
    expect(sa).not.toContain("BRK-001");
    expect(sa).toBe(JSON.stringify(b.packet!.payload));
    expect(sa).not.toBe(JSON.stringify(c.packet!.payload));
    const tok = /tok_[0-9a-f]{10}/.exec(sa)![0];
    expect(a.unmask(`Broker ${tok} is largest`)).toBe("Broker BRK-001 is largest");
  });
  it("answer-from-results is blocked below rows level", () => {
    const b = buildPacket({ ...base, purpose: "answer-from-results", results: qr([["n", "BIGINT"]], [[1]]) }, priv({ tabularLevel: "aggregates" }), "k");
    expect(b.packet).toBeNull();
    expect(b.blockedReason).toMatch(/does not allow/);
  });
  it("answer-from-results sends rows when small, with deny/mask applied", () => {
    const res = qr([["broker_code", "VARCHAR"], ["ssn", "VARCHAR"], ["n", "BIGINT"]], [["BRK-001", "9", 5]]);
    const b = buildPacket({ ...base, purpose: "answer-from-results", results: res }, priv({ denyColumns: ["ssn"], maskColumns: ["broker"] }), "k");
    const s = JSON.stringify(b.packet!.payload);
    expect(s).not.toContain("BRK-001");
    expect(s).not.toContain("ssn");
    expect(b.summarized).toBe(false);
    expect(b.packet!.rowCount).toBe(1);
  });
  it("a 100k-row result never produces a packet over the limits", () => {
    const rows = Array.from({ length: 100_000 }, (_, i) => [`r${i % 7}`, i]);
    const res = qr([["region", "VARCHAR"], ["n", "BIGINT"]], rows);
    const p = priv({ maxRowsSent: 500, maxBytesSent: 200000 });
    const b = buildPacket({ ...base, purpose: "answer-from-results", results: res }, p, "k");
    expect(b.summarized).toBe(true);
    expect(b.packet!.byteSize).toBeLessThanOrEqual(p.maxBytesSent);
    expect(b.packet!.rowCount).toBeLessThanOrEqual(p.maxRowsSent);
    expect(JSON.stringify(b.packet!.payload)).toContain("byDimension");
  });
  it("byte cap alone triggers the summary", () => {
    const rows = Array.from({ length: 50 }, (_, i) => [`a long string value number ${i}`.repeat(5), i]);
    const b = buildPacket({ ...base, purpose: "answer-from-results", results: qr([["s", "VARCHAR"], ["n", "BIGINT"]], rows) }, priv({ maxBytesSent: 1000 }), "k");
    expect(b.summarized).toBe(true);
  });
  it("answer-from-chunks caps chunk count and characters and never sends file names", () => {
    const chunks = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, fileAlias: "guidelines", page: i + 1, text: "x".repeat(5000) }));
    const p = priv({ docTopK: 6, docMaxChars: 12000 });
    const b = buildPacket({ ...base, purpose: "answer-from-chunks", chunks }, p, "k");
    const sent = (b.packet!.payload as { chunks: { text: string }[] }).chunks;
    expect(sent.length).toBeLessThanOrEqual(6);
    expect(sent.reduce((n, c) => n + c.text.length, 0)).toBeLessThanOrEqual(12000);
  });
});
