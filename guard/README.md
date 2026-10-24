# Graveyard Shift: Claude Code terminal guard

The primary product is supervision of Claude Code on a coding project. Existing tool-event hooks detect repeated failures, loops and unverified completion. Gemini diagnoses a detected failure and can redirect the agent. Decisions needing the owner go to one private Telegram account while the synchronous hook holds the exact tool call.

**Current verification:** live private Telegram delivery/replies, one-use approval to a fake local Git remote, Stop and silence were exercised through an explicit hook test caller. One real Gemini diagnosis ran through the hook using synthetic events. **An authenticated Claude Code session has not been tested on this Mac:** Claude Code 2.1.310 is installed locally but reports `Not logged in`; the user does not have a Claude subscription. A real two-turn typed Telegram conversation passed with two Gemini requests using `gemini-3.6-flash`, synthetic evidence and an explicit caller. Original multi-clause guidance was preserved. Actual Voiskey use is not verified. The installed unauthenticated CLI did load UserPromptSubmit and blocked a new prompt for the stopped test session with zero API requests; that does not verify native PreToolUse execution or continuation. Do not describe the hook test caller as Claude Code.

## Local setup

Optional external acceptance verification: [GROKBOT_TEST.md](GROKBOT_TEST.md) documents candidate export, actual GrokBot execution, validated report import and an explicitly requested private Telegram result briefing. This stage never grants approval or automatically intercepts Claude completion.

Its `attach` command can also link imported findings and an explicitly sourced recommendation to a current held decision. Telegram's **Use Grok’s guidance** returns the displayed recommendation through the existing blocked-tool guidance route. Manual GrokBot handoff remains manual; finished decisions are information only. The live button was exercised with clearly labelled test guidance, not a Grok-authored repair.

Use Node 24.15.0 (repository `.nvmrc`). Claude Code **2.1.295 or newer is required** for the `onFailure: "block"` timeout protection; the inspected local version is 2.1.310. See [official hook documentation](https://code.claude.com/docs/en/hooks).

From the repository root:

```bash
mkdir -p demo-project/cli
npm install --prefix demo-project/cli @anthropic-ai/claude-code@2.1.310 --no-audit --no-fund
bash guard/make-demo.sh
node guard/telegram.mjs status
```

The CLI and demo are under the ignored `demo-project/` directory. `make-demo.sh` creates `demo-project/session` only if absent. It preserves an existing demo and its configuration. The fake remote is the local bare repository `demo-project/local-remote.git`, using the `demo-result` branch. It is not GitHub or main.

Hooks are installed only in the demo's `.claude/settings.local.json`. Existing unrelated settings/hooks are preserved; repeated installs are idempotent and replacements are backed up. **No global hooks are installed.** For another explicitly chosen disposable project:

```bash
node guard/install.mjs --project /absolute/path/to/disposable-project
node guard/install.mjs --project /absolute/path/to/disposable-project --remove
```

Restart Claude after hook changes. Do not launch with `--bare` or `--safe-mode`: those modes disable hooks. Do not bypass permissions for this demo.

An authorized Claude subscription, Console API account, or supported provider is needed for a real session. On an authorized machine:

```bash
demo-project/cli/node_modules/.bin/claude auth login
demo-project/cli/node_modules/.bin/claude auth status
cd demo-project/session
../cli/node_modules/.bin/claude
```

An API key is an alternative where authorized; configure it locally using Claude's official authentication instructions. Never paste someone else's credentials into chat. If using a friend's already-authenticated machine, run these project-local setup steps there; this Mac's test results do not establish that machine's integration.

## Telegram owner pairing

1. Create a dedicated bot through [BotFather](https://t.me/BotFather) using `/newbot`, then open your bot's private chat and press Start.
2. Copy `guard/.env.example` to `guard/.env.local` **only if that file does not already exist**. Enter `TELEGRAM_BOT_TOKEN` locally. Do not print or commit it. The real file and `guard/.state/` are ignored.
3. Run `node guard/telegram.mjs pair`. Send the displayed `/start CODE` in your own private bot chat within three minutes.
4. Pairing accepts only that random one-time code, requires the sender to own the private chat, and saves owner/chat IDs locally. It never selects an arbitrary incoming user. A confirmation is sent to that owner. Existing paired owners are preserved.
5. `node guard/telegram.mjs status` reports configuration and the latest decision's effective state, expiry and consumption status without showing tokens. A bot with an existing webhook is not modified: use a dedicated bot instead.

Only one `getUpdates` consumer runs across pairing, hooks and transport tests, using a process lock under the shared state directory. Do not run an unrelated poller against this bot, or set different `GRAVEYARD_HOME` directories for concurrent consumers of the same bot. This MVP covers one owner, one active decision and one demo session.

The terminal hook has no voice, iMessage or phone notification imports. Those legacy helpers remain in the repository but are not used by this terminal flow. No other channel is introduced.

## What the owner sees and how to answer

Telegram shows the task, held action, reason, recent failure evidence, previous supervisor interventions, a specific question, options, a decision ID and the silence default. Known secrets are redacted. No full source files are attached. Remote approval is disabled when a Bash command cannot be shown completely and without redaction, and for non-Bash actions whose complete edit cannot be safely shown.

- **Ask or give guidance:** opens Telegram's reply composer. Dictate with Voiskey or type, then explicitly press Send. The backend receives the text Telegram sends; no Voiskey API or transcription service is used. Replies must target this decision's bot message. Unrelated chat text is ignored.
- **Conditions:** `Yes if the tests pass`, `Use a new branch instead`, and `Use the newer file but preserve the original` become verbatim blocked-tool guidance, never approval. No condition is converted into an automated permission to execute later.
- **Ambiguity:** free-form `yes` never approves. The bot asks one short clarification and holds the action under the original absolute deadline. Opening the guidance composer does not use up that clarification.
- **Approve this action once:** only the inline button can approve. The owner, private chat, message, session, decision and SHA-256 fingerprint of the complete tool input/cwd must match. The approval is persisted as consumed before the hook returns `allow`, and cannot be reused. Expiry and fingerprint are rechecked after the final network wait; a consumed approval that fails that check stays spent and does not authorize execution.
- **Reject action:** denies the shown tool call. No alternative consequential action is authorized by that rejection.
- **Stop task:** persists a separate session veto, denies the held action and returns `continue: false`. Later tool calls in that same session are blocked. A new user prompt beginning `Resume` deliberately clears that veto. This ends a Claude turn; it does not kill the OS process, cancel actions already dispatched, or stop every other Claude session.

When Stop/rejection and approval are already in the same received update batch, Stop/rejection wins, regardless of ordering. Guidance also wins over approval in that batch, preserving conditions. Controls arriving after an approval has been consumed cannot revoke an already dispatched action.

## Bounded questions and guidance

While one action is held, the owner can ask a question before sending guidance. The same Telegram consumer and decision binding handle both. A question is recorded without resolving/consuming the decision; the next reply still targets that same action.

Gemini returns a strict `question`, `guidance` or `clarify` structure. It cannot approve or dispatch tools. For questions it selects IDs from a sanitized, stored evidence snapshot (task, recent tool results/failures, proposed action, supervisor interventions and verification/edit-event coverage). The phone answer quotes only those selected facts. Missing evidence is admitted; the absence of edit events is explicitly **not proof that files are unchanged**, and no independent filesystem diff or Claude cost ledger is claimed.

For high-confidence guidance, the acknowledgment quotes the original human text rather than substituting a model paraphrase. The original instructions remain authoritative in Claude's blocked-tool explanation, including negations, conditions, rejected approaches and file restrictions. This is instruction relay, **not independent enforcement of every restriction**. A question that the model misclassifies as guidance receives a clarification instead of releasing the hold.

Defaults are **three user text turns and two actual conversational Gemini requests** per decision, no retries/fallbacks. Opening the composer is not a user text turn. One ambiguity/conflict clarification is allowed. Diagnosis requests retain their separate bounded path, but both diagnosis and conversation dispatches count against the persisted 12-request supervisor session cap. Every conversational attempt is reserved before sending and the same 1,536-token/minimal-thinking settings are reused.

The original absolute decision deadline never restarts after an answer. Model unavailability, malformed output, missing credentials, exhausted conversation budget, delivery failure, unresolved interpretation or expiry blocks the action and ends the turn using the existing hook mechanism. Stop/Reject/approval controls bypass Gemini; authorized Stop/Reject received during interpretation or acknowledgment are checked by the same consumer before guidance is relayed. These controls cannot revoke an already dispatched action.

```bash
env -u GEMINI_API_KEY -u GOOGLE_API_KEY node --test guard/test/*.test.mjs
node guard/smoke-conversation.mjs
```

The live smoke command uses **synthetic hook evidence**, real Telegram/Gemini and an explicit test caller. No Claude session or tool runs. First ask a question; after its answer, reply with one complete multi-clause instruction. Use actual Voiskey's configured keyboard/dictation control if available, inspect the result and press Send manually. The backend cannot identify which input method produced the text; typed fallback is recorded separately. A failed/expired manual test is not a completed conversation.

For an authenticated teammate's safe worktree, single-machine bot handoff, local hooks, real coding task and cleanup, use [TEAMMATE_TEST.md](TEAMMATE_TEST.md). Do not run a separate Telegram polling worker alongside Claude: the synchronous hook is its only consumer while waiting. Local locks do not coordinate different machines.

## Hold, timeout and restart limits

`PreToolUse` is a synchronous supported hook. While it runs, the proposed tool call has not received an allow result. Guidance/rejection return `permissionDecision: "deny"` with an explanation Claude can use to choose its next step. Explicit approval returns `allow` for that exact call. Stop/failure/silence return both `deny` and `continue: false`.

Installed PreToolUse timeout is **180 seconds**, with `onFailure: "block"`. Internal bounds are: Gemini total assessment deadline at most 20 seconds (12 seconds by default), Telegram decision lifetime at most 120 seconds including delivery/clarification, and original decision status edits at most 4 seconds total (3 seconds normally, plus a 1-second correction if final approval validation fails). Closing an optional Grok guidance attachment adds at most 3 seconds; it cannot extend the decision expiry. No detached reply process is used. A missing/broken/killed hook is blocked by Claude's configured failure behavior on supported versions. Native timeout behavior still needs an authenticated Claude session test on this Mac.

Silence, notification failure and transport failure invalidate the decision and stop the turn; the held action is not authorized. The Telegram message is updated with the final status and buttons removed when possible. A failed final status edit cannot authorize an action. If disconnected, inspect local `status` to resolve stale visible buttons.

There is **no terminal resume API**. Timely guidance reaches the currently waiting hook. An expired or interrupted decision cannot be resumed by a late Telegram reply. Issue a new prompt in Claude and create a new decision if necessary. Native `ask` is intentionally not used as a silent fallback; this milestone chooses a blocking stop instead. Native `ask` and actual Claude timeout/Stop/allow handling remain unverified without login.

State uses atomic private JSON files under `guard/.state/`: session history, actual Gemini attempt reservations, decisions, original/interpreted replies, expiry, notification state and one-use consumption. A new consumer invalidates uncertain pending/approved decisions after interruption rather than replaying them. A lock with unknown ownership requires local inspection rather than being stolen. This is not a durable distributed worker or proof of multi-hour reliability.

## Gemini diagnosis

The hook reuses the existing terminal assessor and cheap detectors. Gemini only judges after a loop/failure signal; deterministic risky-action rules still run first. The default is `gemini-3.6-flash`, one actual request attempt, a 12-second total deadline, 1,536 output tokens and minimal thinking. Requests use the official [Gemini API](https://ai.google.dev/gemini-api/docs/text-generation) with no SDK/HTTP retries.

The optional comma-separated model list is constrained by `GRAVEYARD_GEMINI_MAX_ATTEMPTS` (maximum two, default one), and all fallback attempts share the total deadline. Each actual dispatch is reserved in the persisted session counter before sending; the session cap is 12 supervisor requests. The returned `modelVersion` is recorded when present. These are **request caps, not dollar budgets**, and do not limit Claude Code's own requests or the separate web application's model paths.

Credentials come from the environment, ignored `guard/.env.local`, or the existing ignored `web/.env.local`. Never print them. Test the live terminal-guard assessor with:

```bash
node guard/smoke-gemini.mjs
```

This feeds synthetic repeated-failure events through the real hook and permits one actual Gemini request. It disables Telegram for that isolated check. Its output explicitly identifies that it is not an authenticated Claude session.

## Checks and manual demonstrations

```bash
env -u GEMINI_API_KEY -u GOOGLE_API_KEY node --test guard/test/*.test.mjs
node guard/telegram.mjs test
```

The second command sends a guidance-only transport test. It cannot execute an action. To verify Voiskey, use actual Voiskey dictation in the Telegram reply composer, press Send, and record that input method separately from typed text.

These commands use the real hook and Telegram with an **explicit local test caller**, not Claude Code. Only the `approve` case can execute anything, and it rechecks that the remote is exactly the local fake remote before dispatch:

```bash
node guard/smoke-escalation.mjs guidance
node guard/smoke-escalation.mjs approve
node guard/smoke-escalation.mjs deny
node guard/smoke-escalation.mjs stop
node guard/smoke-escalation.mjs timeout
```

Run them one at a time. Follow the printed Telegram instruction. Timeout requires no reply and expires in eight seconds. The caller checks execution/non-execution and saved state; approval reuse is rejected. A successful harness test does not establish that Claude consumed the hook output.

On an authenticated machine, use the demo project with a real Claude session to verify these independently:

1. Ask Claude to run `npm test` twice as separate tool calls, then try again; authorize it to follow guard guidance and fix the discount formula. Confirm Gemini's diagnosis and Claude's changed next action.
2. Request `git push --force origin demo-result` to the local remote. Reply with conditional guidance, then separately test Reject, Stop, silence and the explicit approval button.
3. For a non-execution marker, append `&& printf executed > held-action.log` to the **shown** local command and confirm that marker is absent on rejection/timeout. Do not use a real remote, main, destructive files or third-party messages.
4. Verify actual native hook timeout/failure behavior as well as the hook's own shorter decision deadline. Do not claim those outcomes until observed in Claude.

## Existing detection limits

Loop, failure, risk and completion checks are deterministic rules, not trained models. Repetition hidden inside one shell command and gaps in risky-command patterns remain. This guard is an advisory project-local integration, not a secure shell containment system; code with filesystem access can alter local configuration. The M1 browser application and verified simulated-shop baseline remain intact as a secondary demonstration.
