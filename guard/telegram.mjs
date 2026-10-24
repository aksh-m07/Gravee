#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadEnv, LOCAL_ENV, STATE_HOME, telegramConfig, redact } from "./lib/config.mjs";
import { DecisionStore, acquireConsumer, fingerprint, readJson, writeJson } from "./lib/decisions.mjs";
import { Telegram, escalateTelegram } from "./lib/telegram.mjs";

loadEnv();
const home = STATE_HOME();
const command = process.argv[2] || "status";
const token = process.env.TELEGRAM_BOT_TOKEN;
async function pair() {
  if (!token) throw new Error("Save TELEGRAM_BOT_TOKEN in guard/.env.local first. Never paste it into chat.");
  if (telegramConfig()) { console.log("An owner is already paired. Existing binding preserved."); return; }
  const release = acquireConsumer(home);
  try {
    const api = new Telegram(token);
    const me = await api.call("getMe", {});
    const webhook = await api.call("getWebhookInfo", {});
    if (webhook.url) throw new Error("This bot already has a webhook. Use a dedicated demo bot; no webhook was changed.");
    const code = crypto.randomBytes(8).toString("hex");
    console.log(`Open https://t.me/${me.username} in your own private Telegram chat and SEND: /start ${code}`);
    console.log("Waiting up to 3 minutes. Only that exact pairing code in a private owner chat can bind the bot.");
    const expires = Date.now() + 180000;
    const offsetFile = path.join(home, "telegram-offset.json");
    let offset = readJson(offsetFile, { offset: 0 }).offset;
    while (Date.now() < expires) {
      const updates = await api.updates(offset, expires);
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1); writeJson(offsetFile, { offset });
        const m = u.message;
        if (m?.chat?.type !== "private" || String(m.from?.id) !== String(m.chat?.id) || m.text?.trim() !== `/start ${code}`) continue;
        let env = fs.existsSync(LOCAL_ENV) ? fs.readFileSync(LOCAL_ENV, "utf8") : "";
        env = env.split("\n").filter((line) => !/^TELEGRAM_(OWNER_ID|CHAT_ID)=/.test(line)).join("\n").trimEnd();
        const tmp = `${LOCAL_ENV}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${env}\nTELEGRAM_OWNER_ID=${m.from.id}\nTELEGRAM_CHAT_ID=${m.chat.id}\n`, { mode: 0o600 });
        fs.renameSync(tmp, LOCAL_ENV);
        await api.call("sendMessage", { chat_id: String(m.chat.id), text: "Graveyard Shift paired to your private account. Only you can answer decisions. Dictation text is guidance; approval requires the exact-action button." });
        console.log("Private owner paired and confirmation delivered. IDs saved locally; token was not printed."); return;
      }
    }
    throw new Error("Pairing expired. No owner was selected; run pair again for a new code.");
  } finally { release(); }
}
async function main() {
  if (command === "pair") return pair();
  const config = telegramConfig();
  if (command === "status") {
    const lock = path.join(home, "telegram.lock");
    const consumer = readJson(path.join(lock, "owner.json"));
    let consumerRunning = fs.existsSync(lock) ? "unknown" : false;
    if (consumer?.pid) { try { process.kill(consumer.pid, 0); consumerRunning = true; } catch (e) { consumerRunning = e.code === "ESRCH" ? false : "unknown"; } }
    const active = new DecisionStore(home).active();
    let effectiveStatus = active?.status;
    if (active && ["pending", "approved"].includes(active.status)) {
      if (Date.now() >= active.expiresAt) effectiveStatus = "expired";
      else { try { process.kill(active.pid, 0); } catch (e) { if (e.code === "ESRCH") effectiveStatus = "interrupted"; } }
    }
    console.log(JSON.stringify({ tokenConfigured: !!token, ownerPaired: !!config, stateDirectory: home, consumerRunning,
      activeDecision: active ? { id: active.id, session: active.sid, status: effectiveStatus, expiresAt: active.expiresAt, approvalConsumed: active.consumed } : null }));
    if (token) { const me = await new Telegram(token).call("getMe", {}); console.log(`Bot verified: @${me.username}`); }
    return;
  }
  if (command !== "test") throw new Error("Usage: node guard/telegram.mjs status|pair|test");
  if (!config) throw new Error("Run pair first; no message sent.");
  const sid = `telegram-smoke-${Date.now()}`;
  const action = { sid, tool: "GuidanceTest", input: {}, cwd: process.cwd() };
  const { result } = await escalateTelegram({ home, config, ...action, actionHash: fingerprint(action),
    goal: "Transport-only guidance test; no Claude action will execute.", history: [], question: "Tap Reply with guidance. Dictate 'Use a new branch instead' with Voiskey, then press Send. Typed text is a fallback.", verdict: "Manual transport test, not proof of a Claude session.", expiresAt: Date.now() + 120000 });
  console.log(JSON.stringify({ decision: result.id, status: result.status, receivedText: redact(result.originalReply), acknowledgment: result.acknowledgment, modelRequests: result.modelRequests, expiresAt: result.expiresAt, terminalSession: false }, (_k, v) => typeof v === "string" ? redact(v) : v));
  if (result.status !== "guidance") process.exitCode = 1;
}
main().catch((e) => { console.error(redact(e.message).replace(/https?:\/\/[^\s]+/g, "[URL]").slice(0, 300)); process.exitCode = 1; });
