import { EngineError } from "@lf/core";

/**
 * Layer 2 of the read-only SQL guard: a statement check before execution.
 *
 * node-sql-parser has no DuckDB dialect, so this is a small tokenizer that respects
 * string literals, quoted identifiers and comments. It is deliberately strict: anything it
 * cannot classify as a plain read-only SELECT over registered tables is rejected.
 */

type Tok =
  | { t: "word"; v: string } // unquoted identifier or keyword, lower-cased
  | { t: "qid"; v: string } // "quoted identifier"
  | { t: "str"; v: string }
  | { t: "num"; v: string }
  | { t: "p"; v: string; pos: number }; // punctuation / operator char

const FORBIDDEN_WORDS = new Set([
  "insert", "update", "delete", "create", "drop", "alter", "copy", "attach", "detach",
  "install", "load", "pragma", "set", "reset", "call", "export", "import", "checkpoint",
  "vacuum", "truncate", "replace", "merge", "grant", "revoke", "use", "begin", "commit",
  "rollback", "analyze", "describe", "show", "summarize", "explain", "prepare", "execute",
  "deallocate", "force", "comment", "read_csv", "read_csv_auto", "read_parquet", "read_json",
  "read_json_auto", "read_ndjson", "read_text", "read_blob", "read_xlsx", "glob", "query",
  "query_table", "getenv", "current_setting", "sniff_csv", "which_secret",
]);
const FORBIDDEN_PREFIXES = [
  "read_", "scan_", "parquet_", "csv_", "json_each", "duckdb_", "pragma_", "http", "iceberg_",
  "delta_", "sqlite_", "postgres_", "mysql_", "st_read", "glob",
];
// FROM inside these function calls is not a table reference (EXTRACT(year FROM d)).
const FROM_IN_FUNCTION = new Set(["extract", "substring", "trim", "overlay", "position", "date_part"]);
// Keywords that end a FROM list.
const FROM_END = new Set([
  "where", "group", "order", "having", "limit", "offset", "union", "intersect", "except",
  "window", "qualify", "fetch", "sample", "using", "on",
]);

function fail(code: "SYNTAX" | "FORBIDDEN" | "UNKNOWN_TABLE", message: string, hint?: string): never {
  throw new EngineError(code, message, hint);
}

export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) fail("SYNTAX", "Unterminated comment.");
      i = end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let v = "";
      for (;;) {
        if (j >= n) fail("SYNTAX", c === "'" ? "Unterminated string literal." : "Unterminated quoted identifier.");
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            v += c;
            j += 2;
            continue;
          }
          break;
        }
        v += sql[j];
        j++;
      }
      out.push({ t: c === "'" ? "str" : "qid", v });
      i = j + 1;
    } else if (c === "$" && /[$A-Za-z_]/.test(sql[i + 1] ?? "")) {
      // Dollar-quoted strings are not needed for read-only questions; refuse rather than parse.
      fail("FORBIDDEN", "Dollar-quoted strings are not allowed.");
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      out.push({ t: "word", v: sql.slice(i, j).toLowerCase() });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9._eE]/.test(sql[j]!)) j++;
      out.push({ t: "num", v: sql.slice(i, j) });
      i = j;
    } else {
      out.push({ t: "p", v: c, pos: i });
      i++;
    }
  }
  return out;
}

export interface GuardResult {
  /** The single statement without trailing semicolon, comments preserved as written. */
  sql: string;
  tables: string[];
}

export function guardSql(sql: string, registeredTables: Iterable<string>): GuardResult {
  const registered = new Set([...registeredTables].map((t) => t.toLowerCase()));
  const toks = tokenize(sql);

  // Exactly one statement: allow one trailing semicolon only.
  const semi = toks.map((t, i) => (t.t === "p" && t.v === ";" ? i : -1)).filter((i) => i >= 0);
  if (semi.length > 1 || (semi.length === 1 && semi[0] !== toks.length - 1)) {
    fail("FORBIDDEN", "Only one statement is allowed.", "Remove extra statements after the semicolon.");
  }
  let cutAt = sql.length;
  if (semi.length === 1) {
    const last = toks.pop()!;
    if (last.t === "p") cutAt = last.pos;
  }
  if (toks.length === 0) fail("SYNTAX", "Empty query.");

  const first = toks[0]!;
  if (!(first.t === "word" && (first.v === "select" || first.v === "with"))) {
    fail("FORBIDDEN", "Only SELECT queries are allowed.", "Start the query with SELECT or WITH.");
  }

  // CTE names: identifiers before `AS (` (optionally with a column list or MATERIALIZED).
  const cteNames = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i]!;
    if (tk.t !== "word" || tk.v !== "as") continue;
    let j = i + 1;
    if (toks[j]?.t === "word" && toks[j]!.v === "not") j++;
    if (toks[j]?.t === "word" && toks[j]!.v === "materialized") j++;
    if (!(toks[j]?.t === "p" && toks[j]!.v === "(")) continue;
    let k = i - 1;
    if (toks[k]?.t === "p" && toks[k]!.v === ")") {
      let depth = 0;
      for (; k >= 0; k--) {
        const x = toks[k]!;
        if (x.t === "p" && x.v === ")") depth++;
        else if (x.t === "p" && x.v === "(" && --depth === 0) break;
      }
      k--;
    }
    const nm = toks[k];
    if (nm && (nm.t === "word" || nm.t === "qid")) cteNames.add(nm.v.toLowerCase());
  }

  const used = new Set<string>();
  // Paren stack: whether FROM inside this paren is a function-internal FROM, and the FROM-list state.
  const stack: { fnFrom: boolean; inFrom: boolean }[] = [{ fnFrom: false, inFrom: false }];
  const top = () => stack[stack.length - 1]!;
  let expectTable = false;

  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i]!;
    const prev = toks[i - 1];

    if (tk.t === "word") {
      const w = tk.v;
      if (FORBIDDEN_WORDS.has(w) || FORBIDDEN_PREFIXES.some((p) => w.startsWith(p))) {
        // `replace(` / `left(` style scalar functions are fine; statement REPLACE is not reachable
        // because the first word must be SELECT or WITH.
        const isScalarCall = w === "replace" && toks[i + 1]?.t === "p" && toks[i + 1]!.v === "(";
        if (!isScalarCall) fail("FORBIDDEN", `"${w}" is not allowed in a read-only query.`, "Use only SELECT over the provided tables.");
      }
    }

    if (expectTable) {
      expectTable = false;
      if (tk.t === "p" && tk.v === "(") {
        // subquery or parenthesised join: handled by the normal flow
      } else if (tk.t === "str") {
        fail("FORBIDDEN", "Reading files directly is not allowed.", "Query the provided t_ tables.");
      } else if (tk.t === "word" || tk.t === "qid") {
        const next = toks[i + 1];
        if (next?.t === "p" && (next.v === "(" || next.v === ".")) {
          fail(next.v === "(" ? "FORBIDDEN" : "UNKNOWN_TABLE",
            next.v === "(" ? "Table functions are not allowed." : `Unknown table "${tk.v}.…".`,
            "Use only the provided t_ tables, without a schema prefix.");
        }
        const name = tk.v.toLowerCase();
        if (!registered.has(name) && !cteNames.has(name)) {
          fail("UNKNOWN_TABLE", `Unknown table "${tk.v}".`, `Available tables: ${[...registered].join(", ") || "(none)"}.`);
        }
        if (registered.has(name)) used.add(name);
      }
    }

    if (tk.t === "p") {
      if (tk.v === "(") {
        const fn = prev?.t === "word" && FROM_IN_FUNCTION.has(prev.v);
        stack.push({ fnFrom: !!fn, inFrom: false });
      } else if (tk.v === ")") {
        if (stack.length > 1) stack.pop();
      } else if (tk.v === "," && top().inFrom) {
        expectTable = true;
      }
    } else if (tk.t === "word") {
      const w = tk.v;
      if (w === "from") {
        const afterDistinct = prev?.t === "word" && prev.v === "distinct";
        if (!top().fnFrom && !afterDistinct) {
          top().inFrom = true;
          expectTable = true;
        }
      } else if (w === "join") {
        expectTable = true;
        top().inFrom = true;
      } else if (FROM_END.has(w) && w !== "on" && w !== "using") {
        top().inFrom = false;
      } else if (w === "select") {
        top().inFrom = false;
      }
    }
  }

  // Strip the trailing semicolon from the original text for execution.
  const text = sql.slice(0, cutAt).trim();
  return { sql: text, tables: [...used] };
}
