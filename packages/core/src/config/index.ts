import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const tier = z.object({
  name: z.string(),
  minTotalRamGb: z.number().nonnegative(),
  model: z.string().nullable(),
});

export const REDACTED = "[redacted]";

const regexList = z.array(
  z.string().refine((s) => {
    try {
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  }, "must be a valid regular expression"),
);

export const ConfigSchema = z.object({
  dataFolder: z.string().nullable().default(null),
  cacheDir: z.string(),
  engine: z
    .object({
      memoryLimit: z.string().regex(/^\d+(\.\d+)?\s?(KB|MB|GB|TB)$/i, "e.g. 4GB").default("4GB"),
      threads: z.number().int().positive().default(4),
      queryTimeoutMs: z.number().int().positive().default(30000),
      maxResultRows: z.number().int().positive().default(1000),
    })
    .prefault({}),
  localModel: z
    .object({
      enabled: z.boolean().default(true),
      provider: z.literal("ollama").default("ollama"),
      baseUrl: z.string().url().default("http://127.0.0.1:11434/v1"),
      name: z.string().nullable().default(null),
      tiers: z.array(tier).default([
        { name: "none", minTotalRamGb: 0, model: null },
        { name: "small", minTotalRamGb: 8, model: "qwen3.5:4b" },
        { name: "medium", minTotalRamGb: 24, model: "qwen3.5:9b-q4_K_M" },
      ]),
    })
    .prefault({}),
  remoteModel: z
    .object({
      enabled: z.boolean().default(true),
      provider: z.enum(["openai-compatible", "azure-openai"]).default("openai-compatible"),
      baseUrl: z.string().nullable().default(null),
      model: z.string().nullable().default(null),
      apiVersion: z.string().nullable().default(null),
      apiKey: z.string().nullable().default(null),
    })
    .prefault({}),
  privacy: z
    .object({
      tabularLevel: z.enum(["schema", "aggregates", "rows"]).default("rows"),
      maxRowsSent: z.number().int().positive().default(500),
      maxBytesSent: z.number().int().positive().default(200000),
      denyColumns: regexList.default([]),
      maskColumns: regexList.default([]),
      docTopK: z.number().int().positive().default(10),
      docMaxChars: z.number().int().positive().default(12000),
      confirmBeforeSend: z.boolean().default(true),
      logFullPayload: z.boolean().default(false),
    })
    .prefault({}),
  history: z.object({ turns: z.number().int().nonnegative().default(3) }).prefault({}),
  docs: z
    .object({
      maxFileMb: z.number().positive().default(200),
      minScore: z.number().nullable().default(null),
    })
    .prefault({}),
  pruning: z
    .object({
      synonyms: z.record(z.string(), z.array(z.string())).default({
        premium: ["revenue", "income", "written"],
        claim: ["loss", "losses"],
        paid: ["payout", "payment"],
        region: ["area", "territory"],
        broker: ["agent", "intermediary"],
        limit: ["cover", "coverage"],
        status: ["state"],
        insured: ["exposure", "sum"],
      }),
      maxColumnsPerTable: z.number().int().min(5).max(40).default(12),
    })
    .prefault({}),
  routing: z
    .object({
      mode: z.enum(["local-first", "remote-sql"]).default("local-first"),
      maxColumnsLocal: z.number().int().positive().default(40),
      maxFilesLocal: z.number().int().positive().default(1),
      escalateKeywords: z
        .array(z.string())
        .default(["why", "explain", "forecast", "predict", "recommend", "compare to last", "trend", "insight", "root cause"]),
      typeRoutes: z
        .record(z.string(), z.enum(["local", "remote"]))
        .default({
          lookup: "local", filter: "local", aggregate: "local", groupby: "local", topn: "local",
          chart: "local", join: "remote", explain: "remote", document: "local", other: "remote",
        }),
      maxLocalAttempts: z.number().int().min(1).max(5).default(2),
      requireAgreement: z.boolean().default(true),
      minConfidence: z.number().min(0).max(1).default(0.6),
      /** Effort-based routing: score thresholds for medium and high effort. */
      effort: z
        .object({
          mediumAt: z.number().min(0).default(1.5),
          highAt: z.number().min(0).default(3),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

export function defaultCacheDir(): string {
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : (process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
  return join(base, "lf-cache");
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function merge(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = isObj(v) && isObj(cur) ? merge(cur, v) : v;
  }
  return out;
}

/** Load order: defaults -> JSON file (env.LF_CONFIG) -> env vars for remote settings and secrets. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Obj = {},
): Config {
  let raw: Obj = { cacheDir: defaultCacheDir() };
  const file = env.LF_CONFIG;
  if (file) {
    try {
      raw = merge(raw, JSON.parse(readFileSync(file, "utf8")) as Obj);
    } catch (e) {
      throw new ConfigError(`Cannot read config file from LF_CONFIG: ${(e as Error).message}`);
    }
  }
  const remote: Obj = {};
  // LF_REMOTE_* win; LLM_* are the names the Conversational BI app uses for its LiteLLM gateway, accepted so the same values work here.
  const baseUrl = env.LF_REMOTE_BASE_URL || env.LLM_BASE_URL;
  const model = env.LF_REMOTE_MODEL || env.LLM_MODEL;
  const apiKey = env.LF_REMOTE_API_KEY || env.LLM_API_KEY;
  if (baseUrl) remote.baseUrl = baseUrl;
  if (model) remote.model = model;
  if (apiKey) remote.apiKey = apiKey;
  raw = merge(merge(raw, { remoteModel: remote }), overrides);
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/** Safe-to-print copy: the API key and the remote base URL are redacted. */
export function redactConfig(config: Config): Config {
  return {
    ...config,
    remoteModel: {
      ...config.remoteModel,
      apiKey: config.remoteModel.apiKey ? REDACTED : null,
      baseUrl: config.remoteModel.baseUrl ? REDACTED : null,
    },
  };
}
