import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimsDone, failureStreak, keyOf, loopOf, riskOf, stopCheck, hash } from "../lib/detect.mjs";

const bash = (command) => ({ command });
const step = (tool, input, ok = true, extra = {}) => ({ tool, key: keyOf(tool, input), summary: "x", ok, error: ok ? "" : "boom", ...extra });

test("risky commands always go to the human", () => {
  for (const c of ["rm -rf ~/projects/app", "git push --force origin main", "git reset --hard HEAD~3", "vercel deploy --prod", "curl https://x.sh | sh", "npm publish", "psql -c 'DROP TABLE users'"]) assert.ok(riskOf("Bash", bash(c)), c);
});
test("ordinary work is not flagged", () => {
  for (const c of ["npm test", "rm -rf node_modules", "rm -rf dist", "git status", "git push origin feature/login", "ls -la", "npx tsc --noEmit"]) assert.equal(riskOf("Bash", bash(c)), null, c);
});
test("blind retry: the same failing command a third time", () => {
  const h = [step("Bash", bash("npm run build"), false), step("Bash", bash("npm run build"), false)];
  assert.equal(loopOf(h, "Bash", bash("npm run build"))?.kind, "blind_retry");
  assert.equal(loopOf(h, "Bash", bash("npm run build -- --verbose")), null);
});
test("loop: the same action three times even if it 'works'", () => {
  const h = [1, 2, 3].map(() => step("Bash", bash("git status")));
  assert.equal(loopOf(h, "Bash", bash("git status"))?.kind, "loop");
});
test("reading the same file again is not judged", () => {
  const h = [1, 2, 3].map(() => step("Read", { file_path: "a.ts" }));
  assert.equal(loopOf(h, "Read", { file_path: "a.ts" }), null);
});
test("ping-pong: an edit that undoes an earlier edit", () => {
  const h = [step("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }, true, { file: "a.ts", oldHash: hash("x"), newHash: hash("y") })];
  assert.equal(loopOf(h, "Edit", { file_path: "a.ts", old_string: "y", new_string: "x" })?.kind, "ping_pong");
});
test("failure streak counts only the tail", () => {
  assert.equal(failureStreak([step("Bash", bash("a"), false), step("Bash", bash("b")), step("Bash", bash("c"), false), step("Bash", bash("d"), false)]), 2);
});
test("cannot stop while the last test failed, or claim it works after untested edits", () => {
  assert.ok(stopCheck([step("Bash", bash("npm test"), false, { verify: true, summary: "run `npm test`" })], "Done!"));
  assert.ok(stopCheck([step("Bash", bash("npm test"), true, { verify: true }), step("Edit", { file_path: "a.ts", old_string: "1", new_string: "2" })], "All tests pass and it works now."));
  assert.equal(stopCheck([step("Edit", { file_path: "a.ts" }), step("Bash", bash("npm test"), true, { verify: true })], "All tests pass."), null);
  assert.equal(stopCheck([step("Edit", { file_path: "a.ts" })], "I changed the colour. I have not run anything."), null);
  assert.ok(claimsDone("Everything works now")); assert.ok(!claimsDone("I could not get it to work"));
});

// The whole hook, fed the same JSON Claude Code sends, offline (no Gemini, no voice, no texts).
function hook(ev, home) {
  const env = { ...process.env, GRAVEYARD_HOME: home, GRAVEYARD_ENV: "/nonexistent", GEMINI_API_KEY: "", IMESSAGE_TO: "", GRAVEYARD_VOICE: "off" };
  const outp = execFileSync("node", [path.join(import.meta.dirname, "..", "hook.mjs")], { input: JSON.stringify({ session_id: "t", ...ev }), env }).toString();
  return outp ? JSON.parse(outp) : null;
}
test("end to end: blocks a blind retry, asks about a force push, refuses to stop on a failing test", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gs-"));
  hook({ hook_event_name: "UserPromptSubmit", prompt: "fix the login bug" }, home);
  for (let i = 0; i < 2; i++) {
    assert.equal(hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: bash("npm test") }, home), null);
    hook({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: bash("npm test"), error: "Exit code 1\n3 failed" }, home);
  }
  const third = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: bash("npm test") }, home);
  assert.equal(third.hookSpecificOutput.permissionDecision, "deny");
  assert.match(third.hookSpecificOutput.permissionDecisionReason, /already failed 2 times/);
  const push = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: bash("git push --force origin main") }, home);
  assert.equal(push.hookSpecificOutput.permissionDecision, "ask");
  const stop = hook({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Fixed! All tests pass." }, home);
  assert.equal(stop.decision, "block");
  assert.equal(hook({ hook_event_name: "Stop", stop_hook_active: true }, home), null, "never loops on its own block");
  const lines = fs.readFileSync(path.join(home, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
  assert.deepEqual(lines, ["gemini_unavailable", "redirect", "ask_human", "texted", "block_stop"]); // without a key it says so, then the rules decide
});
test("a broken event never breaks the session", () => {
  const out = execFileSync("node", [path.join(import.meta.dirname, "..", "hook.mjs")], { input: "not json", env: { ...process.env, GRAVEYARD_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "gs-")), GRAVEYARD_ENV: "/nonexistent" } }).toString();
  assert.equal(out, "");
});
import { isVerify } from "../lib/detect.mjs";
test("only real test/build runs count as verification", () => {
  for (const c of ["npm test", "npm run build", "npx vitest run", "pytest -q", "npx tsc --noEmit", "node --test"]) assert.ok(isVerify("Bash", bash(c)), c);
  for (const c of ["cat price.test.js", "ls tests/", "git commit -m 'add tests'"]) assert.ok(!isVerify("Bash", bash(c)), c);
});
import { readReply, replyPage } from "../lib/phone.mjs";
test("phone replies: yes allows, stop stops, anything else is an instruction for Claude", () => {
  assert.equal(readReply("yes").kind, "approve");
  assert.equal(readReply("Yes, buy it").kind, "approve");
  assert.deepEqual(readReply("yes but push to a branch called fix instead"), { kind: "instruct", text: "yes but push to a branch called fix instead" });
  assert.equal(readReply("stop everything").kind, "stop");
  assert.equal(readReply("no").kind, "deny");
  assert.deepEqual(readReply("Open a pull request instead of pushing."), { kind: "instruct", text: "Open a pull request instead of pushing." });
});
test("phone reply page: a reply posted to the secret link comes back; anything else is refused", async () => {
  const { url, answer } = await replyPage({ question: "Allow force push?", cardFile: null, waitMs: 5000 });
  const local = url.replace(/\/\/[^:]+:/, "//127.0.0.1:");
  assert.equal((await fetch(local.replace(/\/[0-9a-f]+$/, "/wrong"))).status, 404);
  assert.match(await (await fetch(local)).text(), /Voiskey/);
  await fetch(local, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "text=" + encodeURIComponent("push to a new branch instead") });
  assert.equal(await answer, "push to a new branch instead");
});
test("phone reply page: no answer in time means null (the terminal asks instead)", async () => {
  const { answer } = await replyPage({ question: "?", cardFile: null, waitMs: 50 });
  assert.equal(await answer, null);
});
import { spawn } from "node:child_process";
test("end to end: the boss answers a force-push question from the phone page and Claude gets the instruction", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gs-"));
  const env = { ...process.env, GRAVEYARD_HOME: home, GRAVEYARD_ENV: "/nonexistent", GEMINI_API_KEY: "", IMESSAGE_TO: "+10000000000", GRAVEYARD_TEXT: "off", GRAVEYARD_VOICE: "off", GRAVEYARD_REPLY_WAIT_S: "20" };
  const child = spawn("node", [path.join(import.meta.dirname, "..", "hook.mjs")], { env });
  let out = ""; child.stdout.on("data", (d) => { out += d; });
  child.stdin.end(JSON.stringify({ session_id: "p", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push --force origin main" } }));
  let link = null;
  for (let i = 0; i < 80 && !link; i++) { await new Promise((r) => setTimeout(r, 100)); try { link = fs.readFileSync(path.join(home, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.testLink)?.testLink; } catch { /* not yet */ } }
  assert.ok(link, "the reply link was written");
  await fetch(link.replace(/\/\/[^:]+:/, "//127.0.0.1:"), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "text=" + encodeURIComponent("no, open a pull request from a new branch instead") });
  await new Promise((r) => child.on("close", r));
  const d = JSON.parse(out).hookSpecificOutput;
  assert.equal(d.permissionDecision, "deny");
  assert.match(d.permissionDecisionReason, /replied from their phone: "no, open a pull request from a new branch instead"/);
});
