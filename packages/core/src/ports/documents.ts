export interface Chunk {
  id: string;
  fileAlias: string;
  kind: "pdf" | "pptx";
  location: { page?: number; slide?: number };
  title?: string;
  text: string;
  charCount: number;
  score?: number;
}

export interface SkippedDoc {
  alias: string;
  reason: string;
}

export interface DocSearchOptions {
  topK: number;
  aliases?: string[];
}

export interface DocSearchResult {
  chunks: Chunk[];
  /** Set when nothing relevant was found, e.g. "no relevant content found". */
  reason?: string;
}

export interface DocumentStorePort {
  index(entries: import("../domain/index.js").FileEntry[]): Promise<{ indexed: number; skipped: SkippedDoc[] }>;
  search(query: string, opts: DocSearchOptions): Promise<Chunk[]>;
  /** Like `search`, but also says why nothing was returned. */
  searchWithReason(query: string, opts: DocSearchOptions): Promise<DocSearchResult>;
  getChunk(id: string): Chunk | undefined;
  /** All chunks of the given documents in reading order (page or slide order). */
  chunksOf(aliases: string[]): Chunk[];
  /** Aliases of documents that were indexed. */
  aliases(): string[];
}
