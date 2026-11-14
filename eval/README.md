# Evaluation set

`questions.jsonl` holds one JSON object per line:

| field | meaning |
|---|---|
| `id` | unique, `qNNN` |
| `kind` | `table` or `doc` (doc questions are added in Phase 4) |
| `files` | files the question is about (synthetic data from `npm run gen:data`) |
| `question` | the text asked |
| `label` | `simple` (should be answered locally) or `hard` (should escalate) |
| `expected` | `{type: "sql" \| "value" \| "contains" \| "manual", value}`; for `sql`, the reference SQL over `t_<alias>` tables |
| `notes` | why it is simple or hard |

Currently 30 table questions: 18 simple, 12 hard. Reports are written to `eval/reports/`.
