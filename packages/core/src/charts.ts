import type { ChartSpec, QueryResult } from "./domain/index.js";

const isNum = (t: string) => /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT|FLOAT|DOUBLE|DECIMAL)/i.test(t);
const isDate = (t: string) => /^(DATE|TIMESTAMP)/i.test(t);

function looksNumeric(r: QueryResult, i: number): boolean {
  if (isNum(r.columns[i]!.type)) return true;
  const vals = r.rows.map((x) => x[i]).filter((v) => v !== null && v !== undefined);
  return vals.length > 0 && vals.every((v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))));
}

/** Deterministic chart choice from the result shape. */
export function chooseChart(result: QueryResult, question: string): ChartSpec {
  const title = question.trim().replace(/\?+$/, "").slice(0, 80);
  const table: ChartSpec = { type: "table", title };
  const cols = result.columns;
  if (result.rowCount < 2 || cols.length < 2 || result.rowCount > 200) return table;

  const idx = cols.map((_, i) => i);
  const dateCols = idx.filter((i) => isDate(cols[i]!.type));
  const numCols = idx.filter((i) => !dateCols.includes(i) && looksNumeric(result, i));
  const catCols = idx.filter((i) => !dateCols.includes(i) && !numCols.includes(i));

  if (dateCols.length >= 1 && numCols.length >= 1)
    return { type: "line", x: cols[dateCols[0]!]!.name, y: cols[numCols[0]!]!.name, title };
  if (catCols.length === 1 && numCols.length === 1) {
    const wantsShare = /\b(share|proportion|percent|percentage|split|breakdown)\b/i.test(question);
    const x = cols[catCols[0]!]!.name;
    const y = cols[numCols[0]!]!.name;
    if (wantsShare && result.rowCount <= 6) return { type: "pie", x, y, title };
    return { type: "bar", x, y, title };
  }
  if (catCols.length === 2 && numCols.length === 1)
    return { type: "bar", x: cols[catCols[0]!]!.name, y: cols[numCols[0]!]!.name, series: cols[catCols[1]!]!.name, title };
  if (catCols.length === 0 && numCols.length >= 2 && dateCols.length === 0)
    return { type: "scatter", x: cols[numCols[0]!]!.name, y: cols[numCols[1]!]!.name, title };
  if (catCols.length === 1 && numCols.length > 1)
    return { type: "bar", x: cols[catCols[0]!]!.name, y: cols[numCols[0]!]!.name, title };
  return table;
}
