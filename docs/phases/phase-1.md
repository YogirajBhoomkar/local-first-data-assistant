# Phase 1 — Local data engine (DuckDB)

## Built
- `core/ports/data-engine.ts`: `DataEnginePort`, `EngineError` (codes SYNTAX, UNKNOWN_TABLE, UNKNOWN_COLUMN, FORBIDDEN, TIMEOUT, TOO_LARGE, ENGINE with `hint`), `QueryLimits`.
- `packages/engine`: `DuckDbEngine` (scan, register, profile, guarded SQL, sample rows), `guardSql` tokenizer-based guard, XLSX converter, JSON registry cache.
- CLI: `files`, `schema`, `sql` (`--folder`, `--deep`).
- `scripts/perf-engine.ts` -> `eval/reports/engine-perf.md`.

## DuckDB findings (STEP 0)
- Client: `@duckdb/node-api` 2.0.0-r.1 (DuckDB v2.0.0). `DuckDBInstance.create(":memory:")`, `instance.connect()`, `conn.runAndReadAll(sql)` then `getRowsJson()` / `deduplicatedColumnNames()` / `columnTypes()`. `conn.interrupt()` exists and is used for timeouts and cancellation.
- Settings `enable_external_access`, `allowed_directories`, `allowed_paths`, `lock_configuration`, `temp_directory`, `memory_limit`, `threads` all exist. Verified: after views are created, `allowed_directories` + `enable_external_access=false` + `lock_configuration=true` still lets the views read their files, blocks reading any other file, and rejects any later `SET`.
- Excel: the `excel` extension is NOT built in. `read_xlsx` worked here only because DuckDB auto-installed the extension from the internet. That fails on offline or locked-down laptops.

## Excel choice
Option B: **exceljs** reads each sheet (`workbook.xlsx.readFile`), writes a temp CSV, and DuckDB `COPY`s it to Parquet in `cacheDir/xlsx/<key>/`, cached by path+size+mtime. Why: fully offline, pure JS, exposes merged cells. Trade-offs: exceljs' *streaming* reader crashed on our own generated files (`this.model` undefined), so the workbook is loaded in memory; workbooks over 150 MB are skipped. Option A (bundled extension file) was not tested offline; revisit if big workbooks matter.
Messy-sheet detection (warnings on the `TableSchema`): title row above the header, merged cells, more than half of columns empty. Merged non-master cells are blanked so the title row is detectable. The sheet is registered as-is (header = row 1, blank names become `col_N`).

## Guard design
Two layers, as specified.
1. Engine settings after all views exist: memory limit, threads, `temp_directory` in cacheDir, `allowed_directories` (data folders + cacheDir), `enable_external_access=false`, `lock_configuration=true`.
2. `guardSql` (packages/engine/src/guard.ts). `node-sql-parser` has no DuckDB dialect, so it is a careful tokenizer (strings, quoted identifiers, comments, `$$` refused). Checks: one statement (one trailing `;` allowed), starts with SELECT/WITH, forbidden keywords and function names (incl. prefixes `read_`, `duckdb_`, `pragma_`, `http…`) outside string literals, string literal after FROM/JOIN refused (replacement scans like `FROM 'a.csv'`), table functions refused, every table after FROM/JOIN/comma must be a registered `t_` name or a CTE name, no schema prefix. `EXTRACT(.. FROM ..)`, `SUBSTRING(.. FROM ..)` and `IS DISTINCT FROM` are not treated as table references.
Limits: query wrapped as `SELECT * FROM (<sql>) LIMIT maxRows+1` (sets `truncated`), timeout via `interrupt()`, caller `AbortSignal`, result capped at 20 MB (TOO_LARGE), queries serialised on one connection so an interrupt never hits another query.
Known limits of the guard: unquoted column names that equal a forbidden word (`comment`, `set`, `use`, `show`...) are rejected; quote them. LATERAL/unnest in FROM are rejected as table functions.
38 guard tests + 12 engine tests.

## Profiling
Per column: null fraction, `approx_count_distinct`, min/max for numeric and date types, top 5 values for text columns with <=50 distinct. Tables bigger than `profileSampleRows` (default 1,000,000) are profiled on the first N rows and flagged `sampled`. Cached in `cacheDir/registry.json`. Row count: exact for Parquet, estimated from file size for CSV.

## Differences from the prompt
- `ColumnProfile` gained an optional `sampled` flag.
- XLSX sheets are registered as `t_<file>_<sheet>`.

## Performance
Run on the 50 MB synthetic set only (all six queries 130-300 ms, peak RSS ~180 MB; see `eval/reports/engine-perf.md`). The 2-5 GB run was **not done** at the owner's request (a ~1 GB real file will be provided later). To run it: `npm run gen:data -- --size 3GB --out ./sample-big` then `npx tsx scripts/perf-engine.ts ./sample-big`. Note: generating 3 GB takes well over 10 minutes (row-by-row string building).

## Known gaps
- CSV views are re-scanned on every query (no Parquet conversion yet).
- Row estimate for CSV is approximate.
