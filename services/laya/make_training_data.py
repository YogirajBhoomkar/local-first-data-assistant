"""Generate labelled training questions for Laya, with NO insurance vocabulary.

The 45 evaluation questions are about an insurance-style dataset (policies, claims, premium, brokers...). To keep that a
true held-out test, the training questions use other business domains (sales, HR, logistics, finance, clinics, support).
Labels come from how each template is built: they say how much work answering needs, not what the answer is.

    python make_training_data.py --out data --n 1800 --seed 7
"""
import argparse
import json
import os
import random
import re

from questions import QUESTIONS

DOMAINS = {
    "sales": dict(
        entities=["orders", "customers", "invoices", "returns", "quotes"],
        entity_b="customers",
        measures=["revenue", "order value", "discount", "quantity sold", "margin", "shipping cost"],
        dims=["region", "product category", "sales channel", "sales rep", "customer segment"],
        values=["the West region", "online orders", "the enterprise segment", "Q3", "wholesale"],
        statuses=["open", "cancelled", "refunded", "pending", "shipped"],
        dates=("order date", "ship date"),
    ),
    "hr": dict(
        entities=["employees", "job openings", "applications", "timesheets", "training courses"],
        entity_b="departments",
        measures=["salary", "headcount", "overtime hours", "tenure", "leave days", "training cost"],
        dims=["department", "office location", "job level", "manager", "hiring source"],
        values=["engineering", "the Berlin office", "senior staff", "contractors", "2023 hires"],
        statuses=["active", "on leave", "resigned", "probation", "open"],
        dates=("hire date", "start date"),
    ),
    "logistics": dict(
        entities=["shipments", "deliveries", "pallets", "routes", "warehouse bookings"],
        entity_b="carriers",
        measures=["delivery time", "freight cost", "weight", "fuel use", "damage rate", "dwell time"],
        dims=["carrier", "route", "warehouse", "destination country", "transport mode"],
        values=["air freight", "the northern route", "Rotterdam", "express shipments", "carrier A"],
        statuses=["delayed", "delivered", "in transit", "held at customs", "returned"],
        dates=("pickup date", "delivery date"),
    ),
    "finance": dict(
        entities=["invoices", "payments", "expense claims", "purchase orders", "journal entries"],
        entity_b="vendors",
        measures=["amount", "tax", "outstanding balance", "payment delay", "cost", "accrual"],
        dims=["vendor", "currency", "cost center", "approver", "payment method"],
        values=["USD invoices", "marketing", "overdue items", "card payments", "cost center 410"],
        statuses=["paid", "overdue", "approved", "rejected", "draft"],
        dates=("invoice date", "due date"),
    ),
    "clinic": dict(
        entities=["appointments", "patients", "prescriptions", "lab tests", "referrals"],
        entity_b="doctors",
        measures=["waiting time", "visit length", "no-show rate", "test cost", "readmissions", "bed days"],
        dims=["clinic", "doctor specialty", "age group", "visit type", "ward"],
        values=["the east clinic", "cardiology", "first visits", "weekend slots", "over 65s"],
        statuses=["completed", "cancelled", "no-show", "scheduled", "waiting"],
        dates=("booking date", "visit date"),
    ),
    "support": dict(
        entities=["tickets", "chats", "escalations", "survey responses", "refund requests"],
        entity_b="agents",
        measures=["resolution time", "first response time", "satisfaction score", "backlog", "handle time", "reopen rate"],
        dims=["agent", "product", "priority", "channel", "team"],
        values=["priority 1 tickets", "the billing team", "chat support", "new customers", "mobile app"],
        statuses=["open", "resolved", "escalated", "closed", "waiting"],
        dates=("created date", "resolved date"),
    ),
}

DOCS = ["the onboarding handbook", "the quarterly report", "the operations manual", "the vendor contract", "the safety policy", "the roadmap deck", "the audit findings", "the training slides"]
TOPICS = ["the approval limit", "the retention period", "notice periods", "escalation steps", "the reporting deadline", "the budget cap", "who signs off", "the review cycle"]
PREFIX = ["", "", "", "Please ", "Can you ", "I need to know: ", "Quick question: ", "Hey, "]


def label(effort, reasoning="no", multi="no", ambiguous="no"):
    return {"effort": effort, "needs_reasoning": reasoning, "multi_step": multi, "ambiguous": ambiguous}


def low(d, r):
    e, m, dim, val, st = r.choice(d["entities"]), r.choice(d["measures"]), r.choice(d["dims"]), r.choice(d["values"]), r.choice(d["statuses"])
    k = r.choice([3, 5, 10])
    t = r.choice([
        f"How many {e} are there?",
        f"How many {e} are {st}?",
        f"What is the total {m}?",
        f"What is the average {m} for {val}?",
        f"Show the total {m} by {dim}.",
        f"Which {k} {dim}s have the highest {m}?",
        f"What is the largest {m} recorded?",
        f"Count the {e} per {dim}.",
        f"What is the minimum {m} for {val}?",
        f"Give me the number of {e} that are {st}.",
        f"List the {k} {e} with the biggest {m}.",
        f"total {m} please",
        f"how many {e} do we have with status {st}",
        f"What is the sum of {m} where {dim} is {val}?",
        f"Show me {e} per {dim}, top {k}.",
    ])
    return t, label("low")


def medium(d, r):
    e, m, dim, st = r.choice(d["entities"]), r.choice(d["measures"]), r.choice(d["dims"]), r.choice(d["statuses"])
    a, b = d["dates"]
    y1, y2 = r.sample([2021, 2022, 2023, 2024], 2)
    t = r.choice([
        f"How did the total {m} change between {y1} and {y2}?",
        f"What is the average number of days between {a} and {b}?",
        f"What share of {e} are {st}?",
        f"What percentage of {e} are {st}, by {dim}?",
        f"Compare {m} in {y1} versus {y2}.",
        f"How many {e} per month in {y2}?",
        f"What is the {m} this quarter compared to last quarter?",
        f"Rank the {dim}s by {m} and show the running total.",
        f"What is the difference in {m} between {y1} and {y2}?",
        f"What is the ratio of {st} {e} to all {e}?",
        f"Show the month over month growth in {m}.",
        f"How long on average between {a} and {b} for {e}?",
    ])
    return t, label("medium")


def high_join(d, r):
    e, eb, m, dim, val = r.choice(d["entities"]), d["entity_b"], r.choice(d["measures"]), r.choice(d["dims"]), r.choice(d["values"])
    t = r.choice([
        f"What is the total {m} of {e} for {eb} in {val}?",
        f"Which {eb} have the highest {m} across their {e}?",
        f"Show {m} per {eb} joined with their {e} by {dim}.",
        f"How many {e} belong to {eb} with more than 50 {r.choice(d['entities'])}?",
        f"Combine {e} and {eb} to find the {m} by {dim}.",
        f"For each of the {eb}, what is the {m} and the number of {e}?",
        f"Match {e} to {eb} and list those with a {m} above average.",
        f"What is the {m} of {e} linked to {val}?",
    ])
    return t, label("high", multi="yes")


def high_reason(d, r):
    e, m, dim, st = r.choice(d["entities"]), r.choice(d["measures"]), r.choice(d["dims"]), r.choice(d["statuses"])
    t = r.choice([
        f"Why is {m} higher in some {dim}s than others?",
        f"Why did {m} drop last month?",
        f"Explain the rise in {st} {e}.",
        f"What should we do to reduce {m}?",
        f"Forecast the {m} for next quarter.",
        f"Which {dim} should we focus on to improve {m}? Recommend something.",
        f"What are the main drivers of {m}?",
        f"Predict how many {e} will be {st} next month.",
        f"Give me insights about {m} and what they mean.",
        f"What is the root cause of the {st} {e}?",
        f"Is the trend in {m} a problem, and what would you recommend?",
        f"Why do {e} get {st} so often?",
    ])
    return t, label("high", reasoning="yes")


def high_vague(d, r):
    e, m = r.choice(d["entities"]), r.choice(d["measures"])
    t = r.choice([
        f"Which {e} are at risk?",
        "How are we doing?",
        f"Show me the important {e}.",
        "What looks unusual?",
        "Is performance good?",
        f"Anything I should know about {m}?",
        f"Which {e} matter most?",
        f"Find the problem {e}.",
        "Give me an overview of everything.",
        f"What is wrong with {m}?",
    ])
    return t, label("high", ambiguous="yes")


def doc_low(r):
    t = r.choice([
        f"What does {r.choice(DOCS)} say about {r.choice(TOPICS)}?",
        f"Which slide mentions {r.choice(TOPICS)}?",
        f"What is {r.choice(TOPICS)} according to {r.choice(DOCS)}?",
        f"On which page of {r.choice(DOCS)} is {r.choice(TOPICS)} described?",
    ])
    return t, label("low")


def doc_high(r):
    a, b = r.sample(DOCS, 2)
    t = r.choice([
        f"Summarise {a}.",
        f"Give an overview of {a}.",
        f"Compare what {a} and {b} say about {r.choice(TOPICS)}.",
        f"List all the actions across {a}.",
        f"What are the main risks mentioned in {a} and {b}?",
        f"How does {a} relate to {b}?",
    ])
    return t, label("high", reasoning="yes", multi="yes" if " and " in t or "relate" in t else "no")


def decorate(t, r):
    p = r.choice(PREFIX)
    if p and t[0].isupper():
        t = t[0].lower() + t[1:]
    t = p + t
    if r.random() < 0.15:
        t = t.lower().rstrip("?.")
    elif r.random() < 0.1:
        t = t.rstrip("?.")
    return t


def norm(t):
    return re.sub(r"[^a-z0-9 ]", "", t.lower()).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    ap.add_argument("--n", type=int, default=1800)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--eval", default="../../eval/questions.jsonl")
    args = ap.parse_args()
    r = random.Random(args.seed)

    forbidden = {norm(json.loads(l)["question"]) for l in open(args.eval, encoding="utf8") if l.strip()}
    insurance = re.compile(r"polic|claim|premium|broker|loss ratio|insured|exposure|underwrit|reinsur|peril", re.I)

    makers = [
        (low, 0.30), (medium, 0.17), (high_join, 0.15), (high_reason, 0.17), (high_vague, 0.07),
    ]
    rows, seen = [], set()
    attempts = 0
    while len(rows) < args.n and attempts < args.n * 40:
        attempts += 1
        x = r.random()
        if x < 0.07:
            t, lab = doc_low(r) if r.random() < 0.5 else doc_high(r)
        else:
            d = DOMAINS[r.choice(list(DOMAINS))]
            acc = 0.0
            fn = low
            y = r.random() * sum(w for _, w in makers)
            for f, w in makers:
                acc += w
                if y <= acc:
                    fn = f
                    break
            t, lab = fn(d, r)
        t = decorate(t, r)
        k = norm(t)
        if k in seen or k in forbidden or insurance.search(t):
            continue
        seen.add(k)
        rows.append({"state": t, "questions": QUESTIONS, "expected": lab})

    r.shuffle(rows)
    n_dev = max(100, len(rows) // 8)
    dev, train = rows[:n_dev], rows[n_dev:]
    os.makedirs(args.out, exist_ok=True)
    for name, part in (("train", train), ("dev", dev)):
        with open(os.path.join(args.out, f"{name}.jsonl"), "w", encoding="utf8") as f:
            for row in part:
                f.write(json.dumps(row) + "\n")
    from collections import Counter
    print("train", len(train), "dev", len(dev))
    print("effort", Counter(x["expected"]["effort"] for x in train))
    print("reasoning", Counter(x["expected"]["needs_reasoning"] for x in train), "multi", Counter(x["expected"]["multi_step"] for x in train), "ambiguous", Counter(x["expected"]["ambiguous"] for x in train))
    print("examples:")
    for x in train[:8]:
        print(" ", x["state"], "->", x["expected"])


if __name__ == "__main__":
    main()
