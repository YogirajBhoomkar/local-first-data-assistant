import { describe, expect, it } from "vitest";
import { loadConfig } from "@lf/core";
import { LocalOpenAICompatibleAdapter, MockModelAdapter, ModelError, selectLocalModel } from "./index.js";
import { RemoteAdapter } from "./remote/remote-adapter.js";

const KEY = "sk-test-secret-key";
const URL_ = "https://private-host.example.internal/v1";

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
const req = { messages: [{ role: "user" as const, content: "hi" }], temperature: 0, maxTokens: 50 };

describe("local adapter", () => {
  it("builds an OpenAI-style request and turns thinking off for qwen", async () => {
    const { f, calls } = fakeFetch(() => ok('{"a":1}'));
    const a = new LocalOpenAICompatibleAdapter({ baseUrl: "http://127.0.0.1:11434/v1/", model: "qwen3.5:9b-q4_K_M", fetchImpl: f });
    const r = await a.generate({ ...req, system: "sys", responseSchema: { type: "object" } });
    expect(calls[0]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("qwen3.5:9b-q4_K_M");
    expect(body.reasoning_effort).toBe("none");
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.response_format.type).toBe("json_schema");
    expect(r.object).toEqual({ a: 1 });
    expect(r.usage).toEqual({ promptTokens: 5, completionTokens: 3 });
  });
  it("does not send reasoning_effort for other models", () => {
    const a = new LocalOpenAICompatibleAdapter({ baseUrl: "http://x/v1", model: "ministral-3:14b" });
    expect(a.buildBody(req, false).reasoning_effort).toBeUndefined();
  });
  it("parses JSON wrapped in code fences", async () => {
    const { f } = fakeFetch(() => ok('```json\n{"sql":"SELECT 1"}\n```'));
    const a = new LocalOpenAICompatibleAdapter({ baseUrl: "http://x/v1", model: "m", fetchImpl: f });
    expect((await a.generate({ ...req, responseSchema: {} })).object).toEqual({ sql: "SELECT 1" });
  });
  it("retries once on a connection error", async () => {
    let n = 0;
    const { f, calls } = fakeFetch(() => {
      if (n++ === 0) throw new TypeError("fetch failed");
      return ok("done");
    });
    const a = new LocalOpenAICompatibleAdapter({ baseUrl: "http://x/v1", model: "m", fetchImpl: f });
    expect((await a.generate(req)).text).toBe("done");
    expect(calls).toHaveLength(2);
  });
  it("never retries a 4xx", async () => {
    const { f, calls } = fakeFetch(() => new Response("bad request", { status: 400 }));
    const a = new LocalOpenAICompatibleAdapter({ baseUrl: "http://x/v1", model: "m", fetchImpl: f });
    await expect(a.generate(req)).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
  });
  it("times out", async () => {
    const f = ((_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    const a = new LocalOpenAICompatibleAdapter({ baseUrl: "http://x/v1", model: "m", fetchImpl: f, timeoutMs: 20 });
    await expect(a.generate(req)).rejects.toThrow(/timed out/);
  });
  it("streams text deltas and finish", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"He"}}]}\n\ndata: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
    const { f } = fakeFetch(() => new Response(sse));
    const a = new LocalOpenAICompatibleAdapter({ baseUrl: "http://x/v1", model: "m", fetchImpl: f });
    const parts = [];
    for await (const p of a.stream(req)) parts.push(p);
    expect(parts.filter((p) => p.type === "text-delta").map((p) => (p as { delta: string }).delta).join("")).toBe("Hello");
    expect(parts.at(-1)).toEqual({ type: "finish", usage: { promptTokens: 2, completionTokens: 2 } });
  });
  it("gives Mastra an OpenAI-compatible config", () => {
    const a = new LocalOpenAICompatibleAdapter({ baseUrl: "http://127.0.0.1:11434/v1", model: "m:1" });
    expect(a.toMastraModel()).toEqual({ id: "ollama/m:1", url: "http://127.0.0.1:11434/v1", apiKey: "ollama" });
  });
});

describe("remote adapter", () => {
  it("openai-compatible: bearer key and chat URL", async () => {
    const { f, calls } = fakeFetch(() => ok("x"));
    const a = new RemoteAdapter({ provider: "openai-compatible", baseUrl: URL_, model: "big", apiKey: KEY, fetchImpl: f });
    await a.generate(req);
    expect(calls[0]!.url).toBe(`${URL_}/chat/completions`);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0]!.init.body as string).model).toBe("big");
  });
  it("azure: deployment URL, api-version and api-key header, no model in body", async () => {
    const { f, calls } = fakeFetch(() => ok("x"));
    const a = new RemoteAdapter({ provider: "azure-openai", baseUrl: "https://res.example/", model: "dep1", apiKey: KEY, apiVersion: "2024-06-01", fetchImpl: f });
    await a.generate(req);
    expect(calls[0]!.url).toBe("https://res.example/openai/deployments/dep1/chat/completions?api-version=2024-06-01");
    expect((calls[0]!.init.headers as Record<string, string>)["api-key"]).toBe(KEY);
    expect(JSON.parse(calls[0]!.init.body as string).model).toBeUndefined();
  });
  it("redacts the key and URL in errors", async () => {
    const { f } = fakeFetch(() => new Response(`invalid key ${KEY} for ${URL_}`, { status: 401 }));
    const a = new RemoteAdapter({ provider: "openai-compatible", baseUrl: URL_, model: "m", apiKey: KEY, fetchImpl: f });
    const err = await a.generate(req).catch((e: ModelError) => e);
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).not.toContain("private-host");
    expect((err as Error).message).toContain("[redacted]");
  });
  it("redacts the URL on connection failures", async () => {
    const { f } = fakeFetch(() => {
      throw new TypeError(`connect failed to ${URL_}`);
    });
    const a = new RemoteAdapter({ provider: "openai-compatible", baseUrl: URL_, model: "m", apiKey: KEY, fetchImpl: f });
    const err = await a.generate(req).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("private-host");
  });
  it("requires configuration", () => {
    expect(() => new RemoteAdapter({ provider: "openai-compatible", baseUrl: "", model: "m", apiKey: "" })).toThrow(/not configured/);
    expect(() => new RemoteAdapter({ provider: "azure-openai", baseUrl: "https://r", model: "m", apiKey: "k" })).toThrow(/api-version/);
  });
});

describe("mock adapter", () => {
  it("matches by string, regex and function, and records calls", async () => {
    const m = new MockModelAdapter([
      { match: "alpha", reply: { text: "A" } },
      { match: /beta\d/, reply: { object: { b: 1 } } },
      { match: (r) => r.temperature > 0.5, reply: () => ({ text: "hot" }) },
    ]);
    expect((await m.generate({ ...req, messages: [{ role: "user", content: "say alpha" }] })).text).toBe("A");
    expect((await m.generate({ ...req, messages: [{ role: "user", content: "beta2" }] })).object).toEqual({ b: 1 });
    expect((await m.generate({ ...req, temperature: 0.9, messages: [{ role: "user", content: "zzz" }] })).text).toBe("hot");
    expect(m.calls).toHaveLength(3);
    await expect(m.generate({ ...req, messages: [{ role: "user", content: "nothing" }] })).rejects.toThrow(/no rule matched/);
  });
});

describe("selectLocalModel", () => {
  const cfg = loadConfig({});
  const probe = (ram: number, models: string[] = [], reachable = true) => ({ ram: { totalGb: ram }, ollama: { reachable, models } });
  it("none tier for low RAM", () => expect(selectLocalModel(probe(8), cfg)).toMatchObject({ tier: "none", remoteOnly: true }));
  it("small tier when installed", () =>
    expect(selectLocalModel(probe(16, ["qwen3.5:9b-q4_K_M"]), cfg)).toMatchObject({ tier: "small", model: "qwen3.5:9b-q4_K_M", remoteOnly: false }));
  it("medium tier when installed", () =>
    expect(selectLocalModel(probe(32, ["ministral-3:14b-instruct-2512-q4_K_M"]), cfg).tier).toBe("medium"));
  it("override wins, with a RAM warning", () => {
    const c = loadConfig({}, { localModel: { name: "ministral-3:14b-instruct-2512-q4_K_M" } });
    const r = selectLocalModel(probe(16, ["ministral-3:14b-instruct-2512-q4_K_M"]), c);
    expect(r.model).toBe("ministral-3:14b-instruct-2512-q4_K_M");
    expect(r.warning).toMatch(/24 GB/);
  });
  it("Ollama unreachable -> none with hint", () => {
    const r = selectLocalModel(probe(16, [], false), cfg);
    expect(r).toMatchObject({ tier: "none", remoteOnly: true });
    expect(r.installHint).toMatch(/ollama pull qwen3.5/);
  });
  it("model missing -> none with pull hint", () =>
    expect(selectLocalModel(probe(16, ["other:1b"]), cfg).installHint).toBe("ollama pull qwen3.5:9b-q4_K_M"));
  it("disabled in settings", () =>
    expect(selectLocalModel(probe(32), loadConfig({}, { localModel: { enabled: false } })).remoteOnly).toBe(true));
});
