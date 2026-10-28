import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DecisionStore } from "../lib/decisions.mjs";
const root = path.resolve(import.meta.dirname, "..");
function invoke(home, scenario, event) {
  const output = execFileSync(process.execPath, ["--import", path.join(import.meta.dirname, "mock-network.mjs"), path.join(root, "hook.mjs")], {
    input: JSON.stringify({ session_id: "test-session", cwd: "/fake-demo", ...event }), encoding: "utf8",
    env: { ...process.env, GRAVEYARD_HOME: home, GRAVEYARD_ENV: "/nonexistent", GRAVEYARD_TEST_NETWORK: "yes", GRAVEYARD_TEST_CASE: scenario,
      TELEGRAM_BOT_TOKEN: "TEST", TELEGRAM_OWNER_ID: "123", TELEGRAM_CHAT_ID: "123", GEMINI_API_KEY: "TEST", GOOGLE_API_KEY: "", IMESSAGE_TO: "", GRAVEYARD_REPLY_WAIT_S: ["guidance", "conversation"].includes(scenario) ? "2" : ".12" }, timeout: 3000,
  });
  return output ? JSON.parse(output) : null;
}
for (const scenario of ["approve", "guidance", "deny", "stop", "timeout", "delivery_failed", "approve_at_deadline", "conversation"]) test(`real hook subprocess + mocked Telegram: ${scenario}`, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gs-hook-"));
  invoke(home, scenario, { hook_event_name: "UserPromptSubmit", prompt: "safe fake remote demo" });
  const result = invoke(home, scenario, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push --force origin demo-result" } });
  assert.equal(result.hookSpecificOutput.permissionDecision, scenario === "approve" ? "allow" : "deny");
  if (["stop", "timeout", "delivery_failed", "approve_at_deadline"].includes(scenario)) assert.equal(result.continue, false);
  const store = new DecisionStore(home), saved = store.active();
  assert.equal(saved.consumed, ["approve", "approve_at_deadline"].includes(scenario));
  if (scenario === "approve_at_deadline") assert.equal(saved.status, "expired");
  assert.equal(store.consume(saved.id, saved), false);
  if (scenario === "guidance") assert.match(result.hookSpecificOutput.permissionDecisionReason, /Yes if the tests pass\./);
  if (scenario === "conversation") {
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /Stop reinstalling it\. Check the required Node version first\. Keep dependency files unchanged\./);
    assert.equal(saved.modelRequests, 2); assert.equal(saved.userTurns, 2);
    assert.deepEqual(saved.conversation.map((t) => t.kind), ["question", "guidance"]);
  }
  if (scenario === "stop") {
    const blocked = invoke(home, "approve", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo must-not-run" } });
    assert.equal(blocked.continue, false);
    const prompt = invoke(home, "approve", { hook_event_name: "UserPromptSubmit", prompt: "continue without explicit resume" });
    assert.equal(prompt.decision, "block");
    invoke(home, "approve", { hook_event_name: "UserPromptSubmit", prompt: "Resume with a new safe action" });
    assert.equal(invoke(home, "approve", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo okay" } }), null);
  }
});
