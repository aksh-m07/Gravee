"""Cache frozen pretrained-CNN features for every frame, so heads can be trained in seconds.

    .venv/bin/python extract_features.py [--size 224] [--arch resnet18|resnet50]

Writes features/<arch>_<size>/{train,test}.npz with
  feats   (N, T, D) float16  globally pooled backbone features per frame
  grid    (N, T, C, h, w) float16  a small spatial map (so a head can see *where* something changed)
  ids     (N,) sequence ids, labels (N,) (train only; -1 for test)
"""
import argparse
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms
from torchvision.models import ResNet18_Weights, ResNet50_Weights, resnet18, resnet50

from dataset import build_index

HERE = Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument("--size", type=int, default=224, help="short side in pixels")
ap.add_argument("--arch", default="resnet18")
ap.add_argument("--batch", type=int, default=16)
args = ap.parse_known_args()[0]

device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
NORM = transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
tf = transforms.Compose([transforms.Resize(args.size), transforms.ToTensor(), NORM])


class Frames(Dataset):
    def __init__(self, root):
        self.entries, _ = build_index(root)

    def __len__(self):
        return len(self.entries)

    def __getitem__(self, i):
        sid, paths, label = self.entries[i]
        clip = torch.stack([tf(Image.open(p).convert("RGB")) for p in paths])
        return clip, label, i


def main():
    if args.arch == "resnet50":
        net = resnet50(weights=ResNet50_Weights.DEFAULT)
    else:
        net = resnet18(weights=ResNet18_Weights.DEFAULT)
    body = torch.nn.Sequential(*list(net.children())[:-2]).to(device).eval()

    out_dir = HERE / "features" / f"{args.arch}_{args.size}"
    out_dir.mkdir(parents=True, exist_ok=True)

    for split in ("train", "test"):
        ds = Frames(HERE / "data" / split)
        dl = DataLoader(ds, batch_size=args.batch, num_workers=6, persistent_workers=False)
        n, t = len(ds), len(ds.entries[0][1])
        feats = grid = None
        labels = np.array([e[2] for e in ds.entries], dtype=np.float32)
        ids = np.array([e[0] for e in ds.entries])
        t0 = time.time()
        with torch.no_grad():
            for b, (clip, _, idx) in enumerate(dl):
                B = clip.shape[0]
                fmap = body(clip.flatten(0, 1).to(device))                    # (B*T, C, H, W)
                pooled = fmap.mean(dim=(2, 3)).view(B, t, -1)
                small = torch.nn.functional.adaptive_avg_pool2d(fmap.cpu(), (2, 3)).view(B, t, fmap.shape[1], 2, 3)
                if feats is None:
                    feats = np.zeros((n, t, pooled.shape[-1]), np.float16)
                    grid = np.zeros((n, t) + tuple(small.shape[2:]), np.float16)
                feats[idx.numpy()] = pooled.cpu().numpy().astype(np.float16)
                grid[idx.numpy()] = small.cpu().numpy().astype(np.float16)
                if b % 50 == 0:
                    done = (b + 1) * args.batch
                    print(f"{split} {min(done, n)}/{n}  {time.time() - t0:.0f}s", flush=True)
        np.savez(out_dir / f"{split}.npz", feats=feats, grid=grid, ids=ids, labels=labels)
        print(f"saved {out_dir / (split + '.npz')}  {feats.shape}  in {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
