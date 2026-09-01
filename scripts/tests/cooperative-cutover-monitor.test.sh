#!/usr/bin/env bash
# Contract: cooperative cutover monitor exists and /deploy uses it for handover verification.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY="$ROOT/.claude/commands/deploy.md"
MONITOR="$ROOT/back-end/scripts/monitor-cooperative-cutover.ts"

fail() { echo "FAIL: $*" >&2; exit 1; }

require_text() {
  local file=$1 needle=$2 msg=$3
  grep -Fq -- "$needle" "$file" || fail "$msg (missing: $needle in $file)"
}

[ -f "$MONITOR" ] || fail "monitor-cooperative-cutover.ts must exist"

require_text "$MONITOR" '--verify' "monitor must support --verify gate"
require_text "$MONITOR" '--expected-hash' "monitor must accept expected surface hash"
require_text "$MONITOR" 'draining_old_generation' "monitor must report draining phase"
require_text "$MONITOR" 'cooperative_drain_complete' "monitor must report drain complete phase"

require_text "$DEPLOY" 'monitor-cooperative-cutover.ts' \
  "/deploy must use the cooperative cutover monitor"
require_text "$DEPLOY" 'stage-start cooperative-cutover' \
  "/deploy must record cooperative-cutover stage start"
require_text "$DEPLOY" 'stage-finish cooperative-cutover' \
  "/deploy must record cooperative-cutover stage finish"
require_text "$DEPLOY" 'cooperative cutover handover progress' \
  "/deploy must report handover progress during the CI watch"
require_text "$DEPLOY" 'monitor-cooperative-cutover.ts' \
  "/deploy Step 13ab must verify via monitor --verify"

echo "cooperative cutover monitor structural tests: PASS"
