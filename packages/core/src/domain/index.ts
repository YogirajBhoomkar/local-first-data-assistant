export type FileKind = "csv" | "xlsx" | "parquet" | "pdf" | "pptx" | "other";

export interface FileEntry {
  id: string;
  alias: string;
  kind: FileKind;
  sizeBytes: number;
  modifiedAt: string;
  sheet?: string;
}

export interface TableSchema {
  tableName: string;
  fileAlias: string;
  columns: { name: string; type: string }[];
  rowCountEstimate: number;
  warnings?: string[];
}

export interface ColumnProfile {
  name: string;
  type: string;
  nullFraction: number;
  distinctEstimate: number;
  min?: string | number;
  max?: string | number;
  topValues?: { value: string; count: number }[];
  /** true when computed on a sample of the table */
  sampled?: boolean;
}

export interface QueryResult {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface Question {
  turnId: string;
  text: string;
  history: { role: "user" | "assistant"; text: string }[];
}

export type RouteTarget = "local" | "remote";

export interface RouteDecision {
  route: RouteTarget;
  layer: number;
  reasons: string[];
  attempts: number;
}

export type EscalationPurpose = "write-sql" | "answer-from-results" | "answer-from-chunks";

export interface EscalationPacket {
  purpose: EscalationPurpose;
  payload: unknown;
  summary: string;
  tables: string[];
  columns: string[];
  rowCount: number;
  byteSize: number;
}

export interface EgressRecord {
  egressId: string;
  turnId: string;
  timestamp: string;
  destination: "remote-model";
  purpose: EscalationPurpose;
  privacyLevel: "schema" | "aggregates" | "rows";
  tables: string[];
  columns: string[];
  rowCount: number;
  byteSize: number;
  payloadSha256: string;
  approvedBy: "user" | "auto" | "none";
  outcome: "pending" | "sent" | "cancelled" | "failed";
  payload?: unknown;
}

export interface ChartSpec {
  type: "bar" | "line" | "pie" | "scatter" | "table";
  x?: string;
  y?: string;
  series?: string;
  title: string;
}

export interface Citation {
  fileAlias: string;
  page?: number;
  slide?: number;
  /** at most 200 characters */
  snippet: string;
}

export interface AnswerResult {
  answer: string;
  table?: QueryResult;
  chart?: ChartSpec;
  sql?: string[];
  route: RouteDecision;
  filesUsed: string[];
  citations?: Citation[];
}

export type TurnEvent =
  | { type: "trace"; step: string; status: "start" | "done" | "skip" | "error"; detail: string; data?: Record<string, unknown> }
  | { type: "route"; route: RouteTarget; layer: number; reasons: string[] }
  | {
      type: "egress";
      egressId: string;
      destination: "remote-model";
      summary: string;
      /** Details for the "What was sent" view. `preview` is the exact payload (truncated to 8000 characters). */
      detail?: {
        purpose: EscalationPurpose;
        privacyLevel: "schema" | "aggregates" | "rows";
        bytes: number;
        rows: number;
        tables: string[];
        columns: string[];
        summarized: boolean;
        preview: string;
      };
    }
  | { type: "confirm"; egressId: string; preview: string }
  | { type: "text"; delta: string }
  | { type: "text-reset" }
  | ({ type: "final" } & AnswerResult)
  | { type: "suggestions"; items: string[] }
  | { type: "error"; code: string; message: string };
