# Graveyard Shift

**The night guard that knows when your AI agent has stopped making progress.**

Autonomous browser agents can keep clicking, searching and retrying while accomplishing nothing, and each action looks valid on its own. Graveyard Shift keeps the *task* in view: it tracks verifiable requirements, intercepts the next action before it runs, uses Gemini to diagnose a stall and propose a safe recovery, validates that proposal against hard policies, and then checks whether the recovery actually worked.

> Status and caveats are tracked in [`HACKATHON_STATE.md`](HACKATHON_STATE.md). Everything below is labelled built, partial or not run.

## How it works

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

## Run it

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
