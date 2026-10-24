import fs from "node:fs";
import path from "node:path";

export const GUARD_ROOT = path.resolve(import.meta.dirname, "..");
export const LOCAL_ENV = path.join(GUARD_ROOT, ".env.local");
export const STATE_HOME = () => process.env.GRAVEYARD_HOME || path.join(GUARD_ROOT, ".state");
const KEYS = /^(GEMINI_API_KEY|GOOGLE_API_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_OWNER_ID|TELEGRAM_CHAT_ID|GRAVEYARD_[A-Z_]+)$/;

export function loadEnv() {
  const files = process.env.GRAVEYARD_ENV ? [process.env.GRAVEYARD_ENV] : [LOCAL_ENV, path.resolve(GUARD_ROOT, "../web/.env.local")];
  for (const file of files) {
    let source;
    try { source = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of source.split("\n")) {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
      if (!m || !KEYS.test(m[1]) || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

export function redact(value) {
  let text = String(value ?? "");
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && secret && secret.length > 5) text = text.replaceAll(secret, "[REDACTED]");
  }
  return text.replace(/\b(?:sk-[\w-]{12,}|AIza[\w-]{20,}|\d{6,}:[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/((?:--password|--token|--api-key)\s+)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi, "$1[REDACTED]")
    .replace(/\b([A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;]+)/gi, "$1=[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@")
    .replace(/([?&](?:token|key|api_key|password)=)[^&\s]+/gi, "$1[REDACTED]");
}

export function telegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const owner = process.env.TELEGRAM_OWNER_ID?.trim();
  const chat = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !/^\d+$/.test(owner ?? "") || chat !== owner) return null;
  return { token, owner, chat };
}

export const replyWaitMs = () => Math.min(120_000, Math.max(100, Number(process.env.GRAVEYARD_REPLY_WAIT_S || 120) * 1000 || 120_000));
