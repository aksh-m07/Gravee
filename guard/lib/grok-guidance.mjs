import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readJson, writeJson, sessionStopFile } from "./decisions.mjs";
import { redact } from "./config.mjs";
import { VerificationStore } from "./verification.mjs";

const hash = (x) => crypto.createHash("sha256").update(x).digest("hex");
const binding = (d) => ({ decision: d.id, sid: d.sid, actionHash: d.actionHash, owner: d.owner, chat: d.chat, expiresAt: d.expiresAt });
const identity = (a) => hash(JSON.stringify({ binding: a.binding, request: a.request, candidateDigest: a.candidateDigest, reportSha256: a.reportSha256, guidance: a.guidance, source: a.source })).slice(0, 16);
const file = (store, id) => { store.file(id); return path.join(store.home, "grok-guidance", `${id}.json`); };

export function attachedGuidance(store, d) {
  try {
    const a = readJson(file(store, d.id));
    const current = store.validate(d.id, d);
    if (!a || !current || current.status !== "pending" || current.consumed || fs.existsSync(sessionStopFile(store.home, d.sid)) || JSON.stringify(binding(current)) !== JSON.stringify(a.binding) || identity(a) !== a.id || a.delivery !== "sent") return null;
    const v = new VerificationStore(store.home), s = v.status(a.request);
    const raw = fs.readFileSync(path.join(v.dir(a.request), "original-report.json"));
    if (!["passed", "failed", "inconclusive"].includes(s.status) || s.status !== JSON.parse(raw).result || s.provenance !== a.source.verificationProvenance || s.candidateDigest !== a.candidateDigest || s.reportSha256 !== a.reportSha256 || hash(raw) !== a.reportSha256) return null;
    return a;
  } catch { return null; }
}

export function claimAttachedGuidance(store, d, attachmentId) {
  const a = attachedGuidance(store, d);
  if (!a || a.id !== attachmentId || a.used || !a.guidance) return null;
  a.used = true; a.usedAt = Date.now(); writeJson(file(store, d.id), a); return a;
}

export async function attachGrokGuidance({ store, verificationId, decisionId, guidance = null, source = "operator_entered", config, api }) {
  if (!config || config.owner !== config.chat || !/^\d+$/.test(config.owner)) throw new Error("Paired private owner required");
  const d = store.get(decisionId);
  if (!d || d.owner !== config.owner || d.chat !== config.chat) throw new Error("Decision owner/chat mismatch");
  if (!["test_text", "operator_entered", "captured_grokbot_artifact"].includes(source)) throw new Error("Explicit guidance source required");
  if (guidance !== null && (typeof guidance !== "string" || !guidance.trim() || guidance.length > 1000 || redact(guidance) !== guidance)) throw new Error("Guidance must be 1–1000 characters with no recognized secrets; never silently truncated");
  const verifier = new VerificationStore(store.home), s = verifier.status(verificationId);
  if (!["passed", "failed", "inconclusive"].includes(s.status)) throw new Error("An imported verification result is required");
  const rawReport = fs.readFileSync(path.join(verifier.dir(verificationId), "original-report.json"));
  const report = JSON.parse(rawReport);
  if (hash(rawReport) !== s.reportSha256 || report.requestId !== verificationId || report.candidateDigest !== s.candidateDigest || report.result !== s.status) throw new Error("Imported report association changed");
  const a = { binding: binding(d), request: verificationId, candidateDigest: s.candidateDigest, reportSha256: s.reportSha256,
    guidance, source: { kind: source, verificationProvenance: s.provenance, note: "Operator-supplied source label; not authenticated remote authorship" }, used: false, delivery: "sending", messageId: null };
  a.id = identity(a);
  const current = store.validate(d.id, d);
  const pending = current?.status === "pending" && !current.consumed && !fs.existsSync(sessionStopFile(store.home, d.sid));
  const sourceLabel = { test_text: "TEST recommendation; NOT Grok-authored", operator_entered: "Operator-entered recommendation; NOT a captured Grok artifact", captured_grokbot_artifact: "Captured GrokBot artifact (operator attestation)" }[source];
  const text = redact(["GrokBot findings — manual imported result", `Decision: ${d.id}; verification: ${verificationId}`, `Snapshot: ${s.candidateDigest}`, `Result: ${s.status}; provenance: ${s.provenance}`,
    `Found: ${report.findings.join("; ").slice(0, 400)} [see stored report for full findings]`,
    `Tested: ${report.checks.map((c) => `${c.id}: ${c.status}, exit ${c.exitStatus ?? "unknown"}`).join("; ")}`,
    `Evidence excerpt: ${report.checks.map((c) => c.output).join("\n").slice(0, 350)}`,
    `Limitations: ${report.limitations.join("; ").slice(0, 350)}; snapshot association does not prove execution or repair correctness.`,
    `Recommendation source: ${sourceLabel}`, guidance === null ? "No recommendation attached. Findings only; guidance action unavailable." : `Exact recommendation to relay:\n${guidance}`,
    pending ? "Guidance blocks the held action; it grants no approval or patch application. Keep paused does not extend the original deadline." : "INFORMATION ONLY: decision expired/finished or unavailable. Start a fresh supported Claude continuation, then explicitly reattach and validate. This message cannot resume Claude.",
  ].join("\n\n"));
  if (text.length > 3600) throw new Error("Briefing too long; shorten guidance explicitly");
  a.displayText = text;
  const target = file(store, d.id); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, JSON.stringify(a), { flag: "wx", mode: 0o600 });
  const button = (label, action) => ({ text: label, callback_data: `gg:${action}:${d.id}:${a.id}` });
  const rows = pending ? [...(guidance ? [[button("Use Grok’s guidance", "u")]] : []), [button("Keep paused", "p"), button("Stop task", "s")]] : [];
  try {
    const message = await api.call("sendMessage", { chat_id: config.chat, text, reply_markup: { inline_keyboard: rows } });
    if (String(message.chat?.id) !== config.chat || message.chat?.type !== "private" || !Number.isSafeInteger(message.message_id)) throw new Error("Attachment delivery scope mismatch");
    a.messageId = message.message_id; a.delivery = "sent"; writeJson(target, a);
  } catch (error) { a.delivery = "failed"; writeJson(target, a); throw error; }
  const stillPending = pending && attachedGuidance(store, d) !== null;
  if (pending && !stillPending) await closeGuidanceMessage(api, store, d.id);
  return { attachmentId: a.id, decisionId, verificationId, enabled: stillPending && guidance !== null, informationOnly: !stillPending };
}

export async function closeGuidanceMessage(api, store, id) {
  try {
    const a = readJson(file(store, id)), d = store.get(id);
    if (!a?.messageId || a.delivery !== "sent") return;
    await api.call("editMessageText", { chat_id: a.binding.chat, message_id: a.messageId,
      text: `${a.displayText || `${new VerificationStore(store.home).briefing(a.request)}\nRecommendation source: ${a.source.kind}\nExact recommendation:\n${a.guidance || "No guidance attached"}`}\n\nSTATUS: ${d.status}. Guidance handoff closed; buttons disabled. No held action approval. For another decision, start a fresh supported Claude continuation and explicitly reattach.`,
      reply_markup: { inline_keyboard: [] } }, Date.now() + 3000);
  } catch { /* Display failure cannot revive state or authorize the held action. */ }
}
