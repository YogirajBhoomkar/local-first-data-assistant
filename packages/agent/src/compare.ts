import type { QueryResult } from "@lf/core";

const TOL = 1e-6;

function cellEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = typeof a === "number" || (typeof a === "string" && a.trim() !== "" && !isNaN(Number(a))) ? Number(a) : NaN;
  const nb = typeof b === "number" || (typeof b === "string" && b.trim() !== "" && !isNaN(Number(b))) ? Number(b) : NaN;
  if (!isNaN(na) && !isNaN(nb)) return Math.abs(na - nb) <= TOL * Math.max(1, Math.abs(na), Math.abs(nb));
  return String(a) === String(b);
}

const rowKey = (r: unknown[]) =>
  r
    .map((c) => {
      const n = typeof c === "number" || (typeof c === "string" && c.trim() !== "" && !isNaN(Number(c))) ? Number(c) : NaN;
      return isNaN(n) ? `s:${String(c)}` : `n:${n.toPrecision(9)}`;
    })
    .join("|");

/** Compare two result sets. Order-insensitive unless `ordered` (the question asks for an order). */
export function resultsMatch(expected: QueryResult, actual: QueryResult, ordered = false): boolean {
  if (expected.rowCount !== actual.rowCount) return false;
  if (expected.columns.length !== actual.columns.length) return false;
  const e = [...expected.rows];
  const a = [...actual.rows];
  if (!ordered) {
    e.sort((x, y) => rowKey(x).localeCompare(rowKey(y)));
    a.sort((x, y) => rowKey(x).localeCompare(rowKey(y)));
  }
  return e.every((row, i) => row.length === a[i]!.length && row.every((c, j) => cellEq(c, a[i]![j])));
}

export const isOrdered = (referenceSql: string) => /\border\s+by\b/i.test(referenceSql);
