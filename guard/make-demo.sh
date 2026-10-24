#!/usr/bin/env bash
# Recreate demo-project/: a tiny repo with a real bug, failing tests, a local "remote", and the guard installed for that project only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; D="$ROOT/demo-project"; R="$ROOT/demo-remote.git"
rm -rf "$D" "$R"; mkdir -p "$D/.claude"; cd "$D"; git init -q
cat > package.json <<'J'
{ "name": "demo", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" } }
J
cat > price.js <<'J'
// Applies a percentage discount and returns the price in cents, rounded to the nearest cent.
export function discounted(cents, percent) {
  return cents - cents * percent;
}
J
cat > price.test.js <<'J'
import { test } from "node:test";
import assert from "node:assert/strict";
import { discounted } from "./price.js";
test("20% off 1000 cents is 800", () => assert.equal(discounted(1000, 20), 800));
test("rounds to the nearest cent", () => assert.equal(discounted(999, 15), 849));
J
H="$ROOT/guard/hook.mjs"
hook() { printf '[{ %s"hooks": [{ "type": "command", "command": "node", "args": ["%s"], "timeout": %s }] }]' "$1" "$H" "$2"; }
cat > .claude/settings.json <<J
{ "hooks": {
  "UserPromptSubmit": $(hook "" 10),
  "PreToolUse": $(hook '"matcher": "*", ' 45),
  "PostToolUse": $(hook '"matcher": "*", ' 10),
  "PostToolUseFailure": $(hook '"matcher": "*", ' 10),
  "Stop": $(hook "" 10)
} }
J
git add -A && git -c user.email=demo@example.com -c user.name=demo commit -qm "demo project with a bug"
git init -q --bare "$R" && git remote add origin "$R" && git push -q origin main
echo "demo-project ready: cd $D && claude"
