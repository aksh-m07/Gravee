import path from "node:path";
import { DecisionStore, acquireConsumer, fingerprint, readJson, writeJson } from "./decisions.mjs";
import { redact } from "./config.mjs";
import { readReply } from "./phone.mjs";
import { evidenceFor, interpretReply, validateInterpretation, MAX_USER_TURNS, MAX_CONVERSATION_REQUESTS, answerFromFacts, acknowledgeGuidance, clarificationFor } from "./conversation.mjs";
import { attachedGuidance, claimAttachedGuidance, closeGuidanceMessage } from "./grok-guidance.mjs";

export class Telegram {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; }
  async call(method, body, deadline = Date.now() + 8000) {
    const remaining = deadline - Date.now();
    let status;
    if (remaining <= 0) throw new Error("Telegram deadline expired");
    try {
      const r = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.min(25_000, remaining)),
      });
      const j = await r.json();
      status = Number.isInteger(j.error_code) ? j.error_code : r.status;
      if (!r.ok || !j.ok) throw new Error(`Telegram ${method} failed (${r.status})`);
      return j.result;
    } catch (e) {
      // Network exceptions can contain the token-bearing URL. Never propagate those details.
      throw new Error(`Telegram ${method} unavailable${e.name === "TimeoutError" ? " (timeout)" : status ? ` (HTTP ${status})` : ""}`);
    }
  }
  updates(offset, deadline, wait = true) {
    return this.call("getUpdates", { offset, timeout: wait ? Math.max(0, Math.min(20, Math.floor((deadline - Date.now() - 500) / 1000))) : 0, allowed_updates: ["message", "callback_query"] }, deadline);
  }
}

export function briefingFor({ goal, question, tool, input, history = [], tried = [], verdict }) {
  const raw = tool === "Bash" ? String(input?.command ?? "") : `${tool}: ${input?.file_path ?? "(input withheld)"}`;
  const action = redact(raw);
  const approvalEligible = tool === "Bash" && action === raw && raw.length > 0 && raw.length <= 1000;
  const failed = history.filter((h) => h.ok === false).slice(-2).map((h) => redact(`${h.summary}: ${h.error}`).slice(0, 180));
  return { approvalEligible, text: [
    `Task: ${redact(goal || "Current Claude Code task").slice(0, 200)}`,
    `Held action: ${action.slice(0, 1000)}${raw.length > 1000 ? " [truncated; remote approval disabled]" : ""}`,
    `Why: ${redact(verdict || question).slice(0, 260)}`,
    `Evidence: ${failed.join("; ") || "Policy flagged the proposed action before execution."}`,
    `Supervisor already tried: ${redact(tried.slice(-3).map((h) => `${h.kind}: ${h.detail}`).join("; ") || "No supervisor recovery attempted for this task.").slice(0, 350)}`,
    `Question: ${redact(question).slice(0, 240)}`,
    "Options: reply with guidance, reject, or stop. Consequential approval requires the exact-action button; dictated yes never approves.",
    "Silence/delivery failure: action stays blocked and the Claude turn stops. Late replies cannot resume it.",
  ].join("\n\n") };
}

export async function notifyDecision(api, store, d) {
  d = store.get(d.id);
  if (d.delivery !== "unsent") return d;
  d.delivery = "sending"; store.save(d); // uncertain delivery is never retried
  const rows = [
    ...(d.approvalEligible ? [[{ text: "Approve this action once", callback_data: `gs:a:${d.id}` }]] : []),
    [{ text: "Ask or give guidance", callback_data: `gs:g:${d.id}` }],
    [{ text: "Reject action", callback_data: `gs:r:${d.id}` }, { text: "Stop task", callback_data: `gs:s:${d.id}` }],
  ];
  try {
    const message = await api.call("sendMessage", { chat_id: d.chat, text: `${d.briefing}\n\nDecision: ${d.id}`, reply_markup: { inline_keyboard: rows } }, Math.min(d.expiresAt, Date.now() + 8000));
    if (String(message.chat?.id) !== d.chat || message.chat?.type !== "private") throw new Error("Delivery scope mismatch");
    d.messageId = message.message_id; d.replyMessageIds = [message.message_id]; d.delivery = "sent"; store.save(d);
  } catch { d.status = "delivery_failed"; d.delivery = "failed"; store.save(d); }
  return d;
}

/** Pure binding/classification before any state transition. */
export function classifyUpdate(update, d, now = Date.now(), attachment = null) {
  if (!Number.isSafeInteger(update.update_id) || d.status !== "pending" || now >= d.expiresAt || d.seenUpdateIds?.includes(update.update_id)) return null;
  const cb = update.callback_query;
  if (cb) {
    const external = /^gg:([ups]):([a-f0-9]{16}):([a-f0-9]{16})$/.exec(cb.data ?? "");
    if (external) {
      if (!attachment || external[2] !== d.id || external[3] !== attachment.id || cb.message?.message_id !== attachment.messageId || String(cb.from?.id) !== d.owner || String(cb.message?.chat?.id) !== d.chat || cb.message?.chat?.type !== "private") return null;
      if (external[1] === "u" && (!attachment.guidance || attachment.used)) return null;
      return { kind: { u: "grok_guidance", p: "pause", s: "stop" }[external[1]], original: external[1] === "u" ? attachment.guidance : `inline:${external[1]}`, attachmentId: attachment.id, callbackId: cb.id };
    }
    if (String(cb.from?.id) !== d.owner || String(cb.message?.chat?.id) !== d.chat || cb.message?.chat?.type !== "private" || cb.message.message_id !== d.messageId) return null;
    const m = /^gs:([agrs]):([a-f0-9]{16})$/.exec(cb.data ?? "");
    if (!m || m[2] !== d.id) return null;
    const kind = { a: "approve", g: "prompt", r: "deny", s: "stop" }[m[1]];
    if (kind === "approve" && !d.approvalEligible) return null;
    return { kind, original: `inline:${kind}`, callbackId: cb.id };
  }
  const m = update.message;
  if (!m || String(m.from?.id) !== d.owner || String(m.chat?.id) !== d.chat || m.chat?.type !== "private" || !d.replyMessageIds.includes(m.reply_to_message?.message_id) || typeof m.text !== "string" || m.text.length > 2000) return null;
  const r = readReply(m.text);
  return { kind: r.kind === "instruct" ? "text" : r.kind, original: m.text };
}

export async function waitForDecision(args) {
  try { return await waitForDecisionInternal(args); }
  finally { await closeGuidanceMessage(args.api, args.store, args.decision.id); }
}

async function waitForDecisionInternal({ api, store, decision, onUpdate = () => {}, interpret = interpretReply, reserve = () => true }) {
  let d = decision;
  const classify = (update, current) => classifyUpdate(update, current, Date.now(), attachedGuidance(store, current));
  const offsetFile = path.join(store.home, "telegram-offset.json");
  let offset = readJson(offsetFile, { offset: 0 }).offset;
  let queued = [];
  const priority = { stop: 0, deny: 1, grok_guidance: 2, text: 2, pause: 3, ambiguous: 3, prompt: 3, approve: 4 };
  const save = () => store.save(d);
  async function say(text) {
    const m = await api.call("sendMessage", { chat_id: d.chat, text: `${text}\n\nDecision: ${d.id}. The original deadline is unchanged.`,
      reply_markup: { force_reply: true, selective: true } }, Math.min(d.expiresAt, Date.now() + 5000));
    const current = store.validate(d.id, d);
    if (!current || current.status !== "pending") throw new Error("Decision changed during message delivery");
    d = current; d.replyMessageIds.push(m.message_id); save();
  }
  function finish(status) {
    const current = store.validate(d.id, d);
    if (!current || current.status !== "pending") return store.get(d.id);
    if (d.failure) current.failure = d.failure;
    d = current; d.status = status; save(); return d;
  }
  function transportFailure(error, phase) { d.failure = { phase, detail: redact(error.message).replace(/https?:\/\/[^\s]+/g, "[URL]").slice(0, 160) }; return finish(Date.now() >= d.expiresAt ? "expired" : "transport_failed"); }
  const vetoIn = (updates) => updates.find((u) => classify(u, d)?.kind === "stop") || updates.find((u) => classify(u, d)?.kind === "deny");
  function honorVeto(veto) {
    offset = Math.max(offset, veto.update_id + 1); writeJson(offsetFile, { offset });
    const control = classify(veto, d); d.seenUpdateIds.push(veto.update_id); save();
    return store.resolve(d.id, d, control.original, control.kind) ?? store.get(d.id);
  }
  while (d.status === "pending" && Date.now() < d.expiresAt) {
    let updates;
    try { updates = queued.length ? queued.splice(0) : await api.updates(offset, d.expiresAt); }
    catch (e) { return transportFailure(e, "updates"); }
    if (!Array.isArray(updates)) return finish("transport_failed");
    updates.sort((a, b) => (priority[classify(a, d)?.kind] ?? 99) - (priority[classify(b, d)?.kind] ?? 99));
    for (let i = 0; i < updates.length; i++) {
      const update = updates[i];
      if (!Number.isSafeInteger(update.update_id)) continue;
      offset = Math.max(offset, update.update_id + 1); writeJson(offsetFile, { offset });
      d = store.get(d.id);
      const reply = classify(update, d);
      if (!reply) continue;
      d.seenUpdateIds.push(update.update_id); d.seenUpdateIds = d.seenUpdateIds.slice(-64); save();
      if (reply.callbackId) await api.call("answerCallbackQuery", { callback_query_id: reply.callbackId, text: "Received for this decision." }, Math.min(d.expiresAt, Date.now() + 3000)).catch(() => {});
      // Explicit controls bypass all model interpretation and conversational turn limits.
      if (["approve", "stop", "deny"].includes(reply.kind)) {
        if (reply.kind === "approve") {
          let latest;
          try { latest = await api.updates(offset, Math.min(d.expiresAt, Date.now() + 5000), false); }
          catch (e) { return transportFailure(e, "controls_before_approval"); }
          if (!Array.isArray(latest)) return finish("transport_failed");
          const veto = vetoIn([...updates.slice(i + 1), ...latest]);
          if (veto) return honorVeto(veto);
        }
        d = store.resolve(d.id, d, reply.original, reply.kind) ?? store.get(d.id); onUpdate(d); return d;
      }
      if (reply.kind === "pause") {
        try { await say("Kept paused. The held action remains blocked; the original deadline is unchanged."); }
        catch { return finish("delivery_failed"); }
        continue;
      }
      if (reply.kind === "grok_guidance") {
        let latest;
        try { latest = await api.updates(offset, Math.min(d.expiresAt, Date.now() + 5000), false); }
        catch (e) { return transportFailure(e, "controls_before_grok_guidance"); }
        if (!Array.isArray(latest)) return finish("transport_failed");
        const veto = vetoIn([...updates.slice(i + 1), ...latest]);
        if (veto) return honorVeto(veto);
        const a = claimAttachedGuidance(store, d, reply.attachmentId);
        if (!a) return store.get(d.id);
        const acknowledgment = acknowledgeGuidance(a.guidance);
        try { await say(acknowledgment); } catch { return finish("delivery_failed"); }
        let finalUpdates;
        try { finalUpdates = await api.updates(offset, Math.min(d.expiresAt, Date.now() + 5000), false); }
        catch (e) { return transportFailure(e, "controls_after_grok_acknowledgment"); }
        if (!Array.isArray(finalUpdates)) return finish("transport_failed");
        const finalVeto = vetoIn([...updates.slice(i + 1), ...latest, ...finalUpdates]);
        if (finalVeto) return honorVeto(finalVeto);
        const checked = attachedGuidance(store, d);
        if (!checked || checked.id !== a.id || Date.now() >= d.expiresAt) return store.get(d.id);
        const result = store.resolve(d.id, d, a.guidance, "guidance");
        if (!result) return store.get(d.id);
        result.acknowledgment = acknowledgment;
        result.grokGuidance = { attachmentId: a.id, request: a.request, candidateDigest: a.candidateDigest, source: a.source };
        store.save(result); return result;
      }
      if (reply.kind === "prompt") {
        if (!d.guidancePrompted) {
          d.guidancePrompted = true; save();
          try { await say("Ask a question about the stored evidence, or dictate/type guidance. Inspect your words and press Send. Questions leave the action held; text never approves it."); }
          catch { return finish("delivery_failed"); }
        }
        continue;
      }
      if (d.userTurns >= MAX_USER_TURNS) return finish("conversation_limit");
      d.userTurns++; save();
      if (reply.kind === "ambiguous") {
        d = store.resolve(d.id, d, reply.original, "ambiguous");
        if (d.clarified) return finish("interpretation_unclear");
        d.clarified = true; save();
        try { await say("Did you mean a question, guidance, Reject, or Stop? Approval requires the exact-action button. The action remains held."); }
        catch { return finish("delivery_failed"); }
        continue;
      }
      if (d.modelRequests >= MAX_CONVERSATION_REQUESTS) return finish("conversation_limit");
      if (Date.now() + 500 >= d.expiresAt) return finish("insufficient_time");
      let interpretation;
      try {
        const result = await interpret({ original: reply.original, decision: d, deadline: Math.min(d.expiresAt - 500, Date.now() + 12000),
          reserve(model) {
            const current = store.validate(d.id, d);
            if (!current || current.status !== "pending" || current.modelRequests >= MAX_CONVERSATION_REQUESTS || !reserve(model)) return false;
            current.modelRequests++; d = store.save(current); return true;
          } });
        const { model, ...value } = result;
        interpretation = { ...validateInterpretation(value, { original: reply.original, facts: d.evidence }), model: typeof model === "string" ? model : null };
      } catch { return finish(Date.now() >= d.expiresAt ? "expired" : "interpretation_failed"); }
      // Same consumer, non-blocking drain: a Stop/Reject received during Gemini wins before guidance can be relayed.
      let extra;
      try { extra = await api.updates(offset, Math.min(d.expiresAt, Date.now() + 5000), false); }
      catch (e) { return transportFailure(e, "controls_after_interpretation"); }
      if (!Array.isArray(extra)) return finish("transport_failed");
      const pending = [...updates.slice(i + 1), ...extra];
      const veto = vetoIn(pending);
      if (veto) return honorVeto(veto);
      const unique = new Map();
      for (const u of pending) if (!d.seenUpdateIds.includes(u.update_id)) unique.set(u.update_id, u);
      queued.push(...unique.values());
      if (Date.now() >= d.expiresAt) return finish("expired");
      const entry = { original: reply.original, kind: interpretation.kind, model: interpretation.model, at: Date.now() };
      d.conversation.push(entry);
      if (interpretation.kind === "question") {
        entry.factIds = interpretation.fact_ids;
        entry.reply = answerFromFacts(interpretation, d.evidence);
        d.replies.push({ original: reply.original, interpreted: "question", at: Date.now() }); save();
        try { await say(entry.reply); } catch { return finish("delivery_failed"); }
      } else if (interpretation.kind === "clarify") {
        d.replies.push({ original: reply.original, interpreted: "clarify", at: Date.now() });
        if (d.clarified) return finish("interpretation_unclear");
        d.clarified = true; entry.reply = clarificationFor(interpretation.clarification); save();
        try { await say(`${entry.reply} The action remains held.`); } catch { return finish("delivery_failed"); }
      } else {
        entry.reply = acknowledgeGuidance(reply.original); d.acknowledgment = entry.reply; save();
        // A failed acknowledgment is not a successful handoff.
        try { await say(entry.reply); } catch { return finish("delivery_failed"); }
        if (Date.now() >= d.expiresAt) return finish("expired");
        let finalUpdates;
        try { finalUpdates = await api.updates(offset, Math.min(d.expiresAt, Date.now() + 5000), false); }
        catch (e) { return transportFailure(e, "controls_after_acknowledgment"); }
        if (!Array.isArray(finalUpdates)) return finish("transport_failed");
        const finalVeto = vetoIn([...queued, ...finalUpdates]);
        if (finalVeto) return honorVeto(finalVeto);
        if (Date.now() >= d.expiresAt) return finish("expired");
        return store.resolve(d.id, d, reply.original, "guidance") ?? store.get(d.id);
      }
      break; // process queued new messages on the next loop, without a second consumer
    }
  }
  return d.status === "pending" ? finish("expired") : d;
}

export async function escalateTelegram({ home, config, sid, tool, input, cwd, goal, history, tried, question, verdict, expiresAt, actionHash, reserve }) {
  const release = acquireConsumer(home);
  const store = new DecisionStore(home);
  try {
    const briefing = briefingFor({ goal, question, tool, input, history, tried, verdict });
    let d = store.create({ sid, actionHash, owner: config.owner, chat: config.chat, expiresAt, briefing: briefing.text, approvalEligible: briefing.approvalEligible, evidence: evidenceFor({ goal, tool, input, history, tried, verdict }) });
    const api = new Telegram(config.token);
    d = await notifyDecision(api, store, d);
    let result = d.status === "pending" ? await waitForDecision({ api, store, decision: d, reserve }) : d;
    let approved = result.status === "approved" && fingerprint({ sid, tool, input, cwd }) === actionHash &&
      store.consume(result.id, { sid, actionHash, owner: config.owner, chat: config.chat });
    result = store.get(result.id);
    if (result.messageId) {
      const status = approved ? "Exact-action approval consumed once by the hook." : result.status === "guidance" ? "Guidance received. The shown action is blocked; its conditions are preserved." : result.status === "deny" ? "Shown action rejected; no other action approved." : result.status === "cancelled" ? "Stop received; the held action stays blocked." : `Decision ${result.status}; held action blocked. Late replies cannot resume Claude. Issue a new prompt locally to continue.`;
      await api.call("editMessageText", { chat_id: result.chat, message_id: result.messageId, text: `${result.briefing}\n\nDecision: ${result.id}\nSTATUS: ${status}`, reply_markup: { inline_keyboard: [] } }, Date.now() + 3000).catch(() => {});
    }
    // Revalidate after the final network await, immediately before returning an allow.
    // An uncertain/expired consumed approval stays spent, but never dispatches the action.
    if (approved && (Date.now() >= result.expiresAt || fingerprint({ sid, tool, input, cwd }) !== actionHash)) {
      approved = false;
      result.status = Date.now() >= result.expiresAt ? "expired" : "mismatched";
      store.save(result);
      if (result.messageId) await api.call("editMessageText", { chat_id: result.chat, message_id: result.messageId,
        text: `Decision ${result.id}: final validation ${result.status}. The held action is blocked; the consumed approval cannot be reused. Start a new local prompt if needed.`, reply_markup: { inline_keyboard: [] } }, Date.now() + 1000).catch(() => {});
    }
    return { result, approved };
  } finally { release(); }
}
