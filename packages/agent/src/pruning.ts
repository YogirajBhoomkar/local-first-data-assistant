import type { ColumnProfile, TableSchema } from "@lf/core";

export interface PrunedColumn {
  name: string;
  type: string;
  topValues?: string[];
  score: number;
}
export interface PrunedTable {
  tableName: string;
  columns: PrunedColumn[];
  score: number;
}
export interface PruneResult {
  tables: PrunedTable[];
  /** Tables with any evidence of relevance to the question (at least one, the best). */
  tablesNeeded: string[];
  totalColumnsInScope: number;
}

export interface PruneOptions {
  synonyms?: Record<string, string[]>;
  maxColumnsPerTable?: number;
  minColumnsPerTable?: number;
  /** How many tables to keep in the output at most. */
  maxTables?: number;
}

export function stem(w: string): string {
  let s = w.toLowerCase();
  for (const suf of ["ies", "ing", "ed", "es", "ly", "s"]) {
    if (s.length > suf.length + 2 && s.endsWith(suf)) {
      s = suf === "ies" ? s.slice(0, -3) + "y" : s.slice(0, -suf.length);
      break;
    }
  }
  return s;
}

export const tokens = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem).filter((t) => t.length > 1);

const isIdOrDate = (c: { name: string; type: string }) =>
  /(^id$|_id$|_date$|^date$|_at$)/i.test(c.name) || /^(DATE|TIMESTAMP)/i.test(c.type);

/** Deterministic: scores columns by name, synonym and value overlap with the question. */
export function pruneSchema(
  question: string,
  schemas: TableSchema[],
  profiles: Record<string, ColumnProfile[]> = {},
  opts: PruneOptions = {},
): PruneResult {
  const maxCols = opts.maxColumnsPerTable ?? 12;
  const minCols = opts.minColumnsPerTable ?? 5;
  const qTokens = new Set(tokens(question));
  const qLower = question.toLowerCase();
  const syn = new Map<string, Set<string>>();
  for (const [k, list] of Object.entries(opts.synonyms ?? {})) {
    const key = stem(k);
    const set = syn.get(key) ?? new Set<string>();
    for (const w of list) set.add(stem(w));
    syn.set(key, set);
  }
  // A question word that is a synonym of key K also counts as K.
  const expanded = new Set(qTokens);
  for (const [key, set] of syn) for (const t of qTokens) if (set.has(t)) expanded.add(key);

  const tables: PrunedTable[] = schemas.map((s) => {
    const prof = new Map((profiles[s.tableName] ?? []).map((p) => [p.name, p]));
    const nameTokens = tokens(s.tableName.replace(/^t_/, "").replace(/_/g, " "));
    let tableScore = nameTokens.filter((t) => expanded.has(t)).length * 2;
    const scored: PrunedColumn[] = s.columns.map((c) => {
      const ct = tokens(c.name.replace(/_/g, " "));
      let score = ct.filter((t) => qTokens.has(t)).length * 3;
      score += ct.filter((t) => !qTokens.has(t) && expanded.has(t)).length * 2;
      const p = prof.get(c.name);
      const hits = (p?.topValues ?? []).filter((v) => v.value.length > 1 && qLower.includes(v.value.toLowerCase()));
      score += hits.length * 3;
      tableScore += score;
      const col: PrunedColumn = { name: c.name, type: c.type, score };
      if (p?.topValues?.length) col.topValues = p.topValues.map((v) => v.value);
      return col;
    });
    const keep = new Map<string, PrunedColumn>();
    for (const c of scored) if (isIdOrDate(c)) keep.set(c.name, c);
    const ranked = scored.filter((c) => !keep.has(c.name)).sort((a, b) => b.score - a.score);
    for (const c of ranked) {
      if (keep.size >= maxCols) break;
      if (c.score > 0 || keep.size < minCols) keep.set(c.name, c);
    }
    // restore original column order
    const order = new Map(s.columns.map((c, i) => [c.name, i]));
    const columns = [...keep.values()].sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
    return { tableName: s.tableName, columns, score: tableScore };
  });

  tables.sort((a, b) => b.score - a.score || a.tableName.localeCompare(b.tableName));
  const kept = tables.slice(0, opts.maxTables ?? 6);
  const needed = kept.filter((t) => t.score > 0).map((t) => t.tableName);
  if (needed.length === 0 && kept[0]) needed.push(kept[0].tableName);
  const inScope = kept.filter((t) => needed.includes(t.tableName));
  return {
    tables: kept,
    tablesNeeded: needed,
    totalColumnsInScope: inScope.reduce((n, t) => n + t.columns.length, 0),
  };
}
