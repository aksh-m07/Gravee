#!/usr/bin/env node
// Real Telegram/Gemini, synthetic evidence, explicit caller. Never executes a tool or starts Claude.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { loadEnv, STATE_HOME, telegramConfig, redact } from "./lib/config.mjs";
import { fingerprint, DecisionStore } from "./lib/decisions.mjs";
import { escalateTelegram } from "./lib/telegram.mjs";
loadEnv();
const config = telegramConfig();
if (!config) throw new Error("Pair the private owner first. No message sent.");
const sid = `conversation-smoke-${crypto.randomUUID()}`;
const action = { sid, tool: "Bash", input: { command: "npm ci --engine-strict" }, cwd: process.cwd() };
console.log("Real Telegram/Gemini conversation with synthetic hook evidence. No tool execution or Claude session.");
console.log("First reply: ask what failed and whether anything changed. After the answer, dictate multi-clause guidance with Voiskey, inspect it and press Send. Original deadline: 120 seconds; maximum two model requests.");
const { result, approved } = await escalateTelegram({ home: STATE_HOME(), config, ...action, actionHash: fingerprint(action),
  goal: "Synthetic-evidence conversation test: investigate a dependency install failure; no real coding task is running.",
  history: [1, 2, 3].map(() => ({ tool: "Bash", summary: "run npm ci --engine-strict (synthetic hook event)", ok: false,
    error: "Synthetic fixture error EBADENGINE: package requires Node >=26; recorded worker version was Node 24.15.0", verify: false })),
  tried: [{ kind: "Recorded rule intervention", detail: "Held another repeated installation attempt pending owner judgment." }],
  question: "The fixture records three failed dependency installs. Ask what failed, then send guidance. This is a synthetic-evidence test, not a Claude session.",
  verdict: "Repeated failed install attempts in synthetic hook evidence. No filesystem diff was collected.", expiresAt: Date.now() + 120000 });
console.log(JSON.stringify({ actualClaudeSession: false, syntheticEvidence: true, actionExecuted: false, decision: result.id,
  status: result.status, actualGeminiRequests: result.modelRequests, models: result.conversation.map((t) => t.model),
  conversation: result.conversation, acknowledgment: result.acknowledgment, returnedGuidance: redact(result.originalReply),
  storedDecision: new DecisionStore(STATE_HOME()).file(result.id) }, (_k, v) => typeof v === "string" ? redact(v) : v, 2));
assert.equal(approved, false);
if (result.status !== "guidance") { console.error(`Conversation ended ${result.status}; the held action stayed blocked. This is not a completed guidance verification.`); process.exit(1); }
assert.ok(result.conversation.some((t) => t.kind === "question"));
assert.ok(result.acknowledgment.includes(redact(result.originalReply)));
assert.ok(result.modelRequests <= 2);
