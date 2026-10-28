// Real Telegram, synthetic pending decision, actual imported fixture findings, explicit TEST guidance.
// This caller NEVER executes the held action, starts Claude, or invokes Gemini/GrokBot.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { loadEnv, STATE_HOME, telegramConfig } from "./lib/config.mjs";
import { DecisionStore, acquireConsumer, fingerprint } from "./lib/decisions.mjs";
import { Telegram, waitForDecision } from "./lib/telegram.mjs";
import { attachGrokGuidance } from "./lib/grok-guidance.mjs";
loadEnv();
const config = telegramConfig(); if (!config) throw new Error("Pair private owner first");
const home = STATE_HOME(), release = acquireConsumer(home), store = new DecisionStore(home);
const guidance = "Do not push the held action. Inspect the percentage calculation and rounding first. Keep the acceptance tests unchanged. Only report completion after those tests pass.";
try {
  const sid = `synthetic-grok-guidance-${crypto.randomUUID()}`;
  const actionHash = fingerprint({ sid, tool: "Bash", input: { command: "git push --force origin demo-result" }, cwd: process.cwd() });
  const d = store.create({ sid, actionHash, owner: config.owner, chat: config.chat, expiresAt: Date.now() + 120000,
    briefing: "SYNTHETIC decision; no coding agent or held action is running. Actual GrokBot fixture findings; TEST recommendation, not Grok-authored.", approvalEligible: false });
  const api = new Telegram(config.token);
  await attachGrokGuidance({ store, verificationId: "5a1a1bc4f71774af6267428db6fa93dd", decisionId: d.id, guidance, source: "test_text", config, api });
  console.log(`Telegram ready. Tap Use Grok’s guidance once. Decision ${d.id}; fixed two-minute deadline.`);
  const result = await waitForDecision({ api, store, decision: d, interpret: async () => { throw new Error("No model calls allowed in this test"); } });
  console.log(JSON.stringify({ decision: d.id, status: result.status, originalGuidance: result.originalReply, approvalConsumed: result.consumed, actionExecuted: false, actualClaude: false, actualVoiskeyVerified: false, source: result.grokGuidance?.source.kind }, null, 2));
  assert.equal(result.status, "guidance"); assert.equal(result.originalReply, guidance); assert.equal(result.consumed, false);
} finally { release(); }
