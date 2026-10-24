#!/usr/bin/env node
// This is a live Gemini request THROUGH the terminal hook, with synthetic hook events.
// It is not an authenticated Claude Code session and never sends notifications.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadEnv, STATE_HOME } from "./lib/config.mjs";
loadEnv();
if (!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) { console.error("Missing local Gemini credential."); process.exit(2); }
const home = path.join(STATE_HOME(), `gemini-smoke-${Date.now()}`);
const sid = "terminal-hook-gemini-smoke";
const env = { ...process.env, GRAVEYARD_HOME: home, GRAVEYARD_ENV: "/nonexistent", TELEGRAM_BOT_TOKEN: "", TELEGRAM_OWNER_ID: "", TELEGRAM_CHAT_ID: "", IMESSAGE_TO: "", GRAVEYARD_VOICE: "off", GRAVEYARD_GEMINI_MODEL: "gemini-3.6-flash", GRAVEYARD_GEMINI_MAX_ATTEMPTS: "1", GRAVEYARD_GEMINI_TIMEOUT_MS: "12000" };
function hook(event) {
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "hook.mjs")], { env, input: JSON.stringify({ session_id: sid, cwd: process.cwd(), ...event }), encoding: "utf8", timeout: 17000 });
  if (r.status !== 0 || r.error) throw new Error("Hook smoke subprocess failed");
  return r.stdout ? JSON.parse(r.stdout) : null;
}
hook({ hook_event_name: "UserPromptSubmit", prompt: "Fix discounted(cents, percent) so 20% off 1000 is 800. npm test has failed with actual -19000 twice; inspect price.js and correct the percent calculation before testing again." });
for (let i = 0; i < 2; i++) hook({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" }, error: "discount test failed: expected 800, actual -19000; price.js uses cents - cents * percent" });
const decision = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } });
const events = fs.readFileSync(path.join(home, "log.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
const attempts = events.filter((e) => e.event === "gemini_attempt");
const diagnosis = events.find((e) => e.source === "gemini");
console.log(JSON.stringify({ syntheticHookEvents: true, authenticatedClaudeSession: false, actualSupervisorRequests: attempts.length, model: diagnosis?.model ?? null, diagnosis: diagnosis?.diagnosis ?? null, hookDecision: decision, stateDirectory: home }, null, 2));
if (attempts.length !== 1 || !diagnosis || diagnosis.event !== "redirect" || decision?.hookSpecificOutput?.permissionDecision !== "deny") process.exitCode = 1;
