import { describe, expect, it } from "vitest";
import { AskRequestSchema, CancelSchema, ConfirmSchema, EgressQuerySchema, SettingsSchema, SettingsUpdateSchema } from "./ipc";

describe("IPC validation (preload -> main -> agent)", () => {
  it("accepts a well-formed question", () => {
    const r = AskRequestSchema.parse({ turnId: "t1", question: "How many policies?", history: [{ role: "user", text: "hi" }] });
    expect(r.question).toBe("How many policies?");
  });
  it("rejects empty or oversized questions and unknown roles", () => {
    expect(() => AskRequestSchema.parse({ turnId: "t1", question: "", history: [] })).toThrow();
    expect(() => AskRequestSchema.parse({ turnId: "t1", question: "x".repeat(4001), history: [] })).toThrow();
    expect(() => AskRequestSchema.parse({ turnId: "t1", question: "ok", history: [{ role: "system", text: "x" }] })).toThrow();
    expect(() => AskRequestSchema.parse({ turnId: "t1", question: "ok" })).toThrow();
    expect(() => AskRequestSchema.parse("not an object")).toThrow();
  });
  it("rejects too many history entries", () => {
    const history = Array.from({ length: 41 }, () => ({ role: "user" as const, text: "x" }));
    expect(() => AskRequestSchema.parse({ turnId: "t", question: "q", history })).toThrow();
  });
  it("validates confirm, cancel and log queries", () => {
    expect(ConfirmSchema.parse({ egressId: "e1", approved: true }).approved).toBe(true);
    expect(() => ConfirmSchema.parse({ egressId: "e1", approved: "yes" })).toThrow();
    expect(() => CancelSchema.parse({})).toThrow();
    expect(EgressQuerySchema.parse({}).limit).toBe(100);
    expect(() => EgressQuerySchema.parse({ limit: 100000 })).toThrow();
  });
});

describe("settings schema", () => {
  it("fills every default", () => {
    const s = SettingsSchema.parse({});
    expect(s.theme).toBe("dark");
    expect(s.privacy).toMatchObject({ tabularLevel: "rows", confirmBeforeSend: true, maxRowsSent: 500, docTopK: 6 });
    expect(s.localModel).toMatchObject({ enabled: true, name: null });
    expect(s.remote).toMatchObject({ enabled: true, baseUrl: "", provider: "openai-compatible" });
    expect(s.history.turns).toBe(3);
  });
  it("rejects invalid values", () => {
    expect(() => SettingsSchema.parse({ privacy: { tabularLevel: "everything" } })).toThrow();
    expect(() => SettingsSchema.parse({ privacy: { maxRowsSent: 0 } })).toThrow();
    expect(() => SettingsSchema.parse({ theme: "neon" })).toThrow();
    expect(() => SettingsSchema.parse({ localModel: { baseUrl: "not a url" } })).toThrow();
  });
  it("the API key is write-only and size-limited in an update", () => {
    expect(SettingsUpdateSchema.parse({ apiKey: "sk-abc" }).apiKey).toBe("sk-abc");
    expect(SettingsUpdateSchema.parse({ apiKey: "" }).apiKey).toBe("");
    expect(() => SettingsUpdateSchema.parse({ apiKey: "x".repeat(501) })).toThrow();
  });
});
