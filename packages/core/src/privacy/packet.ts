import { createHmac } from "node:crypto";
import type { ColumnProfile, EscalationPacket, EscalationPurpose, QueryResult } from "../domain/index.js";
import type { Config } from "../config/index.js";

/**
 * Pure packet builder for the privacy gate: decides exactly what may leave the machine.
 * No I/O here. The gate (packages/agent/src/gate) writes the egress log and sends.
 */

export interface SchemaInput {
  tableName: string;
  columns: { name: string; type: string }[];
  profiles?: ColumnProfile[];
  sample?: QueryResult;
}

export interface ChunkInput {
  id: string;
  fileAlias: string;
  page?: number;
  slide?: number;
  text: string;
}

export interface EscalationRequest {
  purpose: EscalationPurpose;
  question: string;
  history: { role: "user" | "assistant"; text: string }[];
  tables?: SchemaInput[];
  results?: QueryResult;
  /** Table names the results come from (for the egress record). */
  resultTables?: string[];
  chunks?: ChunkInput[];
  /** write-sql repair round: the failed SQL and the engine error (no data). */
  repair?: { sql: string[]; error: string };
}

export interface BuiltPacket {
  /** null when nothing may be sent for this request (reason in `blockedReason`). */
  packet: EscalationPacket | null;
  blockedReason?: string;
  /** Set when a big result was replaced by a locally computed summary. */
  summarized: boolean;
  /** Maps mask tokens in a model reply back to the real values. */
  unmask(text: string): string;
}

type Privacy = Config["privacy"];
const LEVEL = { schema: 0, aggregates: 1, rows: 2 } as const;
const MAX_SAMPLE_ROWS = 20;

const bytes = (o: unknown) => Buffer.byteLength(JSON.stringify(o), "utf8");
const compile = (list: string[]) => list.map((s) => new RegExp(s, "i"));
const matches = (res: RegExp[], name: string) => res.some((r) => r.test(name));

export class Masker {
  private readonly reverse = new Map<string, string>();
  constructor(private readonly key: string) {}
  token(column: string, value: unknown): string {
    const v = String(value);
    const t = "tok_" + createHmac("sha256", this.key).update(`${column}\u0000${v}`).digest("hex").slice(0, 10);
    this.reverse.set(t, v);
    return t;
  }
  unmask = (text: string): string => text.replace(/tok_[0-9a-f]{10}/g, (t) => this.reverse.get(t) ?? t);
}

function filterResult(r: QueryResult, deny: RegExp[], mask: RegExp[], masker: Masker): QueryResult {
  const keep = r.columns.map((c, i) => ({ c, i })).filter(({ c }) => !matches(deny, c.name));
  return {
    ...r,
    columns: keep.map(({ c }) => c),
    rows: r.rows.map((row) =>
      keep.map(({ c, i }) => (matches(mask, c.name) && row[i] !== null ? masker.token(c.name, row[i]) : row[i])),
    ),
  };
}

function summarize(r: QueryResult): unknown {
  const cols = r.columns.map((c, i) => {
    const vals = r.rows.map((row) => row[i]).filter((v) => v !== null && v !== undefined);
    const nums = vals.map((v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN));
    if (vals.length && nums.every((n) => !isNaN(n))) {
      const sum = nums.reduce((a, b) => a + b, 0);
      return { column: c.name, kind: "numeric", count: vals.length, sum, min: Math.min(...nums), max: Math.max(...nums), avg: sum / vals.length };
    }
    const counts = new Map<string, number>();
    for (const v of vals) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    return { column: c.name, kind: "text", count: vals.length, distinct: counts.size, top: top.map(([value, n]) => ({ value, n })) };
  });
  // Aggregate the first numeric column by the first low-cardinality text column.
  const dim = cols.findIndex((c) => c.kind === "text" && (c as { distinct: number }).distinct <= 20);
  const meas = cols.findIndex((c) => c.kind === "numeric");
  let byDimension: unknown;
  if (dim >= 0 && meas >= 0) {
    const sums = new Map<string, number>();
    for (const row of r.rows) {
      const n = Number(row[meas]);
      if (!isNaN(n)) sums.set(String(row[dim]), (sums.get(String(row[dim])) ?? 0) + n);
    }
    byDimension = { dimension: r.columns[dim]!.name, measure: r.columns[meas]!.name, sums: Object.fromEntries(sums) };
  }
  return { rowCount: r.rowCount, truncatedLocally: r.truncated, columns: cols, byDimension };
}

export function buildPacket(req: EscalationRequest, privacy: Privacy, maskKey: string): BuiltPacket {
  const deny = compile(privacy.denyColumns);
  const mask = compile(privacy.maskColumns);
  const masker = new Masker(maskKey);
  const level = LEVEL[privacy.tabularLevel];
  const blocked = (reason: string): BuiltPacket => ({ packet: null, blockedReason: reason, summarized: false, unmask: masker.unmask });

  let payload: Record<string, unknown> = { question: req.question, history: req.history.map((h) => ({ role: h.role, text: h.text })) };
  const tables: string[] = [];
  const columns: string[] = [];
  let rowCount = 0;
  let summarized = false;
  let summary: string;

  if (req.purpose === "write-sql") {
    const out = (req.tables ?? []).map((t) => {
      tables.push(t.tableName);
      const cols = t.columns.filter((c) => !matches(deny, c.name));
      for (const c of cols) columns.push(`${t.tableName}.${c.name}`);
      const profByName = new Map((t.profiles ?? []).map((p) => [p.name, p]));
      const entry: Record<string, unknown> = {
        table: t.tableName,
        columns: cols.map((c) => {
          const col: Record<string, unknown> = { name: c.name, type: c.type };
          const p = profByName.get(c.name);
          if (level >= LEVEL.aggregates && p) {
            const masked = matches(mask, c.name);
            col.profile = {
              nullFraction: p.nullFraction,
              distinct: p.distinctEstimate,
              ...(masked ? {} : { min: p.min, max: p.max }),
              ...(p.topValues ? { top: p.topValues.map((v) => (masked ? masker.token(c.name, v.value) : v.value)) } : {}),
            };
          }
          return col;
        }),
      };
      if (level >= LEVEL.rows && t.sample) {
        const s = filterResult({ ...t.sample, rows: t.sample.rows.slice(0, MAX_SAMPLE_ROWS) }, deny, mask, masker);
        entry.sampleRows = { columns: s.columns.map((c) => c.name), rows: s.rows };
        rowCount += s.rows.length;
      }
      return entry;
    });
    payload = { ...payload, tables: out, ...(req.repair ? { repair: req.repair } : {}) };
    summary = `schema for ${tables.join(", ")}${level >= LEVEL.aggregates ? " + column profiles" : ""}${level >= LEVEL.rows ? " + sample rows" : ""}`;
  } else if (req.purpose === "answer-from-results") {
    if (level < LEVEL.rows) return blocked("privacy level does not allow sending values");
    if (!req.results) return blocked("no results to send");
    const r = filterResult(req.results, deny, mask, masker);
    tables.push(...(req.resultTables ?? []));
    for (const c of r.columns) columns.push(c.name);
    const rowsPayload = { columns: r.columns.map((c) => c.name), rows: r.rows };
    if (r.rowCount > privacy.maxRowsSent || bytes(rowsPayload) > privacy.maxBytesSent) {
      payload = { ...payload, summary: summarize(r) };
      summarized = true;
      rowCount = 0;
      summary = `locally computed summary of a ${r.rowCount}-row result (too large to send as rows)`;
    } else {
      payload = { ...payload, result: rowsPayload };
      rowCount = r.rowCount;
      summary = `${r.rowCount} result rows, ${r.columns.length} columns`;
    }
  } else {
    const chunks = (req.chunks ?? []).slice(0, privacy.docTopK);
    const out: { ref: string; text: string }[] = [];
    let chars = 0;
    for (const c of chunks) {
      const room = privacy.docMaxChars - chars;
      if (room <= 0) break;
      const text = c.text.length > room ? c.text.slice(0, room) : c.text;
      chars += text.length;
      const loc = c.page !== undefined ? `p${c.page}` : c.slide !== undefined ? `slide${c.slide}` : "";
      out.push({ ref: `${c.fileAlias}${loc ? " " + loc : ""}`, text });
      tables.push(c.fileAlias);
    }
    // Mixed questions (documents + tables): schema only, never values.
    const schemaOnly = (req.tables ?? []).map((t) => ({
      table: t.tableName,
      columns: t.columns.filter((c) => !matches(deny, c.name)).map((c) => ({ name: c.name, type: c.type })),
    }));
    for (const t of req.tables ?? []) tables.push(t.tableName);
    payload = { ...payload, chunks: out, ...(schemaOnly.length ? { tables: schemaOnly } : {}) };
    rowCount = out.length;
    summary = `${out.length} document chunks, ${chars} characters`;
  }

  const packet: EscalationPacket = {
    purpose: req.purpose,
    payload,
    summary,
    tables: [...new Set(tables)],
    columns,
    rowCount,
    byteSize: bytes(payload),
  };
  return { packet, summarized, unmask: masker.unmask };
}
