"""Train sequence classifiers on cached frame features (from extract_features.py) and write a submission.

    .venv/bin/python train_head.py --feat features/resnet18_224 --head rel --out submission_vN.csv

Heads (all score each frame, then take the max over the sequence, because the label means "any frame is anomalous"):
  plain : MLP on the frame's own features
  rel   : MLP on [frame, frame - sequence median]; an animatronic that moved stands out against its neighbours
  cam   : rel + [frame - mean of NORMAL training frames from the same camera] (cameras found by k-means on frame features)

A fixed, seeded, stratified 20% of train is the validation split. The F1 threshold is chosen on validation only.
The final model is refit on all of train with the same number of epochs and that threshold, then applied to test.
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

from dataset import write_submission

ap = argparse.ArgumentParser()
ap.add_argument("--feat", default="features/resnet18_224")
ap.add_argument("--head", default="rel", choices=["plain", "rel", "cam"])
ap.add_argument("--epochs", type=int, default=40)
ap.add_argument("--hidden", type=int, default=256)
ap.add_argument("--dropout", type=float, default=0.3)
ap.add_argument("--lr", type=float, default=1e-3)
ap.add_argument("--wd", type=float, default=1e-3)
ap.add_argument("--grid", action="store_true", help="also use the 2x3 spatial map")
ap.add_argument("--out", default=None)
ap.add_argument("--seed", type=int, default=0)
args = ap.parse_args()
torch.manual_seed(args.seed); np.random.seed(args.seed)

HERE = Path(__file__).resolve().parent
tr = np.load(HERE / args.feat / "train.npz"); te = np.load(HERE / args.feat / "test.npz")


def frame_feats(d):
    x = d["feats"].astype(np.float32)                       # (N, T, D)
    if args.grid:
        g = d["grid"].astype(np.float32)
        x = np.concatenate([x, g.reshape(g.shape[0], g.shape[1], -1)], axis=2)
    return x


Xtr, Xte = frame_feats(tr), frame_feats(te)
y = tr["labels"].astype(np.float32)

# Fixed validation split (stratified, seeded): the same rows every run, so runs are comparable.
rng = np.random.RandomState(1234)
val_mask = np.zeros(len(y), bool)
for c in (0, 1):
    idx = np.where(y == c)[0]; rng.shuffle(idx); val_mask[idx[: int(0.2 * len(idx))]] = True


def frame_cameras(Xall, k=12, iters=30):
    """k-means over individual frames: sequences switch between ~10 fixed cameras, so each FRAME gets a camera id."""
    F = Xall.reshape(-1, Xall.shape[2]); mu, sd = F.mean(0), F.std(0) + 1e-6; Z = (F - mu) / sd
    r = np.random.RandomState(0); cent = Z[r.choice(len(Z), k, replace=False)]
    for _ in range(iters):
        lab = np.concatenate([((Z[i:i + 20000, None, :] - cent[None]) ** 2).sum(-1).argmin(1) for i in range(0, len(Z), 20000)])
        cent = np.stack([Z[lab == j].mean(0) if (lab == j).any() else cent[j] for j in range(k)])
    return lab.reshape(Xall.shape[0], Xall.shape[1])


def build(X, fit_mask_normal, cam=None, cam_means=None):
    med = np.median(X, axis=1, keepdims=True)
    parts = [X, X - med]
    if args.head == "plain":
        parts = [X]
    if args.head == "cam":
        parts.append(X - cam_means[cam])
    return np.concatenate(parts, axis=2)


K = 12
if args.head == "cam":
    cams = frame_cameras(np.concatenate([Xtr, Xte]), k=K)
    cam_tr, cam_te = cams[: len(Xtr)], cams[len(Xtr):]


def cam_means_from(mask):
    """Mean feature of frames from NORMAL training sequences, per camera cluster."""
    out = np.zeros((K, Xtr.shape[2]), np.float32)
    normal = mask & (y == 0)
    for j in range(K):
        sel = (cam_tr == j) & normal[:, None]
        out[j] = Xtr[sel].mean(0) if sel.any() else Xtr[normal].reshape(-1, Xtr.shape[2]).mean(0)
    return out


class Head(nn.Module):
    def __init__(self, d):
        super().__init__()
        self.norm = nn.LayerNorm(d)
        self.mlp = nn.Sequential(nn.Linear(d, args.hidden), nn.GELU(), nn.Dropout(args.dropout), nn.Linear(args.hidden, 1))

    def forward(self, x):                     # (B, T, d)
        return self.mlp(self.norm(x)).squeeze(-1).amax(dim=1)


def train(X, yy, epochs):
    Xt, yt = torch.tensor(X), torch.tensor(yy)
    m = Head(X.shape[2]); opt = torch.optim.AdamW(m.parameters(), lr=args.lr, weight_decay=args.wd)
    pos = yy.mean(); lossf = nn.BCEWithLogitsLoss(pos_weight=torch.tensor((1 - pos) / max(pos, 1e-6)))
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
    for _ in range(epochs):
        m.train(); perm = torch.randperm(len(Xt))
        for i in range(0, len(perm), 64):
            b = perm[i:i + 64]; opt.zero_grad(); loss = lossf(m(Xt[b]), yt[b]); loss.backward(); opt.step()
        sched.step()
    return m


@torch.no_grad()
def predict(m, X):
    m.eval(); return torch.sigmoid(m(torch.tensor(X))).numpy()


def f1_at(p, yy, t):
    pr = p >= t; tp = (pr & (yy == 1)).sum(); fp = (pr & (yy == 0)).sum(); fn = (~pr & (yy == 1)).sum()
    prec = tp / (tp + fp) if tp + fp else 0.0; rec = tp / (tp + fn) if tp + fn else 0.0
    return (2 * prec * rec / (prec + rec) if prec + rec else 0.0), prec, rec


t0 = time.time()
fit = ~val_mask
if args.head == "cam":
    cm = cam_means_from(fit)
    Ftr = build(Xtr, fit, cam_tr, cm)
else:
    Ftr = build(Xtr, fit)
m = train(Ftr[fit], y[fit], args.epochs)
pv = predict(m, Ftr[val_mask]); yv = y[val_mask]
grid = np.linspace(0.05, 0.95, 91)
scores = [f1_at(pv, yv, t)[0] for t in grid]
best_t = float(grid[int(np.argmax(scores))])
f1, prec, rec = f1_at(pv, yv, best_t)
f1_05 = f1_at(pv, yv, 0.5)[0]
print(f"[{args.head}{'+grid' if args.grid else ''}] val F1 {f1:.4f} (P {prec:.3f} R {rec:.3f}) at threshold {best_t:.2f}; F1@0.5 {f1_05:.4f}; n_val {val_mask.sum()} ({int(yv.sum())} anomalous)")

if args.out:
    # Refit on all of train with the same settings, then predict test with the validation-chosen threshold.
    if args.head == "cam":
        cm_all = cam_means_from(np.ones(len(y), bool))
        Fall, Fte = build(Xtr, None, cam_tr, cm_all), build(Xte, None, cam_te, cm_all)
    else:
        Fall, Fte = build(Xtr, None), build(Xte, None)
    mf = train(Fall, y, args.epochs)
    pt = predict(mf, Fte)
    preds = (pt >= best_t).tolist()
    write_submission(HERE / args.out, [str(s) for s in te["ids"]], preds)
    print(f"wrote {args.out}: {sum(preds)}/{len(preds)} predicted anomalous ({time.time() - t0:.0f}s)")
    with open(HERE / "runs.jsonl", "a") as fh:
        fh.write(json.dumps({"out": args.out, "feat": args.feat, "head": args.head, "grid": args.grid, "epochs": args.epochs, "hidden": args.hidden,
                             "val_f1": round(float(f1), 4), "val_precision": round(float(prec), 4), "val_recall": round(float(rec), 4),
                             "threshold": best_t, "test_pos_rate": round(sum(preds) / len(preds), 4), "time": time.strftime("%H:%M")}) + "\n")
