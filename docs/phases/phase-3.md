# Phase 3 — Orchestrator, router, verification, privacy gate, escalation, egress log (tables)

## Built
- `core/ports/agent.ts`: `AgentContract` (`card`, `ask`, `confirm`), `QuestionClassifier`, `QuestionType`.
- `core/routing/router.ts`: policy check, hard rules, `RuleClassifier`, `DecisionModelClassifier` (stub, throws), `routeForType`, `verifyResult`, `resultHash`.
- `core/charts.ts`: deterministic `chooseChart`.
- `core/privacy/packet.ts`: pure `buildPacket` (what may leave the machine) and the HMAC `Masker`.
- `packages/agent`: `TableAgent` (orchestrator), `PrivacyGate`, `EgressLog`, remote prompts (`prompts/remote.ts`), `LocalModelClassifier`, answer/follow-up helpers, end-to-end evaluator (`e2e.ts`), oracle mocks (`mocks.ts`).
- CLI: `ask [--explain-route] [--mock] [--yes]`, `egress --last N`, `eval [--mock]`.
- Config: full `routing` block (mode, maxColumnsLocal, maxFilesLocal, escalateKeywords, typeRoutes, maxLocalAttempts, requireAgreement, minConfidence).

## Workflow vs orchestrator (decision)
A **plain TypeScript orchestrator** (`TableAgent`), not a Mastra workflow. I did **not** test whether Mastra 1.32.1 workflows can stream step events, so the choice is not based on a failed experiment. Reasons: the turn is a linear flow with early exits that must emit `TurnEvent`s as it goes (an async generator is the simplest fit), and models are called through `ChatModelPort`, which keeps every step testable with mocks. Each step's logic is in tested functions (`core/routing`, `core/privacy`, `core/charts`, `pruning`). Mastra agents are not used yet; `LocalOpenAICompatibleAdapter.toMastraModel()` exists if we later want them. Revisit if Phase 5 or the host app wants Mastra-native tracing.

## Which mode does the benchmark recommend?
**Unknown.** No real benchmark exists (no Ollama on this machine, see phase 2). All three modes are built; the default is `local-first`. `routing.mode = "remote-sql"` skips local SQL generation.

## Routing (per turn)
1. **Policy**: remote usable only if enabled and base URL, model and key are set. If not, the route stays local; a hard question gets a clear partial answer and nothing is sent.
2. **Hard rules**: tables needed (`pruned.tablesNeeded`), columns in scope, escalate keywords (whole words).
3. **Classifier**: local model (`LocalModelClassifier`, falls back to `RuleClassifier`); `typeRoutes` decides; confidence < 0.5 escalates.
4. **Local attempt**: local model writes SQL (Phase 2 prompt, history included), engine runs it.
5. **Verify**: guard passed + ran, at least one row, not all null, confidence >= 0.6, and (if `requireAgreement`) a second generation at temperature 0.3 gives the same result hash.
6. **Fallback**: a failed check retries once with the failure reason in the prompt (`maxLocalAttempts` = 2), then escalates. A model that sets `needsEscalation` escalates immediately (no retry).
Every layer's reasons are in `route` events and in `final.route`. Escalation after a local attempt emits a second `route` event (layer 5).

### Router fix found while testing
The first pruner counted any table with any column-name hit as "needed", so "How many policies are there?" needed 3 tables (`policy_id` exists in claims and exposures) and escalated. Table relevance is now: each question word is worth 1/(number of tables with evidence for it), a table-name match adds 1, and `tablesNeeded` is a greedy cover (best table, then only tables that explain a word nobody else does). Profile values match question text as whole words only (country code "us" no longer matches "cause"). On the synthetic set, 16 of 18 simple questions now stay local with the mock models; q014 and q015 ("claims by cause") still wrongly look like 2-table questions. This is conservative (extra escalation, never wrong answers) and is a candidate to tune with a real model.

## Privacy gate
- Only `packages/agent/src/gate/gate.ts` imports `@lf/models/remote` (lint-enforced; verified with a deliberate violation). `remoteFactory` lets tests inject a mock.
- Order for every send: build packet -> **write egress record (pending)** -> emit `egress` -> if `confirmBeforeSend` emit `confirm` and wait (5-minute timeout, cancels the send) -> send -> append the outcome record.
- Race fixed while testing: the confirm waiter is registered **before** the `confirm` event is yielded, otherwise a host that replies immediately was lost.
- Privacy levels: `schema` (names and types only), `aggregates` (+ column profiles), `rows` (+ up to 20 sample rows per table; and answer-from-results allowed). Below `rows`, `answer-from-results` is blocked: the remote model never sees values and the answer is written locally.
- `denyColumns` removed everywhere; `maskColumns` values become `tok_<hmac10>` (HMAC-SHA256, per-install key in `cacheDir/mask.key`), and tokens are mapped back locally in answers and in remote SQL before it runs.
- Big results (> `maxRowsSent` rows or > `maxBytesSent` bytes) are replaced by a locally computed summary (per-column stats and sums by the main dimension) and a trace event says so. A test builds a packet from a 100,000-row result and asserts it is under both limits.
- Documents: `answer-from-chunks` caps chunk count (`docTopK`) and characters (`docMaxChars`); used in Phase 4.

## Egress log format
`cacheDir/egress.log.jsonl`, append-only, one JSON object per line. Each send writes a `pending` record first and appends a second line with the same `egressId` and the final `outcome` (`sent` | `cancelled` | `failed`); readers merge by `egressId`, last wins. Fields: `egressId, turnId, timestamp, destination, purpose, privacyLevel, tables, columns, rowCount, byteSize, payloadSha256, approvedBy (user|auto|none), outcome`, plus `payload` only if `privacy.logFullPayload` is true. `byteSize` and the SHA-256 are of the exact request (system + messages + schema) that is sent. Tests assert the API key and remote URL never appear in it.

## Escalation flows
A. Remote writes SQL (`write-sql`, max 3 queries, JSON), each runs through the guard locally; one repair round sends only the failed SQL and the engine error (no data).
B. Remote writes the answer (`answer-from-results`) only for reasoning questions (why/explain/compare/insight/trend/recommend/forecast...) and only at level `rows`.
C. Otherwise the local model writes the answer, or a deterministic template when there is no local model.
If a send is cancelled, blocked or fails, the agent tries to answer locally (route event layer 6) and explains what happened.

## Differences from the prompt
- **Follow-ups**: generated by the local model when available (items naming unknown tables are dropped); otherwise **deterministic templates** built from real tables and columns. The remote model is never used for follow-ups (it would add another send and another confirm dialog).
- Answer text is produced whole and emitted as `text` deltas of ~4 words, not token-streamed.
- `DataEnginePort` gained `getSchemas()`.

## Evaluation
`cli eval --folder ./sample-data --mock` ran the 30 table questions end to end with scripted oracle models: report `eval/reports/e2e-<date>-mock.md` (route, reasons and exactly what was sent per question). **This is a wiring check, not a quality number**: the mock local model returns the reference SQL, so accuracy is trivially 100%. A real run needs Ollama and a remote endpoint: `npm run cli -- eval --folder ./sample-data`.

## Known gaps
- Real local and remote models untested; remote JSON-mode behaviour (`response_format: json_schema`) differs by provider and may need a fallback.
- Classifier thresholds, `minConfidence`, and the agreement check are untuned.
- Pruner still over-counts tables for some questions (above).
- History is text only; no coreference resolution for follow-up questions.
- The Mastra workflow question is open (above).
