# Phase 2 — Model layer, hardware tiers, benchmark

## Built
- `core/ports/chat-model.ts`: `ChatModelPort` (`generate`, `stream`, `health`) and request/response types.
- `packages/models`: `OpenAICompatAdapter` base (fetch, SSE streaming, timeout, one retry on connection errors only, secret redaction), `LocalOpenAICompatibleAdapter` (Ollama), `RemoteAdapter` (openai-compatible and azure-openai), `MockModelAdapter`, `selectLocalModel` (tiers).
- `packages/agent`: deterministic column pruner (`pruning.ts`), local text-to-SQL prompt (`prompts/local-sql.ts`), result comparison, benchmark harness and report writer.
- CLI: `cli bench --models a,b --runs 3 --folder ./sample-data [--mock]`.
- Config gained `pruning.synonyms` and `pruning.maxColumnsPerTable`.

## Mastra 1.32.1 notes (installed in packages/models; read from the installed types)
- Needs Node >= 22.13; peer dependency is zod 3.25+ or 4 (we use zod 4.6.7).
- Agents take `model` as a model string (`"provider/model"`), an AI SDK model object, or an **OpenAI-compatible config object** `{ id: "provider/model", url?, apiKey?, headers? }` (`OpenAICompatibleConfig`, `dist/llm/model/shared.types.d.ts`). We use the object form, so **no AI SDK provider package is needed**. `LocalOpenAICompatibleAdapter.toMastraModel()` returns it.
- Tools: `createTool({ id, description, inputSchema, outputSchema, execute })` from `@mastra/core/tools`. Agents are `new Agent({ name, instructions, model, tools })`; streaming is `agent.stream()` / `agent.generate()` (details to confirm when Phase 3 wires agents). Mastra server/deployer is not used.
- Not verified here: a real Mastra agent call (no model available); Phase 3 does that.
- Difference from the prompt: the remote adapter is not wrapped as a Mastra model here; Phase 3's gate can build `{ id, url, apiKey }` from the same options if it wants a Mastra agent for remote calls.

## Model tags and licenses
| Role | Ollama tag | Source |
|---|---|---|
| small tier (>= 12 GB RAM) | `qwen3.5:9b-q4_K_M` (~6.6 GB, 256K context) | ollama.com/library/qwen3.5 tags page |
| medium tier (>= 24 GB RAM) | `ministral-3:14b-instruct-2512-q4_K_M` (~9.1 GB) | ollama.com/library/ministral-3 tags page |

Both tags exist on the Ollama library (found by search; **not pulled or run on this machine**). Config defaults and `.env.example` now use these tags.
**Licenses: not verified.** The model pages' license sections could not be read. Please check the Qwen3.5 and Ministral 3 model cards (I expect Apache-2.0 for both, but that is from memory) before shipping.

## Thinking off (Qwen)
Ollama's OpenAI-compatible endpoint accepts `reasoning_effort: "none"`; the adapter sends it for model names matching `qwen3|deepseek-r1|gpt-oss`. **Unverified** against a real Qwen3.5 call (Ollama is not installed here). Alternative if it does not work: Ollama native `/api/chat` with `think: false`.

## Tier selection
`selectLocalModel(probe, config)` -> `{ tier, model, reason, remoteOnly, installHint?, warning? }`. Explicit `localModel.name` wins (RAM warning if below the tier's threshold). Local model disabled, Ollama not reachable, or model not installed -> tier `none`, `remoteOnly: true`, with `ollama pull <tag>` hint. Remote-only mode keeps files local; the gate (Phase 3) limits what is sent.

## Remote adapter and the lint rule
`packages/models/src/remote/remote-adapter.ts` is **not** exported from the package index. ESLint `no-restricted-imports` forbids importing `**/remote/remote-adapter*` anywhere except `packages/agent/src/gate/**` and `packages/models/src/remote/**` (and the models test file). API key and base URL are redacted in all error messages.

## Pruner and prompt
`pruneSchema` scores columns by stemmed name overlap (x3), synonym match (x2) and profile top-value occurrence in the question (x3); always keeps id/date columns; 5 to 12 columns per table; returns `tablesNeeded` and `totalColumnsInScope` for the Phase 3 router. The prompt is ~1.3 KB with 3 few-shot examples and strict JSON output `{ sql, tables, confidence, needsEscalation, reason }`.

## Benchmark
Harness: per model, every simple table question x N runs (run 1 at temperature 0, later runs 0.3), each hard question once. Records valid JSON, guard pass, ran, correct (result set vs reference SQL, order-insensitive unless the reference has ORDER BY, 1e-6 tolerance), escalation flag, confidence, latency, tokens. The decision rule is printed in the report before the numbers.
- **No real benchmark was run**: Ollama is not installed on this machine. Only the mock path ran (`--mock`, saved with a `-mock` suffix; a perfect oracle, proving the wiring only).
- To run on a laptop with Ollama:
  ```
  ollama pull qwen3.5:9b-q4_K_M
  ollama pull ministral-3:14b-instruct-2512-q4_K_M
  npm run gen:data -- --size 50MB --out ./sample-data
  npm run cli -- bench --folder ./sample-data --models qwen3.5:9b-q4_K_M,ministral-3:14b-instruct-2512-q4_K_M --runs 3
  ```
  The first model listed is treated as the "smaller" one by the rule. Note this laptop has 15.4 GB RAM with little free: the 14B model likely does not fit comfortably.

## Known gaps
- Real-model behaviour (thinking off, JSON mode quality, latency) unverified.
- `agreement` metric = share of simple questions whose result set is identical across runs.
- Eval questions use only the synthetic schema; the pruner synonyms are insurance-flavoured defaults.
