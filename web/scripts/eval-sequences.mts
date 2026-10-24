// Anomaly detection on ANY dataset of image sequences. Usage:
//   npx tsx scripts/eval-sequences.mts <datasetDir> [--window 5] [--sub 1] [--out data/results/sequences.json]
//
// Layout (frames are png/jpg/jpeg, sorted by file name):
//   <datasetDir>/train/<sequence>/*.png     sequences of NORMAL behaviour the model learns from
//   <datasetDir>/test/<sequence>/*.png      sequences to score
//   <datasetDir>/labels.json                optional. { "<sequence>": [3, 4, 5, [10, 20]] }  0-based anomalous frames or [start, end] ranges
//                                           or { "<sequence>": "anomalous" | "normal" } for whole-sequence labels
// With no labels.json the script still scores everything and writes the per-frame scores, but reports no accuracy.
//
// Reported: frame-level ROC AUC against a plain motion-energy baseline, sequence-level AUC, and "before it is too late" numbers:
// for each anomalous segment, whether the model raised an alarm inside it and how many frames after it started (detection delay),
// plus the false-alarm rate on frames that are normal. The alarm threshold is the 99th percentile of leave-one-sequence-out
// scores on the TRAINING data only, never tuned on the test labels.
import fs from "node:fs";
import path from "node:path";
import { loadGray } from "../lib/frames";
import { changedFraction, extractFeatures, fitGate, scoreFeatures, type Frame } from "../lib/gate";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const dir = process.argv[2];
if (!dir || dir.startsWith("--")) { console.error("usage: eval-sequences.mts <datasetDir> [--window N] [--sub N] [--out file]"); process.exit(2); }
const WINDOW = Number(arg("--window", "5")), SUB = Number(arg("--sub", "1")), OUT = arg("--out", "data/results/sequences.json");
const W = 96, H = 64;
const IMG = /\.(png|jpe?g)$/i;

const seqDirs = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).filter((x) => fs.statSync(path.join(d, x)).isDirectory()).sort() : []);
async function frames(d: string): Promise<Frame[]> {
  const files = fs.readdirSync(d).filter((f) => IMG.test(f)).sort();
  return Promise.all(files.map(async (f) => ({ w: W, h: H, px: await loadGray(path.join(d, f), W, H) })));
}
const feats = (fr: Frame[]) => fr.map((x, i) => extractFeatures(i ? fr[i - 1] : null, x));
const smooth = (xs: number[], w: number) => xs.map((_, i) => { const a = Math.max(0, i - w + 1); let s = 0; for (let j = a; j <= i; j++) s += xs[j]; return s / (i - a + 1); });

function auc(scores: number[], labels: number[]): number | null {
  const pos = labels.filter(Boolean).length, neg = labels.length - pos;
  if (!pos || !neg) return null;
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]); const rank = new Array<number>(scores.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++; for (let k = i; k <= j; k++) rank[idx[k]] = (i + j) / 2 + 1; i = j + 1; }
  let sumPos = 0; labels.forEach((l, i) => { if (l) sumPos += rank[i]; });
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

type Labels = Record<string, (number | [number, number])[] | "anomalous" | "normal">;
const labelsFile = path.join(dir, "labels.json");
const labels: Labels | null = fs.existsSync(labelsFile) ? JSON.parse(fs.readFileSync(labelsFile, "utf8")) : null;
function frameLabels(seq: string, n: number): number[] | null {
  const l = labels?.[seq];
  if (l === undefined) return labels ? new Array(n).fill(0) : null; // sequences missing from labels.json are treated as normal
  if (l === "anomalous") return new Array(n).fill(1);
  if (l === "normal") return new Array(n).fill(0);
  const out = new Array(n).fill(0);
  for (const e of l) { const [a, b] = Array.isArray(e) ? e : [e, e]; for (let i = a; i <= Math.min(b, n - 1); i++) out[i] = 1; }
  return out;
}
const segments = (y: number[]) => { const s: [number, number][] = []; let a = -1; y.forEach((v, i) => { if (v && a < 0) a = i; if ((!v || i === y.length - 1) && a >= 0) { s.push([a, v ? i : i - 1]); a = -1; } }); return s; };

const trainSeqs = seqDirs(path.join(dir, "train")), testSeqs = seqDirs(path.join(dir, "test"));
if (!trainSeqs.length || !testSeqs.length) { console.error(`need ${dir}/train/<seq>/ and ${dir}/test/<seq>/ folders of frames`); process.exit(2); }
const train: Float64Array[][] = [];
for (const s of trainSeqs) train.push(feats(await frames(path.join(dir, "train", s))).filter((_, i) => i % SUB === 0));
const model = fitGate(train, { k: 1, percentile: 99 });
console.log(`trained on ${trainSeqs.length} normal sequences (${model.bank.length} frame vectors), alarm threshold ${model.threshold.toFixed(3)} (99th pct of leave-one-sequence-out training scores)`);

const per: { seq: string; scores: number[]; motion: number[]; y: number[] | null }[] = [];
for (const s of testSeqs) {
  const fr = await frames(path.join(dir, "test", s));
  per.push({ seq: s, scores: smooth(fr.map((x, i) => scoreFeatures(model, extractFeatures(i ? fr[i - 1] : null, x))), WINDOW), motion: smooth(fr.map((x, i) => (i ? changedFraction(fr[i - 1], x) : 0)), WINDOW), y: frameLabels(s, fr.length) });
}

const result: Record<string, unknown> = { dataset: path.resolve(dir), trainSequences: trainSeqs.length, testSequences: testSeqs.length, testFrames: per.reduce((a, p) => a + p.scores.length, 0), window: WINDOW, threshold: model.threshold };
if (labels) {
  const Y = per.flatMap((p) => p.y!), S = per.flatMap((p) => p.scores), M = per.flatMap((p) => p.motion);
  result.anomalousFrames = Y.filter(Boolean).length;
  result.frameAucModel = auc(S, Y); result.frameAucMotionBaseline = auc(M, Y);
  const seqLab = per.map((p) => +p.y!.some(Boolean));
  result.sequenceAucModel = auc(per.map((p) => Math.max(...p.scores)), seqLab); result.sequenceAucMotionBaseline = auc(per.map((p) => Math.max(...p.motion)), seqLab);
  const segs = per.flatMap((p) => segments(p.y!).map(([a, b]) => ({ seq: p.seq, a, b, hit: p.scores.findIndex((v, i) => i >= a && i <= b && v > model.threshold) })));
  const detected = segs.filter((g) => g.hit >= 0);
  const delays = detected.map((g) => g.hit - g.a).sort((x, y) => x - y);
  const normalFrames = per.flatMap((p) => p.scores.filter((_, i) => !p.y![i]));
  result.segments = segs.length; result.segmentsDetected = detected.length;
  result.medianDelayFrames = delays.length ? delays[Math.floor(delays.length / 2)] : null;
  result.falseAlarmRateOnNormalFrames = normalFrames.length ? normalFrames.filter((v) => v > model.threshold).length / normalFrames.length : null;
}
result.perSequence = per.map((p) => ({ seq: p.seq, frames: p.scores.length, maxScore: Math.max(...p.scores), alarmFrames: p.scores.filter((v) => v > model.threshold).length }));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
const f3 = (x: unknown) => (typeof x === "number" ? x.toFixed(3) : "n/a");
console.log(`test: ${result.testSequences} sequences, ${result.testFrames} frames${labels ? `, ${result.anomalousFrames} anomalous` : " (no labels.json: scores only)"}`);
if (labels) {
  console.log(`frame-level AUC   model ${f3(result.frameAucModel)}   motion baseline ${f3(result.frameAucMotionBaseline)}`);
  console.log(`sequence-level AUC model ${f3(result.sequenceAucModel)}   motion baseline ${f3(result.sequenceAucMotionBaseline)}`);
  console.log(`anomalous segments raised an alarm: ${result.segmentsDetected}/${result.segments}, median delay ${result.medianDelayFrames ?? "n/a"} frames after the segment began`);
  console.log(`false alarms on normal frames: ${typeof result.falseAlarmRateOnNormalFrames === "number" ? (100 * (result.falseAlarmRateOnNormalFrames as number)).toFixed(1) + "%" : "n/a"}`);
}
console.log(`wrote ${OUT}`);
