import { createHash } from "node:crypto";
import type { Config, QueryResult } from "../index.js";
import type { Classification, QuestionClassifier, QuestionType } from "../ports/agent.js";

type RoutingCfg = Config["routing"];

export interface HardRuleInput {
  question: string;
  tablesNeeded: number;
  columnsInScope: number;
}

/** Layer 1: policy. Is a remote model usable at all? */
export function remoteAvailable(config: Config): boolean {
  const r = config.remoteModel;
  return r.enabled && !!r.baseUrl && !!r.model && !!r.apiKey;
}

/** Layer 2: hard rules, no model involved. */
export function hardRules(i: HardRuleInput, cfg: RoutingCfg): { escalate: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (i.tablesNeeded > cfg.maxFilesLocal) reasons.push(`needs ${i.tablesNeeded} tables (local limit ${cfg.maxFilesLocal})`);
  if (i.columnsInScope > cfg.maxColumnsLocal) reasons.push(`${i.columnsInScope} columns in scope (local limit ${cfg.maxColumnsLocal})`);
  const q = i.question.toLowerCase();
  for (const k of cfg.escalateKeywords) {
    if (new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(q)) reasons.push(`keyword "${k}"`);
  }
  return { escalate: reasons.length > 0, reasons };
}

/** Layer 3 (rules only): keyword-based question typing. */
export class RuleClassifier implements QuestionClassifier {
  async classify(question: string): Promise<Classification> {
    const q = question.toLowerCase();
    const has = (re: RegExp) => re.test(q);
    let type: QuestionType = "other";
    let confidence = 0.7;
    if (has(/\b(why|explain|because|reason|root cause|insight|forecast|predict|recommend)\b/)) type = "explain";
    else if (has(/\b(join|combined with|together with|across)\b/)) type = "join";
    else if (has(/\b(chart|plot|graph|visuali[sz]e)\b/)) type = "chart";
    else if (has(/\b(top|bottom|highest|lowest|largest|smallest|most|least)\b/) && has(/\b\d+\b|\btop\b/)) type = "topn";
    else if (has(/\b(per|by|each|breakdown)\b/)) type = "groupby";
    else if (has(/\b(how many|count|total|sum|average|avg|mean|maximum|minimum|max|min|number of)\b/)) type = "aggregate";
    else if (has(/\b(where|only|with status|filter|in the)\b/)) type = "filter";
    else if (has(/\b(show|list|what is|which|find|get)\b/)) type = "lookup";
    else confidence = 0.4;
    return { type, confidence };
  }
}

/** Placeholder for a small decision model (for example Laya) that may be evaluated later. Not installed. */
export class DecisionModelClassifier implements QuestionClassifier {
  async classify(): Promise<Classification> {
    throw new Error("DecisionModelClassifier is a stub: no decision model is installed yet.");
  }
}

export function routeForType(type: QuestionType, cfg: RoutingCfg): "local" | "remote" {
  return cfg.typeRoutes[type] ?? cfg.typeRoutes.other ?? "remote";
}

export interface VerifyInput {
  result: QueryResult | null;
  confidence: number;
  minConfidence: number;
}

/** Layer 5 checks. The SQL passing the guard, running and finishing in time is implied by `result` being set. */
export function verifyResult(i: VerifyInput): string[] {
  const failures: string[] = [];
  if (!i.result) return ["query did not run successfully"];
  if (i.result.rowCount < 1) failures.push("query returned no rows");
  else if (i.result.rows.every((r) => r.every((c) => c === null))) failures.push("result is all null");
  if (i.confidence < i.minConfidence) failures.push(`low model confidence (${i.confidence.toFixed(2)})`);
  return failures;
}

/** Hash of the sorted rows, for the agreement check. */
export function resultHash(r: QueryResult): string {
  const norm = r.rows.map((row) => JSON.stringify(row.map((c) => (typeof c === "number" ? +c.toPrecision(9) : isNumericString(c) ? +Number(c).toPrecision(9) : c))));
  norm.sort();
  return createHash("sha256").update(norm.join("\n")).digest("hex").slice(0, 16);
}
const isNumericString = (c: unknown): c is string => typeof c === "string" && c.trim() !== "" && !isNaN(Number(c));
