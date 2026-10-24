import path from "node:path";
import { DecisionStore, acquireConsumer, fingerprint, readJson, writeJson } from "./decisions.mjs";
import { redact } from "./config.mjs";
import { readReply } from "./phone.mjs";

export class Telegram {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; }
  async call(method, body, deadline = Date.now() + 8000) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Telegram deadline expired");
    try {
      const r = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.min(25_000, remaining)),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(`Telegram ${method} failed (${r.status})`);
      return j.result;
    } catch (e) {
      // Network exceptions can contain the token-bearing URL. Never propagate those details.
      throw new Error(`Telegram ${method} unavailable${e.name === "TimeoutError" ? " (timeout)" : ""}`);
    }
  }
  updates(offset, deadline) {
    return this.call("getUpdates", { offset, timeout: Math.max(0, Math.min(20, Math.floor((deadline - Date.now() - 500) / 1000))), allowed_updates: ["message", "callback_query"] }, deadline);
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
    [{ text: "Reply with guidance", callback_data: `gs:g:${d.id}` }],
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
export function classifyUpdate(update, d, now = Date.now()) {
  if (d.status !== "pending" || now >= d.expiresAt) return null;
  const cb = update.callback_query;
  if (cb) {
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
  return { kind: r.kind === "instruct" ? "guidance" : r.kind, original: m.text };
}

export async function waitForDecision({ api, store, decision, onUpdate = () => {} }) {
  let d = decision;
  const offsetFile = path.join(store.home, "telegram-offset.json");
  let offset = readJson(offsetFile, { offset: 0 }).offset;
  while (d.status === "pending" && Date.now() < d.expiresAt) {
    let updates;
    try { updates = await api.updates(offset, d.expiresAt); }
    catch { d.status = Date.now() >= d.expiresAt ? "expired" : "transport_failed"; store.save(d); break; }
    // A stop/rejection already present in the received batch wins over an approval.
    // Guidance also blocks rather than dropping conditions when controls arrive together.
    const priority = { stop: 0, deny: 1, guidance: 2, ambiguous: 3, prompt: 3, approve: 4 };
    updates.sort((a, b) => (priority[classifyUpdate(a, d)?.kind] ?? 99) - (priority[classifyUpdate(b, d)?.kind] ?? 99));
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      writeJson(offsetFile, { offset }); // acknowledge before processing: a crash never replays an uncertain reply
      d = store.get(d.id);
      const reply = classifyUpdate(update, d);
      if (!reply) continue;
      if (reply.callbackId) await api.call("answerCallbackQuery", { callback_query_id: reply.callbackId, text: "Received for this decision." }, Math.min(d.expiresAt, Date.now() + 3000)).catch(() => {});
      if (reply.kind === "prompt" || reply.kind === "ambiguous") {
        if (reply.kind === "ambiguous") store.resolve(d.id, d, reply.original, "ambiguous");
        const flag = reply.kind === "prompt" ? "guidancePrompted" : "clarified";
        if (!d[flag]) {
          d = store.get(d.id); d[flag] = true; store.save(d);
          try {
            const m = await api.call("sendMessage", { chat_id: d.chat,
              text: `Decision ${d.id}: ${reply.kind === "ambiguous" ? "Did you mean guidance, reject, or stop? Approval requires the exact-action button." : "Dictate or type guidance here, then press Send. Conditions are preserved."}\nReply to this message. The original deadline is unchanged.`,
              reply_markup: { force_reply: true, selective: true } }, Math.min(d.expiresAt, Date.now() + 5000));
            d.replyMessageIds.push(m.message_id); store.save(d);
          } catch { d.status = "delivery_failed"; store.save(d); }
        }
        continue;
      }
      d = store.resolve(d.id, d, reply.original, reply.kind) ?? store.get(d.id);
      onUpdate(d);
      if (d.status !== "pending") break;
    }
  }
  if (d.status === "pending") { d.status = "expired"; store.save(d); }
  return d;
}

export async function escalateTelegram({ home, config, sid, tool, input, cwd, goal, history, tried, question, verdict, expiresAt, actionHash }) {
  const release = acquireConsumer(home);
  const store = new DecisionStore(home);
  try {
    const briefing = briefingFor({ goal, question, tool, input, history, tried, verdict });
    let d = store.create({ sid, actionHash, owner: config.owner, chat: config.chat, expiresAt, briefing: briefing.text, approvalEligible: briefing.approvalEligible });
    const api = new Telegram(config.token);
    d = await notifyDecision(api, store, d);
    let result = d.status === "pending" ? await waitForDecision({ api, store, decision: d }) : d;
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
