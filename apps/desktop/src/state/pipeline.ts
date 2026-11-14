import type { TurnState } from "./turn";

/**
 * The "Under the hood" model: which stage of the real pipeline is doing what right now.
 * Derived only from the turn's recorded events, so it can be replayed at any point in time.
 */

export type NodeId = "question" | "prep" | "router" | "local" | "exec" | "verify" | "gate" | "egress" | "remote" | "answer";
export type NodeStatus = "idle" | "active" | "done" | "skipped" | "error" | "waiting";
export type Mode = "table" | "doc";

export interface NodeState {
  status: NodeStatus;
  /** Duration in ms once finished, or elapsed so far while active. */
  ms?: number;
  detail?: string;
}

export interface EdgeDef {
  from: NodeId;
  to: NodeId;
  /** which lane this edge belongs to */
  lane: "common" | "local" | "remote";
}

export const EDGES: EdgeDef[] = [
  { from: "question", to: "prep", lane: "common" },
  { from: "prep", to: "router", lane: "common" },
  { from: "router", to: "local", lane: "local" },
  { from: "local", to: "exec", lane: "local" },
  { from: "exec", to: "verify", lane: "local" },
  { from: "verify", to: "answer", lane: "local" },
  { from: "router", to: "gate", lane: "remote" },
  { from: "gate", to: "egress", lane: "remote" },
  { from: "egress", to: "remote", lane: "remote" },
  { from: "remote", to: "answer", lane: "remote" },
];

export interface EdgeState extends EdgeDef {
  state: "idle" | "active" | "done" | "skipped";
}

export interface PipelineView {
  mode: Mode;
  nodes: Record<NodeId, NodeState>;
  edges: EdgeState[];
  /** The chosen route, once known. */
  route: "local" | "remote" | null;
  /** True once anything has crossed the laptop boundary (or is waiting to). */
  crossed: boolean;
  waitingForConfirm: boolean;
  /** The sentence being narrated right now. */
  now: string;
}

const idle = (): NodeState => ({ status: "idle" });

/** `upTo` (ms since the question was sent) replays an earlier moment; omitted = everything so far. */
export function derivePipeline(turn: TurnState, upTo?: number, clockMs?: number): PipelineView {
  const limit = upTo ?? Number.POSITIVE_INFINITY;
  const events = turn.events.filter((e) => e.t <= limit);
  const live = upTo === undefined && turn.status !== "done" && turn.status !== "error";
  const elapsed = (from: number) => (live && clockMs !== undefined ? Math.max(0, clockMs - turn.startedAt - from) : undefined);

  const mode: Mode = events.some((e) => e.event.type === "trace" && (e.event.step === "documents" || e.event.step === "remote-docs")) ? "doc" : "table";
  const nodes = Object.fromEntries((["question", "prep", "router", "local", "exec", "verify", "gate", "egress", "remote", "answer"] as NodeId[]).map((n) => [n, idle()])) as Record<NodeId, NodeState>;
  nodes.question = { status: "done" };

  const steps = turn.steps.filter((s) => s.startedAt <= limit).map((s) => ({ ...s, ended: s.endedAt !== undefined && s.endedAt <= limit }));
  const stepNode = (name: string) => steps.filter((s) => s.step === name);
  const statusOf = (list: typeof steps): NodeStatus => {
    if (list.length === 0) return "idle";
    const last = list[list.length - 1]!;
    if (!last.ended) return "active";
    return last.status === "error" ? "error" : last.status === "skip" ? "skipped" : "done";
  };
  const ms = (list: typeof steps): number | undefined => {
    if (list.length === 0) return undefined;
    const last = list[list.length - 1]!;
    return last.ended && last.endedAt !== undefined ? list.reduce((n, s) => n + ((s.endedAt ?? s.startedAt) - s.startedAt), 0) : elapsed(last.startedAt);
  };

  // prep: schema pruning (tables) or keyword search (documents)
  const prep = stepNode(mode === "doc" ? "documents" : "schema");
  nodes.prep = { status: statusOf(prep), ...(ms(prep) !== undefined ? { ms: ms(prep)! } : {}), ...(prep.at(-1) ? { detail: prep.at(-1)!.detail } : {}) };

  // router: classifier step, then the route events
  const routes = turn.routes.filter((r) => r.t <= limit);
  const classify = stepNode("classify");
  const lastRoute = routes.at(-1) ?? null;
  if (lastRoute) {
    nodes.router = { status: "done", detail: `layer ${lastRoute.layer}: ${lastRoute.reasons.join("; ") || lastRoute.route}`, ...(ms(classify) !== undefined ? { ms: ms(classify)! } : {}) };
  } else if (nodes.prep.status === "done" || nodes.prep.status === "skipped") {
    nodes.router = { status: "active", detail: "Deciding where to run this question", ...(ms(classify) !== undefined ? { ms: ms(classify)! } : {}) };
  }

  const firstRoute = routes[0]?.route ?? null;
  const route = lastRoute ? lastRoute.route : null;
  const escalated = routes.some((r) => r.route === "remote");

  // local lane
  const localSteps = mode === "doc" ? stepNode("answer") : stepNode("local-sql");
  nodes.local = { status: statusOf(localSteps), ...(ms(localSteps) !== undefined ? { ms: ms(localSteps)! } : {}), ...(localSteps.at(-1) ? { detail: localSteps.at(-1)!.detail } : {}) };
  const verify = stepNode("verify");
  if (mode === "table") {
    // DuckDB runs the SQL between "the model wrote SQL" and "checks finished"
    const wrote = stepNode("local-sql").filter((s) => s.ended && s.data?.sql);
    const remoteSql = stepNode("remote-sql");
    if (verify.length) nodes.exec = { status: "done", detail: verify.at(-1)!.detail };
    else if (wrote.length) nodes.exec = { status: "active", detail: "Running the SQL on your files (read-only)" };
    else if (remoteSql.some((s) => s.ended && s.status === "done")) nodes.exec = { status: "done", detail: "Ran the remote model's SQL locally" };
    else if (remoteSql.some((s) => s.ended && s.status === "error")) nodes.exec = { status: "error", detail: "Remote SQL failed locally" };
  } else {
    nodes.exec = { status: nodes.prep.status === "done" ? "done" : "idle", detail: "Passages with page and slide references" };
  }
  nodes.verify = { status: statusOf(verify), ...(ms(verify) !== undefined ? { ms: ms(verify)! } : {}), ...(verify.at(-1) ? { detail: verify.at(-1)!.detail } : {}) };

  // remote lane
  const egress = turn.egress.filter((e) => e.t <= limit);
  const confirmPending = !!turn.confirm && turn.status === "confirm" && upTo === undefined;
  const remoteSteps = [...stepNode("remote-sql"), ...stepNode("remote-docs")];
  if (egress.length) {
    nodes.gate = { status: confirmPending ? "waiting" : "done", detail: egress.at(-1)!.summary };
    nodes.egress = { status: "done", detail: `${egress.length} record${egress.length === 1 ? "" : "s"} written before sending` };
    const sending = !confirmPending && !turn.final && !turn.error && upTo === undefined;
    nodes.remote = { status: confirmPending ? "idle" : sending ? "active" : "done", detail: "Remote model (LiteLLM)" };
    if (remoteSteps.some((s) => s.status === "error" && s.ended)) nodes.remote.status = "error";
  } else if (escalated) {
    nodes.gate = { status: "active", detail: "Building the minimal payload" };
  }

  // lanes that were never used are shown as skipped once the route is known
  if (route === "local" && !escalated) {
    for (const id of ["gate", "egress", "remote"] as NodeId[]) nodes[id] = { status: "skipped" };
  }
  if (firstRoute === "remote" && !routes.some((r) => r.route === "local") && nodes.local.status === "idle") {
    for (const id of ["local", "exec", "verify"] as NodeId[]) if (nodes[id].status === "idle") nodes[id] = { status: "skipped" };
  }

  // answer
  const answer = stepNode("answer");
  const finalSeen = !!turn.final && (turn.events.find((e) => e.event.type === "final")?.t ?? 0) <= limit;
  if (finalSeen) nodes.answer = { status: "done", detail: turn.final!.answer.slice(0, 120) };
  else if (turn.error && upTo === undefined) nodes.answer = { status: "error", detail: turn.error.message };
  else if (answer.some((s) => !s.ended) && mode === "table") nodes.answer = { status: "active", detail: answer.at(-1)!.detail };

  const edges: EdgeState[] = EDGES.map((e) => {
    const a = nodes[e.from].status;
    const b = nodes[e.to].status;
    let state: EdgeState["state"] = "idle";
    if (a === "skipped" || b === "skipped") state = "skipped";
    else if (b === "active" || b === "waiting") state = "active";
    else if ((a === "done" || a === "error") && (b === "done" || b === "error")) state = "done";
    return { ...e, state };
  });

  const crossed = egress.length > 0;
  const waitingForConfirm = confirmPending;
  return { mode, nodes, edges, route, crossed, waitingForConfirm, now: narrate(turn, nodes, mode, route, waitingForConfirm, finalSeen) };
}

/** One plain sentence about what is happening right now. */
function narrate(turn: TurnState, n: Record<NodeId, NodeState>, mode: Mode, route: "local" | "remote" | null, waiting: boolean, finalSeen: boolean): string {
  if (turn.error && !finalSeen) return turn.error.code === "CANCELLED" ? "Stopped. Nothing further was sent." : `Something went wrong: ${turn.error.message}`;
  if (finalSeen) return route === "remote" || turn.egress.length ? "Done. The answer used the remote model, and everything that was sent is in the log." : "Done. This was answered entirely on this laptop: nothing was sent anywhere.";
  if (waiting) return "Paused at the privacy gate. Nothing leaves this laptop until you approve the exact payload.";
  if (n.remote.status === "active") return "The minimal payload was logged first, then sent to the remote model. Waiting for its reply.";
  if (n.gate.status === "active") return "Escalating: the privacy gate is building the smallest payload that can answer this, with caps and masks applied.";
  if (n.verify.status === "active") return "Checking the local answer: did it run, return rows, look confident, and repeat on a second try?";
  if (n.exec.status === "active") return mode === "table" ? "Running the SQL on your files with DuckDB, read-only and time-limited, on this laptop." : "Collecting the best passages.";
  if (n.local.status === "active") return mode === "table" ? "The small local model is writing SQL from the pruned schema. No data has left this laptop." : "The small local model is answering from the top passages and must cite them.";
  if (n.router.status === "active") return "The router is deciding: local or remote? It checks policy, hard rules, then the question type.";
  if (n.prep.status === "active") return mode === "table" ? "Finding the few tables and columns this question needs, so the model sees a small, focused schema." : "Searching the documents with a local keyword index.";
  return "Starting.";
}
