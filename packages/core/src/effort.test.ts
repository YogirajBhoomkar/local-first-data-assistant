import { describe, expect, it } from "vitest";
import { describeEffort, estimateEffort, loadConfig, type EffortInput } from "./index.js";

const cfg = loadConfig({}).routing;
const base = (q: string, o: Partial<EffortInput> = {}): EffortInput => ({
  question: q, tablesNeeded: 1, columnsInScope: 8, ambiguousTables: [], maxColumnsLocal: cfg.maxColumnsLocal, escalateKeywords: cfg.escalateKeywords, ...o,
});
const est = (q: string, o: Partial<EffortInput> = {}) => estimateEffort(base(q, o), cfg.effort);

describe("estimateEffort", () => {
  it("a plain single-table lookup is low effort with no signals", () => {
    const e = est("How many policies are there?");
    expect(e).toMatchObject({ level: "low", score: 0, signals: [] });
    expect(describeEffort(e)).toMatch(/plain single-table lookup/);
  });
  it("a reasoning word makes it high effort on its own", () => {
    const e = est("Why is premium higher in some regions?");
    expect(e.level).toBe("high");
    expect(e.signals[0]).toMatchObject({ name: "reasoning-word" });
  });
  it("two tables means high effort", () => expect(est("paid claims by policy region", { tablesNeeded: 2 }).level).toBe("high"));
  it("near-tied tables mean high effort (a small model may pick the wrong one)", () => {
    const e = est("What is the total premium?", { ambiguousTables: ["t_budget_plan", "t_policies"] });
    expect(e.level).toBe("high");
    expect(e.signals.map((s) => s.name)).toContain("ambiguous-table");
  });
  it("period logic alone is medium effort", () => {
    const e = est("How many claims were paid compared to last year?");
    expect(e.level).toBe("medium");
    expect(e.score).toBe(1.5);
  });
  it("a ratio is a small signal that stays low", () => expect(est("What share of claims are open?").level).toBe("low"));
  it("a wide schema adds effort", () => expect(est("list things", { columnsInScope: 60 }).signals.map((s) => s.name)).toContain("wide-schema"));
  it("an unsure classifier adds effort; a confident join/explain type adds a lot", () => {
    expect(est("show it", { classification: { type: "lookup", confidence: 0.3 } }).signals.map((s) => s.name)).toContain("unsure-type");
    expect(est("show it", { classification: { type: "join", confidence: 0.9 } }).level).toBe("high");
    expect(est("show it", { classification: { type: "aggregate", confidence: 0.9 } }).level).toBe("low");
  });
  it("decision-model signals add weighted points", () => {
    const hi = est("show the figures", { decision: { needsReasoning: 0.9, multiStep: 0.8 } });
    expect(hi.level).toBe("high");
    expect(hi.signals.map((s) => s.name)).toEqual(expect.arrayContaining(["laya-reasoning", "laya-multi-step"]));
    expect(est("show the figures", { decision: { needsReasoning: 0.05, multiStep: 0.1 } }).level).toBe("low");
    expect(est("show the figures", { decision: { effort: { label: "medium", confidence: 1 } } }).level).toBe("medium");
  });
  it("every point is explained by a signal and the score is their sum", () => {
    const e = est("Why did claims rise compared to last year?", { ambiguousTables: ["t_x"] });
    expect(e.score).toBeCloseTo(e.signals.reduce((n, s) => n + s.points, 0), 2);
    expect(e.signals.every((s) => s.note.length > 5)).toBe(true);
  });
  it("thresholds are configurable", () => {
    const strict = estimateEffort(base("How many claims were paid compared to last year?"), { mediumAt: 1, highAt: 1.4 });
    expect(strict.level).toBe("high");
  });
});
