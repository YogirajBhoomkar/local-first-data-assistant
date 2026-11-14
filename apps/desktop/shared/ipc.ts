import { z } from "zod";
import type { TurnEvent, EgressRecord } from "@lf/core";

/**
 * The contract between the window, the main process and the agent process.
 * Everything that crosses a process boundary is validated with these schemas on both sides.
 */

// ------------------------------------------------------------------ settings
export const SettingsSchema = z.object({
  theme: z.enum(["dark", "cbi"]).default("dark"),
  /** Show the narrated "Under the hood" view next to the chat. */
  explain: z.boolean().default(true),
  privacy: z
    .object({
      tabularLevel: z.enum(["schema", "aggregates", "rows"]).default("rows"),
      maxRowsSent: z.number().int().min(1).max(100000).default(500),
      maxBytesSent: z.number().int().min(1000).max(5_000_000).default(200000),
      denyColumns: z.array(z.string().max(200)).max(50).default([]),
      maskColumns: z.array(z.string().max(200)).max(50).default([]),
      docTopK: z.number().int().min(1).max(30).default(10),
      docMaxChars: z.number().int().min(500).max(100000).default(12000),
      confirmBeforeSend: z.boolean().default(true),
    })
    .prefault({}),
  history: z.object({ turns: z.number().int().min(0).max(10).default(3) }).prefault({}),
  /** The decision model (Laya) that adds typed signals to the effort estimate. */
  decision: z
    .object({
      enabled: z.boolean().default(true),
      baseUrl: z.string().url().default("http://127.0.0.1:8765"),
      model: z.string().max(200).default("typed-decisions"),
    })
    .prefault({}),
  localModel: z
    .object({
      enabled: z.boolean().default(true),
      /** null = chosen by hardware tier */
      name: z.string().max(200).nullable().default(null),
      baseUrl: z.string().url().default("http://127.0.0.1:11434/v1"),
    })
    .prefault({}),
  remote: z
    .object({
      enabled: z.boolean().default(true),
      provider: z.enum(["openai-compatible", "azure-openai"]).default("openai-compatible"),
      /** empty = fall back to the LLM_* / LF_REMOTE_* environment values */
      baseUrl: z.string().max(500).default(""),
      model: z.string().max(200).default(""),
      apiVersion: z.string().max(50).default(""),
    })
    .prefault({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** What the window may see about settings: never the key itself. */
export interface SettingsView {
  settings: Settings;
  remoteKey: { saved: boolean; last4: string; source: "keychain" | "environment" | "none" };
}

export const SettingsUpdateSchema = z.object({
  settings: SettingsSchema.optional(),
  /** Write-only. "" clears the saved key. */
  apiKey: z.string().max(500).optional(),
});
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;

// ------------------------------------------------------------------ files and status
export type FileStatus = "ready" | "converting" | "indexed" | "skipped" | "warning";

export interface FileView {
  alias: string;
  kind: string;
  sizeBytes: number;
  status: FileStatus;
  /** Reason when skipped, or warnings (for example a messy sheet). */
  notes: string[];
  tables: string[];
}

export interface TableView {
  tableName: string;
  fileAlias: string;
  rows: number;
  columns: { name: string; type: string }[];
  warnings: string[];
}

export interface FolderView {
  /** Folder name only, never the full path. */
  folderName: string;
  /** false while files are still being read and indexed: questions cannot be asked yet */
  ready: boolean;
  files: FileView[];
  tables: TableView[];
  documents: string[];
  /** Questions built from the real file aliases and columns. */
  examples: string[];
}

export interface ModelStatus {
  local: { available: boolean; model: string | null; tier: string; reason: string; installHint?: string; warning?: string };
  remote: { available: boolean; model: string | null; reason: string };
  decision: { available: boolean; model: string | null; reason: string };
}

export interface ProbeView {
  summary: string[];
  ramGb: number;
  recommendation: { tier: string; model: string | null; reason: string };
  ollama: { reachable: boolean; models: string[] };
  gpu: string;
}

// ------------------------------------------------------------------ requests to the agent
export const AskRequestSchema = z.object({
  turnId: z.string().min(1).max(100),
  question: z.string().min(1).max(4000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) })).max(40),
});
export type AskPayload = z.infer<typeof AskRequestSchema>;

export const ConfirmSchema = z.object({ egressId: z.string().min(1).max(100), approved: z.boolean() });
export const CancelSchema = z.object({ turnId: z.string().min(1).max(100) });
export const EgressQuerySchema = z.object({ limit: z.number().int().min(1).max(500).default(100) });

/** main -> agent process */
export type AgentRequest =
  | { id: number; type: "init"; settings: Settings; apiKey: string | null; userData: string }
  | { id: number; type: "selectFolder"; folder: string }
  | { id: number; type: "applySettings"; settings: Settings; apiKey: string | null }
  | { id: number; type: "ask"; payload: AskPayload }
  | { id: number; type: "confirm"; egressId: string; approved: boolean }
  | { id: number; type: "cancel"; turnId: string }
  | { id: number; type: "egressLog"; limit: number }
  | { id: number; type: "probe" }
  | { id: number; type: "status" };

/** agent process -> main */
export type AgentMessage =
  | { type: "response"; id: number; ok: true; result?: unknown }
  | { type: "response"; id: number; ok: false; error: string }
  | { type: "event"; turnId: string; event: TurnEvent }
  | { type: "files"; folder: FolderView }
  | { type: "status"; status: ModelStatus };

// ------------------------------------------------------------------ the API exposed to the window (window.lf)
export interface TurnEnvelope {
  turnId: string;
  event: TurnEvent;
}

export interface LfApi {
  selectFolder(): Promise<FolderView | null>;
  getFolder(): Promise<FolderView | null>;
  ask(req: AskPayload): Promise<void>;
  confirm(egressId: string, approved: boolean): Promise<void>;
  cancel(turnId: string): Promise<void>;
  getEgressLog(limit: number): Promise<EgressRecord[]>;
  getSettings(): Promise<SettingsView>;
  setSettings(update: SettingsUpdate): Promise<SettingsView>;
  runProbe(): Promise<ProbeView>;
  getStatus(): Promise<ModelStatus>;
  onEvent(cb: (e: TurnEnvelope) => void): () => void;
  onFiles(cb: (f: FolderView) => void): () => void;
  onStatus(cb: (s: ModelStatus) => void): () => void;
}

export const CHANNELS = {
  selectFolder: "lf:select-folder",
  getFolder: "lf:get-folder",
  ask: "lf:ask",
  confirm: "lf:confirm",
  cancel: "lf:cancel",
  egressLog: "lf:egress-log",
  getSettings: "lf:get-settings",
  setSettings: "lf:set-settings",
  probe: "lf:probe",
  status: "lf:status",
  event: "lf:event",
  files: "lf:files",
  statusPush: "lf:status-push",
} as const;
