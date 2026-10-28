import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
export const fingerprint = ({ sid, tool, input, cwd }) => crypto.createHash("sha256").update(JSON.stringify(canonical({ sid, tool, input, cwd }))).digest("hex");
export const sessionStopFile = (home, sid) => path.join(home, "sessions", `${crypto.createHash("sha256").update(String(sid)).digest("hex")}.json.stopped`);

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
}

export class DecisionStore {
  constructor(home, now = Date.now) { this.home = home; this.now = now; }
  file(id) { if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Invalid decision identifier"); return path.join(this.home, "decisions", `${id}.json`); }
  get(id) { return readJson(this.file(id)); }
  save(d) { writeJson(this.file(d.id), d); return d; }
  active() { const a = readJson(path.join(this.home, "active.json")); return a ? this.get(a.id) : null; }
  create({ sid, actionHash, owner, chat, expiresAt, briefing, approvalEligible, evidence = [] }) {
    const old = this.active();
    if (old && ["pending", "approved"].includes(old.status)) throw new Error("A decision is already active");
    const d = { id: crypto.randomBytes(8).toString("hex"), sid, actionHash, owner, chat, expiresAt, briefing,
      approvalEligible, evidence, userTurns: 0, modelRequests: 0, conversation: [], seenUpdateIds: [],
      status: "pending", consumed: false, delivery: "unsent", messageId: null, replyMessageIds: [], replies: [], clarified: false, guidancePrompted: false, pid: process.pid };
    this.save(d); writeJson(path.join(this.home, "active.json"), { id: d.id }); return d;
  }
  validate(id, scope) {
    const d = this.get(id);
    if (!d || this.active()?.id !== id || d.sid !== scope.sid || d.actionHash !== scope.actionHash || d.owner !== scope.owner || d.chat !== scope.chat) return null;
    if (this.now() >= d.expiresAt && ["pending", "approved"].includes(d.status)) { d.status = "expired"; this.save(d); }
    return d;
  }
  resolve(id, scope, reply, interpreted) {
    const d = this.validate(id, scope);
    if (!d || d.status !== "pending") return null;
    d.replies.push({ original: reply, interpreted, at: this.now() });
    if (interpreted === "ambiguous") { this.save(d); return d; }
    d.originalReply = reply; d.interpreted = interpreted;
    // Persist the session veto first: interruption cannot lose an owner's Stop.
    if (interpreted === "stop") writeJson(sessionStopFile(this.home, d.sid), { stopped: true, decision: d.id, at: this.now() });
    d.status = interpreted === "approve" ? "approved" : interpreted === "stop" ? "cancelled" : interpreted;
    return this.save(d);
  }
  consume(id, scope) {
    const d = this.validate(id, scope);
    if (!d || d.status !== "approved" || d.consumed || !d.approvalEligible) return false;
    d.consumed = true; d.status = "consumed"; this.save(d); return true;
  }
  invalidateActive(status = "interrupted") {
    const d = this.active();
    if (d && ["pending", "approved"].includes(d.status)) { d.status = status; this.save(d); }
  }
}

/** One Bot API update consumer across hooks, pairing and smoke commands. Never steal a live lock. */
export function acquireConsumer(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = path.join(home, "telegram.lock");
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    const held = readJson(path.join(lock, "owner.json"));
    if (!held) throw new Error("Telegram consumer lock is incomplete; inspect it locally before removal");
    let alive = true;
    try { process.kill(held.pid, 0); } catch (err) { if (err.code === "ESRCH") alive = false; }
    if (alive) throw new Error("Another Telegram consumer is active");
    const recovery = path.join(home, "telegram-recovery.lock");
    try { fs.mkdirSync(recovery, { mode: 0o700 }); }
    catch { throw new Error("Telegram consumer recovery is already active; inspect abandoned recovery locks locally"); }
    try {
      const current = readJson(path.join(lock, "owner.json"));
      if (!current || current.pid !== held.pid) throw new Error("Consumer ownership changed during recovery");
      new DecisionStore(home).invalidateActive();
      fs.rmSync(lock, { recursive: true });
      // If another normal acquire wins this gap, mkdir fails and we never remove its lock.
      fs.mkdirSync(lock, { mode: 0o700 });
    } finally { fs.rmSync(recovery, { recursive: true }); }
  }
  writeJson(path.join(lock, "owner.json"), { pid: process.pid });
  // Any prior approval/pending state is uncertain when a new consumer starts. Never replay it.
  new DecisionStore(home).invalidateActive();
  return () => { if (readJson(path.join(lock, "owner.json"))?.pid === process.pid) fs.rmSync(lock, { recursive: true, force: true }); };
}
