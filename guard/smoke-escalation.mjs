#!/usr/bin/env node
// Explicit test caller for the real hook + Telegram. This is NOT a Claude Code session.
// The only executable action is a force push to this repository's throwaway local bare remote.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadEnv, STATE_HOME, telegramConfig } from "./lib/config.mjs";
import { DecisionStore } from "./lib/decisions.mjs";

loadEnv();
const expected = process.argv[2] || "guidance";
if (!["guidance", "approve", "deny", "stop", "timeout"].includes(expected)) throw new Error("Usage: node guard/smoke-escalation.mjs guidance|approve|deny|stop|timeout");
if (!telegramConfig()) throw new Error("Pair the configured private owner first.");
const root = path.resolve(import.meta.dirname, "..");
const project = path.join(root, "demo-project/session");
const remote = path.join(root, "demo-project/local-remote.git");
const git = (args, cwd = project) => spawnSync("git", args, { cwd, encoding: "utf8" });
assert.equal(git(["remote", "get-url", "origin"]).stdout.trim(), remote, "Only the exact local demo remote may be used");
assert.equal(git(["--git-dir", remote, "rev-parse", "--is-bare-repository"]).stdout.trim(), "true");
const sid = crypto.randomUUID();
const env = { ...process.env, GRAVEYARD_REPLY_WAIT_S: expected === "timeout" ? "8" : "120", IMESSAGE_TO: "", GRAVEYARD_VOICE: "off" };
const hookPath = path.join(import.meta.dirname, "hook.mjs");
function invoke(event) {
  const p = spawnSync(process.execPath, [hookPath], { env, cwd: project, input: JSON.stringify({ session_id: sid, cwd: project, ...event }), encoding: "utf8", timeout: 155000 });
  if (p.error || p.status !== 0) throw new Error("Hook caller failed; no action executed.");
  return p.stdout ? JSON.parse(p.stdout) : null;
}
const instruction = { guidance: "Tap Reply with guidance; dictate or type Use a new branch instead, then press Send.", approve: "Tap Approve this action once. It permits ONLY a push to the throwaway local bare remote.", deny: "Tap Reject action.", stop: "Tap Stop task.", timeout: "Do not reply; this decision will expire after 8 seconds." }[expected];
console.log(`HOOK TEST HARNESS, not Claude Code. ${instruction}`);
invoke({ hook_event_name: "UserPromptSubmit", prompt: `Harmless local demo (${expected}). ${instruction} No external repository is involved.` });
const decision = invoke({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push --force origin demo-result" } });
let executed = false;
if (decision?.hookSpecificOutput?.permissionDecision === "allow" && decision.continue !== false) {
  // Recheck the local remote immediately before the only dispatch this caller supports.
  assert.equal(git(["remote", "get-url", "origin"]).stdout.trim(), remote);
  const result = git(["push", "--force", "origin", "demo-result"]);
  assert.equal(result.status, 0, "Local fake-remote push must succeed"); executed = true;
}
assert.equal(executed, expected === "approve");
const store = new DecisionStore(STATE_HOME());
const result = store.active();
assert.equal(result.sid, sid);
assert.equal(result.status, { guidance: "guidance", approve: "consumed", deny: "deny", stop: "cancelled", timeout: "expired" }[expected]);
if (expected === "approve") assert.equal(store.consume(result.id, result), false, "A consumed approval cannot dispatch a second time");
if (expected === "stop") {
  const again = invoke({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo still-stopped" } });
  assert.equal(again.continue, false);
}
console.log(JSON.stringify({ actualClaudeSession: false, caller: "explicit local test harness", expected, status: result.status,
  decision: result.id, session: sid, actionExecuted: executed, approvalConsumed: result.consumed, hookOutput: decision,
  localRemote: remote, savedDecision: store.file(result.id) }, null, 2));
