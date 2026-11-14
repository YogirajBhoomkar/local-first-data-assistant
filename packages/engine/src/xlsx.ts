import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import ExcelJS from "exceljs";
import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * Excel handling (Option B): read each sheet with exceljs, write a temporary CSV, and COPY it to
 * Parquet in cacheDir. The DuckDB excel extension works but is auto-installed from the internet
 * on first use, which corporate laptops often block. exceljs is pure JS and fully offline.
 * Note: exceljs' streaming reader failed on our own generated files (see phase-1 notes), so the
 * workbook is loaded in memory. Fine for typical workbooks; very large ones are skipped with a warning.
 */

export const MAX_XLSX_BYTES = 150 * 1024 * 1024;

export interface ConvertedSheet {
  sheet: string;
  parquetPath: string;
  warnings: string[];
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().replace(/T00:00:00\.000Z$/, "").replace(/\.000Z$/, "");
  if (typeof v === "object") {
    if ("result" in v) return cellText((v as { result?: ExcelJS.CellValue }).result ?? null);
    if ("richText" in v) return (v as { richText: { text: string }[] }).richText.map((r) => r.text).join("");
    if ("text" in v) return String((v as { text: unknown }).text);
    if ("error" in v) return "";
    return "";
  }
  return String(v);
}

const csvField = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function detectSheetWarnings(rows: string[][], hasMerges: boolean): string[] {
  const warnings: string[] = [];
  const widths = rows.map((r) => r.filter((c) => c !== "").length);
  const max = Math.max(0, ...widths);
  if (rows.length && max > 1 && widths[0]! <= max / 2)
    warnings.push("This sheet has a title row above the header; results may be wrong.");
  if (hasMerges) warnings.push("This sheet has merged cells; values in merged areas may be missing.");
  if (rows.length) {
    const cols = Math.max(...rows.map((r) => r.length));
    let empty = 0;
    for (let c = 0; c < cols; c++) if (rows.every((r) => (r[c] ?? "") === "")) empty++;
    if (cols > 0 && empty / cols > 0.5) warnings.push("More than half of this sheet's columns are empty.");
  }
  return warnings;
}

export function workbookKey(path: string, size: number, mtimeMs: number): string {
  return createHash("sha256").update(`${path}|${size}|${mtimeMs}`).digest("hex").slice(0, 16);
}

export async function convertWorkbook(
  path: string,
  cacheDir: string,
  conn: DuckDBConnection,
): Promise<ConvertedSheet[]> {
  const info = await stat(path);
  if (info.size > MAX_XLSX_BYTES) {
    throw new Error(`Workbook is larger than ${MAX_XLSX_BYTES / 1024 / 1024} MB; convert it to CSV or Parquet first.`);
  }
  const key = workbookKey(path, info.size, info.mtimeMs);
  const dir = join(cacheDir, "xlsx", key);
  await mkdir(dir, { recursive: true });
  const metaPath = join(dir, "meta.json");
  try {
    const cached = JSON.parse(await readFile(metaPath, "utf8")) as ConvertedSheet[];
    for (const c of cached) await access(c.parquetPath);
    return cached;
  } catch {
    /* not cached yet */
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const out: ConvertedSheet[] = [];
  let n = 0;
  for (const ws of wb.worksheets) {
    n++;
    const width = ws.columnCount;
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const r: string[] = [];
      for (let c = 1; c <= width; c++) {
        const cell = row.getCell(c);
        // Merged cells repeat the master value; keep it only in the master cell.
        r.push(cell.isMerged && cell.master.address !== cell.address ? "" : cellText(cell.value));
      }
      rows.push(r);
    });
    if (rows.length === 0) continue;
    const merges = (ws.model as { merges?: string[] }).merges ?? [];
    const warnings = detectSheetWarnings(rows, merges.length > 0);

    // Header: use row 1; blank or duplicate names become col_N.
    const seen = new Set<string>();
    rows[0] = rows[0]!.map((h, i) => {
      let name = h.trim() || `col_${i + 1}`;
      while (seen.has(name.toLowerCase())) name += "_";
      seen.add(name.toLowerCase());
      return name;
    });
    const csvPath = join(dir, `sheet${n}.csv`);
    const stream = createWriteStream(csvPath, { encoding: "utf8" });
    for (const r of rows) if (!stream.write(r.map(csvField).join(",") + "\n")) await once(stream, "drain");
    stream.end();
    await once(stream, "finish");

    const parquetPath = join(dir, `sheet${n}.parquet`).replaceAll("\\", "/");
    const q = (s: string) => s.replaceAll("\\", "/").replaceAll("'", "''");
    await conn.run(
      `COPY (SELECT * FROM read_csv('${q(csvPath)}', header=true, sample_size=-1)) TO '${q(parquetPath)}' (FORMAT PARQUET)`,
    );
    await rm(csvPath, { force: true });
    out.push({ sheet: ws.name, parquetPath, warnings });
  }
  await writeFile(metaPath, JSON.stringify(out));
  return out;
}
