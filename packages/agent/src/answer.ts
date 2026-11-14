import type { ChatModelPort, QueryResult, TableSchema } from "@lf/core";

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return "no value";
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : NaN;
  if (!isNaN(n)) return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return String(v);
};
const humanize = (s: string) => s.replace(/_/g, " ");

/** Deterministic answer used when there is no local model or it fails. */
export function templateAnswer(result: QueryResult): string {
  if (result.rowCount === 0) return "The query returned no rows.";
  if (result.rowCount === 1 && result.columns.length === 1) return `${humanize(result.columns[0]!.name)}: ${fmt(result.rows[0]![0])}.`;
  if (result.rowCount === 1)
    return result.columns.map((c, i) => `${humanize(c.name)}: ${fmt(result.rows[0]![i])}`).join("; ") + ".";
  const shown = result.rows.slice(0, 3).map((r) => r.map(fmt).join(" - "));
  return `Found ${result.rowCount}${result.truncated ? "+" : ""} rows (${result.columns.map((c) => humanize(c.name)).join(", ")}). First: ${shown.join("; ")}.`;
}

/** Local model writes 1-3 sentences from the result; falls back to the template. */
export async function localAnswer(model: ChatModelPort | null, question: string, result: QueryResult): Promise<string> {
  if (!model) return templateAnswer(result);
  try {
    const rows = result.rows.slice(0, 20).map((r) => r.map(fmt).join(" | "));
    const r = await model.generate({
      system: "Answer the question in 1 to 3 plain sentences using ONLY the numbers and values in the result. Do not invent anything.",
      messages: [{ role: "user", content: `Question: ${question}\nColumns: ${result.columns.map((c) => c.name).join(" | ")}\nRows (${result.rowCount} total):\n${rows.join("\n")}` }],
      temperature: 0.1,
      maxTokens: 200,
    });
    const t = r.text?.trim();
    return t ? t : templateAnswer(result);
  } catch {
    return templateAnswer(result);
  }
}

const tid = (s: TableSchema) => s.fileAlias.replace(/_/g, " ");

/** Follow-ups that are valid by construction (only real tables and columns). */
export function deterministicFollowUps(tables: TableSchema[]): string[] {
  const out: string[] = [];
  for (const t of tables.slice(0, 2)) {
    out.push(`How many rows are in ${tid(t)}?`);
    const text = t.columns.find((c) => /^VARCHAR/i.test(c.type) && !/_id$|^id$/i.test(c.name));
    const num = t.columns.find((c) => /^(INTEGER|BIGINT|DOUBLE|DECIMAL|FLOAT)/i.test(c.type));
    if (text && num) out.push(`What is the total ${humanize(num.name)} by ${humanize(text.name)}?`);
    else if (text) out.push(`What are the most common ${humanize(text.name)} values in ${tid(t)}?`);
  }
  return out.slice(0, 3);
}

/** Local model suggests follow-ups; items mentioning unknown t_ tables are dropped. */
export async function suggestFollowUps(
  model: ChatModelPort | null,
  question: string,
  tables: TableSchema[],
): Promise<string[]> {
  const fallback = deterministicFollowUps(tables);
  if (!model) return fallback;
  try {
    const known = new Set(tables.map((t) => t.tableName.toLowerCase()));
    const colNames = tables.map((t) => `${t.fileAlias}(${t.columns.map((c) => c.name).join(", ")})`).join("\n");
    const r = await model.generate({
      system: 'Suggest up to 3 short follow-up questions a user could ask about their data. Use only the tables and columns listed. Reply with JSON: {"items": ["...", "..."]}.',
      messages: [{ role: "user", content: `Tables:\n${colNames}\nThe user just asked: ${question}` }],
      responseSchema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"] },
      temperature: 0.4,
      maxTokens: 150,
    });
    const items = ((r.object as { items?: unknown })?.items ?? []) as unknown[];
    const ok = items
      .filter((x): x is string => typeof x === "string" && x.trim().length > 5)
      .filter((x) => (x.toLowerCase().match(/\bt_[a-z0-9_]+/g) ?? []).every((t) => known.has(t)))
      .slice(0, 3);
    return ok.length ? ok : fallback;
  } catch {
    return fallback;
  }
}
