import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  EngineError,
  type ColumnProfile,
  type DataEnginePort,
  type FileEntry,
  type ProfileOptions,
  type QueryLimits,
  type QueryResult,
  type TableSchema,
} from "@lf/core";
import { guardSql } from "./guard.js";
import { Registry } from "./registry.js";
import { scan } from "./scan.js";
import { convertWorkbook, MAX_XLSX_BYTES } from "./xlsx.js";

export interface EngineOptions {
  cacheDir: string;
  memoryLimit?: string;
  threads?: number;
  queryTimeoutMs?: number;
  maxResultRows?: number;
  /** Rows used for CSV type detection (-1 = whole file). */
  csvSampleSize?: number;
  /** Max rows scanned when profiling a table. */
  profileSampleRows?: number;
}

const MAX_RESULT_BYTES = 20 * 1024 * 1024;
const q = (s: string) => s.replaceAll("\\", "/").replaceAll("'", "''");
const qi = (s: string) => `"${s.replaceAll('"', '""')}"`;
const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT|FLOAT|DOUBLE|DECIMAL|DATE|TIMESTAMP)/i;

export function mapDuckError(e: unknown, tables: string[] = []): EngineError {
  if (e instanceof EngineError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const first = msg.split("\n")[0] ?? msg;
  if (/INTERRUPT/i.test(msg)) return new EngineError("TIMEOUT", "The query took too long and was stopped.", "Try a narrower question or add filters.");
  if (/Parser Error/i.test(msg)) return new EngineError("SYNTAX", first, "Check the SQL syntax.");
  if (/Table with name .* does not exist|Catalog Error: .*Table/i.test(msg))
    return new EngineError("UNKNOWN_TABLE", first, tables.length ? `Available tables: ${tables.join(", ")}.` : undefined);
  if (/Referenced column|Binder Error: .*column|Column .* not found/i.test(msg))
    return new EngineError("UNKNOWN_COLUMN", first, "Check the column names in the schema.");
  if (/Permission Error|file system operations are disabled/i.test(msg))
    return new EngineError("FORBIDDEN", "That query tried to access something that is not allowed.");
  if (/Out of Memory/i.test(msg)) return new EngineError("TOO_LARGE", first, "Add filters or aggregate before returning rows.");
  return new EngineError("ENGINE", first);
}

export class DuckDbEngine implements DataEnginePort {
  private inst: DuckDBInstance | null = null;
  private conn: DuckDBConnection | null = null;
  private paths = new Map<string, string>();
  private schemas = new Map<string, TableSchema>();
  private tableKey = new Map<string, string>();
  private rowCounts = new Map<string, { n: number; exact: boolean }>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly registry: Registry;
  private readonly opt: Required<EngineOptions>;
  private dataDirs = new Set<string>();

  constructor(options: EngineOptions) {
    this.opt = {
      memoryLimit: "4GB",
      threads: 4,
      queryTimeoutMs: 30000,
      maxResultRows: 1000,
      csvSampleSize: 20480,
      profileSampleRows: 1_000_000,
      ...options,
    };
    this.registry = new Registry(this.opt.cacheDir);
  }

  /** Real path of a scanned file. For in-process adapters (the document store) only; never put it in prompts or logs. */
  pathOf(entry: FileEntry): string | undefined {
    return this.paths.get(entry.id);
  }

  async scanFolder(folder: string, opts: { depth?: 0 | 1 } = {}): Promise<FileEntry[]> {
    const { entries, paths } = await scan(folder, opts.depth ?? 0);
    for (const [k, v] of paths) this.paths.set(k, v);
    return entries;
  }

  async registerFiles(entries: FileEntry[]): Promise<TableSchema[]> {
    await this.registry.load();
    await this.closeDb();
    await mkdir(join(this.opt.cacheDir, "tmp"), { recursive: true });
    this.inst = await DuckDBInstance.create(":memory:");
    const conn = (this.conn = await this.inst.connect());
    this.schemas.clear();
    this.tableKey.clear();
    this.rowCounts.clear();
    this.dataDirs.clear();
    await conn.run(`SET memory_limit='${q(this.opt.memoryLimit)}'`);
    await conn.run(`SET threads=${this.opt.threads}`);
    await conn.run(`SET temp_directory='${q(join(this.opt.cacheDir, "tmp"))}'`);

    const out: TableSchema[] = [];
    const taken = new Set<string>();
    const add = async (alias: string, source: string, kind: "csv" | "parquet", key: string, size: number, warnings: string[]) => {
      let a = alias;
      for (let i = 2; taken.has(a); i++) a = `${alias}_${i}`;
      taken.add(a);
      const table = `t_${a}`;
      const reader =
        kind === "csv"
          ? `read_csv('${q(source)}', header=true, sample_size=${this.opt.csvSampleSize})`
          : `read_parquet('${q(source)}')`;
      await conn.run(`CREATE VIEW ${qi(table)} AS SELECT * FROM ${reader}`);
      const desc = await conn.runAndReadAll(`DESCRIBE ${qi(table)}`);
      const columns = desc.getRowObjectsJson().map((r) => ({ name: String(r.column_name), type: String(r.column_type) }));
      let n: number;
      let exact = false;
      if (kind === "parquet") {
        const c = await conn.runAndReadAll(`SELECT COUNT(*) AS n FROM ${qi(table)}`);
        n = Number(c.getRowObjectsJson()[0]!.n);
        exact = true;
      } else {
        n = await this.estimateCsvRows(source, size);
      }
      this.rowCounts.set(table, { n, exact });
      this.tableKey.set(table, key);
      const schema: TableSchema = { tableName: table, fileAlias: a, columns, rowCountEstimate: n };
      if (warnings.length) schema.warnings = warnings;
      this.schemas.set(table, schema);
      out.push(schema);
    };

    for (const e of entries) {
      const path = this.paths.get(e.id);
      if (!path) continue;
      this.dataDirs.add(dirname(path));
      const key = createHash("sha256").update(`${path}|${e.sizeBytes}|${e.modifiedAt}`).digest("hex").slice(0, 16);
      if (e.kind === "csv" || e.kind === "parquet") {
        await add(e.alias, path, e.kind, key, e.sizeBytes, []);
      } else if (e.kind === "xlsx") {
        if (e.sizeBytes > MAX_XLSX_BYTES) continue;
        const sheets = await convertWorkbook(path, this.opt.cacheDir, conn);
        for (const s of sheets) {
          await add(`${e.alias}_${snakeSheet(s.sheet)}`, s.parquetPath, "parquet", `${key}:${s.sheet}`, 0, s.warnings);
        }
      }
    }

    // Layer 1: lock the engine down now that every view exists.
    const dirs = [...this.dataDirs, this.opt.cacheDir].map((d) => `'${q(d)}'`).join(", ");
    await conn.run(`SET allowed_directories=[${dirs}]`);
    await conn.run("SET enable_external_access=false");
    await conn.run("SET lock_configuration=true");
    return out;
  }

  private async estimateCsvRows(path: string, size: number): Promise<number> {
    const { open } = await import("node:fs/promises");
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(Math.min(256 * 1024, size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n").length - 1;
      if (lines < 2) return 0;
      return Math.max(0, Math.round(size / (bytesRead / lines)) - 1);
    } finally {
      await fh.close();
    }
  }

  private requireConn(): DuckDBConnection {
    if (!this.conn) throw new EngineError("ENGINE", "No files are registered yet.", "Call registerFiles first.");
    return this.conn;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async runReadOnlySql(sql: string, limits: Partial<QueryLimits> = {}): Promise<QueryResult> {
    const conn = this.requireConn();
    const tables = [...this.schemas.keys()];
    const guarded = guardSql(sql, tables);
    const maxRows = limits.maxResultRows ?? this.opt.maxResultRows;
    const timeoutMs = limits.timeoutMs ?? this.opt.queryTimeoutMs;
    return this.exclusive(() => this.execute(conn, guarded.sql, maxRows, timeoutMs, tables, limits.signal));
  }

  private async execute(
    conn: DuckDBConnection,
    sql: string,
    maxRows: number,
    timeoutMs: number,
    tables: string[],
    signal?: AbortSignal,
  ): Promise<QueryResult> {
    const started = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      conn.interrupt();
    }, timeoutMs);
    const onAbort = () => conn.interrupt();
    signal?.addEventListener("abort", onAbort);
    try {
      if (signal?.aborted) throw new EngineError("TIMEOUT", "The query was cancelled.");
      const reader = await conn.runAndReadAll(`SELECT * FROM (\n${sql}\n) AS q LIMIT ${maxRows + 1}`);
      const names = reader.deduplicatedColumnNames();
      const types = reader.columnTypes().map((t) => t.toString());
      const all = reader.getRowsJson() as unknown[][];
      const truncated = all.length > maxRows;
      const rows = truncated ? all.slice(0, maxRows) : all;
      if (JSON.stringify(rows).length > MAX_RESULT_BYTES)
        throw new EngineError("TOO_LARGE", "The result is too large to return.", "Select fewer columns or aggregate.");
      return {
        columns: names.map((name, i) => ({ name, type: types[i] ?? "" })),
        rows,
        rowCount: rows.length,
        truncated,
        elapsedMs: Date.now() - started,
      };
    } catch (e) {
      if (timedOut) throw new EngineError("TIMEOUT", `The query took longer than ${timeoutMs} ms and was stopped.`, "Try a narrower question or add filters.");
      throw mapDuckError(e, tables);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async sampleRows(tableName: string, n: number, columns?: string[]): Promise<QueryResult> {
    const schema = this.schemas.get(tableName);
    if (!schema) throw new EngineError("UNKNOWN_TABLE", `Unknown table "${tableName}".`, `Available tables: ${[...this.schemas.keys()].join(", ")}.`);
    let cols = "*";
    if (columns?.length) {
      const known = new Set(schema.columns.map((c) => c.name));
      for (const c of columns) if (!known.has(c)) throw new EngineError("UNKNOWN_COLUMN", `Unknown column "${c}".`);
      cols = columns.map(qi).join(", ");
    }
    return this.runReadOnlySql(`SELECT ${cols} FROM ${tableName} LIMIT ${Math.max(1, Math.floor(n))}`);
  }

  async profile(tableName: string, options: ProfileOptions = {}): Promise<ColumnProfile[]> {
    const conn = this.requireConn();
    const schema = this.schemas.get(tableName);
    if (!schema) throw new EngineError("UNKNOWN_TABLE", `Unknown table "${tableName}".`);
    const sampleRows = options.sampleRows ?? this.opt.profileSampleRows;
    const key = `${this.tableKey.get(tableName)}:${tableName}:${sampleRows}`;
    const cached = this.registry.get(key)?.profile;
    if (cached) return cached;

    const total = this.rowCounts.get(tableName)?.n ?? 0;
    const sampled = total > sampleRows;
    const src = sampled ? `(SELECT * FROM ${qi(tableName)} LIMIT ${sampleRows})` : qi(tableName);
    const profiles = await this.exclusive(async () => {
      const result: ColumnProfile[] = [];
      for (const col of schema.columns) {
        const c = qi(col.name);
        const numeric = NUMERIC.test(col.type);
        const sql = `SELECT COUNT(*) AS n, COUNT(${c}) AS nn, approx_count_distinct(${c}) AS d${
          numeric ? `, MIN(${c})::VARCHAR AS mn, MAX(${c})::VARCHAR AS mx` : ""
        } FROM ${src}`;
        try {
          const r = (await conn.runAndReadAll(sql)).getRowObjectsJson()[0]!;
          const n = Number(r.n);
          const p: ColumnProfile = {
            name: col.name,
            type: col.type,
            nullFraction: n ? 1 - Number(r.nn) / n : 0,
            distinctEstimate: Number(r.d),
          };
          if (sampled) p.sampled = true;
          if (numeric && r.mn != null) {
            const asNum = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|U|FLOAT|DOUBLE|DECIMAL)/i.test(col.type);
            p.min = asNum ? Number(r.mn) : String(r.mn);
            p.max = asNum ? Number(r.mx) : String(r.mx);
          }
          if (/VARCHAR/i.test(col.type) && p.distinctEstimate <= 50 && p.distinctEstimate > 0) {
            const t = await conn.runAndReadAll(
              `SELECT ${c}::VARCHAR AS v, COUNT(*) AS k FROM ${src} WHERE ${c} IS NOT NULL GROUP BY 1 ORDER BY k DESC, v LIMIT 5`,
            );
            p.topValues = t.getRowObjectsJson().map((x) => ({ value: String(x.v), count: Number(x.k) }));
          }
          result.push(p);
        } catch (e) {
          throw mapDuckError(e);
        }
      }
      return result;
    });
    await this.registry.set(key, { profile: profiles });
    return profiles;
  }

  getSchemas(): TableSchema[] {
    return [...this.schemas.values()];
  }

  private async closeDb(): Promise<void> {
    try {
      this.conn?.closeSync();
      this.inst?.closeSync();
    } catch {
      /* already closed */
    }
    this.conn = null;
    this.inst = null;
  }

  async close(): Promise<void> {
    await this.chain;
    await this.closeDb();
  }
}

function snakeSheet(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "sheet";
}

