import type { Classification } from "../ports/agent.js";

/**
 * Effort estimate: how much work a question needs. It drives both where the question runs and how hard the
 * local answer is checked:
 *   low    -> local, one generation (cheap checks)
 *   medium -> local, the answer must be reproduced by a second generation
 *   high   -> remote right away (a small local model would only waste time and then fail)
 * Every signal is recorded with its points so the decision can be shown and explained.
 */

export type EffortLevel = "low" | "medium" | "high";

export interface EffortSignal {
  name: string;
  points: number;
  note: string;
}

export interface EffortEstimate {
  level: EffortLevel;
  score: number;
  signals: EffortSignal[];
}

/** What a decision model such as Laya says about the question (all optional). */
export interface DecisionSignals {
  /** probability that answering needs explanation, reasoning or recommendations */
  needsReasoning?: number;
  /** probability that several dependent steps are needed (not one SELECT) */
  multiStep?: number;
  /** probability that the wording is ambiguous or underspecified */
  ambiguous?: number;
  /** the model's own effort label and how sure it is */
  effort?: { label: EffortLevel; confidence: number };
}

export interface EffortInput {
  question: string;
  tablesNeeded: number;
  columnsInScope: number;
  /** other tables that match the question about as well as the chosen one */
  ambiguousTables: string[];
  classification?: Classification | null;
  decision?: DecisionSignals | null;
  maxColumnsLocal: number;
  escalateKeywords: string[];
}

export interface EffortThresholds {
  mediumAt: number;
  highAt: number;
}

const PERIOD = /\b(versus|vs\.?|compared? (to|with)|year[- ]over[- ]year|month[- ]over[- ]month|growth|change since|between \d{4}|last (year|quarter|month)|previous (year|quarter|month)|days? between|difference between|quarter(ly)? (over|on) quarter)\b/i;
const MULTI = /\b(ratio|percentage of|percent of|share of|divided by|relative to|per (policy|claim|broker) (and|then)|and then|as well as|for each .* (and|then)|rank(ed)?|rolling|cumulative|running total)\b/i;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function estimateEffort(i: EffortInput, t: EffortThresholds): EffortEstimate {
  const signals: EffortSignal[] = [];
  const add = (name: string, points: number, note: string) => {
    if (points > 0) signals.push({ name, points: Math.round(points * 100) / 100, note });
  };
  const q = i.question.toLowerCase();

  for (const k of i.escalateKeywords) {
    if (new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(q)) {
      add("reasoning-word", 3, `the word "${k}" asks for reasoning, not a lookup`);
      break;
    }
  }
  if (i.tablesNeeded >= 2) add("several-tables", 3, `needs ${i.tablesNeeded} tables joined together`);
  if (i.columnsInScope > i.maxColumnsLocal) add("wide-schema", 2, `${i.columnsInScope} columns in scope (limit ${i.maxColumnsLocal})`);
  if (i.ambiguousTables.length > 0) add("ambiguous-table", 3, `several tables could answer this (${i.ambiguousTables.join(", ")}): a small model may pick the wrong one`);
  if (PERIOD.test(i.question)) add("period-logic", 1.5, "compares periods or computes date differences");
  if (MULTI.test(i.question)) add("multi-step", 1, "a ratio or several dependent steps");
  if (i.question.split(/\s+/).length > 25) add("long-question", 0.5, "a long, detailed question");

  const c = i.classification;
  if (c && c.confidence >= 0.5) {
    if (c.type === "join" || c.type === "explain" || c.type === "other") add("question-type", 3, `classified as "${c.type}"`);
    else if (c.type === "topn" || c.type === "groupby" || c.type === "chart") add("question-type", 0.5, `classified as "${c.type}"`);
  } else if (c) {
    add("unsure-type", 1.5, `the classifier is unsure (${c.confidence.toFixed(2)})`);
  }

  const d = i.decision;
  if (d) {
    if (d.needsReasoning !== undefined) add("laya-reasoning", 3 * clamp01(d.needsReasoning), `Laya: ${(d.needsReasoning * 100).toFixed(0)}% likely to need reasoning`);
    if (d.multiStep !== undefined) add("laya-multi-step", 1.5 * clamp01(d.multiStep), `Laya: ${(d.multiStep * 100).toFixed(0)}% likely to need several steps`);
    if (d.ambiguous !== undefined) add("laya-ambiguous", 1.5 * clamp01(d.ambiguous), `Laya: ${(d.ambiguous * 100).toFixed(0)}% likely ambiguous`);
    if (d.effort) {
      const pts = d.effort.label === "high" ? 3 : d.effort.label === "medium" ? 1.5 : 0;
      add("laya-effort", pts * clamp01(d.effort.confidence), `Laya rates the effort "${d.effort.label}" (${(d.effort.confidence * 100).toFixed(0)}% sure)`);
    }
  }

  const score = Math.round(signals.reduce((n, s) => n + s.points, 0) * 100) / 100;
  const level: EffortLevel = score >= t.highAt ? "high" : score >= t.mediumAt ? "medium" : "low";
  return { level, score, signals };
}

export function describeEffort(e: EffortEstimate): string {
  if (e.signals.length === 0) return "a plain single-table lookup";
  return e.signals.map((s) => s.note).join("; ");
}
