import { basename, join } from "node:path";
import { totalmem } from "node:os";
import {
  RuleClassifier,
  loadConfig,
  remoteAvailable,
  type ChatModelPort,
  type Config,
  type EgressRecord,
  type FileEntry,
  type TableSchema,
  type TurnEvent,
} from "@lf/core";
import { DuckDbEngine } from "@lf/engine";
import { DocumentStore } from "@lf/docs";
import { LocalOpenAICompatibleAdapter, selectLocalModel } from "@lf/models";
import { EgressLog, LocalModelClassifier, TableAgent, loadMaskKey, deterministicFollowUps } from "@lf/agent";
import { collectProbe, detectOllama, summarize } from "../../../scripts/probe-lib.js";
import { LayaSidecar } from "./laya-sidecar.js";
import type {
  AgentMessage,
  AskPayload,
  FileView,
  FolderView,
  ModelStatus,
  ProbeView,
  Settings,
  TableView,
} from "../shared/ipc.js";

const GB = 1024 ** 3;

/** Settings -> loader overrides. Empty remote fields are left out so the environment (LLM_*) can fill them. */
export function settingsToOverrides(s: Settings, apiKey: string | null, userData: string): Record<string, unknown> {
  const remote: Record<string, unknown> = { enabled: s.remote.enabled, provider: s.remote.provider };
  if (s.remote.baseUrl) remote.baseUrl = s.remote.baseUrl;
  if (s.remote.model) remote.model = s.remote.model;
  if (s.remote.apiVersion) remote.apiVersion = s.remote.apiVersion;
  if (apiKey) remote.apiKey = apiKey;
  return {
    cacheDir: join(userData, "lf-cache"),
    privacy: { ...s.privacy },
    history: { turns: s.history.turns },
    localModel: { enabled: s.localModel.enabled, baseUrl: s.localModel.baseUrl, ...(s.localModel.name ? { name: s.localModel.name } : {}) },
    remoteModel: remote,
  };
}

/** The agent side of the app: owns the engine, document index, models and the agent. Pure Node (no Electron). */
export class AgentRuntime {
  private config!: Config;
  private settings!: Settings;
  private apiKey: string | null = null;
  private userData = "";
  private engine: DuckDbEngine | null = null;
  private docs: DocumentStore | null = null;
  private agent: TableAgent | null = null;
  private folder: FolderView | null = null;
  private entries: FileEntry[] = [];
  private status: ModelStatus | null = null;
  private laya: LayaSidecar | null = null;
  private layaKey = "";
  private readonly turns = new Map<string, AbortController>();

  constructor(
    private readonly send: (m: AgentMessage) => void,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  // ------------------------------------------------------------------ lifecycle
  async init(settings: Settings, apiKey: string | null, userData: string): Promise<ModelStatus> {
    this.userData = userData;
    return this.applySettings(settings, apiKey);
  }

  async applySettings(settings: Settings, apiKey: string | null): Promise<ModelStatus> {
    this.settings = settings;
    this.apiKey = apiKey;
    this.config = loadConfig(this.env, settingsToOverrides(settings, apiKey, this.userData));
    const status = await this.buildAgent();
    return status;
  }

  private async localModel(): Promise<{ model: ChatModelPort | null; status: ModelStatus["local"] }> {
    const c = this.config;
    const ollama = await detectOllama(c.localModel.baseUrl);
    const choice = selectLocalModel({ ram: { totalGb: Math.round((totalmem() / GB) * 10) / 10 }, ollama }, c);
    const status: ModelStatus["local"] = {
      available: !!choice.model && !choice.remoteOnly,
      model: choice.model,
      tier: choice.tier,
      reason: choice.reason,
      ...(choice.installHint ? { installHint: choice.installHint } : {}),
      ...(choice.warning ? { warning: choice.warning } : {}),
    };
    if (!status.available || !choice.model) return { model: null, status };
    return { model: new LocalOpenAICompatibleAdapter({ baseUrl: c.localModel.baseUrl, model: choice.model, timeoutMs: 300_000 }), status };
  }

  private async buildAgent(): Promise<ModelStatus> {
    const { model, status: local } = await this.localModel();
    const remoteOk = remoteAvailable(this.config);
    // Decision model (Laya): start or reuse the local service; routing works without it.
    const d = this.settings.decision;
    let decision: ModelStatus["decision"] = { available: false, model: null, reason: "Turned off in settings" };
    if (d.enabled) {
      const key = `${d.baseUrl}|${d.model}`;
      if (!this.laya || this.layaKey !== key) {
        this.laya?.stop();
        this.laya = new LayaSidecar(d.baseUrl, d.model, this.env);
        this.layaKey = key;
        void this.laya.start((s) => {
          this.status = this.status ? { ...this.status, decision: { available: s.available, model: d.model, reason: s.reason } } : this.status;
          if (this.status) this.send({ type: "status", status: this.status });
        });
      }
      const ls = this.laya.getStatus();
      decision = { available: ls.available, model: d.model, reason: ls.reason };
    } else {
      this.laya?.stop();
      this.laya = null;
      this.layaKey = "";
    }
    const status: ModelStatus = {
      local,
      remote: {
        available: remoteOk,
        model: this.config.remoteModel.model,
        reason: remoteOk
          ? "Remote model is configured. It is used only when a question is escalated through the privacy gate."
          : this.config.remoteModel.enabled
            ? "No remote endpoint, model and key are configured."
            : "Remote model is turned off in settings.",
      },
      decision,
    };
    this.status = status;
    if (this.engine) {
      this.agent = new TableAgent({
        config: this.config,
        engine: this.engine,
        local: model,
        classifier: model ? new LocalModelClassifier(model) : new RuleClassifier(),
        maskKey: await loadMaskKey(this.config.cacheDir),
        ...(this.docs ? { docs: this.docs } : {}),
        ...(this.laya ? { decision: this.laya.client(this.settings.decision.enabled ? 20_000 : 1000) } : {}),
      });
    }
    this.localAdapter = model;
    this.send({ type: "status", status });
    return status;
  }
  private localAdapter: ChatModelPort | null = null;

  getStatus(): ModelStatus {
    return this.status ?? {
      local: { available: false, model: null, tier: "none", reason: "not initialised" },
      remote: { available: false, model: null, reason: "not initialised" },
      decision: { available: false, model: null, reason: "not initialised" },
    };
  }

  // ------------------------------------------------------------------ folder
  async selectFolder(folder: string): Promise<FolderView> {
    if (!this.config) throw new Error("The agent is not initialised.");
    for (const c of this.turns.values()) c.abort();
    await this.engine?.close();
    const engine = new DuckDbEngine({
      cacheDir: this.config.cacheDir,
      memoryLimit: this.config.engine.memoryLimit,
      threads: this.config.engine.threads,
      queryTimeoutMs: this.config.engine.queryTimeoutMs,
      maxResultRows: this.config.engine.maxResultRows,
    });
    this.engine = engine;
    const entries = await engine.scanFolder(folder);
    this.entries = entries;
    const folderName = basename(folder);

    const initial: FileView[] = entries.map((e) => ({
      alias: e.alias,
      kind: e.kind,
      sizeBytes: e.sizeBytes,
      status: e.kind === "other" ? "skipped" : e.kind === "csv" || e.kind === "parquet" ? "ready" : "converting",
      notes: e.kind === "other" ? ["not a supported file type"] : [],
      tables: [],
    }));
    this.send({ type: "files", folder: { folderName, ready: false, files: initial, tables: [], documents: [], examples: [] } });

    const schemas = await engine.registerFiles(entries);
    this.docs = new DocumentStore({
      cacheDir: this.config.cacheDir,
      resolvePath: (e) => engine.pathOf(e),
      maxFileMb: this.config.docs.maxFileMb,
      minScore: this.config.docs.minScore,
    });
    const indexed = await this.docs.index(entries);
    const skipped = new Map(indexed.skipped.map((s) => [s.alias, s.reason]));
    const docAliases = new Set(this.docs.aliases());

    const tables: TableView[] = schemas.map((s: TableSchema) => ({
      tableName: s.tableName,
      fileAlias: s.fileAlias,
      rows: s.rowCountEstimate,
      columns: s.columns,
      warnings: s.warnings ?? [],
    }));
    const files: FileView[] = entries.map((e) => {
      const mine = schemas.filter((s) => s.fileAlias === e.alias || s.fileAlias.startsWith(`${e.alias}_`));
      const warnings = mine.flatMap((s) => s.warnings ?? []);
      let status: FileView["status"] = "ready";
      const notes: string[] = [];
      if (e.kind === "other") {
        status = "skipped";
        notes.push("not a supported file type");
      } else if (e.kind === "pdf" || e.kind === "pptx") {
        if (docAliases.has(e.alias)) status = "indexed";
        else {
          status = "skipped";
          notes.push(skipped.get(e.alias) ?? "no text found");
        }
      } else if (e.kind === "xlsx" && mine.length === 0) {
        status = "skipped";
        notes.push("workbook could not be read or is too large");
      } else if (warnings.length) {
        status = "warning";
        notes.push(...warnings);
      }
      return { alias: e.alias, kind: e.kind, sizeBytes: e.sizeBytes, status, notes, tables: mine.map((s) => s.tableName) };
    });

    // Profile every table now (cached on disk) so the first question does not pay for it.
    for (const t of schemas) await engine.profile(t.tableName);
    const examples = this.exampleQuestions(schemas, [...docAliases]);
    this.folder = { folderName, ready: true, files, tables, documents: [...docAliases], examples };
    await this.buildAgent(); // the agent needs the engine and the document index
    this.send({ type: "files", folder: this.folder });
    return this.folder;
  }

  private exampleQuestions(schemas: TableSchema[], docs: string[]): string[] {
    const out: string[] = [];
    const real = schemas.filter((s) => !s.warnings?.length);
    for (const q of deterministicFollowUps(real.length ? real : schemas)) out.push(q);
    if (docs[0]) out.push(`Summarise the ${docs[0].replace(/_/g, " ")} document.`);
    if (real[0] && real[1]) out.push(`Why might ${real[0].fileAlias.replace(/_/g, " ")} differ from ${real[1].fileAlias.replace(/_/g, " ")}?`);
    return out.slice(0, 4);
  }

  getFolder(): FolderView | null {
    return this.folder;
  }

  // ------------------------------------------------------------------ turns
  ask(payload: AskPayload): void {
    const agent = this.agent;
    const turnId = payload.turnId;
    const emit = (event: TurnEvent) => this.send({ type: "event", turnId, event });
    if (!agent || !this.folder) {
      emit({ type: "error", code: "NO_FOLDER", message: "Select a data folder first." });
      return;
    }
    const ctl = new AbortController();
    this.turns.set(turnId, ctl);
    void (async () => {
      let ended = false;
      try {
        for await (const e of agent.ask({ turnId, question: payload.question, history: payload.history, context: { folderSelected: true } }, ctl.signal)) {
          if (e.type === "final" || e.type === "error") ended = true;
          emit(e);
        }
      } catch (err) {
        ended = true;
        emit({ type: "error", code: "AGENT", message: (err as Error).message.slice(0, 300) });
      } finally {
        this.turns.delete(turnId);
        if (!ended) emit({ type: "error", code: "CANCELLED", message: "The question was cancelled." });
      }
    })();
  }

  confirm(egressId: string, approved: boolean): void {
    this.agent?.confirm(egressId, approved);
  }

  cancel(turnId: string): void {
    this.turns.get(turnId)?.abort();
  }

  async egressLog(limit: number): Promise<EgressRecord[]> {
    if (!this.config) return [];
    return new EgressLog(this.config.cacheDir).readLast(limit);
  }

  async probe(): Promise<ProbeView> {
    const p = await collectProbe(this.config);
    return {
      summary: summarize(p).split("\n"),
      ramGb: p.ram.totalGb,
      recommendation: p.recommendation,
      ollama: p.ollama,
      gpu: p.gpu === "unknown" ? "unknown" : p.gpu.map((g) => g.name).join(", ") || "none found",
    };
  }

  async close(): Promise<void> {
    this.laya?.stop();
    for (const c of this.turns.values()) c.abort();
    await this.engine?.close();
  }
}
