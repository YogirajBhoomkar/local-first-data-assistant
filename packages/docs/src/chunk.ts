/** Token estimate: characters / 4. */
export const CHARS_PER_TOKEN = 4;
export const TARGET_TOKENS = 800;
export const OVERLAP_TOKENS = 100;

export interface RawChunk {
  location: { page?: number; slide?: number };
  title?: string;
  text: string;
}

export const estimateTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

/** Split on paragraph then sentence boundaries into pieces of at most `max` characters. */
function pieces(text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    if (!para.trim()) continue;
    if (para.length <= max) {
      out.push(para);
      continue;
    }
    for (const sent of para.split(/(?<=[.!?])\s+/)) {
      if (sent.length <= max) out.push(sent);
      else for (let i = 0; i < sent.length; i += max) out.push(sent.slice(i, i + max));
    }
  }
  return out;
}

/**
 * Chunk one page or slide. If it fits in the target size it stays whole (never split inside a slide
 * that fits). Otherwise it is split at paragraph and sentence boundaries with an overlap carried over.
 */
export function chunkUnit(
  unit: { location: RawChunk["location"]; title?: string; text: string },
  targetTokens = TARGET_TOKENS,
  overlapTokens = OVERLAP_TOKENS,
): RawChunk[] {
  const max = targetTokens * CHARS_PER_TOKEN;
  const overlap = overlapTokens * CHARS_PER_TOKEN;
  const text = unit.text.trim();
  if (!text) return [];
  const base = { location: unit.location, ...(unit.title ? { title: unit.title } : {}) };
  if (text.length <= max) return [{ ...base, text }];

  const out: RawChunk[] = [];
  let cur = "";
  for (const p of pieces(text, max - overlap)) {
    if (cur && cur.length + p.length + 1 > max) {
      out.push({ ...base, text: cur });
      const tail = cur.slice(-overlap);
      const cut = tail.indexOf(" ");
      cur = (cut >= 0 ? tail.slice(cut + 1) : tail) + "\n" + p;
    } else {
      cur = cur ? `${cur}\n${p}` : p;
    }
  }
  if (cur.trim()) out.push({ ...base, text: cur });
  return out;
}
