import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Text the guard's annotated screenshot to the boss's own iPhone through macOS Messages, during a call.
 * Off unless IMESSAGE_TO is set (a phone number or Apple ID the boss chose). Never sends anywhere else.
 * The recipient and file path go to AppleScript as arguments, never pasted into the script text.
 */
const SCRIPT = `on run argv
  set target to item 1 of argv
  set msg to item 2 of argv
  set img to POSIX file (item 3 of argv)
  tell application "Messages"
    set svc to 1st account whose service type = iMessage
    set p to participant target of svc
    send msg to p
    send img to p
  end tell
end run`;

export const imessageEnabled = () => !!process.env.IMESSAGE_TO;

const TEXT_SCRIPT = `on run argv
  tell application "Messages"
    set svc to 1st account whose service type = iMessage
    send (item 2 of argv) to participant (item 1 of argv) of svc
  end tell
end run`;

/** A text-only follow-up on the same thread (each guard line on the call). */
export async function textMessage(text: string): Promise<{ ok: boolean; error?: string }> {
  const to = process.env.IMESSAGE_TO;
  if (!to) return { ok: false, error: "IMESSAGE_TO is not set" };
  return new Promise((resolve) => {
    execFile("osascript", ["-e", TEXT_SCRIPT, to, text.slice(0, 600)], { timeout: 20000 }, (err) => resolve(err ? { ok: false, error: String(err.message).slice(0, 160) } : { ok: true }));
  });
}

export async function textImage(caption: string, jpeg: Buffer): Promise<{ ok: boolean; error?: string }> {
  const to = process.env.IMESSAGE_TO;
  if (!to) return { ok: false, error: "IMESSAGE_TO is not set" };
  // Messages can only attach files from folders it is allowed to read, so use one under the home folder.
  const dir = path.join(os.homedir(), "Pictures", "graveyard-shift");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `guard-${Date.now()}.jpg`);
  fs.writeFileSync(file, jpeg);
  return new Promise((resolve) => {
    execFile("osascript", ["-e", SCRIPT, to, caption, file], { timeout: 20000 }, (err) => resolve(err ? { ok: false, error: String(err.message).slice(0, 160) } : { ok: true }));
  });
}
