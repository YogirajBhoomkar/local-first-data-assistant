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
  /** Question words this table has evidence for (column names, table name, values). */
  covered: string[];
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

/** Whole-word (not substring) match: country code "us" must not match "cause". */
function wordIn(text: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(text);
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

  // Column names present in several tables (keys like policy_id, generic ones like status) say little
  // about which table a question needs, so they do not count towards table relevance.
  const nameFreq = new Map<string, number>();
  for (const s of schemas) for (const c of s.columns) nameFreq.set(c.name, (nameFreq.get(c.name) ?? 0) + 1);

  const tables: PrunedTable[] = schemas.map((s) => {
    const prof = new Map((profiles[s.tableName] ?? []).map((p) => [p.name, p]));
    const nameTokens = tokens(s.tableName.replace(/^t_/, "").replace(/_/g, " "));
    let tableScore = nameTokens.filter((t) => expanded.has(t)).length * 4;
    const covered = new Set<string>(nameTokens.filter((t) => expanded.has(t)));
    const scored: PrunedColumn[] = s.columns.map((c) => {
      const ct = tokens(c.name.replace(/_/g, " "));
      let score = ct.filter((t) => qTokens.has(t)).length * 3;
      score += ct.filter((t) => !qTokens.has(t) && expanded.has(t)).length * 2;
      const p = prof.get(c.name);
      const hits = (p?.topValues ?? []).filter((v) => v.value.length > 1 && wordIn(qLower, v.value.toLowerCase()));
      score += hits.length * 3;
      for (const t of ct) if (expanded.has(t)) covered.add(t);
      for (const h of hits) for (const t of tokens(h.value)) covered.add(t);
      if ((nameFreq.get(c.name) ?? 1) < 2) tableScore += score;
      else tableScore += hits.length * 3;
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
    return { tableName: s.tableName, columns, score: tableScore, covered: [...covered] };
  });

  // Table relevance: each question word is worth 1/(number of tables that have evidence for it),
  // so words every table shares (status, region, keys) barely matter. A table-name match adds 1.
  const df = new Map<string, number>();
  for (const t of tables) for (const w of t.covered) df.set(w, (df.get(w) ?? 0) + 1);
  for (const t of tables) {
    const nameHits = tokens(t.tableName.replace(/^t_/, "").replace(/_/g, " ")).filter((w) => expanded.has(w)).length;
    t.score = nameHits + t.covered.reduce((n, w) => n + 1 / (df.get(w) ?? 1), 0);
  }
  tables.sort((a, b) => b.score - a.score || a.tableName.localeCompare(b.tableName));
  const kept = tables.slice(0, opts.maxTables ?? 6);
  // Greedy cover: the best table, then only tables that explain a question word nobody else does.
  const needed: string[] = [];
  const seen = new Set<string>();
  for (const t of kept) {
    if (t.score <= 0) continue;
    const fresh = t.covered.filter((w) => !seen.has(w));
    if (needed.length === 0 || fresh.length > 0) {
      needed.push(t.tableName);
      for (const w of t.covered) seen.add(w);
    }
  }
  if (needed.length === 0 && kept[0]) needed.push(kept[0].tableName);
  const inScope = kept.filter((t) => needed.includes(t.tableName));
  return {
    tables: kept,
    tablesNeeded: needed,
    totalColumnsInScope: inScope.reduce((n, t) => n + t.columns.length, 0),
  };
}
