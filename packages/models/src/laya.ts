import type { DecisionModelPort, DecisionSignals, EffortLevel } from "@lf/core";
import questions from "./laya-questions.json";

/**
 * Client for the Laya decision-model service (`npm run laya:serve`, an HTTP server on loopback).
 * Laya never generates text: for one question it returns typed answers with probabilities. We turn them into the
 * DecisionSignals the effort estimate uses. The question wording lives in laya-questions.json and is shared with the
 * Python training scripts, so a fine-tuned checkpoint sees exactly the same questions.
 */

export const LAYA_QUESTIONS = questions;

interface ChoiceAnswer {
  choice?: string;
  probabilities?: Record<string, number>;
  answer_confidence?: number;
  confidence?: number;
}

export interface LayaOptions {
  baseUrl: string;
  /** Checkpoint name sent as `model` (for example "typed-decisions"); omit to let the server choose. */
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  apiKey?: string;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** P(yes) from a two-option choice answer. */
function pYes(a: ChoiceAnswer | undefined): number | undefined {
  if (!a) return undefined;
  const p = a.probabilities?.yes;
  if (typeof p === "number") return clamp01(p);
  if (a.choice) return a.choice === "yes" ? clamp01(a.answer_confidence ?? 0.5) : clamp01(1 - (a.answer_confidence ?? 0.5));
  return undefined;
}

export function answersToSignals(answers: Record<string, ChoiceAnswer>): DecisionSignals {
  const out: DecisionSignals = {};
  const r = pYes(answers.needs_reasoning);
  const m = pYes(answers.multi_step);
  const a = pYes(answers.ambiguous);
  if (r !== undefined) out.needsReasoning = r;
  if (m !== undefined) out.multiStep = m;
  if (a !== undefined) out.ambiguous = a;
  const e = answers.effort;
  if (e?.choice && ["low", "medium", "high"].includes(e.choice)) {
    out.effort = { label: e.choice as EffortLevel, confidence: clamp01(e.answer_confidence ?? e.probabilities?.[e.choice] ?? 0.34) };
  }
  return out;
}

export class LayaClient implements DecisionModelPort {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly o: LayaOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async health(): Promise<boolean> {
    try {
      const r = await this.fetchImpl(`${this.o.baseUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async decide(question: string): Promise<DecisionSignals | null> {
    const res = await this.fetchImpl(`${this.o.baseUrl.replace(/\/$/, "")}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
      body: JSON.stringify({ state: question, questions: LAYA_QUESTIONS, ...(this.o.model ? { model: this.o.model } : {}) }),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`Laya returned HTTP ${res.status}`);
    const j = (await res.json()) as { answers?: Record<string, ChoiceAnswer> };
    return j.answers ? answersToSignals(j.answers) : null;
  }
}
