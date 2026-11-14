import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import MiniSearch from "minisearch";
import type { Chunk, DocSearchOptions, DocSearchResult, DocumentStorePort, FileEntry, SkippedDoc } from "@lf/core";
import { chunkUnit, type RawChunk } from "./chunk.js";
import { dropRepeatedLines, extractPdfPages, isScanned } from "./pdf.js";
import { extractPptxSlides } from "./pptx.js";

const STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "is", "are", "was", "were", "be", "what", "which", "who", "how", "does", "do", "did", "say", "says", "about", "with", "by", "at", "as", "it", "this", "that", "from", "me", "my", "any", "there", "than", "then", "their", "its"]);

export function stem(w: string): string {
  for (const suf of ["ies", "ing", "ed", "es", "ly", "s"]) {
    if (w.length > suf.length + 2 && w.endsWith(suf)) return suf === "ies" ? w.slice(0, -3) + "y" : w.slice(0, -suf.length);
  }
  return w;
}
const processTerm = (t: string): string | null => {
  const w = t.toLowerCase();
  return w.length < 2 || STOP.has(w) ? null : stem(w);
};

/** Fallback relevance threshold (BM25-style score) when config.docs.minScore is null. Calibrated in phase-4.md. */
export const DEFAULT_MIN_SCORE = 12;

export interface DocumentStoreOptions {
  cacheDir: string;
  /** Real path for a file; paths never leave the docs package. */
  resolvePath: (entry: FileEntry) => string | undefined;
  maxFileMb?: number;
  minScore?: number | null;
}

type Stored = Omit<Chunk, "fileAlias" | "id"> & { n: number };

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export class DocumentStore implements DocumentStorePort {
  private chunks = new Map<string, Chunk>();
  private search_: MiniSearch<Chunk> = this.newIndex();
  private readonly dir: string;
  private readonly minScore: number;
  private readonly maxBytes: number;

  constructor(private readonly o: DocumentStoreOptions) {
    this.dir = join(o.cacheDir, "docs");
    this.minScore = o.minScore ?? DEFAULT_MIN_SCORE;
    this.maxBytes = (o.maxFileMb ?? 200) * 1024 * 1024;
  }

  private newIndex(): MiniSearch<Chunk> {
    return new MiniSearch<Chunk>({
      fields: ["title", "text"],
      idField: "id",
      processTerm,
      searchOptions: { boost: { title: 2 }, prefix: true, fuzzy: 0.15, combineWith: "OR", processTerm },
    });
  }

  private async extract(path: string, kind: "pdf" | "pptx"): Promise<{ stored: Stored[] } | { skip: string }> {
    const raw: RawChunk[] = [];
    if (kind === "pdf") {
      const pages = await extractPdfPages(path);
      if (isScanned(pages)) return { skip: "scanned PDF, OCR not supported in MVP" };
      for (const p of dropRepeatedLines(pages)) {
        const lines = p.text.split("\n").filter(Boolean);
        if (p.text.replace(/\s/g, "").length < 20) continue; // a page with no text
        raw.push(...chunkUnit({ location: { page: p.page }, ...(lines[0] ? { title: lines[0].slice(0, 120) } : {}), text: p.text }));
      }
    } else {
      for (const s of await extractPptxSlides(path)) raw.push(...chunkUnit({ location: { slide: s.slide }, ...(s.title ? { title: s.title } : {}), text: s.text }));
    }
    if (raw.length === 0) return { skip: "no text found" };
    return {
      stored: raw.map((r, n) => ({ kind, location: r.location, ...(r.title ? { title: r.title } : {}), text: r.text, charCount: r.text.length, n })),
    };
  }

  async index(entries: FileEntry[]): Promise<{ indexed: number; skipped: SkippedDoc[] }> {
    await mkdir(this.dir, { recursive: true });
    const skipped: SkippedDoc[] = [];
    const all: Chunk[] = [];
    const keys: string[] = [];
    let indexed = 0;
    for (const e of entries) {
      if (e.kind !== "pdf" && e.kind !== "pptx") continue;
      const path = this.o.resolvePath(e);
      if (!path) {
        skipped.push({ alias: e.alias, reason: "file path unknown" });
        continue;
      }
      const info = await stat(path);
      if (info.size > this.maxBytes) {
        skipped.push({ alias: e.alias, reason: `file larger than ${this.maxBytes / 1024 / 1024} MB` });
        continue;
      }
      const key = sha(`${path}|${info.size}|${info.mtimeMs}`);
      keys.push(`${e.alias}:${key}`);
      const cacheFile = join(this.dir, `${key}.json`);
      let result: { stored: Stored[] } | { skip: string } | undefined;
      try {
        result = JSON.parse(await readFile(cacheFile, "utf8")) as { stored: Stored[] } | { skip: string };
      } catch {
        try {
          result = await this.extract(path, e.kind);
        } catch (err) {
          result = { skip: `could not read file: ${(err as Error).message.slice(0, 80)}` };
        }
        await writeFile(`${cacheFile}.tmp`, JSON.stringify(result));
        await rename(`${cacheFile}.tmp`, cacheFile);
      }
      if ("skip" in result) {
        skipped.push({ alias: e.alias, reason: result.skip });
        continue;
      }
      indexed++;
      for (const s of result.stored) {
        const { n, ...rest } = s;
        const loc = s.location.page !== undefined ? `p${s.location.page}` : `s${s.location.slide}`;
        all.push({ ...rest, id: `${e.alias}:${loc}:${n}`, fileAlias: e.alias });
      }
    }
    this.chunks = new Map(all.map((c) => [c.id, c]));

    // Persist the keyword index; rebuild only when the set of files (or any file) changed.
    const sig = sha(keys.sort().join("|"));
    const idxFile = join(this.dir, `index-${sig}.json`);
    try {
      this.search_ = MiniSearch.loadJSON<Chunk>(await readFile(idxFile, "utf8"), {
        fields: ["title", "text"], idField: "id", processTerm,
        searchOptions: { boost: { title: 2 }, prefix: true, fuzzy: 0.15, combineWith: "OR", processTerm },
      });
    } catch {
      this.search_ = this.newIndex();
      this.search_.addAll(all);
      await writeFile(`${idxFile}.tmp`, JSON.stringify(this.search_));
      await rename(`${idxFile}.tmp`, idxFile);
    }
    return { indexed, skipped };
  }

  async searchWithReason(query: string, opts: DocSearchOptions): Promise<DocSearchResult> {
    if (this.chunks.size === 0) return { chunks: [], reason: "no documents are indexed" };
    const aliases = opts.aliases?.length ? new Set(opts.aliases) : null;
    const hits = this.search_.search(query, {
      ...(aliases ? { filter: (r: { id: string }) => aliases.has(this.chunks.get(r.id)?.fileAlias ?? "") } : {}),
    });
    if (hits.length === 0) return { chunks: [], reason: "no relevant content found (no query word appears in any chunk)" };
    if (hits[0]!.score < this.minScore) return { chunks: [], reason: "no relevant content found (best match is too weak)" };
    const chunks = hits
      .filter((h) => h.score >= this.minScore * 0.5)
      .slice(0, opts.topK)
      .map((h) => ({ ...this.chunks.get(h.id)!, score: h.score }));
    return { chunks };
  }

  async search(query: string, opts: DocSearchOptions): Promise<Chunk[]> {
    return (await this.searchWithReason(query, opts)).chunks;
  }

  getChunk(id: string): Chunk | undefined {
    return this.chunks.get(id);
  }

  chunksOf(aliases: string[]): Chunk[] {
    const want = new Set(aliases);
    return [...this.chunks.values()].filter((c) => want.has(c.fileAlias));
  }

  aliases(): string[] {
    return [...new Set([...this.chunks.values()].map((c) => c.fileAlias))];
  }
}
