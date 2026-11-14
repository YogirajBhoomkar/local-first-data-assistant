"""Fine-tune Laya on the generated training questions (CPU is fine for a frozen encoder; a full run needs time).

    python train.py --limit 64 --epochs 1                 # timing test
    python train.py --epochs 3 --out checkpoints/effort   # real run
"""
import argparse
import json
import os
import time

os.environ.setdefault("USE_TF", "0")

from laya.train import TrainConfig, finetune  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="convaiinnovations/laya-typed-decisions")
ap.add_argument("--data", default="data/train.jsonl")
ap.add_argument("--out", default="checkpoints/effort")
ap.add_argument("--limit", type=int, default=0)
ap.add_argument("--epochs", type=int, default=3)
ap.add_argument("--freeze-encoder", action="store_true")
ap.add_argument("--micro-batch", type=int, default=8)
ap.add_argument("--grad-accum", type=int, default=2)
ap.add_argument("--max-len", type=int, default=64)
ap.add_argument("--head-max-len", type=int, default=320)
ap.add_argument("--loss", default="soft-ce")
args = ap.parse_args()

data = args.data
if args.limit:
    data = "data/_subset.jsonl"
    with open(args.data, encoding="utf8") as f, open(data, "w", encoding="utf8") as g:
        for i, line in enumerate(f):
            if i >= args.limit:
                break
            g.write(line)

cfg = TrainConfig(
    loss=args.loss,
    epochs=args.epochs,
    micro_batch=args.micro_batch,
    grad_accum=args.grad_accum,
    max_len=args.max_len,
    head_max_len=args.head_max_len,
    freeze_encoder=args.freeze_encoder,
    shuffle_options=("choice",),
    log_every=4,
)
t0 = time.time()
report = finetune(data, args.base, args.out, cfg, device="cpu")
print(json.dumps({k: v for k, v in report.items() if k != "history"}, indent=2, default=str))
print("seconds", round(time.time() - t0, 1))
