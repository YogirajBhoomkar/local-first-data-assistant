import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TurnEvent } from "@lf/core";
import { SettingsSchema, type AgentMessage, type FolderView } from "../shared/ipc";
import { AgentRuntime, settingsToOverrides } from "./runtime";

const ENGINE_FX = resolve(import.meta.dirname, "../../../packages/engine/test/fixtures");
const DOCS_FX = resolve(import.meta.dirname, "../../../packages/docs/test/fixtures");

describe("settingsToOverrides", () => {
  const defaults = SettingsSchema.parse({});
  it("leaves empty remote fields out so the environment can supply them", () => {
    const o = settingsToOverrides(defaults, null, "/data") as { remoteModel: Record<string, unknown> };
    expect(o.remoteModel).toEqual({ enabled: true, provider: "openai-compatible" });
  });
  it("passes saved remote values and the key through, and builds the cache path", () => {
    const s = SettingsSchema.parse({ remote: { baseUrl: "https://gw.example/v1", model: "m" } });
    const o = settingsToOverrides(s, "sk-1234", "/data") as { remoteModel: Record<string, unknown>; cacheDir: string };
    expect(o.remoteModel).toMatchObject({ baseUrl: "https://gw.example/v1", model: "m", apiKey: "sk-1234" });
    expect(o.cacheDir).toContain("lf-cache");
  });
  it("carries privacy and history settings", () => {
    const s = SettingsSchema.parse({ privacy: { tabularLevel: "schema", denyColumns: ["ssn"] }, history: { turns: 1 } });
    const o = settingsToOverrides(s, null, "/data") as { privacy: Record<string, unknown>; history: { turns: number } };
    expect(o.privacy).toMatchObject({ tabularLevel: "schema", denyColumns: ["ssn"] });
    expect(o.history.turns).toBe(1);
  });
});

describe("AgentRuntime (real engine and document index, no models)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lf-rt-"));
  const data = join(dir, "data");
  const userData = join(dir, "userdata");
  const messages: AgentMessage[] = [];
  const rt = new AgentRuntime((m) => messages.push(m), {}); // empty environment: no remote model
  let folder: FolderView;

  beforeAll(async () => {
    cpSync(ENGINE_FX, data, { recursive: true });
    cpSync(DOCS_FX, data, { recursive: true });
    // local model off: this test must never depend on what is installed on the machine
    await rt.init(SettingsSchema.parse({ localModel: { enabled: false } }), null, userData);
    folder = await rt.selectFolder(data);
  }, 120000);
  afterAll(async () => {
    await rt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers tables and documents and reports every file with a status", () => {
    expect(folder.ready).toBe(true);
    expect(folder.folderName).toBe("data"); // folder name only, never the path
    expect(JSON.stringify(folder)).not.toContain(tmpdir());
    const names = folder.files.map((f) => f.alias).sort();
    expect(names).toEqual(readdirSync(data).map((f) => f.replace(/\.[a-z0-9]+$/, "")).sort());
    const by = Object.fromEntries(folder.files.map((f) => [f.alias, f]));
    expect(by.policies!.status).toBe("ready");
    expect(by.exposures!.status).toBe("ready");
    expect(by.budget!.tables).toEqual(expect.arrayContaining(["t_budget_plan", "t_budget_actuals"]));
    expect(by.underwriting_guidelines!.status).toBe("indexed");
    expect(by.portfolio_review!.status).toBe("indexed");
  });
  it("flags the messy workbook and skips the scanned PDF with a reason", () => {
    const by = Object.fromEntries(folder.files.map((f) => [f.alias, f]));
    expect(by.messy!.status).toBe("warning");
    expect(by.messy!.notes.join(" ")).toMatch(/title row/);
    expect(by.scanned_notes!.status).toBe("skipped");
    expect(by.scanned_notes!.notes.join(" ")).toMatch(/OCR not supported/);
  });
  it("sends an early not-ready listing, then the final one", () => {
    const listings = messages.filter((m): m is Extract<AgentMessage, { type: "files" }> => m.type === "files");
    expect(listings.length).toBeGreaterThanOrEqual(2);
    expect(listings[0]!.folder.ready).toBe(false);
    expect(listings.at(-1)!.folder.ready).toBe(true);
    expect(listings[0]!.folder.files.find((f) => f.alias === "budget")!.status).toBe("converting");
  });
  it("builds example questions from the real files", () => {
    expect(folder.examples.length).toBeGreaterThan(0);
    expect(folder.examples.length).toBeLessThanOrEqual(4);
    expect(folder.examples.join(" ")).toMatch(/policies|claims|budget|exposures/);
  });
  it("with no model available, a question fails clearly instead of hanging", async () => {
    const events: TurnEvent[] = [];
    const done = new Promise<void>((ok) => {
      const original = messages.push.bind(messages);
      messages.push = (...m: AgentMessage[]) => {
        for (const x of m) if (x.type === "event" && x.turnId === "tq") { events.push(x.event); if (x.event.type === "error" || x.event.type === "final") ok(); }
        return original(...m);
      };
    });
    rt.ask({ turnId: "tq", question: "How many policies are there?", history: [] });
    await done;
    expect(events.at(-1)).toMatchObject({ type: "error", code: "NO_MODEL" });
  });
  it("reports the model status honestly", () => {
    const s = rt.getStatus();
    expect(s.local.available).toBe(false);
    expect(s.local.reason).toMatch(/turned off/);
    expect(s.remote.available).toBe(false);
  });
  it("cancel is safe for an unknown turn, and the egress log starts empty", async () => {
    expect(() => rt.cancel("nope")).not.toThrow();
    expect(await rt.egressLog(10)).toEqual([]);
  });
});
