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

CUTOVER="$ROOT/scripts/deploy-agents-cooperative-cutover.sh"
[ -f "$CUTOVER" ] || fail "deploy-agents-cooperative-cutover.sh must exist"
require_text "$CUTOVER" 'count_open_on_queue' \
  "cutover must sanitize Temporal stdout before comparing open-workflow counts"
require_text "$CUTOVER" '/^[0-9]+$/' \
  "cutover open-count sanitizer must keep only pure integer lines"
require_text "$CUTOVER" 'status=$?' \
  "cutover must capture count-script exit status (not mask with || true)"
# Guard against regressing to `raw="$(... || true)"` which treats failed
# counts (count printed, then disconnect/exit 1) as successful integers.
if grep -n 'count-open-workflows-on-queue' "$CUTOVER" | grep -F '|| true' >/dev/null; then
  fail "count_open_on_queue must not mask count-script failures with || true"
fi

# Extractor contract: INFO lines on stdout must not prevent seeing 0.
extract_open() {
  printf '%s\n' "$1" | awk '/^[0-9]+$/{n=$0} END{if (n == "") print "?"; else print n}'
}
got="$(extract_open $'[2026-09-04T00:55:30.771Z] INFO [Temporal] Connecting...\n0')"
[ "$got" = "0" ] || fail "polluted Temporal stdout must still yield open-count 0 (got: $got)"
got="$(extract_open $'not-a-number\n')"
[ "$got" = "?" ] || fail "non-integer stdout must yield ? (got: $got)"

# Failure-status contract: nonzero exit must yield "?" even if stdout had a digit.
extract_open_with_status() {
  local raw=$1 status=$2
  if [ "$status" -ne 0 ]; then
    printf '?\n'
    return 0
  fi
  extract_open "$raw"
}
got="$(extract_open_with_status $'0' 1)"
[ "$got" = "?" ] || fail "nonzero count-script status must yield ? (got: $got)"
got="$(extract_open_with_status $'0' 0)"
[ "$got" = "0" ] || fail "successful count-script status must keep integer (got: $got)"

# Same-surface deploys must not stop live-generation machines by position:
# `machines stop` SIGTERMs workers mid-activity (30m browser runs die after the
# 5m grace). Only the idle-aware autoscaler may scale the live generation down,
# and the only `machines stop` left is old-gen retirement after drain.
same_surface_block="$(awk '/CURRENT_HASH" = "\$SURFACE_HASH"/{p=1} p{print} p&&/^fi$/{exit}' "$CUTOVER")"
[ -n "$same_surface_block" ] || fail "could not locate the same-surface rolling deploy block"
if grep -q 'machines stop' <<<"$same_surface_block"; then
  fail "same-surface rolling deploy must not stop live-generation machines (autoscaler owns idle-only scale-down)"
fi
stop_calls="$(grep -c 'flyctl machines stop' "$CUTOVER" || true)"
[ "$stop_calls" = "1" ] || fail "cutover must only stop old-gen machines during retirement (found $stop_calls stop calls)"

WORKFLOW="$ROOT/.github/workflows/deploy-agents.yml"
require_text "$CUTOVER" 'timeout --kill-after=30s 120' \
  "old-gen retire must SIGKILL-follow hung flyctl stop/destroy"
require_text "$CUTOVER" 'retire_deadline' \
  "old-gen retire must bound total wall-clock across all machines"
require_text "$WORKFLOW" 'timeout-minutes: 90' \
  "cutover step must allow >60m headroom past the 45m drain SLO"

echo "cooperative cutover monitor structural tests: PASS"
