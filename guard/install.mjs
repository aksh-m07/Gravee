#!/usr/bin/env node
// Project-local only. Never touches ~/.claude/settings.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "./lib/decisions.mjs";

export const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "hook.mjs");
export const EVENTS = { UserPromptSubmit: 10, PreToolUse: 180, PostToolUse: 10, PostToolUseFailure: 10, Stop: 10 };
export function installProject(project, remove = false) {
  const root = path.resolve(project);
  if (!fs.statSync(root).isDirectory()) throw new Error("Project directory must exist");
  const file = path.join(root, ".claude", "settings.local.json");
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.graveyard-backup-${Date.now()}`);
  const mine = (h) => (h.args ?? []).includes(HOOK) || String(h.command ?? "").includes(HOOK);
  settings.hooks ??= {};
  for (const [event, timeout] of Object.entries(EVENTS)) {
    settings.hooks[event] = (settings.hooks[event] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !mine(h)) })).filter((g) => g.hooks.length);
    if (!remove) settings.hooks[event].push({ ...(event.startsWith("Pre") || event.startsWith("Post") ? { matcher: "*" } : {}), hooks: [{
      type: "command", command: process.execPath, args: [HOOK], timeout,
      ...(event === "PreToolUse" ? { onFailure: "block", statusMessage: "Graveyard Shift is checking this action / waiting for its owner" } : {}),
    }] });
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  writeJson(file, settings);
  return file;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--project");
  if (i < 0 || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) {
    console.error("Usage: node guard/install.mjs --project /absolute/demo/directory [--remove]. Requires Claude Code >=2.1.295 for onFailure:block. No global settings changed."); process.exitCode = 2;
  } else console.log(`${process.argv.includes("--remove") ? "Removed" : "Installed"} project hooks: ${installProject(process.argv[i + 1], process.argv.includes("--remove"))}`);
}
