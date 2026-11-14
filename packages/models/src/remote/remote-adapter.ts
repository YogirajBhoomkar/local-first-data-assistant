// PRIVACY: this module is only constructed inside the privacy gate (packages/agent/src/gate).
// It is NOT exported from the package index, and ESLint forbids importing it anywhere else.
import { OpenAICompatAdapter, ModelError, type OpenAICompatOptions } from "../openai-compat.js";

export interface RemoteAdapterOptions {
  provider: "openai-compatible" | "azure-openai";
  /** openai-compatible: base URL ending in /v1. azure-openai: resource URL. */
  baseUrl: string;
  /** Model name, or the Azure deployment name. */
  model: string;
  apiKey: string;
  /** azure-openai only */
  apiVersion?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class RemoteAdapter extends OpenAICompatAdapter {
  constructor(opts: RemoteAdapterOptions) {
    if (!opts.baseUrl || !opts.apiKey || !opts.model) {
      throw new ModelError("Remote model is not configured (base URL, model and API key are required).");
    }
    const base = opts.baseUrl.replace(/\/$/, "");
    let o: OpenAICompatOptions;
    if (opts.provider === "azure-openai") {
      if (!opts.apiVersion) throw new ModelError("Azure OpenAI needs an api-version.");
      o = {
        chatUrl: `${base}/openai/deployments/${encodeURIComponent(opts.model)}/chat/completions?api-version=${encodeURIComponent(opts.apiVersion)}`,
        model: "",
        modelId: opts.model,
        headers: { "api-key": opts.apiKey },
        secrets: [opts.apiKey, base],
      };
    } else {
      o = {
        chatUrl: `${base}/chat/completions`,
        model: opts.model,
        modelId: opts.model,
        headers: { authorization: `Bearer ${opts.apiKey}` },
        secrets: [opts.apiKey, base],
      };
    }
    if (opts.timeoutMs) o.timeoutMs = opts.timeoutMs;
    if (opts.fetchImpl) o.fetchImpl = opts.fetchImpl;
    super(o);
  }
}
