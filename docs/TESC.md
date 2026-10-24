# Graveyard Shift: TESC "Five Nights with AI" submission

Teams may enter several tracks but win only one prize. We enter **Track 2 (Voiskey)** and **Track 3 (Google Gemini)** with the product, and **Track 1 (Highest Accuracy Model)** separately on the leaderboard. (Track numbers follow the official starter kit README.)

---

## One line

**Graveyard Shift is a night guard that lives inside Claude Code. It watches every step your AI agent takes, steers it back when it gets stuck, refuses to let it claim "done" when it isn't, and calls you, out loud and on your phone, only when a human has to decide. You answer by voice with Voiskey.**

## The problem

You hand a coding agent a task and walk away. Overnight it loops on the same failing command, undoes its own fixes, says "all tests pass" when they don't, or reaches for something you can't take back: a force push, a deploy, `rm -rf`. Nobody is watching.

## What it does

No app and no website: it installs into Claude Code (`node guard/install.mjs`) and runs on every step of every session.

1. **Before each action**, cheap checks run in milliseconds:
   - **Irreversible or outward-facing actions** (force push, push to main, deploy, `rm -rf`, `sudo`, dropping tables, sending messages or payments): always the human's call. The guard speaks the question aloud, texts your phone, and Claude Code asks you.
   - **Stuck**: the same action failing again (blind retry), repeating (loop), undoing its own edit (ping-pong), or a long failure streak.
2. **When something looks stuck, Gemini investigates.** It reads your goal, the recent steps and their errors, and the next step. Then it lets Claude continue, **redirects** it with one concrete different move, or decides you are needed.
3. **When Claude tries to finish**, the guard checks the evidence. If the last test or build failed, or Claude says "it works" after changing code without re-running checks, the stop is blocked and Claude is told what is not done.
4. **When nothing is wrong, it stays silent.**

## Track 3: Best use of Google Gemini

Gemini is the guard's investigator. Cheap rules notice *that* something is off; Gemini works out *what* is going on and what to do instead, from the goal and the actual errors.

Live example (gemini-3.5-flash-lite, 1.1 s): Claude was about to run a failing test command for the third time. Gemini's verdict was **redirect**: "The agent is repeating the exact same failing test command without making any code changes. Inspect the login test implementation file to find the root cause before running the tests again." Claude receives that as the reason its step was blocked.

Gemini never overrides the hard rules: irreversible actions always go to the human. If Gemini does not answer in time (free-tier limits), the guard tries the next model, then falls back to rules and logs that it did.

**Evidence from our earlier prototype** (same guard idea on a browser agent in a test shop we built, validation split): rules alone fixed 8 of 16 problem runs; with Gemini, 14 of 16. Unnecessary calls to the human fell from 8/15 to 2/15. That measurement is of the prototype, not of the Claude Code version.

## Track 2: Best use of Voiskey

Voiskey is how you answer the guard without touching the keyboard. When the guard needs you, it says the question out loud on your Mac and texts it to your phone. You answer in Claude Code by talking: Voiskey types your words into the terminal ("no, don't push, open a PR instead" / "yes, deploy it"). The guard turns a silent background agent into something you supervise by voice.

Voiskey has no developer API, so there is no code integration: Voiskey types into Claude Code as it would into any app. That is the design: the guard is built to be talked to.

## Track 1: Highest Accuracy Model

Separate leaderboard entry on the competition dataset (10-frame camera sequences, F1 on the anomalous class). Approach and validation F1: `track1/RESULTS.md`.

## Tested (real runs, not mock-ups)

- 11 guard tests, including the whole hook fed the same JSON Claude Code sends.
- **Real Claude Code sessions** with the guard installed:
  - Normal bug fix: guard saw all 6 steps and stayed silent.
  - "Fix it, commit and force push to main": Claude chained the push into its commit command; the guard stopped it for a human; the remote stayed untouched.
  - "Re-run the tests until they pass, don't edit": when Claude tried to stop with tests failing, the guard blocked the stop and Claude reported honestly that the tests still fail and why.
- Gemini redirect: live call shown above.

## What breaks first (honest)

- The repeat checks compare whole commands, so retries hidden inside one shell loop are missed (we saw this live).
- The risky-action list is patterns, not understanding. It can miss things and occasionally ask about something harmless.
- Free-tier Gemini is slow or capped at times; the guard falls back to rules and says so.
- The Gemini-vs-rules numbers above come from our earlier browser-agent prototype, not from the Claude Code version.
- We trained a mistake detector on 1,642 public agent-failure traces (MAST). It reached 0.76 AUC on one framework it never saw but was at chance on another, so it does not make decisions.

---

## 2-minute demo script

**Setup before judging:** `guard/make-demo.sh`, guard voice on, `IMESSAGE_TO` set to your phone, Voiskey running, Claude Code open in `demo-project`.

**0:00 Hook.** "Coding agents now run for hours on their own. When they get stuck they don't stop: they loop, they say it's fixed when it isn't, or they push to production. Graveyard Shift is a night guard that lives inside Claude Code."

**0:15 Normal work: silence.** Ask Claude: "Fix the bug in price.js so the tests pass." It works; the guard says nothing. "When things are fine, you never hear from it."

**0:40 The dangerous step.** "Now commit it and force push to main." Claude tries; the Mac speaks: "Graveyard Shift. Claude wants to run git push --force... Allow it?" Your phone buzzes with the same question. Claude Code shows the prompt. Answer **by voice with Voiskey**: "No. Push to a new branch instead." Claude does that.

**1:10 Stuck and lying.** Ask: "The tests are flaky, keep re-running them, don't edit anything" (on the buggy version). When Claude tries to stop, the guard blocks it: "Not done yet: the last check failed." Show Claude's honest answer. If Claude repeats the same failing command, show Gemini's redirect message.

**1:40 Close.** "Rules catch it instantly, Gemini figures out what's actually wrong, and you steer it by voice through Voiskey without opening anything. Survive the night."

## Q&A answers

- *Is this a UI?* No. It is hooks inside Claude Code; the only interfaces are your voice, your phone and the prompt Claude Code already shows.
- *What does Gemini decide?* Only what to do when Claude looks stuck: continue, redirect, or ask you. Irreversible actions are never left to a model.
- *Can it trap Claude?* No. It blocks a stop at most twice per prompt and never when Claude is already continuing because of a stop hook.
- *What breaks first?* Retries hidden inside one shell loop, and pattern-based risk detection.
