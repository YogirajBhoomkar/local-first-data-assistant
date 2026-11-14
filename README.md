# Local-first desktop agent

A desktop assistant that answers questions over large local files (CSV, Excel, Parquet, PDF, PPTX). A small local model handles simple questions on the user's machine. Hard questions go to a remote hosted model, and only the information that question needs is sent, through a privacy gate that logs every send.

Built as an independent repo for now; the agent core sits behind interfaces so it can later move into the BridgeAI Electron app. See `plan.md` for the phases and `docs/architecture.md` for the design.

## Scripts

| Command | What it does |
|---|---|
| `npm install` | install workspaces (Node >= 22.13) |
| `npm run typecheck` | TypeScript strict check of all packages, CLI and scripts |
| `npm run lint` | ESLint |
| `npm test` | Vitest |
| `npm run probe` | print a hardware capability report and tier recommendation (`-- --out probe.json` saves it) |
| `npm run gen:data -- --size 50MB --out ./sample-data [--seed 42]` | generate synthetic insurance-style data |
| `npm run cli -- <command>` | developer CLI: `probe`, `config show`; `files`, `sql`, `ask`, `bench` arrive in later phases |

## Status

Phase 0 (bootstrap) — see `docs/phases/phase-0.md`.
