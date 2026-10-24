"""Fine-tune a pretrained CNN end to end (score each frame, max over the sequence), on the same fixed validation split as train_head.py.

    .venv/bin/python finetune.py --arch resnet18 --epochs 3 --size 160 --name ft_r18

Saves preds/<name>.npz with validation probabilities (for threshold choice and ensembling) and test probabilities,
and writes submission_<name>.csv using the threshold that maximises F1 on validation. Never looks at test labels (there are none).
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Subset
from torchvision import transforms
from torchvision.models import ResNet18_Weights, ResNet34_Weights, resnet18, resnet34

from dataset import FazzbearSequenceDataset, write_submission

HERE = Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument("--arch", default="resnet18")
ap.add_argument("--epochs", type=int, default=3)
ap.add_argument("--size", type=int, default=160, help="frame height; width keeps the 455x256 aspect")
ap.add_argument("--batch", type=int, default=8)
ap.add_argument("--lr", type=float, default=2e-4)
ap.add_argument("--name", default="ft")
ap.add_argument("--limit", type=int, default=None, help="train sequences per epoch (None = all)")
ap.add_argument("--workers", type=int, default=6)
args = ap.parse_known_args()[0]

device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
SIZE = (args.size, int(round(args.size * 455 / 256)))
NORM = transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
train_tf = transforms.Compose([transforms.Resize(SIZE), transforms.ColorJitter(0.2, 0.2), transforms.ToTensor(), NORM])
eval_tf = transforms.Compose([transforms.Resize(SIZE), transforms.ToTensor(), NORM])


class Seq(nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = resnet34(weights=ResNet34_Weights.DEFAULT) if args.arch == "resnet34" else resnet18(weights=ResNet18_Weights.DEFAULT)
        self.backbone.fc = nn.Linear(self.backbone.fc.in_features, 1)

    def forward(self, clip):
        b, t = clip.shape[:2]
        return self.backbone(clip.flatten(0, 1)).view(b, t).amax(dim=1)


def val_split(y):
    """Identical to train_head.py: seeded, stratified 20%."""
    rng = np.random.RandomState(1234); m = np.zeros(len(y), bool)
    for c in (0, 1):
        idx = np.where(y == c)[0]; rng.shuffle(idx); m[idx[: int(0.2 * len(idx))]] = True
    return m


def f1_at(p, yy, t):
    pr = p >= t; tp = (pr & (yy == 1)).sum(); fp = (pr & (yy == 0)).sum(); fn = (~pr & (yy == 1)).sum()
    prec = tp / (tp + fp) if tp + fp else 0.0; rec = tp / (tp + fn) if tp + fn else 0.0
    return (2 * prec * rec / (prec + rec) if prec + rec else 0.0), prec, rec


@torch.no_grad()
def probs(model, loader):
    model.eval(); out = []
    for clip, _ in loader:
        out.append(torch.sigmoid(model(clip.to(device))).float().cpu())
    return torch.cat(out).numpy()


def main():
    t0 = time.time()
    train_view = FazzbearSequenceDataset(HERE / "data/train", transform=train_tf)
    eval_view = FazzbearSequenceDataset(HERE / "data/train", transform=eval_tf)
    y = train_view.sequence_labels.numpy()
    vm = val_split(y)
    tr_idx, va_idx = np.where(~vm)[0].tolist(), np.where(vm)[0].tolist()
    rng = np.random.RandomState(0)
    model = Seq().to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    steps_per_epoch = (min(len(tr_idx), args.limit or len(tr_idx)) + args.batch - 1) // args.batch
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.epochs * steps_per_epoch, pct_start=0.15)
    lossf = nn.BCEWithLogitsLoss()
    val_loader = DataLoader(Subset(eval_view, va_idx), batch_size=args.batch * 2, num_workers=args.workers)
    best = (-1.0, None)
    for ep in range(1, args.epochs + 1):
        model.train()
        sub = rng.permutation(tr_idx)[: args.limit or len(tr_idx)].tolist()
        loader = DataLoader(Subset(train_view, sub), batch_size=args.batch, shuffle=True, num_workers=args.workers, drop_last=False)
        run = 0.0
        for step, (clip, label) in enumerate(loader, 1):
            opt.zero_grad(); loss = lossf(model(clip.to(device)), label.to(device)); loss.backward(); opt.step(); sched.step()
            run += loss.item()
            if step % 100 == 0:
                print(f"ep {ep} step {step}/{len(loader)} loss {run / step:.4f}  {time.time() - t0:.0f}s", flush=True)
        pv = probs(model, val_loader); yv = y[va_idx]
        grid = np.linspace(0.05, 0.95, 91); t = float(grid[int(np.argmax([f1_at(pv, yv, g)[0] for g in grid]))])
        f1, p, r = f1_at(pv, yv, t)
        print(f"ep {ep} val F1 {f1:.4f} (P {p:.3f} R {r:.3f}) at t={t:.2f}; F1@0.5 {f1_at(pv, yv, 0.5)[0]:.4f}  {time.time() - t0:.0f}s", flush=True)
        if f1 > best[0]:
            best = (f1, t, p, r, pv.copy())
            torch.save(model.state_dict(), HERE / f"{args.name}.pt")
    # Predict test with the best-on-validation epoch's weights and threshold.
    model.load_state_dict(torch.load(HERE / f"{args.name}.pt", map_location=device))
    test = FazzbearSequenceDataset(HERE / "data/test", transform=eval_tf)
    pt = probs(model, DataLoader(test, batch_size=args.batch * 2, num_workers=args.workers))
    f1, t, p, r, pv = best
    (HERE / "preds").mkdir(exist_ok=True)
    np.savez(HERE / "preds" / f"{args.name}.npz", val=pv, val_idx=np.array(va_idx), test=pt, test_ids=np.array(test.sequence_ids))
    out = f"submission_{args.name}.csv"
    preds = (pt >= t).tolist()
    write_submission(HERE / out, test.sequence_ids, preds)
    print(f"wrote {out}: {sum(preds)}/{len(preds)} anomalous; best val F1 {f1:.4f} at t={t:.2f}; total {time.time() - t0:.0f}s", flush=True)
    with open(HERE / "runs.jsonl", "a") as fh:
        fh.write(json.dumps({"out": out, "kind": "finetune", "arch": args.arch, "size": args.size, "epochs": args.epochs, "limit": args.limit,
                             "val_f1": round(float(f1), 4), "val_precision": round(float(p), 4), "val_recall": round(float(r), 4), "threshold": t,
                             "test_pos_rate": round(sum(preds) / len(preds), 4), "minutes": round((time.time() - t0) / 60, 1), "time": time.strftime("%H:%M")}) + "\n")


if __name__ == "__main__":
    main()
