import type { TurnEvent } from "../domain/index.js";

export interface AgentCard {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  dataPolicy: string;
}

export interface AskRequest {
  turnId: string;
  question: string;
  /** Last N turns (default 3): text only, never result rows. */
  history: { role: "user" | "assistant"; text: string }[];
  context: { folderSelected: boolean };
}

/** The one interface a host (CLI, Electron app, another host) needs. */
export interface AgentContract {
  card(): AgentCard;
  ask(req: AskRequest, signal?: AbortSignal): AsyncIterable<TurnEvent>;
  /** Reply to a `confirm` event. */
  confirm(egressId: string, approved: boolean): void;
}

export type QuestionType =
  | "lookup" | "filter" | "aggregate" | "groupby" | "topn" | "chart" | "join" | "explain" | "other";

export interface Classification {
  type: QuestionType;
  confidence: number;
}

export interface QuestionClassifier {
  classify(question: string, history: AskRequest["history"]): Promise<Classification>;
}
