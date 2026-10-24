#!/usr/bin/env node
// Graveyard Shift: a night guard for Claude Code. Runs as a hook on every step; see README.md.
// Policy errors fail closed. A bounded synchronous hook holds one exact action.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { failureStreak, hash, isVerify, keyOf, loopOf, riskOf, stopCheck, summaryOf } from "./lib/detect.mjs";
import { assess } from "./lib/gemini.mjs";
import { loadEnv, STATE_HOME, telegramConfig, replyWaitMs, redact } from "./lib/config.mjs";
import { readJson, writeJson, fingerprint, sessionStopFile } from "./lib/decisions.mjs";
import { escalateTelegram } from "./lib/telegram.mjs";

loadEnv();
const HOME = STATE_HOME();
const MAX_CONSULTS = 12; // actual supervisor generation attempts per persisted session
const stateFile = (sid) => path.join(HOME, "sessions", `${crypto.createHash("sha256").update(String(sid)).digest("hex")}.json`);
const stopFile = (sid) => sessionStopFile(HOME, sid);
const load = (sid) => readJson(stateFile(sid), { goal: "", history: [], consults: 0, stopBlocks: 0, stopped: false });
const save = (sid, s) => { s.history = s.history.slice(-60); writeJson(stateFile(sid), s); };
const log = (e) => { try { fs.mkdirSync(HOME, { recursive: true, mode: 0o700 }); fs.appendFileSync(path.join(HOME, "log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...e }, (_k, v) => typeof v === "string" ? redact(v) : v) + "\n", { mode: 0o600 }); } catch { /* diagnostic only */ } };
const out = (o) => process.stdout.write(JSON.stringify(o));
const pre = (decision, reason) => out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });
const hold = (reason) => out({ continue: false, stopReason: reason, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

/** No resume API: this hook remains alive while the exact tool call waits. */
async function askBoss(sid, question, { tool, input, history, tried, verdict, goal, cwd, reserve }) {
  const config = telegramConfig();
  if (!config) return { halt: true, reason: "Graveyard Shift: Telegram owner is not configured. The action did not run. Configure guard/.env.local and pair the owner, then issue a new prompt in Claude Code." };
  const actionHash = fingerprint({ sid, tool, input, cwd });
  const { result, approved } = await escalateTelegram({ home: HOME, config, sid, tool, input, cwd, goal, history, tried, question, verdict, actionHash, reserve, expiresAt: Date.now() + replyWaitMs() });
  log({ sid, event: "telegram_decision", decision: result.id, status: result.status, consumed: approved, actionHash, conversationRequests: result.modelRequests, userTurns: result.userTurns, models: result.conversation.map((t) => t.model).filter(Boolean) });
  if (approved) return { decision: "allow", reason: `Graveyard Shift: owner approved this exact action once (decision ${result.id}, ${actionHash}). Approval consumed before returning to Claude.` };
  if (result.status === "guidance") return { decision: "deny", reason: `Graveyard Shift: this action is blocked. The owner's original guidance follows verbatim; preserve every condition and do not treat it as approval: ${result.originalReply}` };
  if (result.status === "deny") return { decision: "deny", reason: `Graveyard Shift: the owner rejected this exact action. It must not execute. Original reply: ${result.originalReply}. No alternative consequential action has been approved.` };
  if (result.status === "cancelled") return { stop: true, halt: true, reason: "Graveyard Shift: the owner stopped this task. The held action did not execute. This stops the Claude turn, not the operating-system process. A new user prompt beginning Resume is required to continue." };
  return { halt: true, reason: `Graveyard Shift: decision ${result.id} is ${result.status}. The action did not run. Late Telegram replies cannot resume it. Inspect the decision locally, then issue a new Claude prompt to retry or choose another action.` };
}

function emitBoss(reply, sid, s) {
  if (reply.stop) { writeJson(stopFile(sid), { stopped: true }); s.stopped = true; save(sid, s); }
  if (reply.halt) hold(reply.reason); else pre(reply.decision, reply.reason);
}

async function main() {
  const raw = fs.readFileSync(0, "utf8");
  const ev = JSON.parse(raw || "{}");
  if (typeof ev.session_id !== "string" || !ev.session_id || ev.hook_event_name === "PreToolUse" && (typeof ev.tool_name !== "string" || !ev.tool_input || typeof ev.tool_input !== "object" || Array.isArray(ev.tool_input))) throw new Error("Invalid hook event identity");
  const sid = ev.session_id ?? "unknown";
  const s = load(sid);
  s.interventions ??= [];
  s.stopped = !!readJson(stopFile(sid)) || s.stopped;
  const name = ev.hook_event_name;

  if (name === "UserPromptSubmit") {
    if (s.stopped && !/^resume\b/i.test(String(ev.prompt ?? "").trim())) {
      out({ decision: "block", reason: "This session was stopped by its owner. Begin a new prompt with Resume to continue deliberately." }); return;
    }
    s.stopped = false;
    fs.rmSync(stopFile(sid), { force: true });
    s.goal = String(ev.prompt ?? "").slice(0, 600); s.stopBlocks = 0; s.interventions = [];
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
    if (s.stopped) { hold("Graveyard Shift: session stopped by owner; held action cannot execute. Begin a new user prompt with Resume to continue."); return; }
    const reserve = (model) => { if (s.consults >= MAX_CONSULTS) return false; s.consults++; save(sid, s); log({ sid, event: "gemini_attempt", model, attempt: s.consults }); return true; };
    const ask = (question, verdict) => askBoss(sid, question, { tool, input, history: s.history, tried: s.interventions, goal: s.goal, cwd: ev.cwd, verdict, reserve });

    // 1. Irreversible or outward-facing: always the human's call. No model can wave it through.
    const risk = riskOf(tool, input);
    if (risk) {
      const q = `Claude wants to ${proposed}. That ${risk.why}. Allow it?`;
      log({ sid, event: "ask_human", source: "rule", proposed, why: risk.why });
      emitBoss(await ask(q, `Guard: this ${risk.why}. Only the owner can approve this exact action.`), sid, s); return;
    }

    // 2. Cheap checks. Nothing flagged: stay silent and let the normal flow continue.
    const loop = loopOf(s.history, tool, input);
    const streak = failureStreak(s.history);
    const flags = [loop?.why, streak >= 5 ? `${streak} failed steps in a row` : null].filter(Boolean);
    if (!flags.length) return;

    // 3. Something is off: ask Gemini what is really going on, within a budget.
    if (s.consults < MAX_CONSULTS) {
      try {
        const g = await assess({ key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY, goal: s.goal, history: s.history, proposed, flags,
          reserve,
        });
        log({ sid, event: g.decision, source: "gemini", model: g.model, proposed, flags, diagnosis: g.diagnosis });
        s.interventions.push({ kind: `Gemini ${g.decision}`, detail: g.advice || g.diagnosis }); s.interventions = s.interventions.slice(-8); save(sid, s);
        if (g.decision === "allow") return;
        if (g.decision === "redirect") { pre("deny", `Graveyard Shift (Gemini): ${g.diagnosis} Do this instead: ${g.advice}`); return; }
        emitBoss(await ask(g.question || g.diagnosis, `Gemini: ${g.diagnosis}`), sid, s); return;
      } catch (e) {
        log({ sid, event: "gemini_unavailable", error: String(e?.message ?? e).slice(0, 120) });
      }
    }

    // 4. Without Gemini the rules decide, and say so.
    if (loop) { log({ sid, event: "redirect", source: "rule", proposed, why: loop.why }); s.interventions.push({ kind: "Rule redirect", detail: loop.why }); s.interventions = s.interventions.slice(-8); save(sid, s); pre("deny", `Graveyard Shift: ${loop.why}. Do not repeat it. Read the error, change the approach, or ask the user.`); return; }
    if (streak >= 8) { const q = `Claude has failed ${streak} steps in a row on: ${s.goal.slice(0, 120) || "its task"}. Should it keep going?`; log({ sid, event: "ask_human", source: "rule", proposed, why: q }); emitBoss(await ask(q), sid, s); }
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

main().catch((e) => {
  log({ event: "guard_error", error: redact(String(e?.message ?? e)).slice(0, 200) });
  hold("Graveyard Shift could not validate this event. Execution is blocked; inspect the local guard state before retrying.");
});
