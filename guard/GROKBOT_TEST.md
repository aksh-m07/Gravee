# GrokBot verification worker (manual file handoff)

This optional stage exports a small candidate, asks an **actual GrokBot with its own computer** to run acceptance checks, and imports evidence associated with that snapshot. It does not use the xAI model API. It does not intercept every Claude completion or grant action approval. Gemini diagnosis and Telegram decision handling are unchanged.

Use Node 24.15.0 locally. Export uses the system `zip` utility. The verifier needs Python 3 standard library, no packages. Open the official [Grok Bot setup](https://docs.x.ai/grok-bot/get-started), sign in yourself, and confirm terminal/file access. Access eligibility must be checked in your own account; no purchase or trial redemption is automated.

## Export the deliberately defective fixture

From the repository root:

```bash
node guard/verification.mjs export --project guard/verification-demo --spec guard/verification-demo/task.json
```

The command prints a fresh request ID, SHA-256 candidate digest, and absolute package/instruction paths. Files are private and ignored under `guard/.state/verification/REQUEST_ID/`:

- `request.json`: stored task, criteria, base commit where available, file-content manifest, selected source/tests, permitted check.
- `handoff/request.json`, `handoff/verify-request.py`, `handoff/INSTRUCTIONS.md`: transfer contents.
- `grokbot-request.zip`: those three files only, with fixed safe archive names.
- `status.json`: application status, separate from imported external evidence.

The allowlist in `task.json` selects only `price.py` and `test_price.py`. This is a **deliberately defective Python fixture derived from the small terminal discount example; it is not Claude-produced work**. Never package the repository, environment, Git directory, local bot state or dependencies. Export rejects unsafe paths, symlinks, common secret/configuration names, non-text/oversized files and recognized credential content. Review selected files yourself too; redaction is not a universal secret detector. No credentials are required on GrokBot.

For another candidate, supply its directory and an explicit small spec with task, acceptanceCriteria, files, and checks. This MVP intentionally supports exactly `[{"id":"acceptance","command":["python3","-m","unittest","-v","test_price.py"]}]`. It does not implement arbitrary execution plans.

## Actual GrokBot task

Attach the ZIP to your actual Bot. Paste:

> Independently verify the attached Graveyard Shift package on your own computer. Read INSTRUCTIONS.md, inspect the source/tests and helper, then in a disposable directory run `python3 verify-request.py request.json result`. Do not edit the candidate or tests. Return `result/report.json` and `result/acceptance-output.txt` as downloadable files, with actual command output and exit status. Report setup failure as inconclusive. Separate observations from hypotheses. No purchases, deployments, pushes, external messages or account connections.

The helper verifies the content manifest, extracts safe explicitly named text files into a new temporary directory, runs the one allowed check with a 30-second bound, captures output/status and rechecks source/test hashes. It removes the disposable candidate afterward. It does **not** provide OS-level containment or network isolation: inspect the tiny code first and use the Bot's disposable copy. It does not send notifications.

Keep the Bot conversation showing the task, command and artifacts. Download the returned report and command-output artifact. That UI observation, or a human attestation, is how provenance is recorded. A matching digest associates the report with a candidate; it cannot prove execution or authenticate the remote machine.

## Import, inspect, optionally notify

Replace REQUEST_ID and the report path with the actual values printed/downloaded:

```bash
node guard/verification.mjs import --id REQUEST_ID --report /absolute/path/to/report.json --provenance operator_observed_grokbot
node guard/verification.mjs status --id REQUEST_ID
```

Use `operator_observed_grokbot` only after observing the actual Bot interaction and returned artifacts. `user_attested_grokbot` records a human's statement, while the default `manual_unverified` makes no GrokBot provenance claim. These are local attestations, not signatures. Preserve the downloaded companion output alongside the report; the report also contains the captured output.

States: `awaiting_external_verification` → `passed`, `failed`, or `inconclusive`; pending requests can also become `expired` (24 hours) or `cancelled`. Only `passed` is complete for the matching exported snapshot. Source edits after export require a **new request**; old results never establish the current working tree's correctness.

Original JSON is saved verbatim as `original-report.json`; extracted evidence is stored as `evidence.json`. `status.json` contains the independently validated state and report digest. Imports validate required fields, request/digest binding, exact check identifiers/command, actual-looking unittest output, exit/status consistency, unchanged-candidate assertion, and overall result. Wrong snapshots, duplicate/expired/cancelled imports, missing evidence and contradictory success are rejected. Reports are untrusted assertions: no commands, paths, links or code in them are executed. An import lock plus exclusive original write fails closed across concurrent imports/crashes; an abandoned lock requires local inspection, not automatic replay.

Only when the owner explicitly asks to send this result:

```bash
node guard/verification.mjs notify --id REQUEST_ID
```

This reuses the paired private Telegram transport, includes evidence and the next decision, and creates **no approval**. It sends only; it never starts `getUpdates`, competes for the existing consumer, calls Gemini or resumes Claude. Export/import/status/cancel are entirely offline.

```bash
node guard/verification.mjs cancel --id REQUEST_ID
env -u GEMINI_API_KEY -u GOOGLE_API_KEY node --test guard/test/verification.test.mjs
```

The tests run the helper locally against both defective and corrected temporary candidates and reject tampered content. Those are explicitly **local regression checks, not GrokBot evidence**. A corrected external demonstration requires a separate exported snapshot and actual Bot execution. Native guidance continuation is now user-confirmed, and actual Voiskey use has a saved human-confirmed Telegram reply. Those separate results are documented in [the current checklist](../docs/VERIFICATION_CHECKLIST.md); they are not inferred from local helper tests.

## Attach findings and owner-selectable guidance to an existing decision

While the existing synchronous hook is waiting, run from the repository root (replace `PENDING_DECISION_ID`):

```bash
node guard/verification.mjs attach --id 5a1a1bc4f71774af6267428db6fa93dd --decision PENDING_DECISION_ID --guidance-file guard/verification-demo/guidance-test.txt --source test_text
```

This fixture command assumes the original demonstration request has already been imported on this machine. On a fresh clone, use the fresh request ID from your own export/import instead; the historical request cannot be re-imported after expiry. The command sends imported GrokBot **test findings**, paired with an explicitly labelled **TEST recommendation, not Grok-authored**. It does not invoke GrokBot. For a real recommendation, manually obtain and save GrokBot's explicit response as a UTF-8 text file, then use `--guidance-file /absolute/path/recommendation.txt --source captured_grokbot_artifact`. The source label is an operator attestation, not authenticated authorship. Use `operator_entered` for your own recommendation. Do not infer a repair merely because tests failed.

Omit `--guidance-file` for findings only; no Use action appears. Guidance is limited to 1,000 characters. Empty, oversized, or recognized secret-bearing text is rejected, never silently shortened. Telegram shows the **entire exact recommendation**; only findings/output excerpts are abbreviated, with full imported evidence retained locally.

`attach` sends one message and registers its ID, private owner/chat, decision/session/action fingerprint/deadline, imported request/report digest, candidate digest, exact guidance and source in a separate private attachment record. It never starts an update consumer or extends expiry. Exactly one attachment is permitted per decision; uncertain delivery is not automatically retried. The existing waiting hook handles the registered buttons:

- **Use Grok’s guidance:** revalidate, reserve once, acknowledge the exact recommendation, check for Stop/Reject, and resolve the existing `guidance` status. The existing hook returns it verbatim in a blocked-tool explanation. No approval, downloaded patch, command or link executes.
- **Keep paused:** hold the action and preserve the original deadline.
- **Stop task:** existing supported turn-stop behavior; no operating-system process-kill claim.

Wrong owner/chat/message/attachment/decision, modified binding/report, cancelled/consumed/expired state and duplicate clicks cannot relay. Stop/Reject takes priority in the received batch and in the same consumer's control checks before/after acknowledgment. Buttons are removed when the waiter exits where Telegram delivery succeeds; authoritative state still rejects stale buttons if that display update fails.

For finished/expired decisions, attaching sends **information only**, without actionable buttons, and explains that a fresh supported Claude continuation and explicit new attachment are required. There is no resume API, deadline extension, old approval reuse or automatic reattachment. GrokBot investigation can exceed the two-minute hook window; gather its recommendation first, then start a fresh decision if needed.

Live transport-only demonstration:

```bash
node guard/smoke-grok-guidance.mjs
```

The already paired owner taps Use once. This creates a clearly labelled synthetic two-minute decision using actual imported fixture findings and the test recommendation. It never executes the proposed action, runs Claude, invokes GrokBot or calls Gemini. It holds the existing single-consumer lock. Do not run it alongside another waiting hook or poller. The successful October 24 test is recorded in `guard/evidence/grok-guidance-live.json`; this proves neither real Grok-authored guidance nor Claude/Voiskey continuation.
