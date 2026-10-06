#!/usr/bin/env bash
# Regression: after a bench child finishes, run-bench-fleet's autoscaler must not
# idle the paid primary for the full finalization budget (~86 min) waiting for
# worker capacity that cannot arrive any more (the primary tears its stack down
# when the bench ends). Once nothing is in flight and the post-child grace has
# elapsed it must settle with the same fail-closed verdict the deadline branch
# would reach. In-flight provisioners (worker-*.pending) still get their budget.
# The function under test is extracted from run-bench-fleet so this cannot drift.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLEET="$ROOT_DIR/scripts/run-bench-fleet"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "❌ $1" >&2; exit 1; }

# Extract the nested function (8-space body, closed by the first 4-space brace).
extract_nested() { sed -n "/^    $1() {/,/^    }/p" "$FLEET"; }
extract_top() { sed -n "/^$1() {/,/^}/p" "$FLEET"; }
eval "$(extract_nested complete_autoscaler_after_child)"
eval "$(extract_top _pool_ids)"
eval "$(extract_top _ready_pool_ids)"
[ "$(type -t complete_autoscaler_after_child)" = "function" ] || fail "could not extract complete_autoscaler_after_child"

# Collaborators the real autoscaler defines around the function.
reconcile_worker_ready_outcomes() { return 0; }
reconcile_worker_failure_outcomes() { return 0; }
fail_autoscaler() { [ -s "$out/autoscaler.failed" ] || printf '%s\n' "$1" > "$out/autoscaler.failed"; return 1; }

new_case() {
    out="$TMP/$1"; bench="probe-bench"
    mkdir -p "$out"
    printf '0\n' > "$out/benchmark-child.finished"
    printf '%s\n' "$2" > "$out/desired-worker-count"
    : > "$out/worker-clones.ids"; : > "$out/worker-ready.ids"
    rm -f "$out/autoscaler.failed" "$out/autoscaler.completed-after-child"
}

# 1. Nothing in flight, capacity short → settle after the grace, fail closed.
AUTOSCALER_FINALIZATION_WAIT_SECONDS=600
CLOUDBENCH_POST_CHILD_SETTLE_SECONDS=1
new_case short 1
SECONDS=0
rc=0; complete_autoscaler_after_child || rc=$?
[ "$rc" -eq 1 ] || fail "short capacity must fail closed (rc=$rc)"
[ "$SECONDS" -lt 30 ] || fail "settle took ${SECONDS}s; must not wait the finalization budget"
grep -q "worker capacity below desired: 0/1" "$out/autoscaler.failed" \
    || fail "expected the capacity verdict, got: $(cat "$out/autoscaler.failed" 2>/dev/null)"
[ ! -e "$out/autoscaler.completed-after-child" ] || fail "short capacity must not publish completion"
echo "✅ post-child short capacity settles in ${SECONDS}s with the fail-closed verdict"

# 2. A provisioner still in flight keeps its budget (no early settle).
AUTOSCALER_FINALIZATION_WAIT_SECONDS=3
new_case inflight 1
: > "$out/worker-abc.pending"
SECONDS=0
rc=0; complete_autoscaler_after_child || rc=$?
[ "$rc" -eq 1 ] || fail "in-flight case must fail closed at the deadline (rc=$rc)"
[ "$SECONDS" -ge 3 ] || fail "in-flight provisioner must be given the finalization budget (took ${SECONDS}s)"
echo "✅ in-flight provisioner keeps the finalization budget (${SECONDS}s)"

# 3. Capacity satisfied and settled → completion proof is published.
AUTOSCALER_FINALIZATION_WAIT_SECONDS=600
new_case ok 1
printf 'm1\n' > "$out/worker-clones.ids"; printf 'm1\n' > "$out/worker-ready.ids"
SECONDS=0
complete_autoscaler_after_child || fail "settled capacity must complete"
[ -e "$out/autoscaler.completed-after-child" ] || fail "completion proof missing"
[ "$SECONDS" -lt 30 ] || fail "settled capacity must complete immediately (took ${SECONDS}s)"
echo "✅ settled capacity publishes autoscaler.completed-after-child"
