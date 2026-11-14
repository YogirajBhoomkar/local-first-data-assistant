# Phase 4 — Documents (PDF and PPTX)

## Library choices (all pinned, all pure JS, all offline)
| Need | Choice | Why |
|---|---|---|
| PDF text per page | `pdfjs-dist` 6.5.438, **legacy build** (`pdfjs-dist/legacy/build/pdf.mjs`) | The standard PDF parser; the legacy build runs in Node without a browser or canvas. Lines are rebuilt from text items by vertical position. API difference found: in this version `destroy()` lives on the loading task, not on the document. `isEvalSupported` is not a valid option in the types. |
| PPTX | `fflate` 0.8.3 (zip) + `fast-xml-parser` 5.12.1 | A PPTX is a zip of XML. Slide order comes from `ppt/presentation.xml` + its rels (not file names); text = `a:t` in paragraphs; table cells; notes from `ppt/notesSlides` (via each slide's rels), prefixed `Notes:`; slide-number placeholders ignored. |
| Keyword search | `minisearch` 7.2.0 | In-process BM25-style full-text; no DuckDB extension, no internet. Title boosted x2, prefix and light fuzzy matching, our own stemmer and stop-word list. |

## Fixtures
`npm run gen:docs -- --out <dir>` (`scripts/gen-docs.ts`) writes, from invented content (`scripts/doc-content.ts`): a 20-page `underwriting_guidelines.pdf`, a 5-page `quarterly_summary.pdf`, an image-only `scanned_notes.pdf`, and two 10-slide decks (`portfolio_review.pptx`, `broker_strategy.pptx`, with titles, bullets, a table and speaker notes). The PDF and ZIP writers are small hand-written ones (no extra dependencies). Total ~50 KB, committed in `packages/docs/test/fixtures`. The generated PPTX is valid for our reader; I have **not** opened it in PowerPoint, so it may not be strictly valid for Office.

## Extraction and chunking rules
- PDF: text per page; lines that repeat on > 60% of pages are dropped (digits normalised, so "Page 4 of 20" counts as a footer). A page with < 20 characters has "no text"; if > 80% of pages have none the file is skipped with `scanned PDF, OCR not supported in MVP`.
- PPTX: one unit per slide = title + body + table cells + `Notes: ...`.
- Chunking: ~800 tokens (chars/4) with 100-token overlap; a page or slide that fits is never split; otherwise split at paragraph then sentence boundaries; page or slide number kept on every chunk.
- Cache: extracted chunks in `cacheDir/docs/<hash>.json` keyed by path + size + mtime; the keyword index is persisted (`index-<hash>.json`) and reused unless the file set or any file changed. Files over `docs.maxFileMb` (200) are skipped with a reason; corrupt files are skipped, not fatal.

## Search and the relevance threshold
`search` returns top-K chunks with scores; `searchWithReason` also says why there is nothing ("no query word appears in any chunk" / "best match is too weak"). `DEFAULT_MIN_SCORE` = **12** (config `docs.minScore` overrides). Calibration, on the synthetic set: relevant lookups score 25 to 300; off-topic questions score 0 to 16 (e.g. "football match" 1.6, "fee for the premium subscription plan" 13). 12 removes the clearly irrelevant ones but is **not** a sharp filter (a question about "the capital of France" still scored 15.7 through a fuzzy match), so the local model's `NOT FOUND` and the citation checks are the real safety net. MiniSearch scores are not normalised; retune on real documents.
Retrieval hit rate on the 15 doc questions (expected page or slide in the top 6): 14 of 15 (d011, a "risks across both decks" summary, is a hit only through the other deck; see the eval).

## Routing for documents (`doc-flow.ts`)
Only when the folder has indexed PDF/PPTX. `docPlan` compares evidence from table and column **names** (`nameEvidence`, max over tables) with how strongly the documents match:
- A question that mentions documents (guideline, document, deck, slide, page, "according to", summarise...) or names a document alias goes to **documents**; if it also has >= 4 name matches against tables it is **mixed**.
- No such cue: no table evidence -> documents; otherwise documents win only when the top document score >= 40 + 20 x name matches, else the normal table path.
- These thresholds were set by looking at the 45 synthetic questions; they are a starting point and will need real data.
- **Mixed** questions go to the remote model (layer 2, reason "mixed sources"); the gate sends the top chunks plus the schema (names and types only, deny-list applied) and the remote model answers from the chunks. It does not run SQL for the table half (MVP limit).
- Local answer: only for lookups (no summary/compare words, no competing second document, chunks fit 6,000 characters) and when a local model exists. The local model must cite `[alias p3]` / `[alias slide4]`.
- Local answer checks: has a citation; cites only chunks it was given; does not say `NOT FOUND` while the top score is >= 4 x the relevance threshold. Any failure escalates (layer 5) or, if the remote is off, returns the answer with a "Not verified" note.
- Escalation: purpose `answer-from-chunks`; the packet holds the question, short history, at most `docTopK` chunks capped at `docMaxChars`, with aliases and page/slide numbers only. Same egress log and confirm flow as tables. A cancelled or failed send falls back to a local answer when it passes the checks.
- The `final` event now carries `citations: { fileAlias, page?, slide?, snippet (<= 200 chars) }[]` (the cited chunks, or the top 3 if none are parsed). `filesUsed` = files of the citations.
- The router's `QuestionType` gained `document`, and `typeRoutes.document` defaults to `local`.

## Eval (mock models: wiring and retrieval, not answer quality)
`cli eval --folder ./sample-data --mock` now covers 45 questions (30 table + 15 document). Latest mock result: documents answer pass 100%, retrieval hit 93.3%, answer cites the expected page or slide 93.3%, mean characters sent per document question 631, wrong-local 0. The mock "answers" are built from the expected phrases, so the answer pass rate says nothing about a real model; retrieval and routing numbers are real.
Also fixed: `cli eval` counted egress records from earlier runs (the log persists), which inflated "bytes sent" in the Phase 3 mock report; it now counts only records written by the current run.

## Differences from the prompt
- The 15 doc questions were appended to `eval/questions.jsonl` (ids `d001`...), with `expected.citation`.
- `search` returns `Chunk[]` as specified; `searchWithReason` is an addition.
- `DuckDbEngine.pathOf(entry)` was added so the document store can read files without paths appearing anywhere else.

## Known gaps
- No OCR (scanned PDFs are skipped), no images or embeddings (as scoped).
- Mixed questions do not execute SQL for the table half.
- Routing thresholds and the relevance score are tuned on synthetic data only.
- Real local model on a document question: see the note in the hand-over message (Qwen 9B on this CPU-only laptop takes minutes per call).
