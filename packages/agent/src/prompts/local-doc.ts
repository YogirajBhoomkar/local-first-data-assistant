import type { Chunk, Citation, GenerateRequest } from "@lf/core";

export const LOCAL_DOC_MAX_CHARS = 6000;

/** Reference used in prompts and citations, e.g. "guidelines p4" or "deck slide7". */
export const chunkRef = (c: Pick<Chunk, "fileAlias" | "location">): string =>
  `${c.fileAlias} ${c.location.page !== undefined ? `p${c.location.page}` : `slide${c.location.slide}`}`;

const SYSTEM = `Answer the question using ONLY the excerpts below. Each excerpt starts with a reference in square brackets.
Cite every fact with its reference in square brackets, exactly as written, for example [guidelines p4] or [deck slide7].
If the excerpts do not contain the answer, reply exactly: NOT FOUND.
Be brief: 1 to 4 sentences.`;

/** Takes chunks in score order until the character budget is used. */
export function fitChunks(chunks: Chunk[], maxChars = LOCAL_DOC_MAX_CHARS): Chunk[] {
  const out: Chunk[] = [];
  let n = 0;
  for (const c of chunks) {
    if (n + c.text.length > maxChars && out.length > 0) break;
    out.push(c);
    n += c.text.length;
  }
  return out;
}

export function buildLocalDocRequest(question: string, chunks: Chunk[]): GenerateRequest {
  const body = chunks.map((c) => `[${chunkRef(c)}]\n${c.text}`).join("\n\n");
  return {
    system: SYSTEM,
    messages: [{ role: "user", content: `${body}\n\nQuestion: ${question}` }],
    temperature: 0,
    maxTokens: 300,
  };
}

const CITE = /\[([a-z0-9_]+) (?:p(\d+)|slide(\d+))\]/gi;

/** Refs ("alias p4") cited in an answer. */
export function citedRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CITE)) out.push(`${m[1]!.toLowerCase()} ${m[2] ? `p${m[2]}` : `slide${m[3]}`}`);
  return out;
}

export interface DocCheck {
  ok: boolean;
  notFound: boolean;
  reasons: string[];
}

/** Local answer checks: has a citation, cites only chunks it was given, and does not give up while the match is strong. */
export function checkDocAnswer(text: string, given: Chunk[], highScore: number): DocCheck {
  const reasons: string[] = [];
  const notFound = /^\s*NOT FOUND\b/i.test(text);
  const refs = citedRefs(text);
  const allowed = new Set(given.map((c) => chunkRef(c).toLowerCase()));
  if (notFound) {
    if ((given[0]?.score ?? 0) >= highScore) reasons.push("model said NOT FOUND although a strong match was found");
  } else {
    if (refs.length === 0) reasons.push("answer has no citation");
    const bad = refs.filter((r) => !allowed.has(r));
    if (bad.length) reasons.push(`cites a chunk it was not given (${bad[0]})`);
  }
  return { ok: reasons.length === 0, notFound, reasons };
}

export function buildCitations(chunks: Chunk[], answer: string): Citation[] {
  const cited = new Set(citedRefs(answer));
  const pick = chunks.filter((c) => cited.has(chunkRef(c).toLowerCase()));
  const use = pick.length ? pick : chunks.slice(0, 3);
  return use.map((c) => ({
    fileAlias: c.fileAlias,
    ...(c.location.page !== undefined ? { page: c.location.page } : {}),
    ...(c.location.slide !== undefined ? { slide: c.location.slide } : {}),
    snippet: c.text.replace(/\s+/g, " ").slice(0, 200),
  }));
}
