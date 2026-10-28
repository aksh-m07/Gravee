import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DecisionStore } from "../lib/decisions.mjs";
import { waitForDecision } from "../lib/telegram.mjs";
import { evidenceFor, validateInterpretation, answerFromFacts, acknowledgeGuidance, interpretReply } from "../lib/conversation.mjs";
const guidance = { kind: "guidance", confidence: "high", fact_ids: [], clarification: "none" };
const question = { kind: "question", confidence: "high", fact_ids: ["result1", "edits"], clarification: "none" };
const clarification = { kind: "clarify", confidence: "uncertain", fact_ids: [], clarification: "conflict" };
const rawGuidance = "Stop reinstalling it. Check the required Node version first. Keep dependency files unchanged. Yes only if the check supports it.";
const evidence = evidenceFor({ goal: "Install the project dependency", tool: "Bash", input: { command: "npm ci" }, history: [
  { tool: "Bash", summary: "run npm ci", ok: false, error: "EBADENGINE: requires Node >=24; current Node 20.9", verify: false },
  { tool: "Bash", summary: "run npm ci", ok: false, error: "EBADENGINE repeated", verify: false },
], tried: [{ kind: "Gemini redirect", detail: "Inspect the engine requirement before another attempt" }] });
function setup(expiresAt = Date.now() + 5000) {
  const store = new DecisionStore(fs.mkdtempSync(path.join(os.tmpdir(), "gs-conversation-")));
  const d = store.create({ sid: "session-A", actionHash: "a".repeat(64), owner: "123", chat: "123", expiresAt, briefing: "Dependency installation is held.", evidence, approvalEligible: true });
  d.messageId = 10; d.replyMessageIds = [10]; store.save(d); return { store, d };
}
const message = (id, text) => ({ update_id: id, message: { from: { id: 123 }, chat: { id: 123, type: "private" }, reply_to_message: { message_id: 10 }, text } });
const cb = (id, d, action) => ({ update_id: id, callback_query: { id: `cb${id}`, from: { id: 123 }, message: { message_id: 10, chat: { id: 123, type: "private" } }, data: `gs:${action}:${d.id}` } });
function provider(result = ({ original }) => original.includes("?") ? question : guidance) {
  let calls = 0;
  const interpret = async (ctx) => { assert.equal(ctx.reserve("mock-gemini"), true); calls++; return { ...(typeof result === "function" ? await result(ctx) : result), model: "mock-gemini" }; };
  return { interpret, calls: () => calls };
}
function apiFor(batches, onSend = () => {}, immediate = () => []) {
  const sent = []; let polls = 0, id = 100;
  return { sent,
    updates: async (_offset, _deadline, wait = true) => wait ? batches[polls++] || [] : immediate(),
    call: async (method, body) => { if (method === "sendMessage") { sent.push(body.text); onSend(body.text); return { message_id: id++ }; } return true; },
  };
}

test("question quotes stored evidence, leaves pending, and then guidance reaches the exact decision", async () => {
  const { store, d } = setup(); let pendingDuringAnswer = false;
  const p = provider();
  const api = apiFor([[message(1, "What exactly failed, and did anything change?")], [message(2, rawGuidance)]], (text) => {
    if (text.startsWith("From stored evidence")) pendingDuringAnswer = store.get(d.id).status === "pending" && !store.get(d.id).consumed;
  });
  const r = await waitForDecision({ api, store, decision: d, interpret: p.interpret });
  assert.equal(pendingDuringAnswer, true); assert.equal(r.status, "guidance"); assert.equal(r.id, d.id); assert.equal(r.sid, d.sid);
  assert.equal(r.originalReply, rawGuidance); assert.equal(r.modelRequests, 2); assert.equal(r.userTurns, 2);
  assert.deepEqual(r.conversation.map((x) => x.kind), ["question", "guidance"]);
  assert.match(api.sent[0], /EBADENGINE/); assert.match(api.sent[0], /does not prove files are unchanged/);
  assert.ok(r.acknowledgment.includes(rawGuidance)); assert.equal(r.expiresAt, d.expiresAt);
  assert.equal(store.consume(r.id, r), false);
});

test("answers cannot contain model-invented facts or unsupported costs/outcomes", () => {
  const answer = answerFromFacts(question, evidence);
  assert.match(answer, /EBADENGINE/); assert.doesNotMatch(answer, /all tests pass|\$[0-9]/i);
  assert.match(answerFromFacts({ fact_ids: [] }, evidence), /don't have recorded evidence/);
  assert.throws(() => validateInterpretation({ ...question, fact_ids: ["invented-success"] }, { original: "What passed?", facts: evidence }));
  assert.throws(() => validateInterpretation({ ...question, answer: "All files are unchanged" }, { original: "What changed?", facts: evidence }));
  assert.match(evidence.find((f) => f.id === "coverage").text, /No independent filesystem diff/);
});

test("acknowledgment preserves negations, conditions, file restrictions and rejected approaches verbatim", () => {
  for (const original of [rawGuidance, "Yes if the tests pass.", "Yes after I review it, but do not overwrite the original.", "Use the newer file but preserve the original."]) {
    assert.ok(acknowledgeGuidance(original).includes(original));
    assert.match(acknowledgeGuidance(original), /not independently enforced every condition/);
  }
});

test("informational question misclassified as guidance stays held for clarification", async () => {
  for (const original of ["Tell me exactly what failed", "Please explain the failure", "I want to know whether files changed"]) {
    assert.equal(validateInterpretation(guidance, { original, facts: evidence }).kind, "clarify");
  }
  const { store, d } = setup(); let pending = false;
  const p = provider(guidance);
  const api = apiFor([[message(1, "Did any tests pass?")], [cb(2, d, "s")]], () => { pending = store.get(d.id).status === "pending"; });
  const r = await waitForDecision({ api, store, decision: d, interpret: p.interpret });
  assert.equal(pending, true); assert.equal(r.status, "cancelled"); assert.equal(r.conversation[0].kind, "clarify");
  assert.ok(!r.replies.some((x) => x.interpreted === "guidance"));
});

for (const malformed of [{ ...guidance, kind: "approve" }, { ...guidance, approve: true }, { ...question, fact_ids: ["fake"] }, null]) test(`malformed interpretation fails closed: ${JSON.stringify(malformed)}`, async () => {
  const { store, d } = setup();
  const p = provider(() => malformed);
  const r = await waitForDecision({ api: apiFor([[message(1, "Please continue carefully")]]), store, decision: d, interpret: p.interpret });
  assert.equal(r.status, "interpretation_failed"); assert.equal(store.consume(r.id, r), false);
});

for (const [action, status] of [["s", "cancelled"], ["r", "deny"]]) test(`explicit ${action} received while Gemini is busy overrides its guidance`, async () => {
  const { store, d } = setup(); let generated = false;
  const p = provider(() => { generated = true; return guidance; });
  const api = apiFor([[message(1, rawGuidance)]], () => {}, () => generated ? [cb(2, d, action)] : []);
  const r = await waitForDecision({ api, store, decision: d, interpret: p.interpret });
  assert.equal(r.status, status); assert.equal(r.consumed, false); assert.equal(api.sent.length, 0);
});

test("Stop during the acknowledgment delivery still blocks guidance relay", async () => {
  const { store, d } = setup(); let delivered = false;
  const p = provider(guidance);
  const api = apiFor([[message(1, rawGuidance)]], () => { delivered = true; }, () => delivered ? [cb(2, d, "s")] : []);
  const r = await waitForDecision({ api, store, decision: d, interpret: p.interpret });
  assert.equal(r.status, "cancelled"); assert.notEqual(r.interpreted, "guidance");
});

test("Stop arriving after a question answer overrides an already queued approval", async () => {
  const { store, d } = setup(); let answered = false;
  const p = provider(question);
  const api = apiFor([[message(1, "What failed?"), cb(2, d, "a")]], () => { answered = true; }, () => answered ? [cb(3, d, "s")] : []);
  const r = await waitForDecision({ api, store, decision: d, interpret: p.interpret });
  assert.equal(r.status, "cancelled"); assert.equal(store.consume(r.id, r), false);
});

test("at most two actual interpretation attempts, no hidden third request", async () => {
  const { store, d } = setup(); const p = provider(question);
  const api = apiFor([[message(1, "What failed?")], [message(2, "What changed?")], [message(3, "What should happen?")]]);
  const r = await waitForDecision({ api, store, decision: d, interpret: p.interpret });
  assert.equal(r.status, "conversation_limit"); assert.equal(p.calls(), 2); assert.equal(r.modelRequests, 2); assert.equal(r.userTurns, 3);
});

test("three-user-turn limit does not prevent deterministic Stop", async () => {
  const { store, d } = setup(); d.userTurns = 3; store.save(d);
  const r = await waitForDecision({ api: apiFor([[cb(1, d, "s")]]), store, decision: d, interpret: async () => { throw new Error("must not run"); } });
  assert.equal(r.status, "cancelled");
  const second = setup(); second.d.userTurns = 3; second.store.save(second.d);
  const limited = await waitForDecision({ api: apiFor([[message(1, "Try a different approach")]]), store: second.store, decision: second.d, interpret: async () => { throw new Error("must not run"); } });
  assert.equal(limited.status, "conversation_limit"); assert.equal(limited.modelRequests, 0);
});

test("absolute deadline is not extended by a model answer", async () => {
  const { store, d } = setup(Date.now() + 600);
  const p = provider(async () => { await new Promise((r) => setTimeout(r, 650)); return guidance; });
  const r = await waitForDecision({ api: apiFor([[message(1, rawGuidance)]]), store, decision: d, interpret: p.interpret });
  assert.equal(r.status, "expired"); assert.equal(r.expiresAt, d.expiresAt); assert.equal(r.consumed, false);
});

test("duplicate question update is ignored instead of charging another interpretation", async () => {
  const { store, d } = setup(); const p = provider();
  const q = message(1, "What failed?");
  const r = await waitForDecision({ api: apiFor([[q, q], [q], [message(2, rawGuidance)]]), store, decision: d, interpret: p.interpret });
  assert.equal(r.status, "guidance"); assert.equal(r.modelRequests, 2); assert.equal(r.userTurns, 2);
});

test("second unresolved interpretation clarification invalidates the decision", async () => {
  const { store, d } = setup(); const p = provider(clarification);
  const r = await waitForDecision({ api: apiFor([[message(1, "Choose both contradictory options")], [message(2, "Still choose both")]]), store, decision: d, interpret: p.interpret });
  assert.equal(r.status, "interpretation_unclear"); assert.equal(r.clarified, true); assert.equal(store.consume(r.id, r), false);
});

test("model and acknowledgment delivery failures keep action blocked", async () => {
  for (const failDelivery of [false, true]) {
    const { store, d } = setup();
    const p = provider(() => { if (!failDelivery) throw new Error("provider unavailable"); return guidance; });
    const api = apiFor([[message(1, rawGuidance)]]);
    if (failDelivery) api.call = async () => { throw new Error("delivery unavailable"); };
    const r = await waitForDecision({ api, store, decision: d, interpret: p.interpret });
    assert.equal(r.status, failDelivery ? "delivery_failed" : "interpretation_failed"); assert.equal(r.consumed, false);
  }
});

test("conversation uses one verified transport request, recorded model, bounded output and no tools", async () => {
  const prior = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = "TEST";
  let requests = 0, reserves = 0;
  try {
    const r = await interpretReply({ original: "What failed?", decision: { briefing: "Held", evidence }, deadline: Date.now() + 1000,
      reserve: () => { reserves++; return true; }, fetcher: async (_url, init) => {
        requests++; const body = JSON.parse(init.body);
        assert.equal(body.generationConfig.maxOutputTokens, 1536); assert.equal(body.tools, undefined); assert.equal(init.redirect, "error");
        return new Response(JSON.stringify({ modelVersion: "mock-gemini", candidates: [{ content: { parts: [{ text: JSON.stringify(question) }] } }] }));
      } });
    assert.equal(requests, 1); assert.equal(reserves, 1); assert.equal(r.model, "mock-gemini");
  } finally { if (prior === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prior; }
});
