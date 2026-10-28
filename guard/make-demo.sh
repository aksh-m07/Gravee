#!/usr/bin/env bash
# Create a new, isolated coding session. Never deletes an existing demo or its settings.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
D="$ROOT/demo-project/session"
if [[ -e "$D" ]]; then
  echo "Preserving existing $D. Use it as-is, or choose a fresh directory manually."
  exit 0
fi
mkdir -p "$D"
cd "$D"
git init -q -b demo-result
cat > package.json <<'J'
{ "name": "graveyard-terminal-demo", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" } }
J
cat > price.js <<'J'
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
git add package.json price.js price.test.js
git -c user.email=demo@example.com -c user.name=demo commit -qm "isolated demo with a failing discount test"
R="$ROOT/demo-project/local-remote.git"
if [[ ! -e "$R" ]]; then git init -q --bare "$R"; fi
git remote add origin "$R"
node "$ROOT/guard/install.mjs" --project "$D"
echo "Ready: cd $D"
echo "Then run: $ROOT/demo-project/cli/node_modules/.bin/claude"
echo "Only the demo's local remote is configured. No global hooks were installed."
