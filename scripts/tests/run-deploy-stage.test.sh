#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
RUN_ROOT="$TEST_ROOT/default"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

run_stage() {
    DEPLOY_RUN_ROOT="$RUN_ROOT" bash "$ROOT_DIR/scripts/run-deploy-stage" "$@"
}

# Timed stages stay in one Python supervisor process. Reintroducing the old
# shell -> logger -> three lifecycle-CLI process chain adds almost a second to
# every deploy gate and makes signal ownership ambiguous.
grep -Fq 'exec python3 "$STAGE_RUNNER"' "$ROOT_DIR/scripts/run-deploy-stage" \
    || fail "timed stages are not delegated to the single-process runner"
grep -Fq 'ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"' \
    "$ROOT_DIR/scripts/run-deploy-stage" \
    || fail "stage wrapper pays for git root discovery on every invocation"

# A successful finish closes the run and prevents later stages from corrupting it.
RUN_ROOT="$TEST_ROOT/lifecycle"
run_stage --start --run-id lifecycle >/dev/null
if run_stage --start --run-id replacement >"$TEST_ROOT/replacement.out" 2>&1; then
    fail "replaced an active timing run"
fi
grep -q "deploy timing run already active" "$TEST_ROOT/replacement.out" \
    || fail "missing active-run diagnostic"
run_stage sample -- bash -c 'printf "sample output\n"' >/dev/null
run_stage --finish >/dev/null
[ ! -e "$RUN_ROOT/current" ] || fail "finish left the current-run pointer behind"
if run_stage late -- true >"$TEST_ROOT/late.out" 2>&1; then
    fail "stage appended without an active timing run"
fi
grep -q "no active deploy timing run" "$TEST_ROOT/late.out" \
    || fail "missing inactive-run diagnostic"

# Successful deterministic gates may be reused only for an identical command
# and exact worktree snapshot in the same deploy. Failures are never reusable.
RUN_ROOT="$TEST_ROOT/reuse"
run_stage --start --run-id reuse >/dev/null
counter="$TEST_ROOT/reuse-counter"
run_stage cached --reuse-passed -- bash -c 'printf "run\n" >> "$1"' _ "$counter" >/dev/null
run_stage cached --reuse-passed -- bash -c 'printf "run\n" >> "$1"' _ "$counter" >"$TEST_ROOT/reused.out"
[ "$(wc -l < "$counter" | tr -d ' ')" = 1 ] || fail "identical passed gate executed twice"
grep -q "reused passed deploy stage" "$TEST_ROOT/reused.out" || fail "cache hit was not disclosed"
run_stage cached --reuse-passed -- bash -c 'printf "changed-command\n" >> "$1"' _ "$counter" >/dev/null
[ "$(wc -l < "$counter" | tr -d ' ')" = 2 ] || fail "changed command reused stale evidence"
failed_counter="$TEST_ROOT/reuse-failed-counter"
for _ in 1 2; do
    if run_stage failed-cache --reuse-passed -- bash -c 'printf "failed\n" >> "$1"; exit 1' _ "$failed_counter" >/dev/null; then
        fail "failing cache fixture reported success"
    fi
done
[ "$(wc -l < "$failed_counter" | tr -d ' ')" = 2 ] || fail "failed gate was reused"
run_stage --finish >/dev/null

# A failed finalize must remain non-zero even though summary rendering succeeds,
# and the pointer stays available so the operator can repair/retry the run.
RUN_ROOT="$TEST_ROOT/finalize"
run_stage --start --run-id finalize-failure >/dev/null
printf '{not-json\n' > "$RUN_ROOT/finalize-failure/metadata.json"
if run_stage --finish >"$TEST_ROOT/finalize.out" 2>&1; then
    fail "finalize failure was masked by summary"
fi
[ "$(sed -n '1p' "$RUN_ROOT/current")" = "finalize-failure" ] \
    || fail "failed finalize discarded the active-run pointer"

# A timing append failure is visible but never changes a successful gate result.
RUN_ROOT="$TEST_ROOT/append"
run_stage --start --run-id append-warning >/dev/null
mkdir "$RUN_ROOT/append-warning/stages.jsonl"
run_stage append-warning -- true >"$TEST_ROOT/append.out" 2>&1 \
    || fail "append failure replaced the gate's successful result"
grep -q "warning: could not append deploy stage record" "$TEST_ROOT/append.out" \
    || fail "append failure was silent"
[ -z "$(find "$RUN_ROOT/append-warning/admissions" -name '*.json' -print)" ] \
    || fail "append failure leaked a stage admission"

# Environment-controlled IDs may not escape their artifact roots.
RUN_ROOT="$TEST_ROOT/invalid"
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

# Signals must reach the supervised command promptly, preserve shell exit codes,
# and release their lifecycle admission.
RUN_ROOT="$TEST_ROOT/signal"
run_stage --start --run-id signal >/dev/null
set +e
DEPLOY_RUN_ROOT="$RUN_ROOT" bash "$ROOT_DIR/scripts/run-deploy-stage" \
    signal -- bash -c 'sleep 30' >"$TEST_ROOT/signal.out" 2>&1 &
wrapper_pid=$!
sleep 0.1
kill -TERM "$wrapper_pid"
wait "$wrapper_pid"
signal_exit=$?
set -e
[ "$signal_exit" -eq 143 ] || fail "signal exit was $signal_exit, expected 143"
run_stage --finish >/dev/null

# Initialization errors must fail the command without publishing the broken run.
RUN_ROOT="$TEST_ROOT/init"
mkdir -p "$RUN_ROOT/init-failure/metadata.json"
if run_stage --start --run-id init-failure >"$TEST_ROOT/init.out" 2>&1; then
    fail "initialization failure reported success"
fi
grep -q "failed to initialize deploy timing run" "$TEST_ROOT/init.out" \
    || fail "missing initialization-failure diagnostic"
[ ! -e "$RUN_ROOT/current" ] || fail "failed initialization published a current run"

# Finish closes admission before waiting, so a late stage is rejected while an
# already-admitted stage completes and records its result.
RUN_ROOT="$TEST_ROOT/concurrent"
run_stage --start --run-id concurrent >/dev/null
run_stage slow -- bash -c 'sleep 1' >"$TEST_ROOT/slow.out" 2>&1 &
slow_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
    find "$RUN_ROOT/concurrent/admissions" -name '*.json' -print -quit 2>/dev/null | grep -q . && break
    sleep 0.05
done
run_stage --finish >"$TEST_ROOT/concurrent-finish.out" 2>&1 &
finish_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
    grep -q '"status": "finishing"' "$RUN_ROOT/concurrent/metadata.json" && break
    sleep 0.05
done
grep -q '"status": "finishing"' "$RUN_ROOT/concurrent/metadata.json" \
    || fail "finish did not close stage admission"
if run_stage late -- true >"$TEST_ROOT/concurrent-late.out" 2>&1; then
    fail "admitted a stage after finish began"
fi
wait "$slow_pid" || fail "admitted stage failed during finish"
wait "$finish_pid" || fail "finish failed while waiting for an admitted stage"
[ ! -e "$RUN_ROOT/current" ] || fail "concurrent finish left the pointer behind"
grep -q '"stage":"slow"' "$RUN_ROOT/concurrent/stages.jsonl" \
    || fail "finish raced the admitted stage append"
python3 - "$RUN_ROOT/concurrent" <<'PY'
import json
import sys
from pathlib import Path

run_dir = Path(sys.argv[1])
metadata = json.loads((run_dir / "metadata.json").read_text())
stage = json.loads((run_dir / "stages.jsonl").read_text().splitlines()[0])
if metadata["finished_epoch"] < stage["finished_epoch"]:
    raise SystemExit("finish timestamp predates an admitted stage")
PY

echo "run-deploy-stage regression tests passed"
