# Observed verification and remaining limits

Updated October 28, 2026. [Demo video](https://youtu.be/pKWqgBBliBA). Saved October 24 artifacts retain their original provenance; the later native result is a separate owner confirmation.

## Tested behavior and evidence

- **Native Claude guidance flow: tested, user-confirmed.** On October 28 the owner explicitly confirmed that a real Claude session held the original action, received Telegram guidance, and continued using it while the original action stayed blocked. [Confirmation and scope](final-evidence/native-claude-user-confirmation.md). The actual test date, host, CLI version and raw native transcript were not supplied; this does not certify all native Stop/approval/timeout cases.

- Existing private Telegram pairing, exact-action one-use approval against a fake local remote, Stop, rejection and expiry through explicit test callers.
- Existing live Gemini diagnosis and typed question → guidance conversation using synthetic evidence. Earlier milestones record models and request counts.
- Actual GrokBot app ran prescribed acceptance checks: defective fixture failed (2/3), separately supplied locally corrected fixture passed (3/3). Exact imported reports and artifacts remain in `guard/evidence/grokbot-m4/`.
- Actual GrokBot authored `guidance.txt` (1,878 characters) at 3:27:43 PM Pacific. Downloaded unchanged and inspected as text. The file was not executed.
- Actual GrokBot authored the 769-character `guidance-short.txt` at 3:29:47 PM after the human requested a transport-sized version preserving restrictions. Human saved it; its bytes were copied unchanged. The longer original is preserved separately. See `final-evidence/provenance.json` for hashes and provenance limits.
- Separate real Telegram reply, decision `48774d2831d5c349`: “Use a new branch instead, and keep the test unchanged”. Acknowledgment preserved that exact text, status guidance, no approval consumed or action executed. One live Gemini interpretation request. The human explicitly confirmed actual Voiskey, inspected text and pressed Send. This is human-attested input method, not backend detection. Evidence: `final-evidence/voiskey-reply-result.json`.
- Previous implementation check: 91 guard tests passed, zero failed. Broad tests were not rerun during this final documentation/verification pass. No application changes were needed.
- **Actual Grok-authored Telegram button PASSED:** fresh synthetic decision `43e584ddc434c7ef`, bound to imported failed snapshot `5a1a1bc4f71774af6267428db6fa93dd`. Source `captured_grokbot_artifact`. The owner selected the real button; all 769 characters returned byte-for-byte once, including restrictions and limitations. Approval consumed false; action executed false. Evidence: `final-evidence/grok-guidance-button-result.json`. This was an explicit synthetic caller, not native Claude.

## Unverified / pending

- Raw native Claude session evidence and environment details; the basic guidance flow is user-confirmed, while native Stop, exact-action approval and hook-timeout cases remain outside that confirmation.
- A new structured verification request/report for the exact integer-arithmetic repair GrokBot recommended. The Bot reports a scratch-copy test, which is a distinct claim from the prior imported passing snapshot using `round(...)`.

## Scope limits

- Manual file upload/download and explicit attachment; no Grok execution API or automatic Grok invocation from Telegram.
- Guidance is inert text until a human-controlled coding agent chooses a next action. The test caller never executes the held action.
- Snapshot association and operator-observed artifact provenance are not signed proof of remote execution.
- Synthetic fixture artifacts do not prove native Claude behavior; the native guidance status comes from the separate owner confirmation. No costs, production correctness, deployment, external push or Devpost submission is inferred from the fixture demonstrations.
- Finished/expired decisions cannot resume. Start a fresh supported continuation and explicitly reattach; only one bot update consumer can run at a time.
