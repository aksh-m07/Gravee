# Two-minute recording sequence

[Recorded demo](https://youtu.be/pKWqgBBliBA). Updated October 28: native guidance continuation is now user-confirmed; the original saved transport callers remain synthetic.

Use the existing branch. Prepare windows and downloaded evidence first. Do not expose `.env.local`, private Telegram IDs, terminal environment output, or unrelated chats. Both live test callers use the same bot, so run them **sequentially**. Start each fresh two-minute decision only when its screen is needed.

| Time | Show | Say |
|---|---|---|
| 0:00–0:15 | Terminal guard overview | “Graveyard Shift holds a coding agent's next action when it detects trouble. Gemini diagnoses failures; the owner can ask questions and return guidance in Telegram.” |
| 0:15–0:35 | Actual GrokBot app, failed/passed report artifacts and guidance.txt | “An actual GrokBot ran acceptance checks on its own computer through a manual file handoff. These explicit fixtures failed, then passed after a local correction. GrokBot also authored this repair recommendation; it reports scratch testing, with limitations.” |
| 0:35–1:05 | Fresh synthetic decision and the real Use Grok’s guidance button | Start the prepared button caller, read the full recommendation, and tap Use once. “This selects instructions; it does not approve the held push or apply a patch.” Show exact-match/once/no-execution output. |
| 1:05–1:40 | Separate Telegram guidance-only test | Start `node guard/telegram.mjs test`. Tap Ask or give guidance. Activate actual Voiskey, dictate “Use a new branch instead, and keep the test unchanged”, inspect it and press Send yourself. Show unchanged acknowledgment. |
| 1:40–2:00 | Verification checklist and captured evidence | “Actual Telegram, GrokBot artifact handoff and human-confirmed Voiskey dictation were exercised. These terminal callers are synthetic. The owner also confirmed native Claude guidance continuation; raw session logs have not been supplied. No purchases, deployment or real remote push occurred.” |

If a live test stalls, show its saved observed result, label it as recorded evidence, and continue recording. Do not extend deadlines, revive old decisions or spend recording time debugging. No need to show the secondary web app or rebuild it.

Commands and safe local replay are in [DEMO_COMMANDS.md](DEMO_COMMANDS.md). Current facts are in [VERIFICATION_CHECKLIST.md](VERIFICATION_CHECKLIST.md). Paste-ready submission copy is in [DEVPOST_DESCRIPTION.md](DEVPOST_DESCRIPTION.md).
