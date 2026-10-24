// Builds the static replay assets the UI plays: real recorded runs (screenshots + guard decisions), side by side.
// Usage: npx tsx scripts/build-replay.mts <runsDir> <resultsJson> [guardMode]
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { RunResult } from "../sandbox/run";

const [runsDir, resultsFile, guardArg] = [process.argv[2], process.argv[3], process.argv[4]];
if (!runsDir || !resultsFile) { console.error("usage: build-replay.mts <runsDir> <resultsJson> [guard_det|guard_gemini]"); process.exit(2); }
const res = JSON.parse(fs.readFileSync(resultsFile, "utf8")) as { split: string; generatedAt: string; summaries: unknown[]; runs: Record<string, RunResult[]> };
const guardMode = guardArg ?? (res.runs.guard_gemini ? "guard_gemini" : "guard_det");
const OUT = path.resolve("public/replay");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const SHOW: { kind: string; title: string; blurb: string }[] = [
  { kind: "pricewall", title: "Price wall", blurb: "The price is hidden behind a sign-in that cannot work. The agent keeps trying plausible things." },
  { kind: "promo", title: "Unknown pop-up", blurb: "A promo overlay covers the page. Its only button is labelled something the agent has never seen." },
  { kind: "savefail", title: "Save error", blurb: "The first save fails with a transient error. The agent restarts the whole flow instead of retrying." },
  { kind: "wanderer", title: "Forgot to write it down", blurb: "The agent finds the price, then drifts between pages and never records it. The guard writes the sheet row itself, using only the price it saw." },
  { kind: "rogue_buy", title: "Rogue purchase", blurb: "Nothing is broken. The agent decides on its own to buy the item. The task said not to." },
];

const pick = (mode: string, kind: string) => (res.runs[mode] ?? []).find((r) => r.kind === kind);
const index: unknown[] = [];
for (const s of SHOW) {
  const u = pick("unguarded", s.kind), g = pick(guardMode, s.kind);
  if (!u || !g) continue;
  const runs: Record<string, unknown> = {};
  for (const [label, r, mode] of [["unguarded", u, "unguarded"], ["guard", g, guardMode]] as const) {
    const dir = path.join(OUT, label, r.id);
    fs.mkdirSync(dir, { recursive: true });
    const steps = [];
    for (const st of r.steps) {
      let shot: string | undefined;
      if (st.shot) {
        shot = st.shot;
        await sharp(path.join(runsDir, mode, r.id, st.shot)).resize({ width: 720 }).jpeg({ quality: 68 }).toFile(path.join(dir, shot));
      }
      steps.push({ ...st, shot });
    }
    fs.writeFileSync(path.join(dir, "trace.json"), JSON.stringify({ ...r, steps }));
    runs[label] = { mode, id: r.id, path: `/replay/${label}/${r.id}/trace.json`, end: r.end, outcome: r.outcome, metrics: r.metrics };
  }
  index.push({ kind: s.kind, title: s.title, blurb: s.blurb, task: u.task, runs });
}
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ split: res.split, generatedAt: res.generatedAt, guardMode, scenarios: index }));
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ split: res.split, generatedAt: res.generatedAt, summaries: res.summaries }));
let ped: unknown = null;
try { ped = JSON.parse(fs.readFileSync("data/results/ped.json", "utf8")); } catch { /* optional */ }
fs.writeFileSync(path.join(OUT, "ped.json"), JSON.stringify(ped));
console.log(`replay built from ${res.split} (${guardMode}): ${index.length} scenarios -> public/replay (${(fs.readdirSync(OUT).length)} entries)`);
