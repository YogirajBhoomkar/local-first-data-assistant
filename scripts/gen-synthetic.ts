import { createWriteStream, mkdirSync } from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import { parquetWriteFile } from "hyparquet-writer";

// All data is invented. Deterministic for a given seed.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseSize(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB)$/i.exec(s.trim());
  if (!m) throw new Error(`Invalid --size "${s}", use e.g. 50MB or 2GB`);
  const unit = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2]!.toUpperCase() as "KB" | "MB" | "GB"];
  return Math.round(parseFloat(m[1]!) * unit);
}

const LOBS = ["Property", "Marine", "Casualty", "Energy", "Aviation", "Cyber"];
const REGIONS = ["EMEA", "APAC", "AMER", "LATAM"];
const CURRENCIES = ["USD", "EUR", "GBP", "JPY"];
const STATUSES = ["active", "expired", "cancelled", "pending"];
const CAUSES = ["fire", "flood", "windstorm", "theft", "collision", "cyber incident", "liability"];
const CLAIM_STATUSES = ["open", "closed", "reopened"];
const COUNTRIES = ["DE", "FR", "GB", "US", "BR", "JP", "SG", "AU", "ZA", "CA"];
const PERILS = ["fire", "flood", "earthquake", "windstorm", "terror"];
const BYTES_PER_POLICY = 140; // approx row size
const BYTES_PER_CLAIM = 85;
const CLAIMS_PER_POLICY = 0.6;
const MAX_EXPOSURE_ROWS = 400_000; // parquet writer builds the file in memory

const pick = <T>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
const day = (n: number) => new Date(Date.UTC(2018, 0, 1) + n * 86400000).toISOString().slice(0, 10);
const money = (r: () => number, scale: number) => (Math.round(r() * scale * 100) / 100).toFixed(2);

async function writeLines(path: string, header: string, count: number, row: (i: number) => string) {
  const out = createWriteStream(path, { encoding: "utf8" });
  out.write(header + "\n");
  for (let i = 0; i < count; i++) {
    if (!out.write(row(i) + "\n")) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");
}

export interface GenOptions {
  outDir: string;
  sizeBytes: number;
  seed: number;
}

export async function generate({ outDir, sizeBytes, seed }: GenOptions) {
  mkdirSync(outDir, { recursive: true });
  const r = mulberry32(seed);
  const policyCount = Math.max(
    20,
    Math.floor(sizeBytes / (BYTES_PER_POLICY + CLAIMS_PER_POLICY * BYTES_PER_CLAIM)),
  );
  const claimCount = Math.floor(policyCount * CLAIMS_PER_POLICY);
  const pid = (i: number) => `POL-${String(i + 1).padStart(8, "0")}`;

  await writeLines(
    resolve(outDir, "policies.csv"),
    "policy_id,line_of_business,region,inception_date,expiry_date,currency,limit_amount,premium_amount,broker_code,status",
    policyCount,
    (i) => {
      const start = Math.floor(r() * 2500);
      return [
        pid(i),
        pick(r, LOBS),
        pick(r, REGIONS),
        day(start),
        day(start + 365),
        pick(r, CURRENCIES),
        money(r, 5_000_000),
        money(r, 80_000),
        `BRK-${String(1 + Math.floor(r() * 120)).padStart(3, "0")}`,
        pick(r, STATUSES),
      ].join(",");
    },
  );

  await writeLines(
    resolve(outDir, "claims.csv"),
    "claim_id,policy_id,loss_date,reported_date,cause,paid_amount,reserve_amount,status",
    claimCount,
    (i) => {
      const loss = Math.floor(r() * 2800);
      return [
        `CLM-${String(i + 1).padStart(8, "0")}`,
        pid(Math.floor(r() * policyCount)),
        day(loss),
        day(loss + Math.floor(r() * 60)),
        pick(r, CAUSES),
        money(r, 200_000),
        money(r, 100_000),
        pick(r, CLAIM_STATUSES),
      ].join(",");
    },
  );

  const expN = Math.min(policyCount, MAX_EXPOSURE_ROWS);
  parquetWriteFile({
    filename: resolve(outDir, "exposures.parquet"),
    columnData: [
      { name: "policy_id", data: Array.from({ length: expN }, (_, i) => pid(i)), type: "STRING" },
      { name: "country_code", data: Array.from({ length: expN }, () => pick(r, COUNTRIES)), type: "STRING" },
      { name: "peril", data: Array.from({ length: expN }, () => pick(r, PERILS)), type: "STRING" },
      { name: "insured_value", data: Array.from({ length: expN }, () => Math.round(r() * 9_000_000)), type: "DOUBLE" },
    ],
  });

  // Clean workbook: plan and actuals sheets.
  const wb = new ExcelJS.Workbook();
  for (const name of ["plan", "actuals"]) {
    const ws = wb.addWorksheet(name);
    ws.addRow(["month", "line_of_business", "region", "premium"]);
    for (let m = 1; m <= 12; m++)
      for (const lob of LOBS.slice(0, 3))
        ws.addRow([`2024-${String(m).padStart(2, "0")}`, lob, pick(r, REGIONS), Math.round(r() * 900_000)]);
  }
  await wb.xlsx.writeFile(resolve(outDir, "budget.xlsx"));

  // Messy workbook: title row above header + a merged cell.
  const mb = new ExcelJS.Workbook();
  const ms = mb.addWorksheet("summary");
  ms.addRow(["Quarterly summary (synthetic)"]);
  ms.mergeCells("A1:C1");
  ms.addRow([]);
  ms.addRow(["region", "gross_premium", "claims_paid"]);
  for (const reg of REGIONS) ms.addRow([reg, Math.round(r() * 1e6), Math.round(r() * 4e5)]);
  await mb.xlsx.writeFile(resolve(outDir, "messy.xlsx"));

  return { policyCount, claimCount, exposureRows: expN };
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

if (process.argv[1]?.endsWith("gen-synthetic.ts")) {
  const opts = {
    outDir: resolve(arg("out", "./sample-data")),
    sizeBytes: parseSize(arg("size", "5MB")),
    seed: Number(arg("seed", "42")),
  };
  const res = await generate(opts);
  console.log(`Generated into ${opts.outDir}:`, res);
}
