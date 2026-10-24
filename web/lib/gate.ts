import type { ProposedAction, Signal } from "./types";

/** A greyscale frame, row major. */
export interface Frame { w: number; h: number; px: Uint8Array }

export const GRID_X = 8;
export const GRID_Y = 5;
const CHANGE_THRESHOLD = 24; // intensity change that counts as a changed pixel

/** Fraction of pixels whose intensity changed by more than CHANGE_THRESHOLD. */
export function changedFraction(a: Frame, b: Frame): number {
  let n = 0;
  for (let i = 0; i < a.px.length; i++) if (Math.abs(a.px[i] - b.px[i]) > CHANGE_THRESHOLD) n++;
  return n / a.px.length;
}

/**
 * Feature vector for one step: where change happened since the previous frame (grid),
 * and what the frame looks like (grid luminance). Dimensionality 2 * GRID_X * GRID_Y + 2.
 */
export function extractFeatures(prev: Frame | null, cur: Frame): Float64Array {
  const cells = GRID_X * GRID_Y;
  const out = new Float64Array(2 * cells + 2);
  const cw = cur.w / GRID_X, ch = cur.h / GRID_Y;
  const lumSum = new Float64Array(cells), diffSum = new Float64Array(cells), count = new Float64Array(cells);
  for (let y = 0; y < cur.h; y++) {
    const gy = Math.min(GRID_Y - 1, Math.floor(y / ch));
    for (let x = 0; x < cur.w; x++) {
      const c = gy * GRID_X + Math.min(GRID_X - 1, Math.floor(x / cw));
      const i = y * cur.w + x;
      lumSum[c] += cur.px[i];
      if (prev) diffSum[c] += Math.abs(cur.px[i] - prev.px[i]);
      count[c]++;
    }
  }
  for (let c = 0; c < cells; c++) {
    out[c] = diffSum[c] / count[c] / 255;
    out[cells + c] = lumSum[c] / count[c] / 255;
  }
  out[2 * cells] = prev ? changedFraction(prev, cur) : 0;
  out[2 * cells + 1] = prev ? out.slice(0, cells).reduce((a, b) => a + b, 0) / cells : 0;
  return out;
}

/** Features live in [0, 1]; a zero-variance feature must not turn tiny noise into a huge z-score. */
const STD_FLOOR = 0.01;

export interface GateModel {
  mean: Float64Array;
  std: Float64Array;
  bank: Float64Array[]; // standardized normal feature vectors
  owner: number[]; // which training sequence each vector came from, for leave-one-out scoring
  k: number;
  threshold: number;
}

function dist(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

function kthNearest(bank: Float64Array[], owner: number[], v: Float64Array, k: number, skipOwner = -1): number {
  const ds: number[] = [];
  for (let i = 0; i < bank.length; i++) if (owner[i] !== skipOwner) ds.push(dist(bank[i], v));
  ds.sort((x, y) => x - y);
  return ds[Math.min(k, ds.length) - 1] ?? 0;
}

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

/**
 * Fit the normal-progress model on feature vectors from NORMAL sequences only.
 * The alarm threshold is a percentile of leave-one-sequence-out scores on the training data,
 * so it never sees any faulty sequence.
 */
export function fitGate(sequences: Float64Array[][], opts: { k?: number; percentile?: number } = {}): GateModel {
  const k = opts.k ?? 3;
  const all = sequences.flat();
  const d = all[0].length;
  const mean = new Float64Array(d), std = new Float64Array(d);
  for (const v of all) for (let i = 0; i < d; i++) mean[i] += v[i] / all.length;
  for (const v of all) for (let i = 0; i < d; i++) std[i] += (v[i] - mean[i]) ** 2 / all.length;
  for (let i = 0; i < d; i++) std[i] = Math.max(Math.sqrt(std[i]), STD_FLOOR);
  const bank: Float64Array[] = [], owner: number[] = [];
  sequences.forEach((seq, s) => seq.forEach((v) => { bank.push(standardize(v, mean, std)); owner.push(s); }));
  const loo = bank.map((v, i) => kthNearest(bank, owner, v, k, owner[i]));
  return { mean, std, bank, owner, k, threshold: percentile(loo, opts.percentile ?? 99) };
}

function standardize(v: Float64Array, mean: Float64Array, std: Float64Array): Float64Array {
  const o = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = (v[i] - mean[i]) / std[i];
  return o;
}

/** Anomaly score: distance to the k-th nearest normal vector. */
export function scoreFeatures(model: GateModel, v: Float64Array): number {
  return kthNearest(model.bank, model.owner, standardize(v, model.mean, model.std), model.k);
}

// ---- stateful per-run tracker: visual novelty + no-progress detection + risky-action prefilter ----

export const STILL_FRACTION = 0.005; // below this changed-pixel fraction a step made no visible progress
export const NO_PROGRESS_RUN = 3; // consecutive still steps before raising stuck or loop

const RISKY = /confirm|purchase|\bbuy\b|\bpay\b|place order|delete|remove all|\bsend\b|submit|transfer|publish/i;
export const isRiskyAction = (a: ProposedAction) => RISKY.test(a.label);

export interface GateReading {
  signals: Signal[];
  score: number;
  changed: number;
  stillRun: number;
}

export class GateTracker {
  private prev: Frame | null = null;
  private stillRun = 0;
  private lastAction: string | null = null;
  private sameActionRun = 0;
  constructor(private model: GateModel) {}

  observe(frame: Frame, action: ProposedAction): GateReading {
    const feat = extractFeatures(this.prev, frame);
    const changed = this.prev ? changedFraction(this.prev, frame) : 1;
    const score = scoreFeatures(this.model, feat);
    this.stillRun = this.prev && changed < STILL_FRACTION ? this.stillRun + 1 : 0;
    const key = `${action.kind}:${action.label}`;
    this.sameActionRun = key === this.lastAction ? this.sameActionRun + 1 : 1;
    this.lastAction = key;
    this.prev = frame;

    const signals: Signal[] = [];
    if (score > this.model.threshold) signals.push("visual_anomaly");
    if (this.stillRun >= NO_PROGRESS_RUN) signals.push(action.kind === "wait" ? "stuck" : "loop");
    if (isRiskyAction(action)) signals.push("risky_action");
    return { signals, score, changed, stillRun: this.stillRun };
  }
}
