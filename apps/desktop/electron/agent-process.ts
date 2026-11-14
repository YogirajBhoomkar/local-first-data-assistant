// Entry of the agent process (an Electron utilityProcess: a plain Node process). It owns the engine,
// document index, models and agent, so heavy queries and slow model calls never freeze the window.
import { AgentRuntime } from "./runtime.js";
import type { AgentMessage, AgentRequest } from "../shared/ipc.js";

const port = (process as unknown as { parentPort: { postMessage(m: unknown): void; on(ev: "message", cb: (e: { data: unknown }) => void): void } }).parentPort;

// Offline test mode: only loopback hosts (the local model server) may be reached. Lets us prove that local
// questions still work with no internet and that remote questions then fail with a clear message.
if (process.env.LF_OFFLINE === "1") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
      throw new TypeError("network blocked (offline test mode)", { cause: { code: "ENETUNREACH", message: "offline test mode" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

const post = (m: AgentMessage) => port.postMessage(m);
const runtime = new AgentRuntime(post);

port.on("message", (e) => {
  const msg = e.data as AgentRequest;
  const reply = (result?: unknown) => post({ type: "response", id: msg.id, ok: true, ...(result !== undefined ? { result } : {}) });
  const fail = (err: unknown) => post({ type: "response", id: msg.id, ok: false, error: (err as Error).message ?? String(err) });
  void (async () => {
    try {
      switch (msg.type) {
        case "init":
          reply(await runtime.init(msg.settings, msg.apiKey, msg.userData));
          break;
        case "applySettings":
          reply(await runtime.applySettings(msg.settings, msg.apiKey));
          break;
        case "selectFolder":
          reply(await runtime.selectFolder(msg.folder));
          break;
        case "ask":
          runtime.ask(msg.payload);
          reply();
          break;
        case "confirm":
          runtime.confirm(msg.egressId, msg.approved);
          reply();
          break;
        case "cancel":
          runtime.cancel(msg.turnId);
          reply();
          break;
        case "egressLog":
          reply(await runtime.egressLog(msg.limit));
          break;
        case "probe":
          reply(await runtime.probe());
          break;
        case "status":
          reply(runtime.getStatus());
          break;
      }
    } catch (err) {
      fail(err);
    }
  })();
});
