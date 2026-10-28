"""Portable standard-library verifier. Run ONLY on a disposable verifier computer.

This executes the explicitly exported Python acceptance test, never report content.
It does not sandbox Python: review the tiny candidate before running it.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python3 verify-request.py request.json NEW_OUTPUT_DIRECTORY")
    source = Path(sys.argv[1])
    if source.is_symlink() or source.stat().st_size > 256_000:
        raise SystemExit("Unsafe/oversized request")
    request = json.loads(source.read_text())
    if request.get("schemaVersion") != 1 or not re.fullmatch(r"[a-f0-9]{32}", request.get("requestId", "")):
        raise SystemExit("Invalid request")
    command = ["python3", "-m", "unittest", "-v", "test_price.py"]
    if request["checks"] != [{"id": "acceptance", "command": command}]:
        raise SystemExit("Unsupported check; no commands executed")
    files = request["files"]
    if not 1 <= len(files) <= 12:
        raise SystemExit("Invalid allowlist")
    manifest = []
    names = set()
    for f in files:
        name = f["path"]
        if not re.fullmatch(r"[A-Za-z0-9_/-]+\.(py|js|mjs|cjs|json|txt|md)", name) or name.startswith("/") or any(p in ("", ".", "..", "node_modules", "__pycache__") for p in name.split("/")) or name in names:
            raise SystemExit("Unsafe/duplicate candidate path")
        names.add(name)
        data = f["content"].encode("utf-8")
        if len(data) != f["size"] or len(data) > 64_000 or digest(data) != f["sha256"]:
            raise SystemExit("Candidate content mismatch")
        manifest.append({"path": name, "size": len(data), "sha256": digest(data)})
    canonical = json.dumps(manifest, separators=(",", ":"), ensure_ascii=False).encode()
    if manifest != request["manifest"] or digest(canonical) != request["candidateDigest"]:
        raise SystemExit("Candidate manifest mismatch")
    output = Path(sys.argv[2])
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="graveyard-verifier-") as temp:
        root = Path(temp)
        for f in files:
            target = root / f["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f["content"], encoding="utf-8")
        # No dependency installation, network, shell interpretation or candidate edits.
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
        try:
            run = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True, timeout=30)
            exit_status = run.returncode if 0 <= run.returncode <= 255 else None
            text = "STDOUT:\n" + run.stdout + "\nSTDERR:\n" + run.stderr
            # Setup/import/runtime errors do not establish acceptance failure.
            result = "passed" if exit_status == 0 and re.search(r"\bRan [1-9][0-9]* tests?\b", text) and re.search(r"\nOK\b", text) else "failed" if exit_status == 1 and re.search(r"FAILED \(failures=[1-9][0-9]*\)", text) else "inconclusive"
            if result == "passed" and re.search(r"\b(skipped|expected failures|unexpected successes|errors)\s*=|^ERROR:|^FAIL:|^FAILED ", text, re.MULTILINE):
                result = "inconclusive"
        except (OSError, subprocess.TimeoutExpired) as error:
            exit_status, result, text = None, "inconclusive", "Environment/setup failure: " + str(error)
        unchanged = all((root / f["path"]).is_file() and not (root / f["path"]).is_symlink() and digest((root / f["path"]).read_bytes()) == f["sha256"] for f in files)
        if not unchanged:
            result = "inconclusive"
        limitations = ["Manual file handoff; report identity is not cryptographic proof of execution.", "Checks cover the supplied acceptance tests only; no production correctness claim."]
        if result == "inconclusive":
            limitations.append("Setup, execution, or unchanged-snapshot evidence is incomplete; keep work incomplete.")
        if len(text) > 48_000:
            text, result = text[:47_900] + "\n[TRUNCATED: verification inconclusive]", "inconclusive"
            limitations.append("Command output exceeded the evidence limit.")
        report = {"schemaVersion": 1, "requestId": request["requestId"], "candidateDigest": request["candidateDigest"], "verifier": "GrokBot (manual file handoff; provenance requires observation)", "result": result,
                  "checks": [{"id": "acceptance", "command": command, "status": result, "exitStatus": exit_status, "output": text, "candidateUnchanged": unchanged}],
                  "findings": ["Observed acceptance command result: " + result + ". See captured output; hypotheses are not execution evidence."], "limitations": limitations,
                  "environment": platform.platform() + "; Python " + platform.python_version()}
        (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        (output / "acceptance-output.txt").write_text(text, encoding="utf-8")
        print(json.dumps({"requestId": request["requestId"], "candidateDigest": request["candidateDigest"], "result": result, "candidateUnchanged": unchanged, "report": str(output / "report.json")}, indent=2))


if __name__ == "__main__":
    main()
