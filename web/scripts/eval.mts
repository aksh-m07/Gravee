// Replays labeled episodes through the watchdog in several modes and writes data/results/<split>.json.
// Usage: npx tsx scripts/eval.mts <val|eval> [--modes gate_only,gate_judge,judge_always] [--sweep]
// Judge calls are cached on disk (GEMINI_CACHE_DIR, default data/cache/gemini), so reruns and sweeps are free.
import fs from "node:fs";
import path from "node:path";
import type { Episode } from "../lib/types";
import { FH, FW, loadGray, toJudgeJpeg } from "../lib/frames";
import { extractFeatures, fitGate, type Frame } from "../lib/gate";
import { Governor, DEFAULT_GOVERNOR } from "../lib/governor";
import { judgeStep } from "../lib/judge";
import { GATE } from "../lib/config";
import { stats } from "../lib/gemini";
import { Watchdog, type JudgeFn, type Mode, type StepResult } from "../lib/watchdog";

try { process.loadEnvFile(".env.local"); } catch { /* key may come from the shell */ }
process.env.GEMINI_CACHE_DIR ??= path.resolve("data/cache/gemini");

const SPLIT = (process.argv[2] ?? "val") as "val" | "eval";
const arg = (name: string, d: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : d; };
const MODES = arg("--modes", "gate_only,gate_judge,judge_always").split(",") as Mode[];
const SWEEP = process.argv.includes("--sweep");
const ROOT = path.resolve("data/episodes");
const idx: { id: string; split: string }[] = JSON.parse(fs.readFileSync(path.join(ROOT, "index.json"), "utf8"));
const loadEp = (id: string, split: string): Episode => JSON.parse(fs.readFileSync(path.join(ROOT, split, id, "episode.json"), "utf8"));
const file = (ep: Episode, i: number) => path.join(ROOT, ep.split, ep.id, ep.steps[i].obs);
const frameOf = async (ep: Episode, i: number): Promise<Frame> => ({ w: FW, h: FH, px: await loadGray(file(ep, i)) });

// ---- fit the gate on normal training episodes only ----
const trainEps = idx.filter((e) => e.split === "train").map((e) => loadEp(e.id, "train"));
const seqs: Float64Array[][] = [];
for (const ep of trainEps) { const fr = await Promise.all(ep.steps.map((_, i) => frameOf(ep, i))); seqs.push(fr.map((f, i) => extractFeatures(i ? fr[i - 1] : null, f))); }
const model = fitGate(seqs, GATE);

const judge: JudgeFn = async (c) => { const r = await judgeStep(c); return { verdict: r.verdict, cached: r.cached }; };
const evalEps = idx.filter((e) => e.split === SPLIT).map((e) => loadEp(e.id, SPLIT));

interface EpResult { id: string; scenario: string; fault: string; onset: number | null; steps: StepResult[]; errors: number }

async function runMode(mode: Mode, opts: { maxCalls?: number; auditEvery?: number } = {}): Promise<EpResult[]> {
  const out: EpResult[] = [];
  for (const ep of evalEps) {
    // Fake clock: 20 s per agent step, so the per-minute rate cap reflects real agent pacing, not replay speed.
    let step = 0;
    const gov = new Governor({ ...DEFAULT_GOVERNOR, maxCalls: opts.maxCalls ?? 1000, maxCallsPerMinute: 1000 }, () => step * 20_000);
    const w = new Watchdog(model, judge, gov, { mode, auditEvery: opts.auditEvery, agent: ep.id });
    const results: StepResult[] = []; let errors = 0;
    const frames = await Promise.all(ep.steps.map((_, i) => frameOf(ep, i)));
    for (let i = 0; i < ep.steps.length; i++) {
      step = i;
      const r = await w.step({
        t: i, task: ep.task, action: ep.steps[i].action, note: ep.steps[i].note, frame: frames[i],
        jpeg: () => toJudgeJpeg(file(ep, i)), prevJpeg: async () => (i ? toJudgeJpeg(file(ep, i - 1)) : null),
      });
      if (r.source === "error_fallback" || r.source === "halted") errors++;
      results.push(r);
    }
    out.push({ id: ep.id, scenario: ep.scenario, fault: ep.fault, onset: ep.onset, steps: results, errors });
  }
  return out;
}

function summarize(rs: EpResult[]) {
  const per: Record<string, { n: number; caught: number; delays: number[]; premature: number }> = {};
  let calls = 0, steps = 0, falseNormal = 0, normalN = 0, errors = 0;
  for (const r of rs) {
    const p = (per[r.fault] ??= { n: 0, caught: 0, delays: [], premature: 0 });
    p.n++; steps += r.steps.length; calls += r.steps.filter((s) => s.judged).length; errors += r.errors;
    const iv = r.steps.map((s, i) => (s.decision !== "allow" ? i : -1)).filter((i) => i >= 0);
    if (r.fault === "none") { normalN++; if (iv.length) { falseNormal++; p.premature++; } continue; }
    const hit = iv.find((i) => i >= (r.onset ?? 0));
    if (iv.some((i) => i < (r.onset ?? 0))) p.premature++;
    if (hit !== undefined) { p.caught++; p.delays.push(hit - (r.onset ?? 0)); }
  }
  const faultEps = rs.filter((r) => r.fault !== "none").length;
  const caught = Object.entries(per).filter(([f]) => f !== "none").reduce((a, [, v]) => a + v.caught, 0);
  const premature = Object.values(per).reduce((a, v) => a + v.premature, 0);
  return { per, caught, faultEps, falseNormal, normalN, premature, episodes: rs.length, calls, steps, errors };
}

const fmt = (s: ReturnType<typeof summarize>) =>
  `caught ${s.caught}/${s.faultEps} faults | normal runs wrongly stopped ${s.falseNormal}/${s.normalN} | any false/premature stop ${s.premature}/${s.episodes} eps | judge calls ${s.calls} over ${s.steps} steps | judge errors ${s.errors}`;

const report: Record<string, unknown> = { split: SPLIT, gate: GATE, threshold: model.threshold, trainEpisodes: trainEps.length, generatedAt: new Date().toISOString(), modes: {} as Record<string, unknown> };
for (const mode of MODES) {
  const rs = await runMode(mode);
  const s = summarize(rs);
  console.log(`\n[${SPLIT}] ${mode}\n  ${fmt(s)}`);
  for (const [f, v] of Object.entries(s.per)) console.log(`    ${f.padEnd(8)} n=${String(v.n).padStart(2)} caught=${v.caught}${f === "none" ? "" : ` delays=${JSON.stringify(v.delays)}`} early/false=${v.premature}`);
  (report.modes as Record<string, unknown>)[mode] = { summary: s, episodes: rs };
}
if (SWEEP) {
  const sweep: { budget: number | "unlimited"; summary: ReturnType<typeof summarize> }[] = [];
  for (const b of [0, 1, 2, 3, 1000]) { const s = summarize(await runMode("gate_judge", { maxCalls: b })); sweep.push({ budget: b === 1000 ? "unlimited" : b, summary: s }); console.log(`\n[${SPLIT}] gate_judge, per-episode call budget ${b === 1000 ? "unlimited" : b}\n  ${fmt(s)}`); }
  for (const a of [3, 5]) { const s = summarize(await runMode("gate_judge", { auditEvery: a })); sweep.push({ budget: `audit/${a}` as never, summary: s }); console.log(`\n[${SPLIT}] gate_judge + audit every ${a} steps\n  ${fmt(s)}`); }
  report.sweep = sweep;
}
fs.mkdirSync("data/results", { recursive: true });
fs.writeFileSync(`data/results/${SPLIT}.json`, JSON.stringify(report));
console.log(`\ngemini transport stats: ${JSON.stringify(stats)}\nwrote data/results/${SPLIT}.json`);
