#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

run_stage() {
    DEPLOY_RUN_ROOT="$TEST_ROOT/runs" bash "$ROOT_DIR/scripts/run-deploy-stage" "$@"
}

# A successful finish closes the run and prevents later stages from corrupting it.
run_stage --start --run-id lifecycle >/dev/null
run_stage sample -- bash -c 'printf "sample output\n"' >/dev/null
run_stage --finish >/dev/null
[ ! -e "$TEST_ROOT/runs/current" ] || fail "finish left the current-run pointer behind"
if run_stage late -- true >"$TEST_ROOT/late.out" 2>&1; then
    fail "stage appended without an active timing run"
fi
grep -q "no active deploy timing run" "$TEST_ROOT/late.out" \
    || fail "missing inactive-run diagnostic"

# A failed finalize must remain non-zero even though summary rendering succeeds,
# and the pointer stays available so the operator can repair/retry the run.
run_stage --start --run-id finalize-failure >/dev/null
printf '{not-json\n' > "$TEST_ROOT/runs/finalize-failure/metadata.json"
if run_stage --finish >"$TEST_ROOT/finalize.out" 2>&1; then
    fail "finalize failure was masked by summary"
fi
[ "$(sed -n '1p' "$TEST_ROOT/runs/current")" = "finalize-failure" ] \
    || fail "failed finalize discarded the active-run pointer"

# A timing append failure is visible but never changes a successful gate result.
run_stage --start --run-id append-warning >/dev/null
mkdir "$TEST_ROOT/runs/append-warning/stages.jsonl"
run_stage append-warning -- true >"$TEST_ROOT/append.out" 2>&1 \
    || fail "append failure replaced the gate's successful result"
grep -q "warning: could not append deploy stage record" "$TEST_ROOT/append.out" \
    || fail "append failure was silent"

# Environment-controlled IDs may not escape their artifact roots.
for invalid_id in . .. ../escape bad/id; do
    if run_stage --start --run-id "$invalid_id" >"$TEST_ROOT/invalid.out" 2>&1; then
        fail "accepted invalid deploy run id: $invalid_id"
    fi
done
for invalid_id in . .. ../escape bad/id; do
    if PREDEPLOY_RUN_ID="$invalid_id" bash "$ROOT_DIR/scripts/run-predeploy-local" \
        >"$TEST_ROOT/predeploy-invalid.out" 2>&1; then
        fail "accepted invalid pre-deploy run id: $invalid_id"
    fi
    grep -q "invalid pre-deploy run id" "$TEST_ROOT/predeploy-invalid.out" \
        || fail "missing pre-deploy invalid-id diagnostic"
done

# Signals must reach the supervised command promptly and preserve shell exit codes.
run_stage --start --run-id signal >/dev/null
set +e
run_stage signal -- bash -c 'sleep 30' >"$TEST_ROOT/signal.out" 2>&1 &
wrapper_pid=$!
sleep 0.1
kill -TERM "$wrapper_pid"
wait "$wrapper_pid"
signal_exit=$?
set -e
[ "$signal_exit" -eq 143 ] || fail "signal exit was $signal_exit, expected 143"

# Initialization errors must fail the command without publishing the broken run.
mkdir -p "$TEST_ROOT/runs/init-failure/metadata.json"
if run_stage --start --run-id init-failure >"$TEST_ROOT/init.out" 2>&1; then
    fail "initialization failure reported success"
fi
grep -q "failed to initialize deploy timing run" "$TEST_ROOT/init.out" \
    || fail "missing initialization-failure diagnostic"
[ "$(sed -n '1p' "$TEST_ROOT/runs/current")" = "signal" ] \
    || fail "failed initialization replaced the current-run pointer"

echo "run-deploy-stage regression tests passed"
