# Graveyard Shift

**A supervisor for coding agents, with evidence and human decisions delivered to Telegram.**

[Watch the demo](https://youtu.be/pKWqgBBliBA) · [Terminal setup](guard/README.md) · [Verification checklist](docs/VERIFICATION_CHECKLIST.md) · [Contributions](docs/PROJECT_CONTRIBUTIONS.md)

Graveyard Shift helps an owner step away from a coding task while keeping consequential decisions in their hands. Project-local Claude Code hooks detect repeated failures, loops and selected risky actions. Gemini diagnoses recorded failures; Telegram delivers the briefing and receives questions or guidance. The original conditions in the owner's reply are preserved. Consequential approval requires a separate, exact-action button that can be consumed once; silence leaves the action blocked.

## How the terminal workflow fits together

```text
Claude proposes a tool call → guard checks recorded events and policy
                                      ↓
                       bounded Gemini diagnosis when needed
                                      ↓
                  Telegram briefing → owner question / decision
                                      ↓
               original guidance returned through the waiting hook

Optional: exported candidate → actual GrokBot checks → imported evidence
                 (manual file handoff) → owner selects attached guidance
```

| Component | Role |
|---|---|
| Claude Code | Performs the coding task; project-local hooks can hold a proposed tool call. |
| Guard | Checks implemented policies, binds replies to the configured owner/action, and handles one-use approvals, Stop and expiry. |
| Google Gemini | Diagnoses recorded failures and supports bounded questions/guidance conversations. It cannot execute tools or grant approval. |
| Telegram | Shows the held action and evidence; receives the owner's question, guidance or explicit decision. |
| Voiskey | Dictates into Telegram's composer. The human inspects the text and presses Send; the backend receives text, not a Voiskey API call. |
| Actual GrokBots | Inspect exported source/tests on their own computer and return evidence and a recommendation through a manual handoff. The Telegram button selects existing guidance; it does not launch GrokBot. |

## Tested behavior and evidence

| Workflow | Status | Evidence |
|---|---|---|
| Native Claude → held action → Telegram guidance → Claude continuation | **Tested; user-confirmed** | [Confirmation recorded October 28](docs/final-evidence/native-claude-user-confirmation.md). The owner confirmed the original held action stayed blocked and Claude continued using the guidance. |
| Telegram questions, guidance, approval, Stop and expiry | **Exercised with explicit test callers** | [Checklist](docs/VERIFICATION_CHECKLIST.md) and committed hook/transport tests; these callers are distinct from native Claude. |
| Actual Voiskey reply | **Tested; human-confirmed input method** | [Received text and acknowledgment](docs/final-evidence/voiskey-reply-result.json); human confirmed dictation, inspection and manual Send. |
| Actual GrokBot acceptance checks | **Failed and passed fixtures verified** | [Exported requests, returned reports and command output](guard/evidence/grokbot-m4/README.md). |
| Grok-authored recommendation selected in Telegram | **Exact text returned once** | [Captured result](docs/final-evidence/grok-guidance-button-result.json); no approval consumed or held action executed in that synthetic test. |
| Automated guard regression suite | **91 tests passed at the October 24 checkpoint** | [Verification checklist](docs/VERIFICATION_CHECKLIST.md). This is a recorded implementation result, not continuous CI. |

The native Claude update is based on the owner's explicit confirmation; raw session logs, test date, machine and CLI version were not supplied. The earlier saved synthetic evidence remains unchanged. Native approval, Stop and hook-timeout cases need their own session evidence before being claimed as native-tested.

## Run and explore

Use Node **24.15.0** (`.nvmrc`). The terminal guard uses Node built-ins; the optional browser baseline has separate dependencies.

- [Terminal installation and private Telegram setup](guard/README.md)
- [Repeat the real Claude session checklist](guard/TEAMMATE_TEST.md)
- [Export/import and attach actual GrokBot guidance](guard/GROKBOT_TEST.md)
- [Demo commands](docs/DEMO_COMMANDS.md) and [two-minute walkthrough](docs/DEMO_2_MINUTES.md)
- [Demo video](https://youtu.be/pKWqgBBliBA)

Offline guard tests, from the repository root:

```bash
env -u GEMINI_API_KEY -u GOOGLE_API_KEY node --test guard/test/*.test.mjs
```

## Contributors

| Contributor | Contribution |
|---|---|
| [Vaidik Nadheria](https://github.com/VaidikNadheria) | Extended the supervisor with bounded Gemini diagnosis/conversations, private Telegram decisions, GrokBot export/import and guidance selection, reproducible setup, regression tests and demonstration documentation. Coordinated the recorded Telegram, GrokBot and Voiskey checks. |
| [Aksh Malik](https://github.com/aksh-m07) | Created the initial project repository and original browser-supervision/evaluation baseline that the terminal milestones build on. |

This is a team project. The [contribution summary](docs/PROJECT_CONTRIBUTIONS.md) ties this split to the project chat and authored Git history.

## Current limits

- GrokBot transfer is manual and currently uses a small Python acceptance-check profile. No automatic Grok execution API or general repair execution is claimed.
- Guidance relays instructions; it does not independently enforce every file restriction or approve the held action.
- The guard is project-local supervision, not secure shell containment or a universal process kill switch. Only one machine may consume updates for the same Telegram bot at a time.
- GrokBot's exact later integer-arithmetic repair has not received a new structured snapshot verification; its scratch-copy test report is a separate claim.
- The browser sandbox below is a scripted secondary baseline, not a production browser-agent benchmark. Model confidence is not calibrated, and no unattended endurance or comprehensive dollar-budget claim is made.

[Detailed verification](docs/VERIFICATION_CHECKLIST.md) distinguishes saved artifacts, synthetic tests and user-confirmed native results. [HACKATHON_STATE.md](HACKATHON_STATE.md) retains dated historical checkpoints; its newest entry supersedes older pending notes.

<details>
<summary>Secondary browser sandbox: architecture, setup and evaluation limits</summary>

## Browser sandbox baseline: how it works

```
agent proposes action ──► GoalGuard.review ──► ALLOW / BLOCK / RECOVER / ASK_HUMAN / STOP
                              │
   learned detector (kNN on screenshot features, fit on normal runs only)
   + no-progress detectors (loop, stuck, stalled requirement state)
   + hard policies (irreversible actions, premature "done" claims)  ← no model can override
                              │ only when something looks stuck
                              ▼
                     Gemini assessment (structured JSON, screenshot + goal + history)
                              │ proposes one recovery
                              ▼
        validateRecovery (allowlist, budgets) ─► executorAllows (independent check) ─► run ─► verify
```

* `web/lib/goal.ts` task as requirements (locate, price, record, verify), evidence extraction, verifiers. Never trusts the agent's own "done".
* `web/lib/gate.ts` learned normal-progress model (kNN) and no-progress detectors.
* `web/lib/guard.ts` the goal-aware guard and decision semantics. `web/lib/recovery.ts` recovery allowlist, validation, executor gate.
* `web/lib/assess.ts` the Gemini assessor (system prompt, schema, validation). `web/lib/gemini.ts` client with timeout, retry, cache.
* `web/lib/governor.ts` call budget, rate cap, circuit breaker. `web/sandbox/` the browser sandbox, scripted agent and runner.

## Run the browser baseline

Use **Node 24.15.0 and npm 11.12.1** (the checked baseline; `.nvmrc` pins Node).
From the repository root, `nvm use` selects that version if you use nvm.

```bash
cd web
npm ci
npm run setup:browser
cp .env.example .env.local      # only if absent; edit secrets locally
npm run check                  # tests, generated route types + TypeScript, lint
npm run smoke:task             # one normal scripted browser task; no API calls
npm run build
npm start -- --hostname 127.0.0.1 --port 3222
```

Open **http://127.0.0.1:3222/chat**. Use the **scripted** agent, guard on, no fault,
and “Find the price of the Mechanical Keyboard and record it in the PriceLog sheet. Do not buy anything.”
This is a real browser operating the project's simulated shop, with completion checked
against its recorded sheet. It does not establish general browser-agent reliability.
For development, use `npm run dev -- --hostname 127.0.0.1 --port 3222` instead.

The baseline needs no secret. For one live Gemini diagnosis/recovery smoke check,
set `GEMINI_API_KEY` in the shell or ignored `web/.env.local`, and select a model ID
available to your key:

```bash
npm run smoke:task -- --gemini --model YOUR_AVAILABLE_GEMINI_MODEL_ID
```

This uses the existing assessment prompt/schema, guard, recovery executor and result
verifier on one validation price-wall scenario. It permits **one actual generation
attempt**, a 30-second timeout, at most 1,536 output tokens, no SDK retries, no fallback
models and no response cache. It requests minimal thinking; use a model supporting it
(such as `gemini-3.6-flash`, verified against the model API and
[official thinking guide](https://ai.google.dev/gemini-api/docs/thinking)). It prints the returned model and observed result, and
fails unless Gemini recovery executes and the correct price is recorded with zero orders.
That cap applies to this smoke command only; the app's other model paths retain their
existing retry behavior. No notification is sent by this command. Leave `IMESSAGE_TO`
unset during local baseline work. See [`web/.env.example`](web/.env.example) for optional settings.

Optional recorded evaluation (separate from the baseline smoke; preserve the held-out
test split until the assessment prompt is frozen):

```bash
npx tsx scripts/gen-episodes.mts                       # older recorded-episode set (optional)
npx tsx scripts/eval-goal.mts val  --modes unguarded,heuristic,guard_det,guard_gemini
```

## Honest limits

* The agent in the evaluation is a **scripted** stand-in with deterministic failure habits, running in a sandbox world written for this project. Results are not production benchmarks.
* Requirements and verifiers are hand-written for one task type.
* The rule-based baseline's pop-up lexicon deliberately lacks the label used by one scenario, so that scenario measures generalisation to unseen labels.
* Gemini's self-reported confidence is shown but never used as a probability.
* The public-dataset check (UCSD Ped2) is a sanity check on the detector, not a state-of-the-art claim. Dataset: Mahadevan et al., CVPR 2010.

</details>
