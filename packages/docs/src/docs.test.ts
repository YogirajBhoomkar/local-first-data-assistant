import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileEntry } from "@lf/core";
import { chunkUnit, estimateTokens } from "./chunk.js";
import { dropRepeatedLines, extractPdfPages, isScanned } from "./pdf.js";
import { extractPptxSlides } from "./pptx.js";
import { DocumentStore } from "./store.js";

const FX = resolve(import.meta.dirname, "../test/fixtures");
const entry = (alias: string, file: string, kind: "pdf" | "pptx"): FileEntry => ({ id: alias, alias, kind, sizeBytes: 1, modifiedAt: "x", sheet: file });
const ENTRIES = [
  entry("underwriting_guidelines", "underwriting_guidelines.pdf", "pdf"),
  entry("quarterly_summary", "quarterly_summary.pdf", "pdf"),
  entry("scanned_notes", "scanned_notes.pdf", "pdf"),
  entry("portfolio_review", "portfolio_review.pptx", "pptx"),
  entry("broker_strategy", "broker_strategy.pptx", "pptx"),
];

describe("pdf extraction", () => {
  it("reads text per page and removes repeated headers and footers", async () => {
    const pages = await extractPdfPages(join(FX, "underwriting_guidelines.pdf"));
    expect(pages).toHaveLength(20);
    expect(pages[3]!.text).toContain("Northwind Mutual - Underwriting Guidelines"); // header present before cleaning
    expect(pages[3]!.text).toContain("Page 4 of 20");
    const clean = dropRepeatedLines(pages);
    expect(clean[3]!.text).not.toMatch(/Northwind Mutual|Page \d+ of 20/);
    expect(clean[3]!.text).toContain("USD 25 million");
  });
  it("detects a scanned (image-only) PDF", async () => {
    expect(isScanned(await extractPdfPages(join(FX, "scanned_notes.pdf")))).toBe(true);
    expect(isScanned(await extractPdfPages(join(FX, "quarterly_summary.pdf")))).toBe(false);
  });
});

describe("pptx extraction", () => {
  it("one unit per slide in presentation order, with table cells and speaker notes", async () => {
    const s = await extractPptxSlides(join(FX, "portfolio_review.pptx"));
    expect(s).toHaveLength(10);
    expect(s.map((x) => x.slide)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s[1]!.title).toBe("Premium by line");
    expect(s[1]!.text).toContain("Property | 38%");
    expect(s[3]!.text).toContain("Notes: Speaker note: renewal retention target for next year is 88 percent.");
    expect(s[3]!.text).not.toMatch(/Notes:.*\b4\b$/); // slide-number placeholder is not part of the notes
  });
});

describe("chunking", () => {
  it("keeps a unit that fits whole, with its page", () => {
    const c = chunkUnit({ location: { page: 3 }, title: "T", text: "short text" });
    expect(c).toEqual([{ location: { page: 3 }, title: "T", text: "short text" }]);
  });
  it("splits big units at about 800 tokens with overlap and keeps the page on every chunk", () => {
    const sentence = "This is a sentence about underwriting that repeats. ";
    const text = Array.from({ length: 400 }, (_, i) => `${sentence}Item ${i}.`).join(" ");
    const chunks = chunkUnit({ location: { page: 9 }, text });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(820);
      expect(c.location.page).toBe(9);
    }
    // overlap: the end of chunk 1 reappears at the start of chunk 2
    const tailWords = chunks[0]!.text.split(" ").slice(-5).join(" ");
    expect(chunks[1]!.text.slice(0, 600)).toContain(tailWords);
  });
  it("returns nothing for empty text", () => expect(chunkUnit({ location: { page: 1 }, text: "  \n " })).toEqual([]));
});

describe("DocumentStore", () => {
  const cache = mkdtempSync(join(tmpdir(), "lf-docs-"));
  let store: DocumentStore;
  let skipped: { alias: string; reason: string }[] = [];
  beforeAll(async () => {
    store = new DocumentStore({ cacheDir: cache, resolvePath: (e) => join(FX, e.sheet!) });
    skipped = (await store.index(ENTRIES)).skipped;
  }, 60000);
  afterAll(() => rmSync(cache, { recursive: true, force: true }));

  it("skips the scanned PDF with a clear reason and indexes the rest", () => {
    expect(skipped).toEqual([{ alias: "scanned_notes", reason: "scanned PDF, OCR not supported in MVP" }]);
    expect(store.aliases().sort()).toEqual(["broker_strategy", "portfolio_review", "quarterly_summary", "underwriting_guidelines"]);
  });
  it("finds the right page for a lookup", async () => {
    const r = await store.search("maximum single-risk limit for Property", { topK: 3 });
    expect(r[0]!.fileAlias).toBe("underwriting_guidelines");
    expect(r[0]!.location.page).toBe(4);
    expect(r[0]!.score).toBeGreaterThan(0);
  });
  it("finds a fact that only lives in speaker notes", async () => {
    const r = await store.search("renewal retention target next year", { topK: 3 });
    expect(r[0]).toMatchObject({ fileAlias: "portfolio_review", location: { slide: 4 } });
  });
  it("restricts to given aliases", async () => {
    const r = await store.search("risks", { topK: 5, aliases: ["broker_strategy"] });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((c) => c.fileAlias === "broker_strategy")).toBe(true);
  });
  it("returns nothing, with a reason, for unrelated questions", async () => {
    const r = await store.searchWithReason("recipe for chocolate cake with strawberries", { topK: 5 });
    expect(r.chunks).toEqual([]);
    expect(r.reason).toMatch(/no relevant content found/);
  });
  it("getChunk returns a stored chunk", async () => {
    const [c] = await store.search("combined ratio", { topK: 1 });
    expect(store.getChunk(c!.id)).toMatchObject({ fileAlias: "quarterly_summary" });
  });
  it("reuses the cache and persisted index on a second run", async () => {
    const again = new DocumentStore({ cacheDir: cache, resolvePath: (e) => join(FX, e.sheet!) });
    expect((await again.index(ENTRIES)).indexed).toBe(4);
    expect((await again.search("flood zone deductible", { topK: 1 }))[0]!.location.page).toBe(9);
  });
  it("skips files over the size limit", async () => {
    const big = join(cache, "big.pdf");
    writeFileSync(big, Buffer.alloc(2 * 1024 * 1024));
    const s = new DocumentStore({ cacheDir: join(cache, "small"), resolvePath: () => big, maxFileMb: 1 });
    const r = await s.index([entry("big", "big.pdf", "pdf")]);
    expect(r.skipped[0]!.reason).toMatch(/larger than 1 MB/);
  });
  it("skips a corrupt file instead of crashing", async () => {
    const bad = join(cache, "bad.pdf");
    writeFileSync(bad, "not a pdf at all");
    const s = new DocumentStore({ cacheDir: join(cache, "bad"), resolvePath: () => bad });
    const r = await s.index([entry("bad", "bad.pdf", "pdf")]);
    expect(r.indexed).toBe(0);
    expect(r.skipped[0]!.reason).toMatch(/could not read file/);
  });
  it("a 200-page document produces at most topK chunks", async () => {
    const r = await store.search("underwriting", { topK: 6 });
    expect(r.length).toBeLessThanOrEqual(6);
  });
  it("eval doc questions retrieve the expected page or slide in the top 6", async () => {
    const qs = readFileSync(resolve(import.meta.dirname, "../../../eval/questions.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; kind: string; question: string; files: string[]; expected: { citation?: { file: string; page?: number; slide?: number } } });
    const docs = qs.filter((q) => q.kind === "doc");
    expect(docs).toHaveLength(15);
    const out: string[] = [];
    let hits = 0;
    for (const q of docs) {
      const aliases = q.files.map((f) => f.replace(/\.(pdf|pptx)$/, ""));
      const r = await store.search(q.question, { topK: 6, aliases });
      const c = q.expected.citation!;
      const hit = r.some((x) => x.fileAlias === c.file && (c.page ? x.location.page === c.page : x.location.slide === c.slide));
      if (hit) hits++;
      out.push(`${q.id} ${hit ? "HIT " : "MISS"} top=${r[0]?.score?.toFixed(1) ?? "-"} n=${r.length}`);
    }
    writeFileSync(join(tmpdir(), "lf-retrieval.txt"), out.join("\n"));
    expect(hits / docs.length).toBeGreaterThanOrEqual(0.8);
  });
});
