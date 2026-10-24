// Graveyard Shift guard: the cheap, deterministic checks. Pure functions over the session's step history, so they are easy to test.
// A step is { tool, key, summary, ok, error, verify } where `verify` marks test/build/lint commands.

const TOOLS_THAT_ACT = new Set(["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch"]);

/** A stable identity for "the same action": the tool plus the parts of its input that matter. */
export function keyOf(tool, input = {}) {
  if (tool === "Bash") return `Bash:${String(input.command ?? "").trim().replace(/\s+/g, " ")}`;
  if (tool === "Edit") return `Edit:${input.file_path}:${hash(input.old_string)}>${hash(input.new_string)}`;
  if (tool === "Write") return `Write:${input.file_path}:${hash(input.content)}`;
  return `${tool}:${JSON.stringify(input).slice(0, 400)}`;
}

/** One line a human (or Gemini) can read. */
export function summaryOf(tool, input = {}) {
  if (tool === "Bash") return `run \`${String(input.command ?? "").slice(0, 160)}\``;
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") return `${tool.toLowerCase()} ${input.file_path}`;
  if (tool === "Read") return `read ${input.file_path}`;
  if (tool === "WebFetch") return `fetch ${input.url}`;
  return `${tool} ${JSON.stringify(input).slice(0, 120)}`;
}

export function hash(s = "") { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

export const isVerify = (tool, input = {}) =>
  tool === "Bash" && /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check)\b|\b(vitest|jest|pytest|mocha|tsc|eslint|ruff|mypy)\b|\bnode\s+--test\b|\bcargo\s+(test|build|check)\b|\bgo\s+(test|build|vet)\b|\bmake\s+(test|check)\b/i.test(String(input.command ?? ""));

/**
 * Irreversible or outward-facing actions. Never decided by a model: the guard always brings the human in.
 * Kept deliberately narrow so it does not cry wolf on ordinary work.
 */
const RISKY = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b(?!\s+(\/tmp|\.\/node_modules|node_modules|dist|build|\.next|coverage)\b)/i, "deletes files recursively and cannot be undone"],
  [/\bgit\s+push\b[^\n]*(--force|-f\b|--force-with-lease)/i, "force-pushes and can overwrite other people's work"],
  [/\bgit\s+push\b[^\n]*\b(main|master|production|prod)\b/i, "pushes straight to a protected branch"],
  [/\bgit\s+reset\s+--hard\b/i, "throws away uncommitted work"],
  [/\bgit\s+clean\s+-[a-z]*f/i, "deletes untracked files"],
  [/\b(vercel|netlify)\b[^\n]*--prod\b|\bnpm\s+publish\b|\bfirebase\s+deploy\b|\bkubectl\s+(apply|delete)\b|\bterraform\s+(apply|destroy)\b/i, "deploys or publishes to the outside world"],
  [/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, "downloads code and runs it immediately"],
  [/\bdrop\s+(table|database)\b|\bdelete\s+from\s+\w+\s*;?\s*$|\btruncate\s+table\b/i, "deletes database data"],
  [/\bsudo\b/i, "runs with administrator rights"],
  [/tell application "Messages"|\bsendmail\b|\bmail\s+-s\b|api\.(sendgrid|twilio|stripe)\.com/i, "sends messages, email or payments to real people"],
  [/(cat|less|head|tail)\s+[^\n]*\.env\b[^\n]*\|\s*(curl|nc|wget)/i, "sends secrets over the network"],
];

export function riskOf(tool, input = {}) {
  if (tool !== "Bash") {
    const p = String(input.file_path ?? "");
    if ((tool === "Write" || tool === "Edit") && /(^|\/)\.(ssh|aws|gnupg)\//.test(p)) return { why: `edits ${p}, which holds credentials` };
    return null;
  }
  const cmd = String(input.command ?? "");
  for (const [re, why] of RISKY) if (re.test(cmd)) return { why };
  return null;
}

/** Loops, blind retries and undoing its own work. Returns a short finding, or null. Only actions that change things are judged. */
export function loopOf(history, tool, input = {}) {
  if (!TOOLS_THAT_ACT.has(tool)) return null;
  const key = keyOf(tool, input);
  const recent = history.slice(-8);
  const same = recent.filter((s) => s.key === key);
  const failedSame = same.filter((s) => s.ok === false);
  if (failedSame.length >= 2) return { kind: "blind_retry", why: `this exact action already failed ${failedSame.length} times (last error: ${failedSame.at(-1).error || "unknown"})` };
  if (same.length >= 3) return { kind: "loop", why: `this exact action was already done ${same.length} times in the last ${recent.length} steps` };
  if (tool === "Edit") {
    const undo = recent.find((s) => s.tool === "Edit" && s.file === input.file_path && s.newHash === hash(input.old_string) && s.oldHash === hash(input.new_string));
    if (undo) return { kind: "ping_pong", why: `this undoes an earlier edit to ${input.file_path}` };
  }
  return null;
}

/** Steps since the last success. Long failure streaks mean the run is stuck even if no single action repeats. */
export function failureStreak(history) {
  let n = 0;
  for (let i = history.length - 1; i >= 0 && history[i].ok === false; i--) n++;
  return n;
}

/** The last verification command (test/build/lint) and whether it passed. */
export function lastVerify(history) {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].verify) return history[i];
  return null;
}

/** Did the code change after the last verification ran? */
export function editedSinceVerify(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].verify) return false;
    if (["Edit", "Write", "MultiEdit"].includes(history[i].tool) && history[i].ok !== false) return true;
  }
  return false;
}

export const claimsDone = (text = "") => /\b(all (tests|checks) pass|tests? (are )?passing|(it|this|everything) (now )?works|(is|are) (now )?(fixed|done|complete|working)|successfully (fixed|implemented|completed)|ready to (ship|merge|deploy))\b/i.test(text);

/** The guard's verdict at the moment Claude tries to stop. */
export function stopCheck(history, lastMessage = "") {
  const v = lastVerify(history);
  if (v && v.ok === false) return { why: `the last check (${v.summary}) failed${v.error ? `: ${v.error}` : ""}. Fix it, or tell the user plainly that it still fails.` };
  if (claimsDone(lastMessage) && editedSinceVerify(history)) return { why: "you say it works, but the code changed after the last test or build ran (or none ran). Run the relevant check first, or say it is untested." };
  return null;
}
