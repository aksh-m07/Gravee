#!/usr/bin/env node
// Install or remove the Graveyard Shift guard for ALL your Claude Code sessions (~/.claude/settings.json).
//   node install.mjs            install (backs up settings first)
//   node install.mjs --remove   remove only the guard's hooks
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "hook.mjs");
const FILE = path.join(os.homedir(), ".claude", "settings.json");
const EVENTS = { UserPromptSubmit: 10, PreToolUse: 45, PostToolUse: 10, PostToolUseFailure: 10, Stop: 10 };
const mine = (h) => (h.args ?? []).includes(HOOK);

const settings = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {};
if (fs.existsSync(FILE)) fs.copyFileSync(FILE, `${FILE}.graveyard-backup-${Date.now()}`);
settings.hooks ??= {};
for (const ev of Object.keys(EVENTS)) {
  settings.hooks[ev] = (settings.hooks[ev] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !mine(h)) })).filter((g) => g.hooks.length);
  if (!process.argv.includes("--remove")) settings.hooks[ev].push({ ...(ev.startsWith("Pre") || ev.startsWith("Post") ? { matcher: "*" } : {}), hooks: [{ type: "command", command: "node", args: [HOOK], timeout: EVENTS[ev] }] });
  if (!settings.hooks[ev].length) delete settings.hooks[ev];
}
fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(settings, null, 2));
console.log(process.argv.includes("--remove") ? `Removed the guard from ${FILE}.` : `Installed the guard in ${FILE} (backup saved next to it). Start a new Claude Code session to use it.`);
