import type { GenerateRequest } from "@lf/core";
import type { PruneResult } from "../pruning.js";

export interface LocalSqlOutput {
  sql: string;
  tables: string[];
  confidence: number;
  needsEscalation: boolean;
  reason: string;
}

export const LOCAL_SQL_SCHEMA = {
  type: "object",
  properties: {
    sql: { type: "string" },
    tables: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    needsEscalation: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["sql", "tables", "confidence", "needsEscalation", "reason"],
} as const;

// Short on purpose: small models do worse with long prompts.
const SYSTEM = `You write one DuckDB SQL query (SELECT only) that answers the question, using ONLY the tables and columns listed.
Reply with JSON: {"sql","tables","confidence","needsEscalation","reason"}.
- confidence: 0 to 1, how sure you are the query answers the question.
- needsEscalation: true if the question needs a join you cannot do, reasoning/explanation, forecasting, or the columns do not exist.
- If needsEscalation is true, sql may be an empty string.

Examples:
Q: How many shipments are delayed?
{"sql":"SELECT COUNT(*) FROM t_shipments WHERE status = 'delayed'","tables":["t_shipments"],"confidence":0.95,"needsEscalation":false,"reason":"single filter and count"}
Q: Total revenue per city, top 3
{"sql":"SELECT city, SUM(revenue) AS total FROM t_sales GROUP BY city ORDER BY total DESC LIMIT 3","tables":["t_sales"],"confidence":0.9,"needsEscalation":false,"reason":"group by with top N"}
Q: Why did costs rise last year?
{"sql":"","tables":[],"confidence":0.2,"needsEscalation":true,"reason":"needs explanation, not a lookup"}`;

export function renderSchema(pruned: PruneResult): string {
  return pruned.tables
    .filter((t) => pruned.tablesNeeded.includes(t.tableName))
    .map((t) => {
      const cols = t.columns
        .map((c) => `${c.name} ${c.type}${c.topValues?.length ? ` [${c.topValues.slice(0, 4).join(", ")}]` : ""}`)
        .join("; ");
      return `${t.tableName}(${cols})`;
    })
    .join("\n");
}

export function buildLocalSqlRequest(
  question: string,
  pruned: PruneResult,
  opts: { temperature?: number; previousError?: string; maxTokens?: number; history?: { role: "user" | "assistant"; text: string }[] } = {},
): GenerateRequest {
  const err = opts.previousError ? `\nYour previous query failed: ${opts.previousError}\nFix it.` : "";
  const past = opts.history ?? [];
  const hist = past.length
    ? `Earlier in this chat:\n${past.map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.text.slice(0, 200)}`).join("\n")}\n\n`
    : "";
  return {
    system: SYSTEM,
    messages: [{ role: "user", content: `${hist}Tables:\n${renderSchema(pruned)}\n\nQ: ${question}${err}` }],
    responseSchema: LOCAL_SQL_SCHEMA as unknown as Record<string, unknown>,
    temperature: opts.temperature ?? 0,
    maxTokens: opts.maxTokens ?? 400,
  };
}

export function parseLocalSql(obj: unknown): LocalSqlOutput | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.sql !== "string" || typeof o.confidence !== "number" || typeof o.needsEscalation !== "boolean") return null;
  return {
    sql: o.sql,
    tables: Array.isArray(o.tables) ? o.tables.map(String) : [],
    confidence: o.confidence,
    needsEscalation: o.needsEscalation,
    reason: typeof o.reason === "string" ? o.reason : "",
  };
}
