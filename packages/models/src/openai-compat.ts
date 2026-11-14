import type {
  ChatModelPort,
  GenerateRequest,
  GenerateResult,
  ModelHealth,
  StreamPart,
  ToolCall,
  Usage,
} from "@lf/core";

export interface OpenAICompatOptions {
  /** Full chat-completions URL (the adapter decides how to build it). */
  chatUrl: string;
  /** Model id sent in the body (or "" for Azure, where the deployment is in the URL). */
  model: string;
  /** Model id reported back to callers. */
  modelId: string;
  headers: Record<string, string>;
  /** Merged into every request body (e.g. reasoning_effort for local thinking models). */
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
  /** Strings that must never appear in errors or logs (key, base URL). */
  secrets?: string[];
  fetchImpl?: typeof fetch;
  healthUrl?: string;
}

export class ModelError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out;
}

const isConnectionError = (e: unknown): boolean => {
  if (!(e instanceof Error)) return false;
  const code = (e.cause as { code?: string } | undefined)?.code;
  return (
    e.name === "TypeError" ||
    ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code ?? "")
  );
};

export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new ModelError("The model did not return valid JSON.");
  }
}

interface ApiMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}

export class OpenAICompatAdapter implements ChatModelPort {
  protected readonly fetchImpl: typeof fetch;
  constructor(protected readonly o: OpenAICompatOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  /** Exposed for tests: the exact request body for a call. */
  buildBody(req: GenerateRequest, stream: boolean): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) {
      messages.push(
        m.role === "tool"
          ? { role: "tool", content: m.content, tool_call_id: m.toolCallId }
          : { role: m.role, content: m.content },
      );
    }
    const body: Record<string, unknown> = {
      messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream,
      ...this.o.extraBody,
    };
    if (this.o.model) body.model = this.o.model;
    if (req.tools?.length)
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    if (req.responseSchema)
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "output", schema: req.responseSchema, strict: false },
      };
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  private signalFor(req: GenerateRequest): AbortSignal {
    const t = AbortSignal.timeout(this.o.timeoutMs ?? 120_000);
    return req.signal ? AbortSignal.any([t, req.signal]) : t;
  }

  private async post(req: GenerateRequest, stream: boolean): Promise<Response> {
    const secrets = this.o.secrets ?? [];
    const init = (): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json", ...this.o.headers },
      body: JSON.stringify(this.buildBody(req, stream)),
      signal: this.signalFor(req),
    });
    let res: Response;
    try {
      try {
        res = await this.fetchImpl(this.o.chatUrl, init());
      } catch (e) {
        if (req.signal?.aborted || !isConnectionError(e)) throw e;
        res = await this.fetchImpl(this.o.chatUrl, init()); // one retry, connection errors only
      }
    } catch (e) {
      const name = (e as Error).name;
      if (name === "TimeoutError") throw new ModelError("The model call timed out.");
      if (name === "AbortError") throw new ModelError("The model call was cancelled.");
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      const why = cause ? ` (${cause.code ?? ""} ${cause.message ?? ""})`.replace(/\s+\)/, ")") : "";
      throw new ModelError(redact(`Could not reach the model: ${(e as Error).message}${why}`, secrets));
    }
    if (!res.ok) {
      // Never retried: a 4xx/5xx is a real answer.
      const detail = redact((await res.text()).slice(0, 300), secrets);
      throw new ModelError(`The model returned HTTP ${res.status}. ${detail}`, res.status);
    }
    return res;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    const res = await this.post(req, false);
    const j = (await res.json()) as {
      choices?: { message?: ApiMessage }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const msg = j.choices?.[0]?.message;
    const text = msg?.content ?? undefined;
    const out: GenerateResult = {
      usage: { promptTokens: j.usage?.prompt_tokens ?? 0, completionTokens: j.usage?.completion_tokens ?? 0 },
      latencyMs: Date.now() - started,
      modelId: this.o.modelId,
    };
    if (text !== undefined) out.text = text;
    if (req.responseSchema && text) out.object = parseJsonLoose(text);
    if (msg?.tool_calls?.length)
      out.toolCalls = msg.tool_calls.map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: safeParse(c.function.arguments),
      }));
    return out;
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamPart> {
    let res: Response;
    try {
      res = await this.post(req, true);
    } catch (e) {
      yield { type: "error", message: (e as Error).message };
      return;
    }
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: Usage = { promptTokens: 0, completionTokens: 0 };
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const j = JSON.parse(data) as {
          choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        if (j.usage) usage = { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0 };
        const d = j.choices?.[0]?.delta;
        if (d?.content) yield { type: "text-delta", delta: d.content };
        for (const tc of d?.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(tc.index, cur);
        }
      }
    }
    for (const c of calls.values()) {
      const call: ToolCall = { id: c.id, name: c.name, arguments: safeParse(c.args) };
      yield { type: "tool-call", call };
    }
    yield { type: "finish", usage };
  }

  async health(): Promise<ModelHealth> {
    const url = this.o.healthUrl;
    if (!url) return { ok: true, modelId: this.o.modelId, detail: "no health endpoint configured" };
    try {
      const r = await this.fetchImpl(url, { headers: this.o.headers, signal: AbortSignal.timeout(3000) });
      return { ok: r.ok, modelId: this.o.modelId, detail: r.ok ? "reachable" : `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, modelId: this.o.modelId, detail: redact((e as Error).message, this.o.secrets ?? []) };
    }
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return s;
  }
}
