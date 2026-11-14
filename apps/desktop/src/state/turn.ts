import type { TurnEvent } from "@lf/core";

/** One entry per question. Built only from the agent's real TurnEvents (one reducer for the whole UI). */

export type FinalEvent = Extract<TurnEvent, { type: "final" }>;
export type EgressEvent = Extract<TurnEvent, { type: "egress" }>;
export type RouteEvent = Extract<TurnEvent, { type: "route" }>;

export interface Stamped {
  /** milliseconds since the question was sent */
  t: number;
  event: TurnEvent;
}

export interface StepRecord {
  step: string;
  status: "running" | "done" | "skip" | "error";
  detail: string;
  data?: Record<string, unknown>;
  startedAt: number;
  endedAt?: number;
}

export interface EgressItem {
  egressId: string;
  t: number;
  summary: string;
  detail?: EgressEvent["detail"];
  outcome: "pending" | "approved" | "cancelled";
}

export interface TurnState {
  id: string;
  question: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "confirm" | "done" | "error";
  events: Stamped[];
  steps: StepRecord[];
  routes: (Pick<RouteEvent, "route" | "layer" | "reasons"> & { t: number })[];
  egress: EgressItem[];
  confirm: { egressId: string; preview: string } | null;
  text: string;
  final: FinalEvent | null;
  suggestions: string[];
  error: { code: string; message: string } | null;
}

export function newTurn(id: string, question: string, now: number): TurnState {
  return {
    id, question, startedAt: now, status: "running", events: [], steps: [], routes: [], egress: [],
    confirm: null, text: "", final: null, suggestions: [], error: null,
  };
}

export type TurnAction = { kind: "event"; event: TurnEvent; now: number } | { kind: "confirmed"; approved: boolean };

export function reduceTurn(s: TurnState, a: TurnAction): TurnState {
  if (a.kind === "confirmed") {
    const egress = s.egress.map((e, i) => (i === s.egress.length - 1 && e.outcome === "pending" ? { ...e, outcome: a.approved ? ("approved" as const) : ("cancelled" as const) } : e));
    return { ...s, confirm: null, egress, status: s.status === "confirm" ? "running" : s.status };
  }
  const t = Math.max(0, a.now - s.startedAt);
  const e = a.event;
  const next: TurnState = { ...s, events: [...s.events, { t, event: e }] };
  switch (e.type) {
    case "trace": {
      const steps = [...s.steps];
      const base = { detail: e.detail, ...(e.data ? { data: e.data } : {}) };
      if (e.status === "start") {
        steps.push({ step: e.step, status: "running", startedAt: t, ...base });
      } else {
        const i = steps.map((x) => x.step === e.step && x.status === "running").lastIndexOf(true);
        const status = e.status;
        if (i >= 0) steps[i] = { ...steps[i]!, status, endedAt: t, ...base };
        else steps.push({ step: e.step, status, startedAt: t, endedAt: t, ...base });
      }
      return { ...next, steps };
    }
    case "route":
      return { ...next, routes: [...s.routes, { route: e.route, layer: e.layer, reasons: e.reasons, t }] };
    case "egress":
      return { ...next, egress: [...s.egress, { egressId: e.egressId, t, summary: e.summary, ...(e.detail ? { detail: e.detail } : {}), outcome: "pending" }] };
    case "confirm":
      return { ...next, confirm: { egressId: e.egressId, preview: e.preview }, status: "confirm" };
    case "text":
      return { ...next, text: s.text + e.delta };
    case "text-reset":
      return { ...next, text: "" };
    case "final": {
      // A send that was never cancelled and reached the final answer counts as approved/auto.
      const egress = s.egress.map((x) => (x.outcome === "pending" ? { ...x, outcome: "approved" as const } : x));
      return { ...next, final: e, egress, status: "done", endedAt: a.now, confirm: null };
    }
    case "suggestions":
      return { ...next, suggestions: e.items };
    case "error":
      return { ...next, error: { code: e.code, message: e.message }, status: "error", endedAt: a.now, confirm: null };
  }
}
