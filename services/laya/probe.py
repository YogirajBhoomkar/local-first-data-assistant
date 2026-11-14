"""Run Laya (as shipped, no fine-tuning) on the evaluation questions and score it against the gold effort labels.

    services/laya/.venv/Scripts/python.exe services/laya/probe.py [--model convaiinnovations/laya-typed-decisions]
"""
import argparse
import json
import os
import time

os.environ.setdefault("USE_TF", "0")  # transformers probes for TensorFlow, which can deadlock model construction

import laya  # noqa: E402

from questions import QUESTIONS, gold_effort  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="convaiinnovations/laya-typed-decisions")
ap.add_argument("--questions", default="eval/questions.jsonl")
ap.add_argument("--out", default="eval/reports/laya-zero-shot.json")
args = ap.parse_args()

items = [json.loads(line) for line in open(args.questions, encoding="utf8") if line.strip()]
agent = laya.Agent(args.model)

rows = []
t_all = time.time()
for q in items:
    t0 = time.time()
    out = agent.predict(q["question"], QUESTIONS)
    ms = (time.time() - t0) * 1000
    a = out["answers"]
    rows.append({
        "id": q["id"],
        "kind": q["kind"],
        "label": q["label"],
        "gold": gold_effort(q),
        "effort": a["effort"]["choice"] if "effort" in a else None,
        "effort_conf": a["effort"].get("answer_confidence") if "effort" in a else None,
        "effort_probs": a["effort"].get("probabilities") if "effort" in a else None,
        "needs_reasoning": a["needs_reasoning"]["choice"],
        "needs_reasoning_conf": a["needs_reasoning"].get("answer_confidence"),
        "multi_step": a["multi_step"]["choice"],
        "ambiguous": a["ambiguous"]["choice"],
        "ms": round(ms),
    })

n = len(rows)
acc3 = sum(r["effort"] == r["gold"] for r in rows) / n
# what routing actually needs: does Laya separate "high" (go remote) from the rest (try locally)?
tp = sum(r["effort"] == "high" and r["gold"] == "high" for r in rows)
fp = sum(r["effort"] == "high" and r["gold"] != "high" for r in rows)
fn = sum(r["effort"] != "high" and r["gold"] == "high" for r in rows)
tn = n - tp - fp - fn
summary = {
    "model": args.model,
    "questions": n,
    "effort_accuracy_3class": round(acc3, 3),
    "high_vs_rest": {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "accuracy": round((tp + tn) / n, 3)},
    "majority_baseline": round(max(sum(r["gold"] == g for r in rows) for g in ("low", "medium", "high")) / n, 3),
    "mean_ms": round(sum(r["ms"] for r in rows) / n),
    "total_s": round(time.time() - t_all, 1),
}
# The individual signals the effort estimate uses (gold sets are judgement calls, see docs/phases/phase-5.md).
REASONING_GOLD = {"q024", "q025", "q029", "q030"} | {f"d{n:03d}" for n in range(9, 16)}
MULTI_GOLD = {"q019", "q020", "q021", "q027", "q028", "q029", "q030"}


def signal_stats(key, gold):
    tp = sum(r[key] == "yes" and r["id"] in gold for r in rows)
    fp = sum(r[key] == "yes" and r["id"] not in gold for r in rows)
    fn = sum(r[key] == "no" and r["id"] in gold for r in rows)
    tn = n - tp - fp - fn
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "accuracy": round((tp + tn) / n, 3)}


summary["needs_reasoning"] = signal_stats("needs_reasoning", REASONING_GOLD)
summary["multi_step"] = signal_stats("multi_step", MULTI_GOLD)
os.makedirs(os.path.dirname(args.out), exist_ok=True)
json.dump({"summary": summary, "rows": rows}, open(args.out, "w", encoding="utf8"), indent=2)
print(json.dumps(summary, indent=2))
