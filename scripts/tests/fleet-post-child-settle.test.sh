#!/usr/bin/env bash
# Regression: after a bench child finishes, run-bench-fleet's autoscaler must not
# idle the paid primary for the full finalization budget (~86 min) waiting for
# worker capacity that cannot arrive any more (the primary tears its stack down
# when the bench ends). Once nothing is in flight and the post-child grace has
# elapsed it must settle owned work. A finished task cannot use unallocated
# demand; in-flight provisioners (worker-*.pending) still get their budget and
# invalid capacity observations still fail closed.
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

# 1. Nothing in flight, terminal demand unallocated → settle without new workers.
AUTOSCALER_FINALIZATION_WAIT_SECONDS=600
new_case short 1
SECONDS=0
rc=0; complete_autoscaler_after_child || rc=$?
[ "$rc" -eq 0 ] || fail "settled terminal demand must complete (rc=$rc)"
[ "$SECONDS" -lt 30 ] || fail "settle took ${SECONDS}s; must not wait the finalization budget"
[ ! -e "$out/autoscaler.failed" ] || fail "unallocated terminal demand must not reject the finished task"
[ -e "$out/autoscaler.completed-after-child" ] || fail "settled terminal capacity must publish completion"
[ "$(cat "$out/autoscaler.completed-after-child")" = "0" ] || fail "completion must preserve the actual child exit code"
echo "✅ post-child unallocated terminal demand settles in ${SECONDS}s"

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

# 4. A malformed desired-capacity observation is still a hard failure.
new_case malformed unknown
SECONDS=0
rc=0; complete_autoscaler_after_child || rc=$?
[ "$rc" -eq 1 ] || fail "malformed capacity must fail closed (rc=$rc)"
grep -q "autoscaler never observed valid desired capacity" "$out/autoscaler.failed" \
    || fail "malformed capacity must retain its explicit failure verdict"
[ ! -e "$out/autoscaler.completed-after-child" ] || fail "malformed capacity must not publish completion"
[ "$SECONDS" -lt 30 ] || fail "malformed capacity must fail promptly (took ${SECONDS}s)"
echo "✅ malformed desired capacity fails closed without completion"

# 5. Settled infrastructure preserves a failed child's independent exit code.
new_case failed-child 1
printf '17\n' > "$out/benchmark-child.finished"
SECONDS=0
complete_autoscaler_after_child || fail "settled infrastructure must retain the finished child result"
[ "$(cat "$out/autoscaler.completed-after-child")" = "17" ] || fail "completion must not replace a failed child exit code"
[ ! -e "$out/autoscaler.failed" ] || fail "a benchmark failure is not an infrastructure failure"
[ "$SECONDS" -lt 30 ] || fail "failed-child settlement must not wait the finalization budget"
echo "✅ settled infrastructure preserves the failed child exit code"

# 6. A failed observation records command statuses without exposing its value.
# Both collaborator faults leave a real, valid capacity file in place, as in
# the captured I28 terminal state. They are controlled faults, not a claim
# about which operation failed on the original controller.
cat() {
    if [ "${TEST_CAPACITY_READ_MODE:-}" = fail ] && [ "${1:-}" = "$out/desired-worker-count" ]; then
        return 7
    fi
    if [ "${TEST_CAPACITY_READ_MODE:-}" = partial ] && [ "${1:-}" = "$out/desired-worker-count" ]; then
        printf '0\n'
        return 7
    fi
    command cat "$@"
}
grep() {
    if [ "${TEST_CAPACITY_VALIDATOR_FAIL:-0}" = 1 ] && [ "${1:-}" = -Eq ]; then
        return 2
    fi
    command grep "$@"
}
for fault in read validator invalid; do
    new_case "diagnostic-$fault" 0
    : > "$out/autoscaler.ready"
    TEST_CAPACITY_READ_MODE=""; TEST_CAPACITY_VALIDATOR_FAIL=0
    case "$fault" in
        read) TEST_CAPACITY_READ_MODE=fail; expected='read_exit=7 validation_exit=1 printf_exit=0 readiness=1' ;;
        validator) TEST_CAPACITY_VALIDATOR_FAIL=1; expected='read_exit=0 validation_exit=2 printf_exit=0 readiness=1' ;;
        invalid)
            printf 'private-invalid-value\n' > "$out/desired-worker-count"
            expected='read_exit=0 validation_exit=1 printf_exit=0 readiness=1' ;;
    esac
    rc=0; complete_autoscaler_after_child 2> "$out/diagnostic.log" || rc=$?
    [ "$rc" = 1 ] || fail "$fault must retain its failure"
    TEST_CAPACITY_READ_MODE=""; TEST_CAPACITY_VALIDATOR_FAIL=0
    grep -Fq "$expected" "$out/diagnostic.log" || fail "$fault command statuses missing"
    ! grep -Fq 'private-invalid-value' "$out/diagnostic.log" || fail "invalid value leaked"
    grep -Fq 'autoscaler never observed valid desired capacity' "$out/autoscaler.failed" \
        || fail "$fault changed the existing durable failure reason"
    [ ! -e "$out/autoscaler.completed-after-child" ] || fail "$fault published completion"
done
echo '✅ capacity failures retain classification and record bounded command statuses'

# Readiness and valid zero retain their independent semantics. A partial read
# whose numeric output already passed the old validator still passes: this
# diagnostics-only change must not introduce a new acceptance predicate.
new_case diagnostic-before-ready unknown
rc=0; complete_autoscaler_after_child 2> "$out/diagnostic.log" || rc=$?
[ "$rc" = 1 ] || fail 'invalid pre-ready observation must fail'
grep -Fq 'readiness=0' "$out/diagnostic.log" || fail 'pre-ready state not recorded'
for read_mode in normal partial; do
    new_case "diagnostic-zero-$read_mode" 0
    TEST_CAPACITY_READ_MODE="$read_mode"
    complete_autoscaler_after_child 2> "$out/diagnostic.log" || fail 'valid zero behavior changed'
    TEST_CAPACITY_READ_MODE=""
    [ -e "$out/autoscaler.completed-after-child" ] || fail 'valid zero completion missing'
    [ ! -s "$out/diagnostic.log" ] || fail 'valid zero emitted failure diagnostics'
done
echo '✅ readiness coverage and valid-zero acceptance remain unchanged'
