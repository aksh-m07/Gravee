import Link from "next/link";
import fs from "node:fs";
import path from "node:path";

export const metadata = { title: "Proof · Graveyard Shift" };

type S = {
  mode: string; runs: number; normalRuns: number; falseInterventions: number; faultRuns: number; faultSuccess: number; faultCompleted: number; faultHarmful: number;
  faultFalseClaims: number; faultSafeStops: number; recoverableRuns: number; recoveredAndCompleted: number; aloneCompleted: number; calledOnFinishable: number; impossibleRuns: number; calledOnImpossible: number; recoveriesTried: number; recoveriesVerified: number;
  wastedSteps: number; executedSteps: number; meanLatency: number | null; assessments: number; meanGeminiMs: number | null;
  byKind: Record<string, { n: number; success: number }>;
};
const read = <T,>(f: string): T | null => { try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), "public/replay", f), "utf8")) as T; } catch { return null; } };
const NAME: Record<string, string> = { unguarded: "No guard", heuristic: "Repeat-action heuristic", guard_det: "Goal-aware guard, rules only", guard_gemini: "Goal-aware guard + Gemini" };
const f = (a: number, b: number) => (b ? `${a}/${b}` : "n/a");

type SeqEval = { segments: number; segmentsDetected: number; medianDelayFrames: number | null; falseAlarmRateOnNormalFrames: number | null; threshold: number };
function readSeq(): SeqEval | null {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/results/sequences-ped2.json"), "utf8")) as SeqEval; } catch { return null; }
}

type MastEval = {
  chosen: string; naive: string;
  design: Record<string, { per_framework: Record<string, number>; mean: number }>;
  final_magentic: Record<string, { mean_auc: number; modes_scored: number }>;
};
function readMast() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/results/mast-eval.json"), "utf8")) as MastEval;
    return { n: 1642, chosen: m.design[m.chosen], naive: m.design[m.naive], finalChosen: m.final_magentic[m.chosen], finalNaive: m.final_magentic[m.naive] };
  } catch { return null; }
}

export default function Proof() {
  const res = read<{ split: string; generatedAt: string; summaries: S[] }>("results.json");
  const mast = readMast();
  const seq = readSeq();
  const ped = read<{ ped2_reported: { aucKnn: number; aucMotionBaseline: number; testFrames: number; anomalousFrames: number }; ped1_design: { auc: Record<string, number> } }>("ped.json");
  const rows: [string, (s: S) => string][] = [
    ["Normal runs wrongly interrupted", (s) => f(s.falseInterventions, s.normalRuns)],
    ["Fault runs ending in the right outcome", (s) => f(s.faultSuccess, s.faultRuns)],
    ["  task completed and verified", (s) => f(s.faultCompleted, s.faultRuns)],
    ["  purchase executed against the task", (s) => f(s.faultHarmful, s.faultRuns)],
    ["  agent falsely claimed success", (s) => f(s.faultFalseClaims, s.faultRuns)],
    ["  safe stop or handed to a human", (s) => f(s.faultSafeStops, s.faultRuns)],
    ["Recoverable runs fixed and completed", (s) => f(s.recoveredAndCompleted, s.recoverableRuns)],
    ["Finishable fault runs done without a call", (s) => f(s.aloneCompleted, s.recoverableRuns)],
    ["Calls to the boss on finishable runs", (s) => f(s.calledOnFinishable, s.recoverableRuns)],
    ["Calls to the boss on impossible runs", (s) => f(s.calledOnImpossible, s.impossibleRuns)],
    ["Recoveries verified / attempted", (s) => f(s.recoveriesVerified, s.recoveriesTried)],
    ["Executed steps that achieved nothing", (s) => f(s.wastedSteps, s.executedSteps)],
    ["Mean steps from fault to intervention", (s) => (s.meanLatency === null ? "n/a" : s.meanLatency.toFixed(1))],
    ["Gemini assessments (mean ms)", (s) => (s.assessments ? `${s.assessments} (${Math.round(s.meanGeminiMs ?? 0)})` : "0")],
  ];
  return (
    <main className="wrap">
      <div className="top"><div className="brand"><span className="rec" aria-hidden />GRAVEYARD SHIFT</div><nav className="nav"><Link href="/">Console</Link><Link href="/chat">Live chat</Link><Link href="/proof">Proof</Link></nav></div>
      <h1>What the guard actually did, with denominators.</h1>
      <p className="sub">Every number below comes from a run that executed in a real browser against the sandbox. Nothing here is a production benchmark.</p>

      <div className="card warn">
        <h2>Read this first</h2>
        <ul className="muted">
          <li>The agent is a <b>scripted</b> stand-in with deterministic failure habits, not a model. The guard code is the same code that runs live.</li>
          <li>The sandbox world is mine. The rule-based guard&apos;s pop-up lexicon was written without the label &ldquo;Got it&rdquo;, which is what the pop-up scenario uses. That gap is what the Gemini column measures there, not general intelligence.</li>
          <li>{res?.split === "test" ? "Gate settings and prompts were frozen on the validation split first. This table is the held-out test split." : "This table is the validation split, the same one used to choose the gate settings and read the failures. The held-out test split has not been run, so treat these as development numbers."}</li>
        </ul>
      </div>

      <div className="card">
        <h2>Same scenarios, four ways to run the agent</h2>
        {!res ? <p className="muted">No results file found.</p> : (
          <table>
            <thead><tr><th />{res.summaries.map((s) => <th key={s.mode}>{NAME[s.mode] ?? s.mode}</th>)}</tr></thead>
            <tbody>{rows.map(([label, fn]) => <tr key={label}><td>{label}</td>{res.summaries.map((s) => <td className="n" key={s.mode}>{fn(s)}</td>)}</tr>)}</tbody>
          </table>
        )}
        {res && <p className="muted" style={{ fontSize: 13 }}>Generated {res.generatedAt}. {res.summaries[0]?.runs} runs per column.</p>}
      </div>

      {mast && (
        <div className="card">
          <h2>Training on a large public failure dataset: what we found</h2>
          <p>We trained a failure-mode detector on <b>MAST-Data</b> (Cemri et al. 2025, CC-BY-4.0): {mast.n} traces from 7 multi-agent frameworks, labelled for 14 failure modes. The labels came from an LLM annotator that the dataset authors checked against humans, so they are not gold. The test that matters is whether it works on an agent framework it has never seen.</p>
          <table>
            <thead><tr><th>Mean AUC over scorable failure modes (0.5 = coin flip)</th><th>Naive model</th><th>Improved model</th></tr></thead>
            <tbody>
              <tr><td>Design: 3 frameworks, each held out in turn (choices made here)</td><td className="n">{mast.naive.mean.toFixed(2)}</td><td className="n">{mast.chosen.mean.toFixed(2)}</td></tr>
              <tr><td>Magentic, never used for any choice, scored once ({mast.finalChosen.modes_scored} modes)</td><td className="n">{mast.finalNaive.mean_auc.toFixed(2)}</td><td className="n">{mast.finalChosen.mean_auc.toFixed(2)}</td></tr>
            </tbody>
          </table>
          <p className="muted">The naive model memorises each framework&apos;s own vocabulary and is close to a coin flip on a new one. The improved model only uses words common to several frameworks, adds length and repetition signals, and is strongly regularised. Per framework in the design phase it scored {Object.entries(mast.chosen.per_framework).map(([f, v]) => `${f} ${v.toFixed(2)}`).join(", ")}, so it is uneven: on AG2 it is still no better than chance. The Magentic number is one framework, scored once.</p>
          <p className="muted">It was trained on multi-agent software traces, not browser agents, and we have not validated it on this shop. <b>It does not decide anything in the guard.</b> The guard&apos;s named mistake checks are plain rules, mapped to the closest MAST mode, and they are called rules. The only trained model that acts in the product is the screen-anomaly detector above.</p>
        </div>
      )}

      <div className="card">
        <h2>By scenario kind (right outcome / runs)</h2>
        {res && (
          <table>
            <thead><tr><th>Kind</th>{res.summaries.map((s) => <th key={s.mode}>{NAME[s.mode] ?? s.mode}</th>)}</tr></thead>
            <tbody>{Object.keys(res.summaries[0].byKind).map((k) => <tr key={k}><td>{k}</td>{res.summaries.map((s) => <td className="n" key={s.mode}>{s.byKind[k] ? f(s.byKind[k].success, s.byKind[k].n) : "n/a"}</td>)}</tr>)}</tbody>
          </table>
        )}
      </div>

      {ped && (
        <div className="card">
          <h2>The learned detector on a public benchmark</h2>
          <p>UCSD Ped2, frame-level ROC AUC over {ped.ped2_reported.testFrames} test frames ({ped.ped2_reported.anomalousFrames} anomalous): <b>{ped.ped2_reported.aucKnn.toFixed(3)}</b> for the kNN normal-progress model against <b>{ped.ped2_reported.aucMotionBaseline.toFixed(3)}</b> for a plain motion-energy baseline.</p>
          {seq && <p>With the alarm threshold fixed on the training clips only (never on test labels), the model raised an alarm in <b>{seq.segmentsDetected} of {seq.segments}</b> anomalous segments, a median <b>{seq.medianDelayFrames} frames after the anomaly began</b>, with {seq.falseAlarmRateOnNormalFrames === null ? "n/a" : (100 * seq.falseAlarmRateOnNormalFrames).toFixed(1)}% false alarms on the normal frames (there are few: nearly every Ped2 test clip contains an anomaly). That is late, not early.</p>}
          <p className="muted">That is a modest gain and well below published video-anomaly methods. On Ped1 (used for design choices) the two are about equal ({ped.ped1_design.auc.knn_w1.toFixed(3)} vs {ped.ped1_design.auc.motion_w1.toFixed(3)}). It is here to show the detector is a real trained model, not to claim state of the art.</p>
        </div>
      )}

      <div className="card">
        <h2>What breaks first</h2>
        <ul className="muted">
          <li><b>Familiar-looking blockers.</b> The learned detector flags pages unlike its normal runs. An obstruction that looks like a normal page is caught only by the stall and requirement rules, later.</li>
          <li><b>Slow but legitimate work.</b> The stall limit is 4 steps without requirement progress. A real agent that takes longer to do something legitimate would be interrupted.</li>
          <li><b>Requirements are hand-written</b> for one task type (find a price, record it). New task types need new verifiers.</li>
          <li><b>Gemini&apos;s confidence is its own estimate.</b> It has not been calibrated against outcomes, so the guard never treats it as a probability.</li>
        </ul>
      </div>
    </main>
  );
}
