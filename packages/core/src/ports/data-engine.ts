import type { ColumnProfile, FileEntry, QueryResult, TableSchema } from "../domain/index.js";

export type EngineErrorCode =
  | "SYNTAX"
  | "UNKNOWN_TABLE"
  | "UNKNOWN_COLUMN"
  | "FORBIDDEN"
  | "TIMEOUT"
  | "TOO_LARGE"
  | "ENGINE";

export class EngineError extends Error {
  constructor(
    public readonly code: EngineErrorCode,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint };
  }
}

export interface QueryLimits {
  maxResultRows: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProfileOptions {
  /** Profile only this many rows for big tables. */
  sampleRows?: number;
}

export interface DataEnginePort {
  scanFolder(folder: string, opts?: { depth?: 0 | 1 }): Promise<FileEntry[]>;
  registerFiles(entries: FileEntry[]): Promise<TableSchema[]>;
  profile(tableName: string, options?: ProfileOptions): Promise<ColumnProfile[]>;
  runReadOnlySql(sql: string, limits?: Partial<QueryLimits>): Promise<QueryResult>;
  sampleRows(tableName: string, n: number, columns?: string[]): Promise<QueryResult>;
  close(): Promise<void>;
}
