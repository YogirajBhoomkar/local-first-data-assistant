import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RuleClassifier, loadConfig, type ChatModelPort, type GenerateRequest, type GenerateResult, type TurnEvent } from "@lf/core";
import { DocumentStore } from "@lf/docs";
import { DuckDbEngine } from "@lf/engine";
import { MockModelAdapter } from "@lf/models";
import { EgressLog, TableAgent } from "./index.js";
import { checkDocAnswer, citedRefs } from "./prompts/local-doc.js";

const DOC_FX = resolve(import.meta.dirname, "../../docs/test/fixtures");
const sys = (r: GenerateRequest) => r.system ?? "";

class Spy implements ChatModelPort {
  calls: GenerateRequest[] = [];
  constructor(private readonly reply: (r: GenerateRequest) => Partial<GenerateResult>) {}
  async generate(r: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(r);
    return { usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 1, modelId: "spy", ...this.reply(r) };
  }
  async *stream() { /* unused */ }
  async health() { return { ok: true, modelId: "spy", detail: "" }; }
}

describe("document answer checks", () => {
  const chunk = (alias: string, page: number, score = 10) => ({ id: `${alias}${page}`, fileAlias: alias, kind: "pdf" as const, location: { page }, text: "x", charCount: 1, score });
  it("parses citations", () => expect(citedRefs("A [guidelines p4] and [deck slide7].")).toEqual(["guidelines p4", "deck slide7"]));
  it("passes with a given citation", () => expect(checkDocAnswer("Yes [guidelines p4]", [chunk("guidelines", 4)], 50).ok).toBe(true));
  it("fails without a citation", () => expect(checkDocAnswer("Yes.", [chunk("guidelines", 4)], 50).reasons).toContain("answer has no citation"));
  it("fails when citing a chunk it was not given", () =>
    expect(checkDocAnswer("Yes [guidelines p9]", [chunk("guidelines", 4)], 50).reasons.join()).toMatch(/not given/));
  it("fails NOT FOUND when the match was strong, accepts it when weak", () => {
    expect(checkDocAnswer("NOT FOUND", [chunk("g", 1, 100)], 50).ok).toBe(false);
    expect(checkDocAnswer("NOT FOUND", [chunk("g", 1, 5)], 50)).toMatchObject({ ok: true, notFound: true });
  });
});

describe("TableAgent on documents", () => {
  const cache = mkdtempSync(join(tmpdir(), "lf-docagent-"));
  const engine = new DuckDbEngine({ cacheDir: cache });
  const store = new DocumentStore({ cacheDir: cache, resolvePath: (e) => engine.pathOf(e) });
  beforeAll(async () => {
    const entries = await engine.scanFolder(DOC_FX);
    await engine.registerFiles(entries);
    await store.index(entries);
  }, 60000);
  afterAll(async () => {
    await engine.close();
    rmSync(cache, { recursive: true, force: true });
  });

  let n = 0;
  function make(local: ChatModelPort | null, remote: Spy | null, over: Record<string, unknown> = {}) {
    const dir = join(cache, `run${++n}`);
    const config = loadConfig({}, {
      cacheDir: dir,
      remoteModel: { baseUrl: "https://private.example.internal/v1", model: "big", apiKey: "sk-x" },
      privacy: { confirmBeforeSend: false },
      ...over,
    });
    return {
      log: new EgressLog(dir),
      agent: new TableAgent({ config, engine, local, classifier: new RuleClassifier(), maskKey: "k", docs: store, ...(remote ? { remoteFactory: () => remote } : {}) }),
    };
  }
  async function ask(agent: TableAgent, q: string) {
    const events: TurnEvent[] = [];
    for await (const e of agent.ask({ turnId: `t${++n}`, question: q, history: [], context: { folderSelected: true } })) events.push(e);
    return { events, final: events.find((e) => e.type === "final") as Extract<TurnEvent, { type: "final" }> };
  }
  const localDoc = (text: string) => new MockModelAdapter([{ match: (r) => sys(r).includes("using ONLY the excerpts below"), reply: { text } }], "local");

  it("a lookup is answered locally with citations, sending nothing", async () => {
    const { agent, log } = make(localDoc("The limit is USD 25 million. [underwriting_guidelines p4]"), new Spy(() => { throw new Error("remote must not be called"); }));
    const { events, final } = await ask(agent, "What does the guideline say about the maximum single-risk limit for Property?");
    expect(events.find((e) => e.type === "route")).toMatchObject({ route: "local", layer: 4 });
    expect(final.answer).toContain("25 million");
    expect(final.citations![0]).toMatchObject({ fileAlias: "underwriting_guidelines", page: 4 });
    expect(final.citations![0]!.snippet.length).toBeLessThanOrEqual(200);
    expect(final.filesUsed).toEqual(["underwriting_guidelines"]);
    expect(await log.readAll()).toHaveLength(0);
  });

  it("a slide lookup cites the slide", async () => {
    const { agent } = make(localDoc("Retention target is 88 percent. [portfolio_review slide4]"), null);
    const { final } = await ask(agent, "What is the renewal retention target for next year according to the speaker note?");
    expect(final.citations![0]).toMatchObject({ fileAlias: "portfolio_review", slide: 4 });
  });

  it("a local answer citing a chunk it was not given escalates to the remote model with only the top chunks", async () => {
    const remote = new Spy(() => ({ text: "USD 25 million [underwriting_guidelines p4]" }));
    const { agent, log } = make(localDoc("Probably 25 million [underwriting_guidelines p19]"), remote);
    const { events, final } = await ask(agent, "What does the guideline say about the maximum single-risk limit for Property?");
    const routes = events.filter((e): e is Extract<TurnEvent, { type: "route" }> => e.type === "route");
    expect(routes.at(-1)).toMatchObject({ route: "remote", layer: 5 });
    expect(routes.at(-1)!.reasons.join(" ")).toMatch(/not given/);
    expect(final.answer).toContain("25 million");
    const recs = await log.readAll();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ purpose: "answer-from-chunks", outcome: "sent" });
    const sent = JSON.parse(remote.calls[0]!.messages[0]!.content) as { chunks: { ref: string; text: string }[] };
    expect(sent.chunks.length).toBeLessThanOrEqual(10); // the default docTopK
    expect(sent.chunks.reduce((s, c) => s + c.text.length, 0)).toBeLessThanOrEqual(12000);
    expect(JSON.stringify(sent)).not.toMatch(/\.pdf|\.pptx|C:\\|Users/); // aliases only, never file names or paths
  });

  it("a summary escalates at layer 2 and the remote answer carries citations", async () => {
    const remote = new Spy(() => ({ text: "Referrals go to the CUO above USD 5 million [underwriting_guidelines p3]." }));
    const { agent } = make(localDoc("unused"), remote);
    const { events, final } = await ask(agent, "Summarise the referral and authority rules in the underwriting guidelines.");
    expect(events.find((e) => e.type === "route")).toMatchObject({ route: "remote", layer: 2 });
    expect(final.citations![0]).toMatchObject({ fileAlias: "underwriting_guidelines", page: 3 });
  });

  it("nothing relevant: says so, sends nothing, calls no model", async () => {
    const local = new Spy(() => { throw new Error("no model call expected"); });
    const { agent, log } = make(local, new Spy(() => { throw new Error("no remote call expected"); }));
    const { final } = await ask(agent, "What does the document say about chocolate cake recipes?");
    expect(final.answer).toMatch(/could not find relevant content/);
    expect(final.citations).toEqual([]);
    expect(await log.readAll()).toHaveLength(0);
    expect(local.calls).toHaveLength(0);
  });

  it("remote disabled: a failing local check gives a clear partial answer", async () => {
    const { agent } = make(localDoc("It is about 25 million."), null, { remoteModel: { enabled: false } });
    const { final } = await ask(agent, "What does the guideline say about the maximum single-risk limit for Property?");
    expect(final.route.route).toBe("local");
    expect(final.answer).toMatch(/Not verified: answer has no citation/);
  });

  it("no local model: remote-only mode answers from chunks", async () => {
    const remote = new Spy(() => ({ text: "Flood deductible is 5 percent [underwriting_guidelines p9]." }));
    const { agent } = make(null, remote);
    const { events, final } = await ask(agent, "What is the mandatory deductible for properties in flood zone A?");
    expect(events.find((e) => e.type === "route")!).toMatchObject({ route: "remote" });
    expect(final.citations![0]).toMatchObject({ page: 9 });
  });

  it("cancelling the confirm keeps the question local with an explanation", async () => {
    const remote = new Spy(() => ({ text: "x" }));
    const { agent } = make(localDoc("Probably 25 million."), remote, { privacy: { confirmBeforeSend: true } });
    const events: TurnEvent[] = [];
    for await (const e of agent.ask({ turnId: "tc", question: "What does the guideline say about the maximum single-risk limit for Property?", history: [], context: { folderSelected: true } })) {
      events.push(e);
      if (e.type === "confirm") agent.confirm(e.egressId, false);
    }
    expect(remote.calls).toHaveLength(0);
    const final = events.find((e) => e.type === "final") as Extract<TurnEvent, { type: "final" }>;
    expect(final.answer).toMatch(/cancelled/);
  });
});
