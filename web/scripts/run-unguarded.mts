// Runs every scenario kind once with NO guard and prints what the scripted agent does. Usage: npx tsx scripts/run-unguarded.mts [split]
import { chromium } from "playwright";
import { describeAction } from "../lib/goal";
import { Env } from "../sandbox/env";
import { ScriptedAgent } from "../sandbox/agent";
import { scenarios, type Split } from "../sandbox/scenarios";

const split = (process.argv[2] ?? "val") as Split;
const seen = new Set<string>();
const browser = await chromium.launch();
for (const sc of scenarios(split)) {
  if (seen.has(sc.kind)) continue; seen.add(sc.kind);
  const env = await Env.open(browser, sc.query);
  const agent = new ScriptedAgent(sc.product, sc.quirk);
  const log: string[] = [];
  for (let i = 0; i < 40; i++) {
    const obs = await env.observe();
    const a = agent.next(obs);
    const r = await env.execute(a);
    log.push(`${describeAction(a)}${r.ok ? "" : " [FAILED: " + r.error + "]"}`);
    if (a.kind === "finish") break;
  }
  const t = await env.truth();
  console.log(`\n${sc.id} (${sc.product}): ${log.length} steps, orders=${t.orders}, sheet=${JSON.stringify(t.sheet)}`);
  console.log("  " + log.slice(0, 14).join(" > ") + (log.length > 14 ? " > ..." : ""));
  await env.close();
}
await browser.close();
