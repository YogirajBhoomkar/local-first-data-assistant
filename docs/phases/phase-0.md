# Phase 0 — Bootstrap

## Built
- npm workspaces monorepo: `packages/{core,engine,models,docs,agent}`, `apps/{cli,desktop}`, `eval/`, `scripts/`, `docs/`.
- Strict TypeScript, ESLint (flat config, typescript-eslint), Prettier, Vitest. All versions pinned exactly.
- `core`: domain types, ports placeholder, typed zod config (defaults -> `LF_CONFIG` JSON -> env for remote settings/secrets) with redaction.
- `scripts/probe.ts`: hardware probe that outputs only an allow-listed set of keys, plus tier recommendation.
- `scripts/gen-synthetic.ts`: deterministic, streamed synthetic data (policies.csv, claims.csv, exposures.parquet, budget.xlsx, messy.xlsx).
- `eval/questions.jsonl`: 30 table questions (18 simple, 12 hard) with a validator test.
- `apps/cli`: `probe`, `config show`, and placeholders for `files`, `sql`, `ask`, `bench`.
- Tiny fixtures (~190 KB) committed in `packages/engine/test/fixtures`.

## How to run
`npm install`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run probe`, `npm run gen:data -- --size 50MB`.

## Decisions
- **TypeScript 6.0.3, not 7.x**: typescript-eslint 8.72.2 supports TypeScript `<6.1`.
- **moduleResolution `bundler`**: works with Vitest and tsx; code is run through tsx/Vite, not emitted for Node directly.
- **Extra dependencies** (not named in the prompt, small and pure JS, chosen because I could not ask): `exceljs` (write xlsx, incl. merged cells), `hyparquet-writer` (write Parquet), `commander` (CLI args), `tsx` (run TS). Revisit if you object.
- Parquet writer builds the file in memory, so `exposures.parquet` is capped at 400,000 rows. CSVs are streamed and can reach multi-GB.
- Non-core packages have `main: src/index.ts` (no build step needed for dev).
- `.gitattributes` forces LF line endings.
- The lint rule restricting the remote adapter is a pattern placeholder; Phase 2 finalises the real path.

## Known gaps / deviations
- The folder was not an empty git repo (it held `plan.md`, no git). I ran `git init`, committed `plan.md` on `main`, then branched.
- No `<CBI_REPO_PATH>` was provided, so `docs/reference-notes.md` was skipped.
- `config show` prints the local cache path (not a secret, but a user path) — acceptable for a dev CLI.
- Probe checks Ollama's `/models` list; the GPU check on Windows reports AdapterRAM, which caps at 4 GB (hint only).
