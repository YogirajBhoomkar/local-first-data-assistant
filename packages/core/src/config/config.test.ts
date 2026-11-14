import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, redactConfig } from "./index.js";

describe("config", () => {
  it("loads defaults", () => {
    const c = loadConfig({});
    expect(c.engine.memoryLimit).toBe("4GB");
    expect(c.privacy.tabularLevel).toBe("rows");
    expect(c.localModel.tiers).toHaveLength(3);
    expect(c.cacheDir).toContain("lf-cache");
  });
  it("reads remote settings from env", () => {
    const c = loadConfig({ LF_REMOTE_MODEL: "m", LF_REMOTE_API_KEY: "sk-secret-1234" });
    expect(c.remoteModel.model).toBe("m");
    expect(c.remoteModel.apiKey).toBe("sk-secret-1234");
  });
  it("accepts the Conversational BI names (LLM_*) and prefers LF_REMOTE_*", () => {
    const a = loadConfig({ LLM_BASE_URL: "https://gw.example/v1", LLM_MODEL: "gpt-x", LLM_API_KEY: "k1" });
    expect(a.remoteModel).toMatchObject({ baseUrl: "https://gw.example/v1", model: "gpt-x", apiKey: "k1" });
    const b = loadConfig({ LLM_MODEL: "old", LF_REMOTE_MODEL: "new" });
    expect(b.remoteModel.model).toBe("new");
  });
  it("fails with a readable message on invalid values", () => {
    expect(() => loadConfig({}, { engine: { threads: -1 } })).toThrow(ConfigError);
    expect(() => loadConfig({}, { privacy: { tabularLevel: "all" } })).toThrow(/privacy\.tabularLevel/);
    expect(() => loadConfig({}, { privacy: { denyColumns: ["("] } })).toThrow(/regular expression/);
  });
  it("never leaks the API key or remote URL in a dump", () => {
    const c = loadConfig({
      LF_REMOTE_API_KEY: "sk-secret-1234",
      LF_REMOTE_BASE_URL: "https://private.example.internal",
    });
    const dump = JSON.stringify(redactConfig(c));
    expect(dump).not.toContain("sk-secret-1234");
    expect(dump).not.toContain("private.example");
  });
});
