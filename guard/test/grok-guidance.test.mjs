import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DecisionStore, acquireConsumer, readJson, writeJson } from "../lib/decisions.mjs";
import { VerificationStore } from "../lib/verification.mjs";
import { attachGrokGuidance, attachedGuidance } from "../lib/grok-guidance.mjs";
import { waitForDecision, classifyUpdate } from "../lib/telegram.mjs";
const evidence = path.resolve(import.meta.dirname, "../evidence/grokbot-m4");
const guidance = "Do not push. Keep tests unchanged. Only report done if every acceptance test passes.";
const config = { owner: "123", chat: "123" };
async function setup(t, text = guidance) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-attach-"));
  const release = acquireConsumer(home); t.after(() => { release(); fs.rmSync(home, { recursive: true, force: true }); });
  const verification = new VerificationStore(home), request = readJson(path.join(evidence, "failed-request.json"));
  verification.create(request); verification.import(request.requestId, fs.readFileSync(path.join(evidence, "failed-report.json"), "utf8"));
  const store = new DecisionStore(home), d = store.create({ sid: "synthetic-session", actionHash: "a".repeat(64), owner: "123", chat: "123", expiresAt: Date.now() + 5000, briefing: "Synthetic", approvalEligible: true });
  d.messageId = 10; d.replyMessageIds = [10]; store.save(d);
  const sent = [], edits = []; let messageId = 42;
  const api = { call: async (method, body) => { if (method === "editMessageText") edits.push(body); if (method === "sendMessage") { sent.push(body); return { message_id: messageId++, chat: { id: 123, type: "private" } }; } return true; } };
  const attach = await attachGrokGuidance({ store, verificationId: request.requestId, decisionId: d.id, guidance: text, source: "test_text", config, api });
  const a = attachedGuidance(store, d);
  return { home, store, d, api, sent, edits, a, attach, request };
}
const click = (d, a, action = "u", id = 1) => ({ update_id: id, callback_query: { id: `cb${id}`, from: { id: 123 }, message: { message_id: a.messageId, chat: { id: 123, type: "private" } }, data: `gg:${action}:${d.id}:${a.id}` } });
const control = (d, action, id = 2) => ({ update_id: id, callback_query: { id: `cb${id}`, from: { id: 123 }, message: { message_id: 10, chat: { id: 123, type: "private" } }, data: `gs:${action}:${d.id}` } });
function polling(ctx, batches, immediate = () => []) {
  let polls = 0; ctx.api.updates = async (_offset, _deadline, wait = true) => wait ? batches[polls++] ?? [] : immediate();
}
test("matching button relays exact conditional guidance once, without approval/model or second consumer", async (t) => {
  const c = await setup(t); const cb = click(c.d, c.a); polling(c, [[cb, cb]]);
  assert.throws(() => acquireConsumer(c.home), /consumer is active/);
  const r = await waitForDecision({ api: c.api, store: c.store, decision: c.d, interpret: async () => { throw Error("No Gemini"); } });
  assert.equal(r.status, "guidance"); assert.equal(r.originalReply, guidance); assert.equal(r.consumed, false); assert.equal(r.modelRequests, 0);
  assert.equal(c.store.consume(r.id, r), false); assert.equal(r.replies.filter(x => x.interpreted === "guidance").length, 1);
  assert.ok(c.sent[0].text.includes(guidance)); assert.match(c.sent[0].text, /NOT Grok-authored/);
  assert.equal(classifyUpdate(cb, r, Date.now(), c.a), null);
  assert.equal(readJson(path.join(c.home, "grok-guidance", `${r.id}.json`)).used, true);
  assert.deepEqual(c.edits.at(-1).reply_markup.inline_keyboard, []); assert.match(c.edits.at(-1).text, /buttons disabled/);
});
test("wrong owner, chat, message, attachment or decision cannot select guidance", async (t) => {
  const c = await setup(t);
  for (const mutate of [x => x.callback_query.from.id = 456, x => x.callback_query.message.chat.id = 456, x => x.callback_query.message.chat.type = "group", x => x.callback_query.message.message_id = 10, x => x.callback_query.data = x.callback_query.data.replace(c.d.id, "0".repeat(16)), x => x.callback_query.data = x.callback_query.data.replace(c.a.id, "0".repeat(16))]) {
    const cb = click(c.d, c.a); mutate(cb); assert.equal(classifyUpdate(cb, c.d, Date.now(), c.a), null);
  }
});
for (const state of ["expired", "cancelled", "consumed", "changed"]) test(`${state} decision disables attachment`, async (t) => {
  const c = await setup(t), d = c.store.get(c.d.id);
  if (state === "expired") d.expiresAt = Date.now() - 1;
  else if (state === "changed") d.actionHash = "b".repeat(64);
  else { d.status = state; d.consumed = state === "consumed"; }
  c.store.save(d); assert.equal(attachedGuidance(c.store, c.d), null);
});
test("missing guidance presents findings without enabled selection", async (t) => {
  const c = await setup(t, null); assert.equal(c.attach.enabled, false);
  assert.ok(!c.sent[0].reply_markup.inline_keyboard.flat().some(b => b.callback_data.includes("gg:u:")));
  assert.equal(classifyUpdate(click(c.d, c.a), c.d, Date.now(), c.a), null);
});
for (const action of ["s", "r"]) test(`competing ${action} takes precedence, including during acknowledgment`, async (t) => {
  const first = await setup(t); polling(first, [[click(first.d, first.a), control(first.d, action)]]);
  const a = await waitForDecision({ api: first.api, store: first.store, decision: first.d }); assert.equal(a.status, action === "s" ? "cancelled" : "deny");
  const second = await setup(t); polling(second, [[click(second.d, second.a)]], () => second.sent.length > 1 ? [control(second.d, action)] : []);
  const b = await waitForDecision({ api: second.api, store: second.store, decision: second.d }); assert.equal(b.status, action === "s" ? "cancelled" : "deny"); assert.notEqual(b.interpreted, "guidance");
});
test("Keep paused preserves original deadline then Stop uses existing behavior", async (t) => {
  const c = await setup(t); polling(c, [[click(c.d, c.a, "p")], [click(c.d, c.a, "s", 2)]]);
  const r = await waitForDecision({ api: c.api, store: c.store, decision: c.d }); assert.equal(r.status, "cancelled"); assert.equal(r.expiresAt, c.d.expiresAt); assert.equal(r.modelRequests, 0);
});
test("expired attachment is information only; no old decision revival", async (t) => {
  const c = await setup(t); c.d.status = "expired"; c.store.save(c.d);
  fs.unlinkSync(path.join(c.home, "grok-guidance", `${c.d.id}.json`));
  const result = await attachGrokGuidance({ store: c.store, verificationId: c.request.requestId, decisionId: c.d.id, guidance, source: "test_text", config, api: c.api });
  assert.equal(result.informationOnly, true); assert.equal(result.enabled, false); assert.deepEqual(c.sent.at(-1).reply_markup.inline_keyboard, []);
  assert.match(c.sent.at(-1).text, /fresh supported Claude continuation/); assert.equal(c.store.get(c.d.id).status, "expired");
});
test("changed recommendation or imported report invalidates binding; conditions never truncated", async (t) => {
  const c = await setup(t), f = path.join(c.home, "grok-guidance", `${c.d.id}.json`), a = readJson(f);
  a.guidance += " Extra"; writeJson(f, a); assert.equal(attachedGuidance(c.store, c.d), null);
  const second = await setup(t); fs.appendFileSync(path.join(second.home, "verification", second.request.requestId, "original-report.json"), " "); assert.equal(attachedGuidance(second.store, second.d), null);
  await assert.rejects(attachGrokGuidance({ store: c.store, verificationId: c.request.requestId, decisionId: c.d.id, guidance: "x".repeat(1001), config, api: c.api }), /never silently truncated/);
});
test("decision changed during acknowledgment cannot be overwritten or relayed", async (t) => {
  const c = await setup(t); polling(c, [[click(c.d, c.a)]]);
  const original = c.api.call;
  c.api.call = async (method, body) => {
    const answer = await original(method, body);
    if (method === "sendMessage") { const d = c.store.get(c.d.id); d.actionHash = "b".repeat(64); c.store.save(d); }
    return answer;
  };
  const r = await waitForDecision({ api: c.api, store: c.store, decision: c.d });
  assert.notEqual(r.status, "guidance"); assert.equal(c.store.get(c.d.id).actionHash, "b".repeat(64)); assert.equal(r.originalReply, undefined);
});
