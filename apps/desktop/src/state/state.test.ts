import { describe, expect, it } from "vitest";
import type { TurnEvent } from "@lf/core";
import { derivePipeline } from "./pipeline";
import { newTurn, reduceTurn, type TurnState } from "./turn";

/** Replays a recorded event sequence through the reducer with a fake clock (100 ms apart). */
function play(events: TurnEvent[], onConfirm?: "approve" | "cancel"): TurnState {
  let s = newTurn("t1", "q", 0);
  let now = 0;
  for (const event of events) {
    now += 100;
    s = reduceTurn(s, { kind: "event", event, now });
    if (event.type === "confirm" && onConfirm) s = reduceTurn(s, { kind: "confirmed", approved: onConfirm === "approve" });
  }
  return s;
}

const trace = (step: string, status: "start" | "done" | "skip" | "error", detail = "", data?: Record<string, unknown>): TurnEvent => ({ type: "trace", step, status, detail, ...(data ? { data } : {}) });
const finalEv = (route: "local" | "remote", extra: Partial<Extract<TurnEvent, { type: "final" }>> = {}): TurnEvent => ({
  type: "final", answer: "There are 274,496 policies.", route: { route, layer: route === "local" ? 4 : 2, reasons: [], attempts: 1 }, filesUsed: ["policies"], ...extra,
});

const LOCAL_SIMPLE: TurnEvent[] = [
  trace("schema", "start"), trace("schema", "done", "1 table(s), 5 columns in scope", { tablesNeeded: ["t_policies"] }),
  trace("classify", "start"), trace("classify", "done", "aggregate (confidence 0.90)", { type: "aggregate", confidence: 0.9 }),
  { type: "route", route: "local", layer: 4, reasons: ['question type "aggregate" can be answered locally'] },
  trace("local-sql", "start"), trace("local-sql", "done", "Local model wrote SQL", { sql: "SELECT COUNT(*) FROM t_policies", confidence: 0.95 }),
  trace("verify", "done", "1 row(s), checks passed"),
  trace("answer", "start"), trace("answer", "done", "local"),
  { type: "text", delta: "There are " }, { type: "text", delta: "274,496 policies." },
  finalEv("local", { sql: ["SELECT COUNT(*) FROM t_policies"] }),
  { type: "suggestions", items: ["How many claims?"] },
];

const ESCALATED: TurnEvent[] = [
  trace("schema", "start"), trace("schema", "done", "2 table(s)"),
  { type: "route", route: "remote", layer: 2, reasons: ["needs 2 tables (local limit 1)"] },
  trace("remote-sql", "start"),
  { type: "egress", egressId: "e1", destination: "remote-model", summary: "write-sql: schema (4060 bytes)", detail: { purpose: "write-sql", privacyLevel: "rows", bytes: 4060, rows: 40, tables: ["t_policies"], columns: ["t_policies.region"], summarized: false, preview: "{}" } },
  { type: "confirm", egressId: "e1", preview: "{}" },
  trace("remote-sql", "done", "1 query ran locally", { queries: ["SELECT 1"] }),
  { type: "text", delta: "Answer." }, finalEv("remote"),
];

describe("turn reducer", () => {
  it("local simple: steps, route, text and final", () => {
    const s = play(LOCAL_SIMPLE);
    expect(s.status).toBe("done");
    expect(s.text).toBe("There are 274,496 policies.");
    expect(s.steps.map((x) => [x.step, x.status])).toEqual([["schema", "done"], ["classify", "done"], ["local-sql", "done"], ["verify", "done"], ["answer", "done"]]);
    expect(s.steps[2]!.data).toMatchObject({ sql: "SELECT COUNT(*) FROM t_policies" });
    expect(s.routes).toHaveLength(1);
    expect(s.egress).toHaveLength(0);
    expect(s.suggestions).toEqual(["How many claims?"]);
    expect(s.events.at(-1)!.t).toBe(1400);
  });
  it("escalated with confirm approved", () => {
    const s = play(ESCALATED, "approve");
    expect(s.status).toBe("done");
    expect(s.confirm).toBeNull();
    expect(s.egress).toHaveLength(1);
    expect(s.egress[0]).toMatchObject({ outcome: "approved" });
    expect(s.egress[0]!.detail?.bytes).toBe(4060);
  });
  it("waits at the confirm step until answered", () => {
    const s = play(ESCALATED.slice(0, 6));
    expect(s.status).toBe("confirm");
    expect(s.confirm).toMatchObject({ egressId: "e1" });
  });
  it("escalated with confirm cancelled keeps the answer local", () => {
    const events: TurnEvent[] = [
      ...ESCALATED.slice(0, 6), trace("remote-sql", "error", "Sending to the remote model was cancelled, so the answer stays local."),
      { type: "route", route: "local", layer: 6, reasons: ["answered locally because the remote step did not complete"] },
      finalEv("local"),
    ];
    const s = play(events, "cancel");
    expect(s.egress[0]!.outcome).toBe("cancelled");
    expect(s.routes.map((r) => r.route)).toEqual(["remote", "local"]);
    expect(s.final!.route.route).toBe("local");
  });
  it("error mid-stream ends the turn with the message", () => {
    const s = play([trace("schema", "start"), { type: "error", code: "NO_MODEL", message: "No model available." }]);
    expect(s.status).toBe("error");
    expect(s.error).toEqual({ code: "NO_MODEL", message: "No model available." });
    expect(s.steps[0]!.status).toBe("running");
  });
  it("text-reset clears the streamed text", () => {
    const s = play([{ type: "text", delta: "abc" }, { type: "text-reset" }, { type: "text", delta: "xyz" }]);
    expect(s.text).toBe("xyz");
  });
  it("a document answer keeps its citations", () => {
    const s = play([
      trace("documents", "start"), trace("documents", "done", "6 passage(s)", { passages: [{ ref: "underwriting_guidelines p4", score: 143, snippet: "x" }] }),
      { type: "route", route: "local", layer: 4, reasons: ["lookup answerable from a few passages"] },
      trace("answer", "start"),
      finalEv("local", { citations: [{ fileAlias: "underwriting_guidelines", page: 4, snippet: "USD 25 million" }], filesUsed: ["underwriting_guidelines"] }),
    ]);
    expect(s.final!.citations![0]).toMatchObject({ fileAlias: "underwriting_guidelines", page: 4 });
  });
});

describe("pipeline derivation", () => {
  it("local simple: remote lane is skipped and nothing crossed the boundary", () => {
    const p = derivePipeline(play(LOCAL_SIMPLE));
    expect(p.mode).toBe("table");
    expect(p.route).toBe("local");
    expect(p.crossed).toBe(false);
    expect(p.nodes.gate.status).toBe("skipped");
    expect(p.nodes.remote.status).toBe("skipped");
    expect(p.nodes.local.status).toBe("done");
    expect(p.nodes.verify.status).toBe("done");
    expect(p.nodes.answer.status).toBe("done");
    expect(p.now).toMatch(/entirely on this laptop/);
    expect(p.edges.find((e) => e.from === "router" && e.to === "gate")!.state).toBe("skipped");
  });
  it("escalated: the local lane is skipped and the boundary was crossed", () => {
    const p = derivePipeline(play(ESCALATED, "approve"));
    expect(p.route).toBe("remote");
    expect(p.crossed).toBe(true);
    expect(p.nodes.local.status).toBe("skipped");
    expect(p.nodes.egress.status).toBe("done");
    expect(p.nodes.exec.status).toBe("done");
    expect(p.now).toMatch(/remote model/);
  });
  it("waiting at confirm: gate is waiting and remote has not started", () => {
    const p = derivePipeline(play(ESCALATED.slice(0, 6)));
    expect(p.waitingForConfirm).toBe(true);
    expect(p.nodes.gate.status).toBe("waiting");
    expect(p.nodes.remote.status).toBe("idle");
    expect(p.now).toMatch(/Nothing leaves this laptop until you approve/);
  });
  it("replay at an earlier moment shows only what had happened by then", () => {
    const s = play(LOCAL_SIMPLE);
    const early = derivePipeline(s, 250); // after schema done, classify started
    expect(early.nodes.prep.status).toBe("done");
    expect(early.nodes.local.status).toBe("idle");
    expect(early.nodes.answer.status).toBe("idle");
    const mid = derivePipeline(s, 650); // the local model is still writing SQL
    expect(mid.route).toBe("local");
    expect(mid.nodes.local.status).toBe("active");
    expect(derivePipeline(s, 750).nodes.local.status).toBe("done");
  });
  it("document turns use the documents layout", () => {
    const s = play([
      trace("documents", "start"), trace("documents", "done", "3 passage(s)"),
      { type: "route", route: "remote", layer: 2, reasons: ["summary, comparison or list across passages"] },
      trace("remote-docs", "start"),
      { type: "egress", egressId: "e2", destination: "remote-model", summary: "answer-from-chunks: 3 chunks" },
      trace("remote-docs", "done", "answered"),
      finalEv("remote"),
    ]);
    const p = derivePipeline(s);
    expect(p.mode).toBe("doc");
    expect(p.nodes.prep.status).toBe("done");
    expect(p.crossed).toBe(true);
  });
  it("an error leaves the answer node in error", () => {
    const p = derivePipeline(play([trace("schema", "start"), { type: "error", code: "AGENT", message: "boom" }]));
    expect(p.nodes.answer.status).toBe("error");
    expect(p.now).toMatch(/boom/);
  });
});
