import type { Config } from "@lf/core";
import { OpenAICompatAdapter, type OpenAICompatOptions } from "./openai-compat.js";

export interface LocalAdapterOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Models that think by default and need it switched off (Ollama's OpenAI endpoint: reasoning_effort). */
const THINKING_MODELS = /qwen3|deepseek-r1|gpt-oss/i;

export class LocalOpenAICompatibleAdapter extends OpenAICompatAdapter {
  constructor(private readonly opts: LocalAdapterOptions) {
    const base = opts.baseUrl.replace(/\/$/, "");
    const o: OpenAICompatOptions = {
      chatUrl: `${base}/chat/completions`,
      model: opts.model,
      modelId: opts.model,
      headers: { authorization: "Bearer ollama" },
      healthUrl: `${base}/models`,
      ...(THINKING_MODELS.test(opts.model) ? { extraBody: { reasoning_effort: "none" } } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    };
    super(o);
  }

  /** A Mastra model config (OpenAI-compatible object form) so Phase 3 agents can use this endpoint. */
  toMastraModel(): { id: `${string}/${string}`; url: string; apiKey: string } {
    return { id: `ollama/${this.opts.model}`, url: this.opts.baseUrl.replace(/\/$/, ""), apiKey: "ollama" };
  }
}

export function createLocalAdapter(config: Config, model: string): LocalOpenAICompatibleAdapter {
  return new LocalOpenAICompatibleAdapter({ baseUrl: config.localModel.baseUrl, model });
}
