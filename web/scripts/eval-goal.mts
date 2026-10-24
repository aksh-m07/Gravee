// Goal-aware guard evaluation on the live sandbox. Usage:
//   npx tsx scripts/eval-goal.mts <val|test> [--modes unguarded,heuristic,guard_det,guard_gemini] [--shots dir]
// guard_gemini needs GEMINI_API_KEY (web/.env.local). Gemini answers are cached in data/cache/gemini.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { geminiAssessor } from "../lib/assess";
import { scenarios, type Split } from "../sandbox/scenarios";
import { runScenario, trainGate, type Mode, type RunResult } from "../sandbox/run";
import { summarize, table } from "../sandbox/metrics";

try { process.loadEnvFile(".env.local"); } catch { /* key may come from the shell */ }
process.env.GEMINI_CACHE_DIR ??= path.resolve("data/cache/gemini");

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const split = (process.argv[2] ?? "val") as Split;
const modes = arg("--modes", "unguarded,heuristic,guard_det").split(",") as Mode[];
const noLearned = process.env.GS_NO_LEARNED === "1";
const outFile = arg("--out", `data/results/goal-${split}.json`);
const shots = process.argv.includes("--shots") ? path.resolve(arg("--shots", "data/runs")) : undefined;
if (modes.includes("guard_gemini") && !(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY) && !fs.existsSync(process.env.GEMINI_CACHE_DIR!)) {
  console.error("guard_gemini needs GEMINI_API_KEY in web/.env.local"); process.exit(2);
}

const browser = await chromium.launch();
const model = await trainGate(browser);
console.log(`gate fit on ${scenarios("train").length} normal training runs, threshold ${model.threshold.toFixed(2)}`);
const scs = scenarios(split);
console.log(`${split}: ${scs.length} scenarios (${[...new Set(scs.map((s) => s.kind))].join(", ")})`);

const all: Record<string, RunResult[]> = {};
for (const mode of modes) {
  all[mode] = [];
  for (const sc of scs) {
    const r = await runScenario(browser, sc, mode, { model, assess: geminiAssessor, shotsDir: shots, noLearned });
    all[mode].push(r);
    process.stdout.write(r.outcome.success ? "." : r.outcome.harmful ? "H" : "x");
  }
  process.stdout.write(`  ${mode}\n`);
}
await browser.close();

const sums = modes.map((m) => summarize(m, all[m]));
console.log("\n" + table(sums));
console.log("\nPer scenario kind (success/n):");
const kinds = [...new Set(scs.map((s) => s.kind))];
console.log("kind".padEnd(16) + modes.map((m) => m.padEnd(16)).join(""));
for (const k of kinds) console.log(k.padEnd(16) + sums.map((s) => `${s.byKind[k].success}/${s.byKind[k].n}`.padEnd(16)).join(""));

fs.mkdirSync("data/results", { recursive: true });
const out = outFile;
fs.writeFileSync(out, JSON.stringify({ split, generatedAt: new Date().toISOString(), summaries: sums, runs: all }));
console.log(`\nwrote ${out}`);
