# Exact local launch and demonstration commands

Repository:

```bash
cd /Users/vaidiknadheria/Documents/Codex/2026-10-24/b/Gravee
node --version
```

Use the existing Node 24.15.0 runtime. Do not reinstall dependencies or rerun unrelated builds. The existing secondary browser app is at `http://127.0.0.1:3222/chat`; it is optional and already running from the earlier milestone.

## Real Telegram, actual Grok-authored guidance, synthetic decision

The prepared local verification caller is ignored, contains no secrets and uses existing application functions. It creates a fresh relevant synthetic held-push decision, invokes the supported attach CLI with `captured_grokbot_artifact`, waits on the existing single consumer and asserts exact guidance, once, no approval. It never runs the held action or downloaded text.

```bash
node guard/.state/final-grok-button.mjs
```

When its message arrives, read the complete recommendation and tap **Use Grok’s guidance** once. Do not run another Telegram test until this caller has ended. This local prepared caller is not a new product feature and is not shipped as a general agent runner.

Its exact attach operation (replace `FRESH_PENDING_DECISION_ID` only while that decision is actually waiting):

```bash
node guard/verification.mjs attach \
  --id 5a1a1bc4f71774af6267428db6fa93dd \
  --decision FRESH_PENDING_DECISION_ID \
  --guidance-file docs/final-evidence/guidance-short.txt \
  --source captured_grokbot_artifact
```

Do not reuse a prior decision ID. The original 1,878-character artifact exceeds the existing 1,000-character guidance limit, so it was preserved but not truncated or sent through that button. GrokBot authored the shorter artifact separately.

## Separate actual Voiskey reply

```bash
node guard/telegram.mjs test
```

Tap **Ask or give guidance**, activate your configured actual Voiskey shortcut/control, dictate, inspect and explicitly press Send. Confirm the input method yourself afterward. Text does not establish it. This command makes one Gemini interpretation for the reply and never executes an action. It has a fixed two-minute deadline.

## Recorded evidence, without starting another consumer

```bash
node guard/verification.mjs status --id 5a1a1bc4f71774af6267428db6fa93dd
node guard/verification.mjs status --id 7724c8820a072c78bf61bfabc3ed63f3
```

Open `docs/final-evidence/` for preserved recommendation files, provenance, exact returned text and final test outcomes. Keep `.env.local` and runtime decision files off screen.

## Native Claude

Use `guard/TEAMMATE_TEST.md` on the teammate's own authenticated machine. Do not retry authentication on this Mac or share credentials. Confirm this Mac's Telegram consumer has ended before the teammate starts one. No teammate message was sent by the agent.

Record and submit manually. These commands do not deploy, merge, publish or submit Devpost.
