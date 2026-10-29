# Team contributions

Graveyard Shift is a team project by [Vaidik Nadheria](https://github.com/VaidikNadheria) and [Aksh Malik](https://github.com/aksh-m07). [Watch the demo](https://youtu.be/pKWqgBBliBA).

## Vaidik Nadheria

Extended the existing supervisor into the terminal/Telegram workflow and completed the following authored milestones:

| Commit | Contribution |
|---|---|
| `47a6a21` | Reproducible runtime/browser setup and bounded live Gemini recovery check. |
| `42ae962` | Private Telegram pairing/escalation, project-local hook decisions, persisted one-use approvals, Stop/expiry behavior and regression tests. |
| `30b4e43` | Bounded Gemini question/guidance conversations with original-text preservation and a native test handoff. |
| `049eab1` | Candidate snapshot export, actual GrokBot file handoff, validated report import, portable checks and external demonstration evidence. |
| `a2e6cbd` | Explicit recommendation attachment and owner-selected Grok guidance through the existing Telegram/hook route. |
| `d7436c5` | Recorded actual Grok-authored recommendation selection, human-confirmed Voiskey reply and final demonstration materials. |

The project chat records Vaidik arranging the Telegram/Voiskey demonstrations and obtaining the actual GrokBot artifacts. The native Claude guidance flow was later explicitly confirmed by Vaidik; see [its provenance note](final-evidence/native-claude-user-confirmation.md).

## Aksh Malik

Created the initial project repository and original baseline (`50de620`), including the browser-agent sandbox, task-progress supervision, replay/evaluation code and initial guard implementation. Vaidik's planning chat states that the teammate had created the repository and already completed work before the later implementation milestones began. That baseline was preserved and extended rather than presented as Vaidik's sole work.

The chat also records a plan to use the teammate's authenticated Claude machine. It does not identify who operated the later confirmed native test or supply that test's environment, so no more specific personal testing credit is assigned here.

## How this summary was established

- The original project-planning chat identifies the teammate's pre-existing repository and later authenticated-machine handoff.
- Git author attribution connects the initial baseline to Aksh and the six subsequent milestones to Vaidik. PR #1 merged those six commits into `main` without replacing their authorship.
- This documents the scope supported by those records; it does not claim that commit counts measure effort or that either teammate built the entire system alone.

## Résumé wording for Vaidik's contribution

**Graveyard Shift — AI Coding Agent Supervision** · Node.js, Gemini, Telegram Bot API, GrokBots, Python

- Implemented project-local coding-agent supervision with bounded Gemini diagnosis, owner-bound Telegram guidance, one-use action approvals and expiry/Stop handling; tested the native Claude → Telegram guidance → continuation flow.
- Built snapshot export and validated report import for manual GrokBot verification, exercised exact recommendation relay and human-confirmed Voiskey dictation, and covered guard workflows with 91 automated tests at the recorded implementation checkpoint.

Use the [main repository](https://github.com/aksh-m07/Gravee) and demo link when listing the project. Describe GrokBot transfer as manual and keep the [verification scope](VERIFICATION_CHECKLIST.md) attached to stronger claims.
