import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { readJson, writeJson } from "./decisions.mjs";
import { redact } from "./config.mjs";

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const RESULTS = ["passed", "failed", "inconclusive"];
const COMMAND = ["python3", "-m", "unittest", "-v", "test_price.py"];
const plain = (x) => x && typeof x === "object" && !Array.isArray(x);
const str = (x, max = 4000) => typeof x === "string" && x.trim().length > 0 && x.length <= max;
const strings = (x, max = 20) => Array.isArray(x) && x.length <= max && x.every((v) => str(v));
function requireThat(ok, message) { if (!ok) throw new Error(message); }
function fields(x, names) { requireThat(plain(x) && Object.keys(x).every((k) => names.includes(k)) && names.every((k) => Object.hasOwn(x, k)), "Invalid schema fields"); }

export function safeCandidatePath(name) {
  requireThat(str(name, 180) && /^[A-Za-z0-9_/-]+\.(py|js|mjs|cjs|json|txt|md)$/.test(name), "Unsafe or unsupported candidate path");
  const parts = name.split("/");
  requireThat(!path.isAbsolute(name) && parts.every((p) => p && p !== "." && p !== ".." && !/^(node_modules|__pycache__|dist|build|coverage)$/i.test(p)), "Unsafe candidate path");
  requireThat(!/(^|[\/_-])(env|credentials?|secrets?|tokens?|auth|config|settings|service-account)([\/_\-.]|$)/i.test(name) && !/lock\.json$/i.test(name), "Configuration/secret files are excluded");
  return name;
}

function readCandidate(root, name) {
  safeCandidatePath(name);
  let current = root;
  for (const part of name.split("/")) {
    current = path.join(current, part);
    requireThat(!fs.lstatSync(current).isSymbolicLink(), "Candidate symlinks are excluded");
  }
  const st = fs.statSync(current);
  requireThat(st.isFile() && st.size <= 64_000, "Candidate must be a small regular file");
  const bytes = fs.readFileSync(current);
  const content = bytes.toString("utf8");
  requireThat(Buffer.from(content).equals(bytes) && !content.includes("\0"), "Candidate must be UTF-8 text");
  requireThat(redact(content) === content, "Possible credential in candidate; export refused");
  return { path: name, size: bytes.length, sha256: hash(bytes), content };
}

export function createRequest(project, spec, now = Date.now()) {
  fields(spec, ["task", "acceptanceCriteria", "files", "checks"]);
  requireThat(str(spec.task) && strings(spec.acceptanceCriteria) && spec.acceptanceCriteria.length > 0, "Task and acceptance criteria required");
  requireThat(Array.isArray(spec.files) && spec.files.length > 0 && spec.files.length <= 12 && new Set(spec.files).size === spec.files.length, "Explicit unique file allowlist required");
  requireThat(Array.isArray(spec.checks) && spec.checks.length === 1, "MVP supports one Python unittest acceptance check");
  const check = spec.checks[0]; fields(check, ["id", "command"]);
  requireThat(check.id === "acceptance" && JSON.stringify(check.command) === JSON.stringify(COMMAND), "Unsupported acceptance command");
  requireThat(spec.files.includes("test_price.py"), "Acceptance test must be exported");
  const root = fs.realpathSync(project);
  const files = [...spec.files].sort().map((name) => readCandidate(root, name));
  requireThat(files.reduce((n, f) => n + f.size, 0) <= 160_000, "Candidate too large");
  const manifest = files.map(({ path: p, size, sha256 }) => ({ path: p, size, sha256 }));
  let baseCommit = null;
  try { baseCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim(); } catch { /* disposable non-Git fixture */ }
  const request = { schemaVersion: 1, requestId: crypto.randomBytes(16).toString("hex"), createdAt: now, expiresAt: now + 86_400_000,
    task: spec.task, acceptanceCriteria: spec.acceptanceCriteria, baseCommit, candidateDigest: hash(JSON.stringify(manifest)), manifest, files, checks: spec.checks };
  requireThat(redact(JSON.stringify(request)) === JSON.stringify(request), "Possible credential in request; export refused");
  return request;
}

export function validateReport(request, report) {
  fields(report, ["schemaVersion", "requestId", "candidateDigest", "verifier", "result", "checks", "findings", "limitations", "environment"]);
  requireThat(report.schemaVersion === 1 && report.requestId === request.requestId && report.candidateDigest === request.candidateDigest, "Report request/snapshot mismatch");
  requireThat(str(report.verifier, 120) && RESULTS.includes(report.result) && strings(report.findings) && strings(report.limitations) && str(report.environment, 500), "Invalid report schema");
  requireThat(Array.isArray(report.checks) && report.checks.length === request.checks.length, "Missing required check evidence");
  const ids = new Set();
  for (const c of report.checks) {
    fields(c, ["id", "command", "status", "exitStatus", "output", "candidateUnchanged"]);
    const expected = request.checks.find((x) => x.id === c.id);
    requireThat(expected && !ids.has(c.id) && JSON.stringify(c.command) === JSON.stringify(expected.command), "Wrong or duplicate check"); ids.add(c.id);
    requireThat(RESULTS.includes(c.status) && (c.exitStatus === null || (Number.isSafeInteger(c.exitStatus) && c.exitStatus >= 0 && c.exitStatus <= 255)) && str(c.output, 48_000) && typeof c.candidateUnchanged === "boolean", "Invalid or missing command evidence");
    const ranTests = /\bRan [1-9][0-9]* tests?\b/.test(c.output);
    const incomplete = /\b(skipped|expected failures|unexpected successes|errors)\s*=|^ERROR:|^FAIL:|^FAILED /m.test(c.output);
    requireThat(c.status !== "passed" || (c.exitStatus === 0 && c.candidateUnchanged && ranTests && /\nOK\b/.test(c.output) && !incomplete), "Passed check contradicts evidence");
    requireThat(c.status !== "failed" || (c.exitStatus === 1 && c.candidateUnchanged && ranTests && /FAILED \(failures=[1-9][0-9]*\)/.test(c.output)), "Failed check contradicts evidence");
  }
  const derived = report.checks.some((c) => c.status === "inconclusive" || !c.candidateUnchanged) ? "inconclusive" : report.checks.some((c) => c.status === "failed") ? "failed" : "passed";
  requireThat(report.result === derived, "Overall result contradicts required checks");
  return derived;
}

export async function notifyVerification(store, id, api, config) {
  requireThat(config && /^\d+$/.test(config.owner) && config.chat === config.owner, "Paired private owner required");
  const message = await api.call("sendMessage", { chat_id: config.chat, text: store.briefing(id) });
  requireThat(String(message.chat?.id) === config.chat && message.chat?.type === "private", "Notification scope mismatch");
}

export class VerificationStore {
  constructor(home, now = Date.now) { this.root = path.join(home, "verification"); this.now = now; }
  dir(id) { requireThat(typeof id === "string" && /^[a-f0-9]{32}$/.test(id), "Invalid request identifier"); return path.join(this.root, id); }
  create(request) {
    const dir = this.dir(request.requestId); fs.mkdirSync(this.root, { recursive: true, mode: 0o700 }); fs.mkdirSync(dir, { mode: 0o700 });
    writeJson(path.join(dir, "request.json"), request);
    writeJson(path.join(dir, "status.json"), { requestId: request.requestId, candidateDigest: request.candidateDigest, status: "awaiting_external_verification", completed: false, provenance: "not_verified", expiresAt: request.expiresAt });
    return dir;
  }
  status(id) {
    const dir = this.dir(id), status = readJson(path.join(dir, "status.json")); requireThat(status, "Unknown verification request");
    if (status.status === "awaiting_external_verification" && this.now() >= status.expiresAt) { status.status = "expired"; writeJson(path.join(dir, "status.json"), status); }
    return status;
  }
  lock(id, fn) {
    const lock = path.join(this.dir(id), "import.lock"); fs.mkdirSync(lock, { mode: 0o700 });
    try { return fn(); } finally { fs.rmdirSync(lock); }
  }
  cancel(id) { return this.lock(id, () => { const s = this.status(id); requireThat(s.status === "awaiting_external_verification", "Request is not awaiting verification"); s.status = "cancelled"; writeJson(path.join(this.dir(id), "status.json"), s); return s; }); }
  import(id, raw, provenance = "manual_unverified") {
    requireThat(["manual_unverified", "operator_observed_grokbot", "user_attested_grokbot"].includes(provenance), "Unknown provenance label");
    requireThat(typeof raw === "string" && Buffer.byteLength(raw) <= 256_000, "Report too large");
    return this.lock(id, () => {
      const dir = this.dir(id), status = this.status(id);
      requireThat(status.status === "awaiting_external_verification", "Duplicate, expired or cancelled request");
      const request = readJson(path.join(dir, "request.json")); const report = JSON.parse(raw);
      const result = validateReport(request, report);
      // Never evaluate report content, open links, or execute its command/path fields.
      // Exclusive original write also prevents replay after a crash before status commit.
      fs.writeFileSync(path.join(dir, "original-report.json"), raw, { flag: "wx", mode: 0o600 });
      writeJson(path.join(dir, "evidence.json"), { checks: report.checks, findings: report.findings, limitations: report.limitations, environment: report.environment });
      const validated = { ...status, status: result, completed: result === "passed", importedAt: this.now(), verifier: report.verifier, provenance,
        provenanceLimit: "Snapshot association and local provenance attestation only; no cryptographic proof of execution", reportSha256: hash(raw) };
      writeJson(path.join(dir, "status.json"), validated); return validated;
    });
  }
  briefing(id) {
    const s = this.status(id), dir = this.dir(id), r = readJson(path.join(dir, "request.json")), e = readJson(path.join(dir, "evidence.json"));
    return redact([`External verification: ${s.status}; completed: ${s.completed}`, `Task: ${r.task}`, `Request: ${id}`, `Snapshot: ${s.candidateDigest}`,
      ...(e?.checks ?? []).map((c) => `${c.id}: ${c.status}, exit ${c.exitStatus ?? "unknown"}\n${c.output.slice(0, 650)}`),
      `Findings: ${e?.findings.join("; ") || "No imported findings"}`, `Limitations: ${e?.limitations.join("; ") || "External execution not yet evidenced"}`,
      `Provenance: ${s.provenance} (local attestation; snapshot matching does not prove execution)`,
      s.status === "passed" ? "Next decision: review evidence before accepting this snapshot. No action approval granted." : "Next decision: keep work incomplete; inspect the defect or resolve setup/evidence gaps, then export a new candidate.",
    ].join("\n")).slice(0, 3800);
  }
}
