// How the guard reaches the boss when it needs a human: it says it out loud (Gemini's voice, or the Mac's if Gemini is unavailable)
// and texts the boss's own phone a picture of what Claude wants to do and what is wrong, if IMESSAGE_TO is set.
// The boss answers in Claude Code itself; Voiskey voice typing works in the terminal.
import { execFile, spawn } from "node:child_process";
import path from "node:path";

export function speak(text) {
  if (process.env.GRAVEYARD_VOICE === "off" || process.platform !== "darwin") return;
  // Detached, so the hook returns at once while the voice is fetched and played.
  try { spawn(process.execPath, [path.join(import.meta.dirname, "voice.mjs"), text], { detached: true, stdio: "ignore", env: process.env }).unref(); } catch { /* no voice */ }
}

const SEND = `on run argv
  tell application "Messages"
    set svc to 1st account whose service type = iMessage
    set p to participant (item 1 of argv) of svc
    send (item 2 of argv) to p
    if (count of argv) > 2 then send (POSIX file (item 3 of argv)) to p
  end tell
end run`;

/** Texts the boss. Returns "sent", "sent without picture", "off" or an error message, so the log shows what really happened. */
export async function textPhone(text, file) {
  const to = process.env.IMESSAGE_TO;
  if (!to || process.platform !== "darwin") return "off";
  if (process.env.GRAVEYARD_TEXT === "off") return "skipped"; // tests: serve the reply page without sending a real message
  return new Promise((resolve) => execFile("osascript", ["-e", SEND, to, text.slice(0, 600), ...(file ? [file] : [])], { timeout: 20000 }, (err, _o, e) => resolve(err ? `failed: ${String(e || err.message).slice(0, 160)}` : file ? "sent" : "sent without picture")));
}
