import { readFile } from "node:fs/promises";
// The pdfjs "legacy" build runs in Node without a browser or canvas for text extraction.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PageText {
  page: number;
  text: string;
}

/** Text per page. Lines are rebuilt from text items using their vertical position. */
export async function extractPdfPages(path: string): Promise<PageText[]> {
  const data = new Uint8Array(await readFile(path));
  const task = getDocument({ data, verbosity: 0, useSystemFonts: false, disableFontFace: true });
  const doc = await task.promise;
  try {
    const pages: PageText[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const rows = new Map<number, { x: number; s: string }[]>();
      for (const it of content.items) {
        if (!("str" in it) || !it.str.trim()) continue;
        const y = Math.round(it.transform[5] as number);
        const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key)!.push({ x: it.transform[4] as number, s: it.str });
      }
      const lines = [...rows.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, items]) =>
          items
            .sort((a, b) => a.x - b.x)
            .map((i) => i.s)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
        );
      pages.push({ page: n, text: lines.join("\n") });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy(); // the loading task owns the document (API differs from older pdfjs: no doc.destroy)
  }
}

const normalizeLine = (l: string) => l.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();

/** Removes lines that repeat on more than 60% of pages (headers, footers, page numbers). */
export function dropRepeatedLines(pages: PageText[], threshold = 0.6): PageText[] {
  if (pages.length < 3) return pages;
  const counts = new Map<string, number>();
  for (const p of pages) {
    for (const l of new Set(p.text.split("\n").map(normalizeLine))) if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const repeated = new Set([...counts].filter(([, n]) => n / pages.length > threshold).map(([l]) => l));
  return pages.map((p) => ({
    page: p.page,
    text: p.text
      .split("\n")
      .filter((l) => !repeated.has(normalizeLine(l)))
      .join("\n"),
  }));
}

export const MIN_PAGE_CHARS = 20;

/** Scanned PDF: more than 80% of pages have (almost) no text. */
export function isScanned(pages: PageText[]): boolean {
  if (pages.length === 0) return true;
  return pages.filter((p) => p.text.replace(/\s/g, "").length < MIN_PAGE_CHARS).length / pages.length > 0.8;
}
