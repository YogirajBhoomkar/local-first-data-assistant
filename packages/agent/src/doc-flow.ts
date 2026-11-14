import type {
  AskRequest,
  Chunk,
  ChatModelPort,
  Config,
  DocumentStorePort,
  TableSchema,
  TurnEvent,
} from "@lf/core";
import { gateNote, type GateResult, type PrivacyGate } from "./gate/gate.js";
import { buildCitations, buildLocalDocRequest, checkDocAnswer, fitChunks, LOCAL_DOC_MAX_CHARS } from "./prompts/local-doc.js";
import { tokens, type PruneResult } from "./pruning.js";

const DOC_CUES =
  /\b(guidelines?|documents?|docs?|decks?|slides?|presentations?|pdfs?|pages?|sections?|speaker notes?|according to|say about|says|mentions?|mentioned|summaris?e|summariz?e|overview|report)\b/i;
const DOC_SUMMARY =
  /\b(summaris?e|summariz?e|summary|overview|compare|comparison|across|differences?|relate|list all|all the|main (risks|points|themes))\b/i;
const DEFAULT_MIN_SCORE_HINT = 12;

export interface DocContext {
  config: Config;
  docs: DocumentStorePort;
  local: ChatModelPort | null;
  gate: PrivacyGate;
}

export interface DocPlan {
  path: "table" | "doc" | "mixed";
  reason: string;
  aliases: string[];
}

const toChunkInput = (c: Chunk) => ({
  id: c.id,
  fileAlias: c.fileAlias,
  ...(c.location.page !== undefined ? { page: c.location.page } : {}),
  ...(c.location.slide !== undefined ? { slide: c.location.slide } : {}),
  text: c.text,
});

/**
 * Decide between the table path, the documents path, and a mixed question.
 * Evidence from table and column NAMES is compared with how strongly the documents match.
 * The numbers (mixed at >= 4 name matches; documents win when their top score >= 40 + 20 x name matches)
 * were set by looking at the 45 synthetic eval questions: they are a starting point, not a law.
 */
export async function docPlan(
  question: string,
  schemas: TableSchema[],
  pruned: PruneResult,
  docs: DocumentStorePort,
): Promise<DocPlan> {
  const qTokens = new Set(tokens(question));
  const named = docs.aliases().filter((a) => {
    const t = tokens(a.replace(/_/g, " "));
    return t.length > 0 && t.every((w) => qTokens.has(w));
  });
  const cue = DOC_CUES.test(question) || named.length > 0;
  const ev = schemas.length === 0 ? 0 : Math.max(0, ...pruned.tables.map((t) => t.nameEvidence));
  if (cue) {
    if (ev >= 4) return { path: "mixed", reason: "mixed sources (documents and tables)", aliases: named };
    return { path: "doc", reason: named.length ? `question names a document (${named.join(", ")})` : "question refers to documents", aliases: named };
  }
  if (ev === 0) return { path: "doc", reason: "no table matches the question; trying the documents", aliases: [] };
  const top = (await docs.searchWithReason(question, { topK: 1 })).chunks[0]?.score ?? 0;
  if (top >= 40 + 20 * ev) return { path: "doc", reason: `documents match much more strongly (${top.toFixed(0)}) than the tables`, aliases: [] };
  return { path: "table", reason: "", aliases: [] };
}

export async function* docFlow(
  ctx: DocContext,
  req: AskRequest,
  plan: DocPlan,
  pruned: PruneResult,
  history: AskRequest["history"],
  signal: AbortSignal | undefined,
  routeOnly: boolean,
): AsyncGenerator<TurnEvent> {
  const { config, docs, local, gate } = ctx;
  const remoteOk = gate.available();
  const localOk = !!local;
  const reasons: string[] = [plan.reason];

  yield { type: "trace", step: "documents", status: "start", detail: "Searching the documents" };
  const found = await docs.searchWithReason(req.question, {
    topK: config.privacy.docTopK,
    ...(plan.aliases.length ? { aliases: plan.aliases } : {}),
  });
  if (found.chunks.length === 0) {
    const why = found.reason ?? "no relevant content found";
    reasons.push(why);
    yield { type: "trace", step: "documents", status: "skip", detail: why };
    yield { type: "route", route: "local", layer: 2, reasons: [...reasons] };
    if (routeOnly) return;
    const msg = `I could not find relevant content in the documents for this question (${why}).`;
    yield { type: "text", delta: msg };
    yield { type: "final", answer: msg, route: { route: "local", layer: 2, reasons, attempts: 0 }, filesUsed: [], citations: [] };
    return;
  }
  const chunks = found.chunks;
  const files = [...new Set(chunks.map((c) => c.fileAlias))];
  yield { type: "trace", step: "documents", status: "done", detail: `${chunks.length} passage(s) from ${files.join(", ")}`, data: { passages: chunks.map((c) => ({ ref: `${c.fileAlias} ${c.location.page !== undefined ? "p" + c.location.page : "slide" + c.location.slide}`, score: Number((c.score ?? 0).toFixed(1)), snippet: c.text.replace(/s+/g, " ").slice(0, 160) })) } };

  // Several documents only matter when more than one of them matches about as well as the best one.
  const bestByFile = new Map<string, number>();
  for (const c of chunks) bestByFile.set(c.fileAlias, Math.max(bestByFile.get(c.fileAlias) ?? 0, c.score ?? 0));
  const topScore = Math.max(...bestByFile.values());
  const competing = [...bestByFile.values()].filter((v) => v >= 0.7 * topScore).length > 1;
  const fits = fitChunks(chunks);
  const totalChars = chunks.reduce((n, c) => n + c.text.length, 0);
  let target: "local" | "remote" = "local";
  let layer = 4;
  if (plan.path === "mixed") {
    target = "remote";
    layer = 2;
  } else if (DOC_SUMMARY.test(req.question) || competing || totalChars > LOCAL_DOC_MAX_CHARS) {
    target = "remote";
    layer = 2;
    reasons.push(
      DOC_SUMMARY.test(req.question)
        ? "summary, comparison or list across passages"
        : competing
          ? "answer needs several documents"
          : `passages exceed ${LOCAL_DOC_MAX_CHARS} characters`,
    );
  } else if (!localOk) {
    target = "remote";
    layer = 2;
    reasons.push("no local model available");
  } else {
    reasons.push("lookup answerable from a few passages");
  }
  if (target === "remote" && !remoteOk) {
    reasons.push("remote model is disabled or not configured: answering locally");
    target = "local";
    layer = 1;
  }
  yield { type: "route", route: target, layer, reasons: [...reasons] };
  if (routeOnly) return;
  if (target === "local" && !localOk) {
    yield { type: "error", code: "NO_MODEL", message: "No local model is installed and no remote model is configured." };
    return;
  }

  let answer = "";
  let attempts = 0;
  let notes = "";
  let routeNow: "local" | "remote" = target;

  const localTry = async (strong: number) => {
    let text = "";
    try {
      text = (await local!.generate({ ...buildLocalDocRequest(req.question, fits), ...(signal ? { signal } : {}) })).text?.trim() ?? "";
    } catch (e) {
      reasons.push(`local model error: ${(e as Error).message.slice(0, 100)}`);
    }
    return { text, check: checkDocAnswer(text, fits, strong) };
  };

  if (target === "local") {
    attempts = 1;
    yield { type: "trace", step: "answer", status: "start", detail: "Local model answers from the passages" };
    const { text, check } = await localTry((config.docs.minScore ?? DEFAULT_MIN_SCORE_HINT) * 4);
    if (text && check.ok && !check.notFound) {
      answer = text;
    } else {
      reasons.push(...(text ? check.reasons : ["no local answer"]));
      if (check.notFound && check.ok) reasons.push("model could not find the answer in the passages");
      if (remoteOk) {
        routeNow = "remote";
        yield { type: "route", route: "remote", layer: 5, reasons: [...reasons, "escalating after a failed local check"] };
      } else {
        answer = check.notFound ? "I could not find the answer in the documents." : text || "I could not answer this reliably on this laptop, and the remote model is turned off.";
        notes = check.reasons.length ? ` (Not verified: ${check.reasons.join("; ")}.)` : "";
      }
    }
  }

  if (routeNow === "remote") {
    attempts += 1;
    yield { type: "trace", step: "remote-docs", status: "start", detail: "Asking the remote model with the question and the top passages only" };
    const tableInputs =
      plan.path === "mixed"
        ? pruned.tables
            .filter((t) => pruned.tablesNeeded.includes(t.tableName))
            .map((t) => ({ tableName: t.tableName, columns: t.columns.map((c) => ({ name: c.name, type: c.type })) }))
        : [];
    const g: GateResult = yield* gate.send(
      { purpose: "answer-from-chunks", question: req.question, history, chunks: chunks.map(toChunkInput), ...(tableInputs.length ? { tables: tableInputs } : {}) },
      req.turnId,
      undefined,
      signal,
    );
    if (g.status === "sent" && g.result.text) {
      answer = g.unmask(g.result.text.trim());
      yield { type: "trace", step: "remote-docs", status: "done", detail: "answered" };
    } else {
      const why = gateNote(g);
      yield { type: "trace", step: "remote-docs", status: "error", detail: why };
      const { text, check } = localOk ? await localTry(Infinity) : { text: "", check: { ok: false, notFound: false, reasons: [] as string[] } };
      if (text && check.ok && !check.notFound) {
        answer = text;
        routeNow = "local";
        yield { type: "route", route: "local", layer: 6, reasons: [...reasons, "answered locally because the remote step did not complete"] };
      } else {
        answer = "I could not answer this from the documents.";
      }
      notes = ` ${why}`;
    }
  }
  answer += notes;

  const words = answer.split(/(?<=\s)/);
  for (let i = 0; i < words.length; i += 4) yield { type: "text", delta: words.slice(i, i + 4).join("") };
  const citations = buildCitations(chunks, answer);
  yield {
    type: "final",
    answer,
    route: { route: routeNow, layer: routeNow === target ? layer : 5, reasons, attempts },
    filesUsed: [...new Set(citations.map((c) => c.fileAlias))],
    citations,
  };
}
