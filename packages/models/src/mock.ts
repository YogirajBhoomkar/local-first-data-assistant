import type { ChatModelPort, GenerateRequest, GenerateResult, ModelHealth, StreamPart } from "@lf/core";

export type Matcher = string | RegExp | ((req: GenerateRequest) => boolean);
export interface Scripted {
  match: Matcher;
  reply: Partial<Pick<GenerateResult, "text" | "object" | "toolCalls">> | ((req: GenerateRequest) => Partial<GenerateResult>);
  /** Simulated latency in ms (reported only, no real wait). */
  latencyMs?: number;
}

const promptOf = (r: GenerateRequest) => `${r.system ?? ""}\n${r.messages.map((m) => m.content).join("\n")}`;

/** Scripted model for tests and CI. First matching rule wins; calls are recorded. */
export class MockModelAdapter implements ChatModelPort {
  readonly calls: GenerateRequest[] = [];
  constructor(
    private readonly rules: Scripted[],
    private readonly modelId = "mock",
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    const text = promptOf(req);
    const rule = this.rules.find((r) =>
      typeof r.match === "string" ? text.includes(r.match) : r.match instanceof RegExp ? r.match.test(text) : r.match(req),
    );
    if (!rule) throw new Error(`MockModelAdapter: no rule matched prompt: ${text.slice(0, 120)}`);
    const reply = typeof rule.reply === "function" ? rule.reply(req) : rule.reply;
    const out: GenerateResult = {
      usage: { promptTokens: Math.ceil(text.length / 4), completionTokens: 20 },
      latencyMs: rule.latencyMs ?? 1,
      modelId: this.modelId,
      ...reply,
    };
    if (out.object !== undefined && out.text === undefined) out.text = JSON.stringify(out.object);
    return out;
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamPart> {
    const r = await this.generate(req);
    if (r.text) for (const w of r.text.split(/(?<= )/)) yield { type: "text-delta", delta: w };
    for (const call of r.toolCalls ?? []) yield { type: "tool-call", call };
    yield { type: "finish", usage: r.usage };
  }

  async health(): Promise<ModelHealth> {
    return { ok: true, modelId: this.modelId, detail: "mock" };
  }
}
