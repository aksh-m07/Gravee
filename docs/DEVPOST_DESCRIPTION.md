# Graveyard Shift

Graveyard Shift is a supervisor for coding agents that holds a proposed action when it detects repeated failures, loops or a policy concern, then brings the owner enough evidence to choose the next step.

**Gemini** diagnoses recorded failures and supports a bounded Telegram conversation. The owner can ask what happened, inspect evidence gaps and send guidance whose original conditions are preserved. Consequential approval uses a separate exact-action button; guidance does not grant approval.

**Actual GrokBots** provide an optional independent verification step. Graveyard Shift exports selected source and acceptance tests with a content manifest. A GrokBot inspects and runs them on its own computer, returning structured evidence through a manual file handoff. Imported reports are validated against the request and snapshot. The owner can select an explicitly attached Grok-authored recommendation in Telegram. This returns instructions, not permission to execute a held action or apply downloaded code.

We exercised that real Telegram button with the actual Grok-authored artifact: the complete recommendation returned unchanged once, with no approval consumed or held action executed.

**Voiskey** lets the human dictate into Telegram, inspect the text and explicitly press Send. We exercised a separate real Telegram reply and the human confirmed using actual Voiskey. The backend receives text; it cannot identify the dictation application itself.

Demonstration scope: GrokBot checked explicit defective and locally corrected fixtures. Its later recommendation reports scratch-only repair testing; that exact repair has not received a new structured snapshot verification. Telegram guidance was exercised through synthetic callers. Project-local Claude hooks exist, but authenticated native Claude continuation remains pending on a teammate's machine. We do not claim unattended production reliability, a universal process kill switch, or automatic GrokBot invocation.
