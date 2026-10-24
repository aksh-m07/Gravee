import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { geminiAssessorFor } from "../lib/assess";
import type { Briefing } from "../lib/escalation";
import { nextCallTurn, type CallTurn } from "../lib/call";
import sharp from "sharp";
import { imessageEnabled, textImage, textMessage } from "./imessage";
import os from "node:os";
import { fitGate, type GateModel } from "../lib/gate";
import { parseFreeTask } from "../lib/goal";
import { CATALOG } from "./catalog";
import { ClaudeAgent, CLAUDE_MODEL } from "./claude-agent";
import { GeminiAgent, type AgentLike } from "./gemini-agent";
import { BuyerAgent, ScriptedAgent } from "./agent";
import { runScenario, trainGate, type RunResult, type StepTrace } from "./run";
import type { Scenario } from "./scenarios";

export type LiveFault = "none" | "pricewall" | "promo" | "savefail" | "popup_ad" | "slow";
/** "surprise" picks one at random and hides it from the screen and from the guard until the run is over. */
export type LiveFaultChoice = LiveFault | "surprise";
export interface LiveRequest { task: string; fault: LiveFaultChoice; guard: "on" | "off"; agent: "claude" | "gemini" | "scripted" }

export type LiveEvent =
  | { type: "start"; product: string; record: boolean; buy: boolean; agent: string; model: string; guard: boolean; fault: LiveFaultChoice }
  | { type: "ask"; id: string; briefing: Briefing; step: number }
  | { type: "relay"; to: string; text: string; understood: string }
  | { type: "heard"; id: string; text: string }
  | { type: "call"; id: string; say: string; shot: string | null; note: string | null; source: string; final?: boolean }
  | { type: "step"; step: StepTrace; shot: string | null; say: string }
  | { type: "done"; result: Pick<RunResult, "end" | "outcome" | "metrics">; usage: { input: number; output: number } | null; fault: LiveFault; boss: { asked: number; understood: string[] } }
  | { type: "error"; message: string };

const FAULT: Record<LiveFault, { query: string; kind: Scenario["kind"] }> = {
  none: { query: "", kind: "normal" },
  pricewall: { query: "?fault=pricewall", kind: "pricewall" },
  promo: { query: "?modal=promo2", kind: "promo" },
  savefail: { query: "?fault=savefail", kind: "savefail" },
  popup_ad: { query: "?modal=ad", kind: "popup_ad" },
  slow: { query: "?slowprice=2", kind: "slowprice" },
};

const MODEL_FILE = path.resolve("data/cache/gate-model.json");
let gateModel: GateModel | null = null;

/** The learned detector is fit once on normal runs and cached on disk, so a live run does not retrain it. */
async function loadGate(browser: Browser): Promise<GateModel> {
  if (gateModel) return gateModel;
  try {
    const j = JSON.parse(fs.readFileSync(MODEL_FILE, "utf8")) as { mean: number[]; std: number[]; bank: number[][]; owner: number[]; k: number; threshold: number };
    gateModel = { ...j, mean: Float64Array.from(j.mean), std: Float64Array.from(j.std), bank: j.bank.map((v) => Float64Array.from(v)) };
    return gateModel;
  } catch { /* not trained yet */ }
  gateModel = await trainGate(browser);
  fs.mkdirSync(path.dirname(MODEL_FILE), { recursive: true });
  fs.writeFileSync(MODEL_FILE, JSON.stringify({ ...gateModel, mean: [...gateModel.mean], std: [...gateModel.std], bank: gateModel.bank.map((v) => [...v]) }));
  return gateModel;
}
void fitGate;

/**
 * Live runs use their own Gemini model setting. The free tier caps each model per day, and the recorded validation results
 * (cached) were produced with MODELS.judge, so live use must not eat that quota.
 */
export const LIVE_MODEL = process.env.LIVE_JUDGE_MODEL ?? "gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite"; // tried in order: the free tier caps or stalls single models

/** The screenshot with the guard's diagnosis written across the top, for the call (and the boss's phone). */
async function annotate(jpeg: Buffer, text: string): Promise<Buffer> {
  const img = sharp(jpeg); const { width = 960 } = await img.metadata();
  const esc = text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!).slice(0, 110);
  const svg = Buffer.from(`<svg width="${width}" height="56" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#b3261e"/><text x="16" y="36" font-family="Helvetica, Arial" font-size="22" font-weight="700" fill="#fff">${esc}</text></svg>`);
  return img.composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 80 }).toBuffer();
}

let busy = false;
export const liveBusy = () => busy;

/** Open calls, so the phone reply page can show the screenshot and the conversation so far. */
const calls = new Map<string, { turns: CallTurn[]; shot: string | null; open: boolean }>();
export const getCall = (id: string) => calls.get(id) ?? null;

/** Where the boss's phone can reach this laptop: PUBLIC_CALL_BASE if set, else this machine's Wi-Fi address. */
function callBase(): string {
  if (process.env.PUBLIC_CALL_BASE) return process.env.PUBLIC_CALL_BASE.replace(/\/$/, "");
  const nets = os.networkInterfaces();
  const v4 = (list: os.NetworkInterfaceInfo[] | undefined) => list?.find((a) => a.family === "IPv4" && !a.internal)?.address;
  const ip = v4(nets.en0) ?? v4(Object.values(nets).flat().filter((a): a is os.NetworkInterfaceInfo => !!a)) ?? "localhost"; // en0 is the Wi-Fi card on a Mac
  return `http://${ip}:${process.env.CALL_PORT ?? "3222"}`;
}

/** The one run that is waiting for the boss, if any. */
const waiting = new Map<string, (text: string | null) => void>();
const BOSS_PATIENCE_MS = 180_000;
export function answerBoss(id: string, text: string): boolean {
  const resolve = waiting.get(id);
  if (!resolve) return false;
  waiting.delete(id); resolve(text);
  return true;
}

/** Live runs: a real agent drives a real browser on the sandbox shop, with the guard in between when it is on. */
export async function runLive(req: LiveRequest, emit: (e: LiveEvent) => void): Promise<void> {
  if (busy) { emit({ type: "error", message: "Another run is in progress. Try again in a minute." }); return; }
  busy = true;
  let browser: Browser | null = null;
  try {
    const parsed = parseFreeTask(req.task, CATALOG.map((p) => p.name));
    if ("error" in parsed) { emit({ type: "error", message: `${parsed.error} This sandbox shop sells: ${CATALOG.map((p) => p.name).join(", ")}.` }); return; }
    const agent: AgentLike & { usage?: { input: number; output: number } } =
      req.agent === "claude" ? new ClaudeAgent(req.task) : req.agent === "gemini" ? new GeminiAgent(req.task, LIVE_MODEL) : parsed.buy ? new BuyerAgent(parsed.product) : new ScriptedAgent(parsed.product, "standard");
    browser = await chromium.launch();
    const model = await loadGate(browser);
    const actual: LiveFault = req.fault === "surprise" ? (["pricewall", "promo", "savefail", "popup_ad", "slow", "none"] as const)[crypto.randomInt(6)] : req.fault;
    const f = FAULT[actual];
    const sc: Scenario = { id: "live", split: "val", kind: f.kind, product: parsed.product, query: f.query, quirk: "standard", task: req.task, expect: "complete", record: parsed.record, buy: parsed.buy };
    emit({ type: "start", product: parsed.product, record: parsed.record, buy: parsed.buy, agent: req.agent, model: req.agent === "claude" ? CLAUDE_MODEL : req.agent === "gemini" ? LIVE_MODEL : "scripted", guard: req.guard === "on", fault: req.fault });
    const r = await runScenario(browser, sc, req.guard === "on" ? "guard_gemini" : "unguarded", {
      model, assess: geminiAssessorFor(LIVE_MODEL), agent, cap: 16, stepBudget: 14, realClock: true,
      boss: {
        // A call: show (and optionally text) the screen with the guard's diagnosis on it, then talk until the boss's intent is clear.
        ask: async ({ briefing, step, shot }) => {
          const id = crypto.randomUUID();
          const waitReply = () => new Promise<string | null>((resolve) => {
            const timer = setTimeout(() => { waiting.delete(id); resolve(null); }, BOSS_PATIENCE_MS);
            waiting.set(id, (t) => { clearTimeout(timer); resolve(t); });
          });
          const link = `${callBase()}/call/${id}`;
          const caption = `Graveyard Shift: ${briefing.spoken}\nReply here (Voiskey keyboard works): ${link}`;
          const banner = briefing.confusion === "irreversible" ? "GUARD: needs your OK, this action cannot be undone" : `GUARD: ${briefing.stuckOn}`;
          const image = shot ? await annotate(shot, banner) : null;
          const turns: CallTurn[] = [{ from: "guard", text: briefing.spoken }];
          const call = { turns, shot: image ? image.toString("base64") : null, open: true };
          calls.set(id, call);
          let texted: string | null = null;
          if (image && imessageEnabled()) { const r = await textImage(caption, image); texted = r.ok ? `sent to your phone by iMessage, with a reply link (${link})` : `iMessage failed: ${r.error}`; }
          emit({ type: "ask", id, briefing, step });
          emit({ type: "call", id, say: briefing.spoken, shot: call.shot, note: texted, source: "guard" });
          try {
            for (let turn = 0; turn < 4; turn++) {
              const said = await waitReply();
              if (said === null) return null; // silence keeps it stopped
              turns.push({ from: "boss", text: said });
              emit({ type: "heard", id, text: said });
              const d = await nextCallTurn(LIVE_MODEL, briefing, turns);
              turns.push({ from: "guard", text: d.say });
              if (imessageEnabled()) void textMessage(`Guard: ${d.say}`);
              if (d.action === "clarify" && turn < 3) { emit({ type: "call", id, say: d.say, shot: null, note: null, source: d.source }); continue; }
              emit({ type: "call", id, say: d.say, shot: null, note: null, source: d.source, final: true });
              return d.action === "stop" ? "stop" : d.action === "approve" ? "yes" : d.action === "clarify" ? null : (d.instruction ?? said);
            }
            return null;
          } finally { call.open = false; }
        },
        relay: ({ text, understood }) => emit({ type: "relay", to: req.agent === "claude" ? "Claude" : req.agent === "gemini" ? "Gemini" : "the agent", text, understood }),
      },
      onStep: (tr, jpeg) => emit({ type: "step", step: tr, shot: jpeg ? jpeg.toString("base64") : null, say: agent.lastSay ?? "" }),
    });
    const said = r.steps.filter((s) => s.boss).map((s) => s.boss!.understood);
    emit({ type: "done", result: { end: r.end, outcome: r.outcome, metrics: r.metrics }, usage: agent.usage ?? null, fault: actual, boss: { asked: said.length, understood: said } });
  } catch (e) {
    emit({ type: "error", message: String((e as Error).message ?? e).slice(0, 300) });
  } finally {
    await browser?.close();
    busy = false;
  }
}
