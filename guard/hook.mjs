#!/usr/bin/env node
// Graveyard Shift: a night guard for Claude Code. Runs as a hook on every step; see README.md.
// It must never break the user's session: any internal error means "no opinion" (exit 0, nothing printed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { failureStreak, hash, isVerify, keyOf, loopOf, riskOf, stopCheck, summaryOf } from "./lib/detect.mjs";
import { assess } from "./lib/gemini.mjs";
import { speak, textPhone } from "./lib/notify.mjs";
import { renderCard } from "./lib/card.mjs";
import { readReply, replyPage } from "./lib/phone.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.GRAVEYARD_HOME ?? path.join(os.homedir(), ".graveyard-shift");
const MAX_CONSULTS = 12;

// Keys come from the environment, or from the project's web/.env.local (never printed, never logged).
function loadEnv() {
  const file = process.env.GRAVEYARD_ENV ?? path.join(HERE, "..", "web", ".env.local");
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^(GEMINI_API_KEY|IMESSAGE_TO)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim(); // an explicit empty value switches it off
    }
  } catch { /* optional */ }
}

const stateFile = (sid) => path.join(HOME, "sessions", `${String(sid).replace(/[^\w-]/g, "")}.json`);
const load = (sid) => { try { return JSON.parse(fs.readFileSync(stateFile(sid), "utf8")); } catch { return { goal: "", history: [], consults: 0, stopBlocks: 0 }; } };
const save = (sid, s) => { fs.mkdirSync(path.dirname(stateFile(sid)), { recursive: true }); s.history = s.history.slice(-60); fs.writeFileSync(stateFile(sid), JSON.stringify(s)); };
const log = (e) => { try { fs.mkdirSync(HOME, { recursive: true }); fs.appendFileSync(path.join(HOME, "log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n"); } catch { /* best effort */ } };

const out = (o) => process.stdout.write(JSON.stringify(o));
const pre = (decision, reason) => out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });

const PHONE_WAIT_MS = Number(process.env.GRAVEYARD_REPLY_WAIT_S ?? 180) * 1000;

/**
 * Brings the boss in: says it aloud, texts the phone a picture of the exact code or command and what is wrong, with a reply link,
 * and waits for the answer (typed or spoken with the Voiskey keyboard). Returns the PreToolUse decision to give Claude.
 * No answer in time: fall back to Claude Code's own prompt in the terminal.
 */
async function askBoss(sid, question, { tool, input, history, verdict }) {
  speak(`Graveyard Shift. ${question}`);
  const code = tool === "Bash" ? `$ ${input?.command ?? ""}` : tool ? `${tool} ${input?.file_path ?? ""}\n${String(input?.new_string ?? input?.content ?? "").slice(0, 900)}` : "";
  const lastErr = [...(history ?? [])].reverse().find((h) => h.ok === false)?.error ?? "";
  let card = null;
  try { card = await renderCard({ title: "GRAVEYARD SHIFT: CLAUDE NEEDS YOU", code, error: lastErr, verdict: verdict ?? question }); } catch { card = null; }
  const phone = process.env.IMESSAGE_TO && process.env.GRAVEYARD_PHONE_REPLY !== "off" ? await replyPage({ question, cardFile: card, waitMs: PHONE_WAIT_MS }) : null;
  const texted = await textPhone(`Graveyard Shift: Claude needs you. ${question}${phone ? ` Answer here (talk with the Voiskey keyboard): ${phone.url}` : " Answer in Claude Code."}`, card);
  log({ sid, event: "texted", texted, replyLink: !!phone, ...(texted === "skipped" ? { testLink: phone?.url } : {}) });
  const said = phone && !texted.startsWith("failed") && texted !== "off" ? await phone.answer : null;
  if (phone && said === null) phone.close?.();
  if (said === null) return ["ask", `Graveyard Shift: ${question}`];
  const r = readReply(said);
  log({ sid, event: "boss_replied", via: "phone", understood: r.kind, said });
  if (r.kind === "approve") return ["allow", `Approved by the user from their phone ("${said}").`];
  if (r.kind === "stop") return ["deny", `The user said stop ("${said}"). Do not continue this task; tell them where things stand.`];
  if (r.kind === "deny") return ["deny", `The user said no to this action ("${said}"). Do not do it. Continue another way, or ask them.`];
  return ["deny", `The user replied from their phone: "${r.text}". Follow that instead of this action.`];
}

async function main() {
  const raw = fs.readFileSync(0, "utf8");
  const ev = JSON.parse(raw || "{}");
  loadEnv();
  const sid = ev.session_id ?? "unknown";
  const s = load(sid);
  const name = ev.hook_event_name;

  if (name === "UserPromptSubmit") {
    s.goal = String(ev.prompt ?? "").slice(0, 600); s.stopBlocks = 0;
    save(sid, s); return;
  }

  if (name === "PostToolUse" || name === "PostToolUseFailure") {
    const tool = ev.tool_name, input = ev.tool_input ?? {};
    const r = ev.tool_response ?? {};
    const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const verify = isVerify(tool, input);
    let ok = name === "PostToolUse";
    let error = name === "PostToolUseFailure" ? String(ev.error ?? "").split("\n").slice(0, 2).join(" ").slice(0, 200) : "";
    // A test or build can "succeed" as a tool call and still report failures in its output.
    if (ok && verify && /(\b\d+ (failed|failing)\b|\bFAIL\b|error TS\d+|\bTests?:.*failed|BUILD FAILED|npm ERR!)/.test(text)) { ok = false; error = (text.match(/.*(failed|FAIL|error TS\d+|ERR!).*/)?.[0] ?? "").trim().slice(0, 200); }
    s.history.push({ tool, key: keyOf(tool, input), summary: summaryOf(tool, input), ok, error, verify, file: input.file_path, oldHash: hash(input.old_string), newHash: hash(input.new_string) });
    save(sid, s); return;
  }

  if (name === "PreToolUse") {
    const tool = ev.tool_name, input = ev.tool_input ?? {};
    const proposed = summaryOf(tool, input);

    // 1. Irreversible or outward-facing: always the human's call. No model can wave it through.
    const risk = riskOf(tool, input);
    if (risk) {
      const q = `Claude wants to ${proposed}. That ${risk.why}. Allow it?`;
      log({ sid, event: "ask_human", source: "rule", proposed, why: risk.why });
      const [d, why] = await askBoss(sid, q, { tool, input, history: s.history, verdict: `Guard: this ${risk.why}. Only you can approve it.` });
      pre(d, why); return;
    }

    // 2. Cheap checks. Nothing flagged: stay silent and let the normal flow continue.
    const loop = loopOf(s.history, tool, input);
    const streak = failureStreak(s.history);
    const flags = [loop?.why, streak >= 5 ? `${streak} failed steps in a row` : null].filter(Boolean);
    if (!flags.length) return;

    // 3. Something is off: ask Gemini what is really going on, within a budget.
    if (s.consults < MAX_CONSULTS) {
      s.consults++; save(sid, s);
      try {
        const g = await assess({ key: process.env.GEMINI_API_KEY, goal: s.goal, history: s.history, proposed, flags });
        log({ sid, event: g.decision, source: "gemini", model: g.model, proposed, flags, diagnosis: g.diagnosis });
        if (g.decision === "allow") return;
        if (g.decision === "redirect") { pre("deny", `Graveyard Shift (Gemini): ${g.diagnosis} Do this instead: ${g.advice}`); return; }
        const [d, why] = await askBoss(sid, g.question || g.diagnosis, { tool, input, history: s.history, verdict: `Gemini: ${g.diagnosis}` });
        pre(d, d === "ask" ? `Graveyard Shift (Gemini) needs you: ${g.question || g.diagnosis}` : why); return;
      } catch (e) {
        log({ sid, event: "gemini_unavailable", error: String(e?.message ?? e).slice(0, 120) });
      }
    }

    // 4. Without Gemini the rules decide, and say so.
    if (loop) { log({ sid, event: "redirect", source: "rule", proposed, why: loop.why }); pre("deny", `Graveyard Shift: ${loop.why}. Do not repeat it. Read the error, change the approach, or ask the user.`); return; }
    if (streak >= 8) { const q = `Claude has failed ${streak} steps in a row on: ${s.goal.slice(0, 120) || "its task"}. Should it keep going?`; log({ sid, event: "ask_human", source: "rule", proposed, why: q }); const [d, why] = await askBoss(sid, q, { tool, input, history: s.history }); pre(d, why); }
    return;
  }

  if (name === "Stop" || name === "SubagentStop") {
    if (ev.stop_hook_active || s.stopBlocks >= 2) return; // never trap Claude in a loop of its own
    const c = stopCheck(s.history, ev.last_assistant_message ?? "");
    if (!c) return;
    s.stopBlocks++; save(sid, s);
    log({ sid, event: "block_stop", source: "rule", why: c.why });
    out({ decision: "block", reason: `Graveyard Shift: not done yet: ${c.why}` });
  }
}

main().catch((e) => { log({ event: "guard_error", error: String(e?.message ?? e).slice(0, 200) }); process.exit(0); });
