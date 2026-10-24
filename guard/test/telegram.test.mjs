import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DecisionStore, acquireConsumer, fingerprint, readJson, writeJson, sessionStopFile } from "../lib/decisions.mjs";
import { Telegram, briefingFor, classifyUpdate, notifyDecision, waitForDecision } from "../lib/telegram.mjs";
import { readReply } from "../lib/phone.mjs";
import { installProject, EVENTS } from "../install.mjs";
import { assess } from "../lib/gemini.mjs";

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "gs-telegram-"));
const scope = { sid: "session-A", actionHash: "a".repeat(64), owner: "123", chat: "123" };
function setup(expiresAt = Date.now() + 5000) {
  const store = new DecisionStore(temporary());
  const d = store.create({ ...scope, expiresAt, briefing: "Task, exact action, evidence, question, default", approvalEligible: true });
  d.messageId = 10; d.replyMessageIds = [10]; store.save(d);
  return { store, d };
}
const callback = (d, action = "a", overrides = {}) => ({ update_id: 1, callback_query: { id: "callback", from: { id: 123 }, message: { chat: { id: 123, type: "private" }, message_id: 10 }, data: `gs:${action}:${d.id}`, ...overrides } });
const message = (text, replyTo = 10) => ({ update_id: 2, message: { from: { id: 123 }, chat: { id: 123, type: "private" }, text, reply_to_message: { message_id: replyTo } } });

test("all conditional replies preserve original text and never approve", () => {
  for (const text of ["Yes if the tests pass.", "Yes, after I review the changes.", "Use the newer file but preserve the original.", "Use a new branch instead.", "Don't stop; preserve the original.", "Stop if the tests fail."]) {
    assert.deepEqual(readReply(text), { kind: "instruct", text });
  }
  for (const text of ["yes", "approve", "okay yes, buy it", "go ahead", "approve this action once"]) assert.equal(readReply(text).kind, "ambiguous");
  assert.equal(readReply("Stop everything!").kind, "stop");
  assert.equal(readReply("No, use a branch instead").kind, "deny");
});

test("fingerprint binds exact session, cwd, tool, and full input, including whitespace", () => {
  const action = { sid: "a", cwd: "/demo", tool: "Bash", input: { command: "echo a", description: "test" } };
  const hash = fingerprint(action);
  assert.equal(hash, fingerprint({ ...action, input: { description: "test", command: "echo a" } }));
  for (const change of [{ sid: "b" }, { cwd: "/elsewhere" }, { tool: "Edit" }, { input: { command: "echo  a", description: "test" } }]) assert.notEqual(hash, fingerprint({ ...action, ...change }));
});

test("callback binds owner, private chat, message and decision; unauthorized and stale updates rejected", () => {
  const { d } = setup();
  assert.equal(classifyUpdate(callback(d), d).kind, "approve");
  for (const override of [{ from: { id: 456 } }, { message: { chat: { id: 456, type: "private" }, message_id: 10 } }, { message: { chat: { id: 123, type: "group" }, message_id: 10 } }, { message: { chat: { id: 123, type: "private" }, message_id: 11 } }, { data: "gs:a:bbbbbbbbbbbbbbbb" }]) assert.equal(classifyUpdate(callback(d, "a", override), d), null);
  assert.equal(classifyUpdate(message("guidance", 999), d), null);
  assert.equal(classifyUpdate(message("yes"), d).kind, "ambiguous");
  assert.equal(classifyUpdate(callback(d), { ...d, approvalEligible: false }), null);
});

test("one exact approval is consumed once; session or fingerprint mismatch cannot consume", () => {
  const { store, d } = setup();
  assert.equal(store.resolve(d.id, { ...scope, sid: "other" }, "inline:approve", "approve"), null);
  assert.equal(store.resolve(d.id, { ...scope, actionHash: "wrong" }, "inline:approve", "approve"), null);
  store.resolve(d.id, scope, "inline:approve", "approve");
  assert.equal(store.consume(d.id, { ...scope, owner: "other" }), false);
  assert.equal(store.consume(d.id, scope), true);
  assert.equal(store.consume(d.id, scope), false);
  assert.equal(store.resolve(d.id, scope, "inline:approve", "approve"), null);
  assert.equal(store.get(d.id).consumed, true);
});

test("expired, cancelled and rejected decisions reject late or duplicate approvals", () => {
  for (const kind of ["stop", "deny"]) {
    const { store, d } = setup();
    store.resolve(d.id, scope, kind, kind);
    assert.equal(store.resolve(d.id, scope, "inline:approve", "approve"), null);
    assert.equal(store.consume(d.id, scope), false);
  }
  const { store, d } = setup(Date.now() - 1);
  assert.equal(store.resolve(d.id, scope, "inline:approve", "approve"), null);
  assert.equal(store.get(d.id).status, "expired");
  assert.equal(classifyUpdate(callback(d), d), null);
});

test("approval expiring before consumption cannot dispatch", () => {
  let now = 1000;
  const store = new DecisionStore(temporary(), () => now);
  const d = store.create({ ...scope, expiresAt: 1100, briefing: "test", approvalEligible: true });
  store.resolve(d.id, scope, "inline:approve", "approve"); now = 1100;
  assert.equal(store.consume(d.id, scope), false); assert.equal(store.get(d.id).status, "expired");
});

test("Stop session veto survives interruption before the decision write completes", () => {
  const { store, d } = setup();
  const save = store.save.bind(store);
  store.save = (value) => { if (value.status === "cancelled") throw new Error("simulated interruption"); return save(value); };
  assert.throws(() => store.resolve(d.id, scope, "Stop", "stop"), /interruption/);
  assert.equal(readJson(sessionStopFile(store.home, scope.sid)).stopped, true);
  assert.equal(store.consume(d.id, scope), false);
});

test("notification is persisted/deduplicated, even with a stale caller object", async () => {
  const { store, d } = setup();
  d.delivery = "unsent"; d.messageId = null; store.save(d);
  let sends = 0;
  const api = { call: async () => { sends++; return { message_id: 20, chat: { id: 123, type: "private" } }; } };
  await notifyDecision(api, store, d); await notifyDecision(api, store, { ...d, delivery: "unsent" });
  assert.equal(sends, 1); assert.equal(store.get(d.id).delivery, "sent");
});

test("delivery failure never approves, and does not retry uncertain sends", async () => {
  const { store, d } = setup();
  let calls = 0;
  const api = { call: async () => { calls++; throw new Error("failed"); } };
  await notifyDecision(api, store, d); await notifyDecision(api, store, d);
  assert.equal(calls, 1); assert.equal(store.get(d.id).status, "delivery_failed"); assert.equal(store.consume(d.id, scope), false);
});

test("silence expires at absolute deadline and cannot approve", async () => {
  const { store, d } = setup(Date.now() + 20);
  const api = { updates: async () => { await new Promise((r) => setTimeout(r, 5)); return []; } };
  const result = await waitForDecision({ api, store, decision: d });
  assert.equal(result.status, "expired"); assert.equal(store.consume(d.id, scope), false);
});

test("one clarification preserves deadline; conditional dictated guidance is persisted verbatim", async () => {
  const { store, d } = setup();
  let polls = 0; let clarifications = 0;
  const api = {
    updates: async () => polls++ === 0 ? [message("yes")] : [{ ...message("Yes if the tests pass.", 77), update_id: 3 }],
    call: async () => { clarifications++; return { message_id: 77 }; },
  };
  const result = await waitForDecision({ api, store, decision: d });
  assert.equal(result.status, "guidance"); assert.equal(result.originalReply, "Yes if the tests pass.");
  assert.equal(result.expiresAt, d.expiresAt); assert.equal(clarifications, 1);
  assert.equal(result.replies[0].interpreted, "ambiguous"); assert.equal(result.replies[1].interpreted, "guidance");
  assert.equal(new DecisionStore(store.home).get(d.id).originalReply, "Yes if the tests pass.");
  assert.equal(store.consume(d.id, scope), false);
});

test("opening guidance composer still permits one ambiguity clarification, without extending expiry", async () => {
  const { store, d } = setup();
  let polls = 0; let prompts = 0;
  const api = { updates: async () => [[callback(d, "g")], [{ ...message("yes", 77), update_id: 2 }], [{ ...message("Use a new branch instead", 78), update_id: 3 }]][polls++],
    call: async (method) => method === "sendMessage" ? { message_id: 77 + prompts++ } : true };
  const result = await waitForDecision({ api, store, decision: d });
  assert.equal(result.status, "guidance"); assert.equal(result.expiresAt, d.expiresAt); assert.equal(prompts, 2);
  assert.equal(result.clarified, true); assert.equal(result.guidancePrompted, true);
});

test("Stop and rejection dominate approval in either order within the received batch", async () => {
  for (const [action, status] of [["s", "cancelled"], ["r", "deny"]]) for (const reverse of [false, true]) {
    const { store, d } = setup();
    const updates = [callback(d, action), { ...callback(d), update_id: 2 }];
    if (reverse) updates.reverse();
    const api = { updates: async () => updates, call: async () => true };
    const result = await waitForDecision({ api, store, decision: d });
    assert.equal(result.status, status); assert.equal(store.consume(d.id, scope), false);
  }
});

test("state survives restart and uncertain approval is invalidated rather than replayed", () => {
  const { store, d } = setup();
  store.resolve(d.id, scope, "inline:approve", "approve");
  assert.equal(new DecisionStore(store.home).get(d.id).status, "approved");
  const release = acquireConsumer(store.home);
  assert.equal(new DecisionStore(store.home).get(d.id).status, "interrupted");
  assert.equal(store.consume(d.id, scope), false); release();
});

test("only one update consumer can hold the lock", () => {
  const home = temporary(); const release = acquireConsumer(home);
  assert.throws(() => acquireConsumer(home), /consumer is active/); release();
  const release2 = acquireConsumer(home); release2();
});

test("dead consumer ownership invalidates persisted pending state before another poller starts", () => {
  const { store, d } = setup();
  fs.mkdirSync(path.join(store.home, "telegram.lock"));
  writeJson(path.join(store.home, "telegram.lock", "owner.json"), { pid: 99999999 });
  const release = acquireConsumer(store.home);
  assert.equal(store.get(d.id).status, "interrupted"); release();
});

test("concurrent dead-consumer recovery admits only one consumer", async () => {
  const home = temporary();
  fs.mkdirSync(path.join(home, "telegram.lock"));
  writeJson(path.join(home, "telegram.lock", "owner.json"), { pid: 99999999 });
  const module = new URL("../lib/decisions.mjs", import.meta.url).href;
  const script = `import {acquireConsumer} from ${JSON.stringify(module)}; try { const release=acquireConsumer(process.argv[1]); console.log("acquired"); setTimeout(()=>{release()},300); } catch { process.exitCode=2; }`;
  const launch = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", script, home]); let out = "";
    p.stdout.on("data", (s) => { out += s; }); p.on("error", reject); p.on("close", (status) => resolve({ status, out }));
  });
  const runs = await Promise.all([launch(), launch(), launch()]);
  assert.equal(runs.filter((r) => r.status === 0 && r.out.includes("acquired")).length, 1);
});

test("unknown lock ownership stays blocked instead of stealing a consumer", () => {
  const home = temporary(); fs.mkdirSync(path.join(home, "telegram.lock"));
  assert.throws(() => acquireConsumer(home), /incomplete/);
});

test("corrupt pending state fails closed", () => {
  const home = temporary(); fs.writeFileSync(path.join(home, "active.json"), "broken");
  assert.throws(() => new DecisionStore(home).active());
});

test("briefing redacts known secrets and disables approval when exact action cannot be shown", () => {
  const prior = process.env.TEST_API_KEY; process.env.TEST_API_KEY = "sensitive-value-12345";
  try {
    const b = briefingFor({ goal: "test", question: "Allow?", tool: "Bash", input: { command: "send sensitive-value-12345" }, history: [] });
    assert.equal(b.approvalEligible, false); assert.doesNotMatch(b.text, /sensitive-value/); assert.match(b.text, /REDACTED/);
    assert.equal(briefingFor({ goal: "test", question: "Allow?", tool: "Bash", input: { command: "x".repeat(1001) } }).approvalEligible, false);
  } finally { if (prior === undefined) delete process.env.TEST_API_KEY; else process.env.TEST_API_KEY = prior; }
});

test("Telegram transport never leaks its token-bearing URL", async () => {
  const token = "123:secret-token";
  const api = new Telegram(token, async (url) => { throw new Error(url); });
  await assert.rejects(api.call("sendMessage", {}), (e) => !e.message.includes(token) && /unavailable/.test(e.message));
});

test("project install preserves unrelated configuration, is idempotent, and fails closed on hook timeout", () => {
  const project = temporary(); const file = path.join(project, ".claude", "settings.local.json");
  writeJson(file, { custom: true, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "other-hook" }] }] } });
  installProject(project); installProject(project);
  const s = readJson(file); assert.equal(s.custom, true); assert.equal(s.hooks.PreToolUse.length, 2);
  const hook = s.hooks.PreToolUse[1].hooks[0]; assert.equal(hook.timeout, 180); assert.equal(hook.onFailure, "block");
  assert.ok(EVENTS.PreToolUse > 120 + 20 + 8 + 3);
  installProject(project, true); assert.equal(readJson(file).hooks.PreToolUse[0].hooks[0].command, "other-hook");
});

test("Gemini actual attempts include fallback and reservation; no automatic retries", async () => {
  const old = { model: process.env.GRAVEYARD_GEMINI_MODEL, models: process.env.GRAVEYARD_GEMINI_MODELS, cap: process.env.GRAVEYARD_GEMINI_MAX_ATTEMPTS };
  process.env.GRAVEYARD_GEMINI_MODEL = "model-a,model-b,model-c"; process.env.GRAVEYARD_GEMINI_MAX_ATTEMPTS = "2";
  let attempts = 0; let reservations = 0;
  try {
    await assert.rejects(assess({ key: "fake", goal: "test", history: [], proposed: "test", flags: [], reserve: () => { reservations++; return true; }, fetcher: async () => { attempts++; return { ok: false, status: 429 }; } }), /2 actual attempt/);
    assert.equal(attempts, 2); assert.equal(reservations, 2);
    attempts = 0;
    await assert.rejects(assess({ key: "fake", goal: "test", history: [], proposed: "test", flags: [], reserve: () => false, fetcher: async () => { attempts++; } }), /0 actual attempt/);
    assert.equal(attempts, 0);
  } finally {
    for (const [name, value] of [["GRAVEYARD_GEMINI_MODEL", old.model], ["GRAVEYARD_GEMINI_MODELS", old.models], ["GRAVEYARD_GEMINI_MAX_ATTEMPTS", old.cap]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
