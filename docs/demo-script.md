# Demo script (about 10 minutes)

Everything below runs on the synthetic data in `sample-data/` with the real local model (`qwen3.5:4b` through Ollama) and the real remote model (`gpt-5.1` through your LiteLLM proxy). Nothing is mocked.

## Before the client arrives
1. Ollama is running (`ollama ps` works) and `qwen3.5:4b` is installed (`ollama pull qwen3.5:4b`).
2. A `.env` in the repo root has `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` (or enter them once in Settings; the key is stored in the OS keychain).
3. Generate the data once: `npm run gen:data -- --size 50MB --out ./sample-data` and `npm run gen:docs -- --out ./sample-data`.
4. Build and start: `npm run desktop:build`, then `npm run start -w @lf/desktop` (development: `npm run desktop:dev`).
5. Warm the local model by asking it one throwaway question: the first local call loads the model (about 20 s).
6. Close other heavy applications: the local model runs on CPU and needs memory.

## 1. The idea (1 min)
Point at the status line: local model ready, remote model ready. Say: a small model on this laptop handles simple questions; only hard ones go to a stronger remote model, and only through a gate that shows and logs exactly what is sent. Files never leave as files.
Open **Select folder** and choose `sample-data`. Point out the file list: CSV, Parquet, Excel, PDF and PowerPoint, each with a status. The messy workbook shows a warning; the scanned PDF is skipped with a reason (no OCR in this version).

## 2. A simple question stays on the laptop (2 min)
Ask: **How many policies are there?**
Watch the **Under the hood** panel while it runs (about 45 s on this CPU-only laptop; talk through it):
- Question → **Schema pruning**: only the few relevant tables and columns are kept.
- **Router**: click it to read the layers. It decided *local*.
- **Local model** lights up: it writes one SQL query. Click the node to read the SQL.
- **DuckDB** runs it read-only; **Verify** checks the result and asks the model a second time to confirm.
- The escalation lane (privacy gate, egress log, remote) stays dimmed: "not needed". The counter says **0 B left the laptop**.
Answer badge: "Answered on this laptop".

## 3. Table, chart and SQL (1 min)
Ask: **Show total premium by region.** Switch the chart type (bar, line, pie, scatter). Open "SQL used". Sort a column in the table.

## 4. A hard question escalates, with consent (3 min)
Ask: **Why is premium higher in some regions than others?**
- The router escalates immediately: the word "why" and the number of tables are hard rules, no model needed. The router node shows `→ remote`.
- The **Confirm** dialog appears. This is the point to slow down: the payload is the schema and a few sample rows, nothing else. Click **Cancel** first to show that the question then stays local with an explanation, then ask again and press **Send**.
- Watch the packet cross the dashed **laptop boundary**. The remote model writes SQL; the SQL runs **locally** on the real data; a capped result is sent back for the explanation.
- Counters: bytes and rows that left the laptop versus rows kept local.
- Click **Privacy gate** and **Egress log** nodes: purpose, tables, columns, bytes, and the exact payload.

## 5. A document question with sources (1 min)
Ask: **What does the guideline say about the maximum single-risk limit for Property?**
The map switches to the document layout (keyword search over local passages). The answer cites `[underwriting_guidelines p4]`; the Sources card shows the passage. A summary question across documents (for example **Summarise the referral and authority rules in the underwriting guidelines.**) escalates, sending only the top passages.

## 6. The log and the privacy dial (2 min)
- **Egress log** (top right): every send, with purpose, outcome, level, bytes, approval and a SHA-256 of the exact payload. It is append-only and stays on the laptop.
- **Settings → Privacy**: change from "Schema + summaries + rows" to **Schema only**, ask the "why" question again, and show the payload in the confirm dialog: no values at all. With schema-only the remote model never sees a value and the answer is written locally.
- Add a **never send** pattern (for example `region`) or a **mask** pattern and ask again to show columns removed or replaced by `tok_…` tokens.
- **Replay**: select any finished answer and press Replay at 0.5× to walk the pipeline again.

## If something goes wrong
- *Local model slow:* expected on CPU. Narrate the steps; or switch the model in Settings to a smaller one.
- *Remote unreachable:* the status line says so; the question fails with a clear message and nothing is sent.
- *Offline:* local questions still work; remote ones fail clearly (this is tested, see `docs/phases/phase-5.md`).
