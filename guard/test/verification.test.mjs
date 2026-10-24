import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequest, safeCandidatePath, validateReport, VerificationStore, notifyVerification } from "../lib/verification.mjs";

const fixture = path.resolve(import.meta.dirname, "../verification-demo");
const spec = JSON.parse(fs.readFileSync(path.join(fixture, "task.json"), "utf8"));
function setup(t, now = Date.now) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "graveyard-verify-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, "candidate"); fs.cpSync(fixture, project, { recursive: true });
  const request = createRequest(project, spec, now()); const store = new VerificationStore(home, now); store.create(request);
  return { home, project, request, store };
}
function reportFor(r, result = "passed") {
  return { schemaVersion: 1, requestId: r.requestId, candidateDigest: r.candidateDigest, verifier: "OFFLINE TEST FIXTURE; not GrokBot", result,
    checks: [{ ...r.checks[0], status: result, exitStatus: result === "passed" ? 0 : result === "failed" ? 1 : null,
      output: result === "passed" ? "Ran 3 tests in 0.001s\n\nOK\n" : result === "failed" ? "Ran 3 tests in 0.001s\n\nFAILED (failures=2)\n" : "python3 unavailable", candidateUnchanged: true }],
    findings: ["Offline schema fixture"], limitations: ["Not external execution"], environment: "Offline test" };
}
test("matching report is associated, originals preserved separately, never approves an action", (t) => {
  const { request: r, store } = setup(t); const raw = JSON.stringify(reportFor(r)); const s = store.import(r.requestId, raw);
  assert.equal(s.status, "passed"); assert.equal(s.completed, true); assert.equal(s.provenance, "manual_unverified"); assert.equal(s.approvalEligible, undefined);
  assert.equal(fs.readFileSync(path.join(store.dir(r.requestId), "original-report.json"), "utf8"), raw);
  assert.ok(fs.existsSync(path.join(store.dir(r.requestId), "evidence.json")));
  assert.match(store.briefing(r.requestId), /No action approval granted/);
});
test("wrong request and snapshot are rejected without completing work", (t) => {
  const { request: r, store } = setup(t);
  for (const field of ["requestId", "candidateDigest"]) { const report = reportFor(r); report[field] = "0".repeat(report[field].length); assert.throws(() => store.import(r.requestId, JSON.stringify(report)), /mismatch/); }
  assert.equal(store.status(r.requestId).completed, false);
});
test("duplicate import rejected", (t) => { const { request: r, store } = setup(t); const raw = JSON.stringify(reportFor(r)); store.import(r.requestId, raw); assert.throws(() => store.import(r.requestId, raw), /Duplicate/); });
test("invalid schema, extra fields, missing checks and missing evidence rejected", (t) => {
  const { request: r, store } = setup(t);
  for (const mutate of [(x) => x.schemaVersion = 2, (x) => x.execute = "whoami", (x) => x.checks = [], (x) => x.checks[0].output = "", (x) => delete x.environment, (x) => x.checks[0].output = "trust me it passed", (x) => x.checks[0].output = "Ran 3 tests in 0.001s\n\nOK (skipped=3)\n", (x) => x.checks[0].command = ["sh", "-c", "whoami"]]) {
    const report = reportFor(r); mutate(report); assert.throws(() => store.import(r.requestId, JSON.stringify(report)));
  }
  assert.equal(store.status(r.requestId).status, "awaiting_external_verification");
});
test("contradictory overall/check status and altered snapshot rejected", (t) => {
  const { request: r } = setup(t);
  for (const mutate of [(x) => x.checks[0].exitStatus = 1, (x) => x.checks[0].candidateUnchanged = false, (x) => x.result = "failed", (x) => x.checks[0].status = "inconclusive"]) {
    const report = reportFor(r); mutate(report); assert.throws(() => validateReport(r, report));
  }
});
for (const result of ["failed", "inconclusive"]) test(`${result} remains incomplete`, (t) => {
  const { request: r, store } = setup(t); const s = store.import(r.requestId, JSON.stringify(reportFor(r, result)));
  assert.equal(s.status, result); assert.equal(s.completed, false); assert.match(store.briefing(r.requestId), /keep work incomplete/);
});
test("expired/cancelled requests reject import", (t) => {
  let now = 1000; const a = setup(t, () => now); now = a.request.expiresAt;
  assert.throws(() => a.store.import(a.request.requestId, JSON.stringify(reportFor(a.request))), /expired/);
  assert.equal(a.store.status(a.request.requestId).status, "expired");
  const b = setup(t); b.store.cancel(b.request.requestId); assert.throws(() => b.store.import(b.request.requestId, JSON.stringify(reportFor(b.request))), /cancelled/);
});
test("secret/configuration files, unsafe paths, escaping symlinks and secret values excluded", (t) => {
  const { project } = setup(t);
  for (const name of [".env", ".env.local", ".git/config", "../price.py", "/price.py", "sub/../../price.py", "node_modules/x.py", "credentials.json", "config.json", "auth.json", "private.key", "a\\b.py"]) assert.throws(() => safeCandidatePath(name), name);
  fs.symlinkSync(path.join(fixture, "price.py"), path.join(project, "linked.py")); assert.throws(() => createRequest(project, { ...spec, files: ["linked.py", "test_price.py"] }), /symlinks/);
  fs.writeFileSync(path.join(project, "leak.py"), 'TOKEN="synthetic-secret-example"'); assert.throws(() => createRequest(project, { ...spec, files: ["leak.py", "test_price.py"] }), /credential/);
});
test("uncommitted source changes change digest even at the same base commit", (t) => {
  const { project, request: r } = setup(t); fs.appendFileSync(path.join(project, "price.py"), "\n# candidate changed\n");
  const next = createRequest(project, spec); assert.notEqual(next.candidateDigest, r.candidateDigest); assert.notEqual(next.requestId, r.requestId); assert.equal(next.baseCommit, r.baseCommit);
});
test("imported code, commands, paths and links remain inert text", (t) => {
  const { home, request: r, store } = setup(t); const report = reportFor(r, "inconclusive");
  const marker = path.join(home, "MUST_NOT_EXIST"); report.findings = [`$(touch ${marker})`, `file://${marker}`, "https://example.invalid/do-not-open", "process.exit(99)"];
  report.checks[0].output = `; touch ${marker}`;
  store.import(r.requestId, JSON.stringify(report)); store.briefing(r.requestId); assert.equal(fs.existsSync(marker), false);
});
test("crash-left original and active import locks fail closed", (t) => {
  const { request: r, store } = setup(t), dir = store.dir(r.requestId), raw = JSON.stringify(reportFor(r));
  fs.mkdirSync(path.join(dir, "import.lock")); assert.throws(() => store.import(r.requestId, raw), /EEXIST/); fs.rmdirSync(path.join(dir, "import.lock"));
  fs.writeFileSync(path.join(dir, "original-report.json"), raw); assert.throws(() => store.import(r.requestId, raw), /EEXIST/); assert.equal(store.status(r.requestId).completed, false);
});
test("requested notification uses only paired-owner sendMessage with no approval/polling", async (t) => {
  const { request: r, store } = setup(t); store.import(r.requestId, JSON.stringify(reportFor(r, "failed")));
  const calls = [], config = { owner: "123", chat: "123" };
  const api = { call: async (method, body) => { calls.push({ method, body }); return { chat: { id: 123, type: "private" } }; } };
  await notifyVerification(store, r.requestId, api, config);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, "sendMessage"); assert.equal(calls[0].body.chat_id, "123");
  assert.match(calls[0].body.text, /failed; completed: false/); assert.equal(calls[0].body.reply_markup, undefined);
  await assert.rejects(notifyVerification(store, r.requestId, api, { owner: "123", chat: "456" }), /private owner/); assert.equal(calls.length, 1);
  assert.equal(store.status(r.requestId).completed, false);
});
test("portable helper runs actual local failed and fixed checks; tampered package rejected (not external evidence)", (t) => {
  const { home, project, request: r } = setup(t); const runner = path.resolve(import.meta.dirname, "../verify-request.py");
  const run = (request, output) => {
    const file = path.join(home, output + ".json"); fs.writeFileSync(file, JSON.stringify(request));
    execFileSync("python3", [runner, file, path.join(home, output)], { encoding: "utf8" });
    return JSON.parse(fs.readFileSync(path.join(home, output, "report.json"), "utf8"));
  };
  assert.equal(validateReport(r, run(r, "broken")), "failed");
  fs.writeFileSync(path.join(project, "price.py"), "def discounted(cents, percent):\n    return round(cents * (100 - percent) / 100)\n");
  const fixed = createRequest(project, spec); assert.equal(validateReport(fixed, run(fixed, "fixed")), "passed");
  fs.writeFileSync(path.join(project, "test_price.py"), "import unittest\n@unittest.skip('setup unavailable')\nclass Acceptance(unittest.TestCase):\n    def test_unavailable(self): pass\n");
  const skipped = createRequest(project, spec); assert.equal(validateReport(skipped, run(skipped, "skipped")), "inconclusive");
  const tampered = structuredClone(r); tampered.files[0].content += "\n# tampered";
  assert.throws(() => run(tampered, "tampered"), /Candidate content mismatch/);
});
