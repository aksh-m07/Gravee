// Gate-only analysis on seeded agent episodes. No Gemini calls. Usage: npx tsx scripts/eval-gate.mts
import fs from "node:fs";
import path from "node:path";
import type { Episode } from "../lib/types";
import { loadGray, FW, FH } from "../lib/frames";
import { extractFeatures, fitGate, GateTracker, type Frame } from "../lib/gate";

const ROOT = path.resolve("data/episodes");
const SPLIT = (process.argv[2] ?? "val") as "val" | "eval";
const GRID = process.argv[3] === "grid";
const idx: { id: string; split: "train" | "val" | "eval" }[] = JSON.parse(fs.readFileSync(path.join(ROOT, "index.json"), "utf8"));
const load = (id: string, split: string): Episode => JSON.parse(fs.readFileSync(path.join(ROOT, split, id, "episode.json"), "utf8"));
async function frames(ep: Episode): Promise<Frame[]> {
  return Promise.all(ep.steps.map(async (s) => ({ w: FW, h: FH, px: await loadGray(path.join(ROOT, ep.split, ep.id, s.obs)) })));
}

const train = await Promise.all(idx.filter((e) => e.split === "train").map(async (e) => frames(load(e.id, "train"))));
const seqs = train.map((fs_) => fs_.map((f, i) => extractFeatures(i ? fs_[i - 1] : null, f)));
const evalEps = await Promise.all(idx.filter((x) => x.split === SPLIT).map(async (e) => { const ep = load(e.id, SPLIT); return { ep, fr: await frames(ep) }; }));

interface Row { n: number; detected: number; delays: number[]; fp: number; sig: Record<string, number>; who: string[] }

function run(k: number, pct: number, verbose: boolean) {
  const model = fitGate(seqs, { k, percentile: pct });
  if (verbose) console.log(`gate fit on ${train.length} normal episodes, ${model.bank.length} vectors, k=${k}, percentile=${pct}, threshold ${model.threshold.toFixed(2)}`);
  const rows: Record<string, Row> = {};
  for (const { ep, fr } of evalEps) {
    const tr = new GateTracker(model);
    const r = (rows[ep.fault] ??= { n: 0, detected: 0, delays: [], fp: 0, sig: {}, who: [] });
    r.n++;
    let first: number | null = null; let early = false;
    ep.steps.forEach((s, i) => {
      const g = tr.observe(fr[i], s.action);
      const flag = g.signals.filter((x) => x !== "risky_action");
      for (const sg of g.signals) r.sig[sg] = (r.sig[sg] ?? 0) + 1;
      if (flag.length) { if (ep.onset !== null && i >= ep.onset) { first ??= i; } else early = true; }
    });
    if (early) { r.fp++; r.who.push(ep.scenario); }
    if (first !== null) { r.detected++; r.delays.push(first - (ep.onset ?? 0)); }
  }
  return rows;
}
if (GRID) {
  for (const k of [1, 3, 5]) for (const pct of [90, 95, 97, 99]) {
    const rows = run(k, pct, false);
    const f = (n: string) => (rows[n] ? `${rows[n].detected}/${rows[n].n}` : "-");
    console.log(`k=${k} pct=${pct}  false-alarm eps (normal)=${rows.none.fp}/${rows.none.n}  blocked=${f("blocked")} drift=${f("drift")} stuck=${f("stuck")} loop=${f("loop")}`);
  }
  process.exit(0);
}
const rows = run(Number(process.argv[4] ?? 3), Number(process.argv[5] ?? 99), true);
console.log("flagged normal scenarios:", JSON.stringify(rows.none?.who ?? []));

for (const [f, r] of Object.entries(rows))
  console.log(`${f.padEnd(8)} n=${String(r.n).padStart(2)} detected=${r.detected} early/false=${r.fp} delays=${JSON.stringify(r.delays)} signals=${JSON.stringify(r.sig)}`);
