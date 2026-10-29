# Exact local launch and demonstration commands

Repository:

```bash
cd /Users/vaidiknadheria/Documents/Codex/2026-10-24/b/Gravee
node --version
```

Use the existing Node 24.15.0 runtime. Do not reinstall dependencies or rerun unrelated builds. The optional secondary browser baseline uses `http://127.0.0.1:3222/chat` after launch; follow the setup in `web/README.md`. Its current running state is not asserted here.

## Real Telegram, actual Grok-authored guidance, synthetic decision

The prepared local verification caller is ignored and is **not included in a fresh clone**. It creates a fresh synthetic decision using existing APIs, but depends on the original machine's already-imported October 24 verification state. The committed `guard/smoke-grok-guidance.mjs` also references a historical imported request and uses explicitly labelled **test text**; it is not a fresh-clone shortcut for actual Grok guidance.

For a fresh clone, first configure the private owner, then follow [GROKBOT_TEST.md](../guard/GROKBOT_TEST.md) to export a new candidate, obtain a real GrokBot report, and import it with the fresh request ID. Attach that result and the captured recommendation to a new waiting native decision. Replace the historical verification ID in the command below with your new ID. Expired requests cannot be imported again. The original recorded evidence remains under `docs/final-evidence/`.

On the original prepared machine, this local caller never executes a held action or downloaded text:

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

The owner confirmed native held-action blocking, Telegram guidance and Claude continuation. See `docs/final-evidence/native-claude-user-confirmation.md` for provenance. Use `guard/TEAMMATE_TEST.md` on an authenticated machine to repeat the test and collect detailed evidence. Never share credentials, and confirm the previous Telegram consumer has ended before another machine starts one. This documentation update does not authenticate Claude or launch a session.

Record and submit manually. These commands do not deploy, merge, publish or submit Devpost.
