# Moving the agent into another Electron host (for example the BridgeAI app)

## What to take
Five workspace packages, all TypeScript source with no build step of their own:

| Package | Role | Depends on |
|---|---|---|
| `@lf/core` | domain types, config (zod), ports (interfaces), router layers, chart chooser, privacy packet builder | zod |
| `@lf/engine` | DuckDB engine: scan, register, guarded read-only SQL, profiling, Excel conversion | `@duckdb/node-api`, `exceljs` |
| `@lf/docs` | PDF and PPTX extraction, chunking, keyword index | `pdfjs-dist`, `fflate`, `fast-xml-parser`, `minisearch` |
| `@lf/models` | Local (Ollama) adapter, mock, tier selection, the remote adapter (only importable through `@lf/models/remote`) | none at runtime (uses `fetch`) |
| `@lf/agent` | `TableAgent` (the `AgentContract`), privacy gate, egress log, prompts, evaluation harness | the four above |

The desktop app in `apps/desktop` is the reference host: copy `electron/runtime.ts` (agent-side wiring, plain Node) and `shared/ipc.ts` (the message contract).

## How the host starts it
Run the agent in an Electron `utilityProcess` (a Node process), as `apps/desktop/electron/main.ts` does. Bundle the agent entry (`electron/agent-process.ts`) with esbuild as ESM (`scripts/build-electron.mjs`), keeping `electron`, `@duckdb/*`, `pdfjs-dist` and `exceljs` external. The host sends `AgentRequest` messages and receives `AgentMessage` responses and events over `parentPort`. Never run the agent in the main process: queries and model calls are long.

## The contract
`AgentContract` (`packages/core/src/ports/agent.ts`):
- `card()` -> `{ name, version, description, capabilities, dataPolicy }`
- `ask({ turnId, question, history, context: { folderSelected } }, signal)` -> `AsyncIterable<TurnEvent>`
- `confirm(egressId, approved)` answers a `confirm` event.

`TurnEvent` (`packages/core/src/domain/index.ts`): `trace {step, status, detail, data?}`, `route {route, layer, reasons}`, `egress {egressId, summary, detail?}` (emitted before a send), `confirm {egressId, preview}`, `text {delta}`, `text-reset`, `final {answer, table?, chart?, sql?, route, filesUsed, citations?}`, `suggestions {items}`, `error {code, message}`.
The final event carries the `RouteDecision`; `trace` events carry structured `data` (SQL, schema scores, passages, checks) that the "Under the hood" view uses. A host that only wants an answer can ignore `trace`, `route` and `egress`.

## Settings and secrets
- Settings are a zod schema (`SettingsSchema` in `shared/ipc.ts`) stored as JSON in the user-data folder. The host maps them to the core config with `settingsToOverrides` and `loadConfig`.
- The remote API key is stored with Electron `safeStorage` (OS keychain), read in the main process, passed only to the agent process, and shown to the window only as "saved ••••1234". It never reaches the renderer. Environment values (`LF_REMOTE_*`, or the Conversational BI names `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`) are accepted as fallbacks.
- The remote model is any OpenAI-compatible endpoint (a LiteLLM proxy works as is) or Azure OpenAI.

## Privacy rules the host must keep
- Only `packages/agent/src/gate` may import `@lf/models/remote` (ESLint `no-restricted-imports` enforces it; copy the rule).
- Every remote call is logged to `cacheDir/egress.log.jsonl` before it is sent. Expose the log to the user.
- Keep `confirmBeforeSend` on unless the host's own consent flow replaces it, and show the `confirm.preview` payload exactly.
- File paths stay inside the engine process: models, logs and events only ever see aliases such as `t_policies`.

## Native modules and packaging
- DuckDB uses N-API prebuilt binaries: no rebuild for Electron's ABI. Verified on Electron 45.3.2 (bundles Node 24.22.2). The `@duckdb/*` packages must be unpacked from the asar archive (`asarUnpack` in `electron-builder.yml`); `pdfjs-dist` is unpacked too.
- The Excel path uses `exceljs` (pure JavaScript, offline). The DuckDB excel extension is not used because it installs from the internet.
- Hosts that set `ELECTRON_RUN_AS_NODE` (for example when started from VS Code) must unset it when launching Electron.

## Open questions for the host team
1. Does the host already ship Ollama, or must the installer check for it and guide the user? Without a local model the app runs remote-only (files still stay local).
2. Which model tier is acceptable on the target laptops? A CPU-only laptop runs `qwen3.5:4b` at roughly 10 to 15 s per model call.
3. Is the remote gateway reachable from user laptops, and which model alias and rate limits apply?
4. Which columns must never leave the laptop (deny list) and which should be masked? These fill `privacy.denyColumns` and `privacy.maskColumns`.
5. Should the egress log be exportable or sent to a central audit store? Today it is local only.
6. Does the host want the "Under the hood" view as a product feature, or only for demonstrations? It is a React component driven purely by `TurnEvent`s (`apps/desktop/src/state/pipeline.ts`, `components/Pipeline.tsx`).
7. Mixed questions (documents and tables together) currently go to the remote model with schema and passages only and do not run SQL for the table half.
