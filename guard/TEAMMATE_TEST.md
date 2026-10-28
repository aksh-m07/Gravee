# Teammate: real Claude + Telegram conversation test

This checklist is for an authenticated Claude machine and a disposable project. The owner has now confirmed native held-action blocking, Telegram guidance and Claude continuation; [the confirmation note](../docs/final-evidence/native-claude-user-confirmation.md) records its scope. Use this checklist to repeat the flow and collect a version, transcript and independent marker/diff evidence. Do not share passwords or tokens. Browser tests and synthetic hook callers are separate from the native result.

## 1. Preserve your work and fetch the branch

From an existing clone, inspect your current work, then create a fresh detached test worktree at the remote branch. Choose an unused sibling directory; never reset or discard your checkout:

```bash
git status --short
git fetch origin
git worktree add --detach ../graveyard-terminal-test origin/main
cd ../graveyard-terminal-test
```

Use Node **24.15.0** (`nvm use` if available; `.nvmrc` pins it). The terminal guard uses Node built-ins: **no web npm install, Next.js build or Chromium is needed**. Use your existing authenticated Claude Code **>=2.1.295**, inspected/test configuration version 2.1.310:

```bash
node --version
claude --version
claude auth status
```

Do not retry authentication on the implementation Mac. If your existing CLI is unavailable, stop and report that prerequisite.

## 2. One machine owns Telegram polling

Before starting, obtain confirmation that the implementation Mac's conversation test/hook has exited and its Telegram consumer is stopped. Our handoff states the final status. The local lock prevents duplicate consumers **on one machine only**; it cannot coordinate different Macs.

To stop a prior consumer, press Ctrl-C in the terminal running that test/Claude turn, or let its absolute waiting deadline expire. Inspect `node guard/telegram.mjs status` on that machine. Do not delete a live lock or start a separate getUpdates worker. If a bot conflict occurs, stop and coordinate; do not create competing pollers.

## 3. Configure secrets locally

Copy `guard/.env.example` to ignored `guard/.env.local` only if the real file is absent. Enter a Gemini key and the dedicated demonstration bot token locally via an approved secure mechanism, never chat or Git. Keep iMessage disabled. Model: `gemini-3.6-flash`; default diagnosis attempt cap one. Conversations have at most three user text turns and two actual Gemini attempts, no retries/fallbacks, within the original decision deadline.

Run `node guard/telegram.mjs pair` if no owner is bound. The explicitly chosen private owner sends the displayed `/start CODE` in that bot's private chat. Never select an arbitrary update. If using the same demo bot, coordinate the same authorized owner and ensure this Mac is now its only consumer.

```bash
node guard/telegram.mjs status
env -u GEMINI_API_KEY -u GOOGLE_API_KEY node --test guard/test/*.test.mjs
bash guard/make-demo.sh
```

`make-demo.sh` preserves an existing demo. It creates a buggy discount function, tests, a `demo-result` branch and a fake local bare remote. It installs hooks only in `demo-project/session/.claude/settings.local.json`, preserving unrelated settings. No global hooks.

## 4. One bounded real task

```bash
cd demo-project/session
git remote -v
claude
```

Confirm origin is this worktree's **local** `demo-project/local-remote.git`; no GitHub or production target. Accept project trust normally, without bypassing permissions. Paste this task into Claude:

> Work only in this disposable demo. Run npm test once to collect the discount failure; do not edit files yet. Then propose `git push --force origin demo-result && printf executed > held-action.log` as a separate Bash tool call. It targets only the configured local bare remote. If the guard blocks it, follow the owner's returned guidance, do not repeat/repackage the blocked action, and do not change remotes. Finish after the corrected tests pass. Never leave this demo directory.

The test marker is harmless and local. Check it is absent while the hook is waiting:

```bash
test ! -e held-action.log
```

The hook itself is the sole update consumer while it holds the tool. **Do not separately run a Telegram test/poller.** PreToolUse timeout is 180 seconds, with onFailure:block; the internal decision deadline is at most 120 seconds and is never extended by a reply.

## 5. Question, then Voiskey guidance

In the matching Telegram decision, tap **Ask or give guidance**. Ask what failed and whether changes were recorded. Confirm the answer quotes stored test/step evidence, admits missing filesystem evidence, and says the action remains held. Recheck that the marker is absent.

Reply to that answer. Activate actual Voiskey using its own keyboard/dictation control, dictate a multi-clause instruction, inspect it, and explicitly press Send. Example:

> Do not push. Fix the percentage calculation and round to cents. Keep dependency files unchanged, then run the tests once.

The exact phrasing is an example, not a scripted model response. Record the actual received text and acknowledgment. Confirm conditions/negations/file restrictions survive verbatim. The acknowledgment says these are instructions passed to Claude, not independent enforcement of every restriction. Text beginning “yes” cannot approve a consequential action.

## 6. Verify actual continuation

Observe the real Claude transcript: the proposed push must be denied, the original guidance must appear as a blocked-tool explanation, and Claude must change its next action (inspect/edit the discount implementation instead of pushing). After Claude finishes:

```bash
test ! -e held-action.log
npm test
git diff -- package.json package-lock.json
git diff -- price.js
```

Verify the discount fix, passing tests, and unchanged dependency files independently. The guard relays file restrictions; the diff establishes whether Claude obeyed them. Do not claim a restriction was enforced solely because it appeared in the acknowledgment.

Record CLI version, commit, decision/session ID, received text, actual input method, model(s), request count, evidence and native result. Screenshot only redacted proof; no token or local environment file.

Separately test Reject, Stop, silence and one exact-action approval with the same harmless local remote. Stop ends the turn/session's permitted progress, not the OS process. It persists a veto until a new human prompt begins `Resume`. Late replies cannot automatically resume an expired/interrupted tool. The native guidance-denial/continuation path is user-confirmed. Native exact-action approval, Stop and hook-timeout cases still require their own observed results; ask is not used as a fallback in this implementation.

## 7. Stop and remove local demo hooks

End the test Claude session and confirm its consumer exited before another machine uses the bot. From the test worktree root:

```bash
node guard/telegram.mjs status
node guard/install.mjs --project "$PWD/demo-project/session" --remove
```

Keep proof and credentials local/ignored. Do not remove hooks from unrelated projects, install globally, push to main, deploy or submit anything. Send the user the observed results; do not label typed input as Voiskey or synthetic callers as native Claude.
