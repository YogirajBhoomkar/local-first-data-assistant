"""The typed questions we ask Laya about every user question, and the gold effort labels used to score it.

The wording is shared with the TypeScript client: packages/models/src/laya-questions.json is the single source of
truth, so a fine-tuned checkpoint is trained on exactly the questions the app asks.

Laya is a decision model: it never writes text. For one piece of state (the user's question) it answers typed
questions with calibrated probabilities. We use it as one extra signal in the effort estimate.
"""
import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
QUESTIONS = json.load(open(os.path.join(_HERE, "..", "..", "packages", "models", "src", "laya-questions.json"), encoding="utf8"))

# Gold effort for the 45 evaluation questions (a judgement call, documented in docs/phases/phase-5.md):
# low = one table, one plain query; medium = one table with date/period/ratio logic; high = joins, reasoning,
# forecasting, recommendation, vague wording, summaries across documents.
GOLD_MEDIUM_TABLE = {"q022", "q023"}


def gold_effort(q: dict) -> str:
    if q["kind"] == "table":
        if q["label"] == "simple":
            return "low"
        return "medium" if q["id"] in GOLD_MEDIUM_TABLE else "high"
    return "low" if q["label"] == "simple" else "high"
