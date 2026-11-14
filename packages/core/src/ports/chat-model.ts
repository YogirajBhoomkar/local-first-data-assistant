export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema of the arguments */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface GenerateRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** JSON schema; the model is asked for strict JSON and `object` is parsed from the reply. */
  responseSchema?: Record<string, unknown>;
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface GenerateResult {
  text?: string;
  object?: unknown;
  toolCalls?: ToolCall[];
  usage: Usage;
  latencyMs: number;
  modelId: string;
}

export type StreamPart =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "finish"; usage: Usage }
  | { type: "error"; message: string };

export interface ModelHealth {
  ok: boolean;
  modelId: string;
  detail: string;
}

export interface ChatModelPort {
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream(req: GenerateRequest): AsyncIterable<StreamPart>;
  health(): Promise<ModelHealth>;
}
