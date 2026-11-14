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

export interface AnswerResult {
  answer: string;
  table?: QueryResult;
  chart?: ChartSpec;
  sql?: string[];
  route: RouteDecision;
  filesUsed: string[];
}

export type TurnEvent =
  | { type: "trace"; step: string; status: "start" | "done" | "skip" | "error"; detail: string }
  | { type: "route"; route: RouteTarget; layer: number; reasons: string[] }
  | { type: "egress"; egressId: string; destination: "remote-model"; summary: string }
  | { type: "confirm"; egressId: string; preview: string }
  | { type: "text"; delta: string }
  | { type: "text-reset" }
  | ({ type: "final" } & AnswerResult)
  | { type: "suggestions"; items: string[] }
  | { type: "error"; code: string; message: string };
