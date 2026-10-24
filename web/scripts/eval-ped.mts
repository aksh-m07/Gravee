// External benchmark: the same normal-progress model on UCSD Ped1/Ped2 (frame-level ROC AUC, pooled over all test frames).
// Design choices (smoothing window) are picked on Ped1; Ped2 is the reported number. Usage: npx tsx scripts/eval-ped.mts
import fs from "node:fs";
import path from "node:path";
import { loadGray } from "../lib/frames";
import { extractFeatures, fitGate, scoreFeatures, changedFraction, type Frame } from "../lib/gate";

// Frames are PackBits TIFFs that sharp cannot decode, so scripts-convert-ped.sh converts them to PNG with macOS sips first.
const RAW = path.resolve("../data/ped-png");
const GT = path.resolve("../data/raw");
const W = 96, H = 64;

function parseGt(mfile: string): number[][] {
  const out: number[][] = [];
  for (const m of fs.readFileSync(mfile, "utf8").matchAll(/gt_frame\s*=\s*\[([^\]]*)\]/g)) {
    const set: number[] = [];
    for (const part of m[1].split(",")) { const [a, b] = part.trim().split(":").map(Number); for (let i = a; i <= (b ?? a); i++) set.push(i); }
    out.push(set);
  }
  return out;
}

async function clip(dir: string): Promise<Frame[]> {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  return Promise.all(files.map(async (f) => ({ w: W, h: H, px: await loadGray(path.join(dir, f), W, H) })));
}

function auc(scores: number[], labels: number[]): number {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  const rank = new Array(scores.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++; for (let k = i; k <= j; k++) rank[idx[k]] = (i + j) / 2 + 1; i = j + 1; }
  let pos = 0, sumPos = 0;
  labels.forEach((l, i) => { if (l) { pos++; sumPos += rank[i]; } });
  const neg = labels.length - pos;
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

const smooth = (xs: number[], w: number) => xs.map((_, i) => { const a = Math.max(0, i - w + 1); let s = 0; for (let j = a; j <= i; j++) s += xs[j]; return s / (i - a + 1); });

async function bench(name: "UCSDped1" | "UCSDped2", sub: number) {
  const base = path.join(RAW, name);
  const trainDirs = fs.readdirSync(path.join(base, "Train")).filter((d) => /^Train\d+$/.test(d)).sort();
  const testDirs = fs.readdirSync(path.join(base, "Test")).filter((d) => /^Test\d+$/.test(d)).sort();
  const gt = parseGt(path.join(GT, name, "Test", `${name}.m`));
  const seqs: Float64Array[][] = [];
  for (const d of trainDirs) { const fr = await clip(path.join(base, "Train", d)); const f = fr.map((x, i) => extractFeatures(i ? fr[i - 1] : null, x)); seqs.push(f.filter((_, i) => i % sub === 0)); }
  const model = fitGate(seqs, { k: 1, percentile: 99 });
  const knn: number[][] = [], motion: number[][] = [], labels: number[][] = [];
  for (let t = 0; t < testDirs.length; t++) {
    const fr = await clip(path.join(base, "Test", testDirs[t]));
    const bad = new Set(gt[t]);
    knn.push(fr.map((x, i) => scoreFeatures(model, extractFeatures(i ? fr[i - 1] : null, x))));
    motion.push(fr.map((x, i) => (i ? changedFraction(fr[i - 1], x) : 0)));
    labels.push(fr.map((_, i) => (bad.has(i + 1) ? 1 : 0)));
  }
  const res: Record<string, number> = {};
  for (const w of [1, 5, 9]) {
    res[`knn_w${w}`] = auc(knn.flatMap((s) => smooth(s, w)), labels.flat());
    res[`motion_w${w}`] = auc(motion.flatMap((s) => smooth(s, w)), labels.flat());
  }
  const n = labels.flat().length, nPos = labels.flat().reduce((a, b) => a + b, 0);
  return { name, trainClips: trainDirs.length, trainVectors: model.bank.length, testClips: testDirs.length, testFrames: n, anomalousFrames: nPos, auc: res };
}

const p1 = await bench("UCSDped1", 2);
console.log("Ped1 (design set):", JSON.stringify(p1));
const bestW = [1, 5, 9].reduce((b, w) => (p1.auc[`knn_w${w}`] > p1.auc[`knn_w${b}`] ? w : b), 1);
console.log(`smoothing window chosen on Ped1: ${bestW}`);
const p2 = await bench("UCSDped2", 1);
console.log("Ped2 (reported):", JSON.stringify(p2));
const out = { chosenSmoothingWindow: bestW, ped1_design: p1, ped2_reported: { ...p2, aucKnn: p2.auc[`knn_w${bestW}`], aucMotionBaseline: p2.auc[`motion_w${bestW}`] }, note: "Frame-level ROC AUC pooled over all test frames. Design choices on Ped1 only. No published-method comparison is claimed." };
fs.mkdirSync("data/results", { recursive: true });
fs.writeFileSync("data/results/ped.json", JSON.stringify(out, null, 1));
console.log(`\nPed2 frame-level AUC: kNN gate ${out.ped2_reported.aucKnn.toFixed(3)} vs motion-energy baseline ${out.ped2_reported.aucMotionBaseline.toFixed(3)} (window ${bestW}, n=${p2.testFrames} frames, ${p2.anomalousFrames} anomalous)`);
