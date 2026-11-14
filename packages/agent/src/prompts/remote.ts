import type { EscalationPacket, GenerateRequest } from "@lf/core";

// Prompts for the remote model. They state clearly that the model sees a schema or results,
// never the user's files. Only the privacy gate calls these.

export interface RemoteSqlOutput {
  sql: string[];
  explanation: string;
}

export const REMOTE_SQL_SCHEMA = {
  type: "object",
  properties: {
    sql: { type: "array", items: { type: "string" }, maxItems: 3 },
    explanation: { type: "string" },
  },
  required: ["sql", "explanation"],
} as const;

const SQL_SYSTEM = `You write DuckDB SQL for a data assistant. You are given a schema (table and column names, types, sometimes column profiles or a few sample rows). You do NOT have the data files.
Write up to 3 read-only SELECT queries that together answer the question. Use only the tables and columns listed. Tokens like tok_ab12cd34ef are masked values: use them as they appear.
If "repair" is present, your previous SQL failed with the given error: fix it.
Reply with JSON: {"sql": ["SELECT ..."], "explanation": "one sentence"}.`;

const ANSWER_SYSTEM = `You answer a business question using ONLY the query results or summary provided. You do not have the underlying files.
Be concise and concrete (2 to 5 sentences). If the data does not support an answer, say so. Keep any tokens like tok_ab12cd34ef exactly as written.`;

const CHUNKS_SYSTEM = `You answer a question using ONLY the document excerpts provided (each has a reference). You do not have the full documents.
Cite references in square brackets, for example [guidelines p3]. If the excerpts do not contain the answer, say so.`;

export function buildRemoteRequest(packet: EscalationPacket, maxTokens = 800): GenerateRequest {
  const user = JSON.stringify(packet.payload);
  if (packet.purpose === "write-sql")
    return {
      system: SQL_SYSTEM,
      messages: [{ role: "user", content: user }],
      responseSchema: REMOTE_SQL_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0,
      maxTokens,
    };
  return {
    system: packet.purpose === "answer-from-chunks" ? CHUNKS_SYSTEM : ANSWER_SYSTEM,
    messages: [{ role: "user", content: user }],
    temperature: 0.2,
    maxTokens,
  };
}

export function parseRemoteSql(obj: unknown): RemoteSqlOutput | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const sql = Array.isArray(o.sql) ? o.sql.filter((s): s is string => typeof s === "string" && s.trim() !== "") : typeof o.sql === "string" ? [o.sql] : null;
  if (!sql || sql.length === 0) return null;
  return { sql: sql.slice(0, 3), explanation: typeof o.explanation === "string" ? o.explanation : "" };
}
