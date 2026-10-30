#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
RUN_ROOT="$TEST_ROOT/default"
cleanup() {
    local result=$?
    touch "$TEST_ROOT/slow-release"
    for pid in "${slow_pid:-}" "${finish_pid:-}"; do
        if [ -n "$pid" ] && jobs -pr | grep -Fxq "$pid"; then
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done
    for pid in "${slow_pid:-}" "${finish_pid:-}"; do
        [ -z "$pid" ] || wait "$pid" 2>/dev/null || true
    done
    if [ "$result" -ne 0 ]; then
        local artifacts="${BLACKBOX_TEST_ARTIFACT_DIR:-$ROOT_DIR/.context/test-runs}"
        local retained="$artifacts/deploy-stage-$(date -u +%Y%m%dT%H%M%SZ)-$$"
        if mkdir -p "$artifacts" && mkdir -m 700 "$retained"; then
            cp -R "$TEST_ROOT/." "$retained/" 2>/dev/null || true
            echo "deploy-stage fixture retained: $retained" >&2
        fi
    fi
    rm -rf "$TEST_ROOT"
    return "$result"
}
trap cleanup EXIT

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
# The snapshot is a whole-worktree fingerprint, so this runs in its own
# committed fixture repository: on a shared checkout another editor can change
# the real tree between the two calls ("deploy inputs changed while cached
# ran") and the reuse miss would be the environment, not the runner.
REUSE_REPO="$TEST_ROOT/reuse-repo"
mkdir -p "$REUSE_REPO/scripts"
cp "$ROOT_DIR/scripts/run-deploy-stage" "$ROOT_DIR/scripts/run_deploy_stage.py" \
    "$ROOT_DIR/scripts/deploy_stage.py" "$ROOT_DIR/scripts/factory_metadata.py" \
    "$ROOT_DIR/scripts/factory_detail.py" "$REUSE_REPO/scripts/"
printf 'fixture\n' > "$REUSE_REPO/README"
printf '.context/\n' > "$REUSE_REPO/.gitignore"
git -C "$REUSE_REPO" init -q
git -C "$REUSE_REPO" add -A
git -C "$REUSE_REPO" -c user.name=t -c user.email=t@t commit -qm fixture
RUN_ROOT="$TEST_ROOT/reuse"
reuse_stage() {
    (cd "$REUSE_REPO" && DEPLOY_RUN_ROOT="$RUN_ROOT" bash scripts/run-deploy-stage "$@")
}
reuse_stage --start --run-id reuse >/dev/null
counter="$TEST_ROOT/reuse-counter"
reuse_stage cached --reuse-passed -- bash -c 'printf "run\n" >> "$1"' _ "$counter" >/dev/null
reuse_stage cached --reuse-passed -- bash -c 'printf "run\n" >> "$1"' _ "$counter" >"$TEST_ROOT/reused.out"
[ "$(wc -l < "$counter" | tr -d ' ')" = 1 ] || fail "identical passed gate executed twice"
grep -q "reused passed deploy stage" "$TEST_ROOT/reused.out" || fail "cache hit was not disclosed"
reuse_stage cached --reuse-passed -- bash -c 'printf "changed-command\n" >> "$1"' _ "$counter" >/dev/null
[ "$(wc -l < "$counter" | tr -d ' ')" = 2 ] || fail "changed command reused stale evidence"
failed_counter="$TEST_ROOT/reuse-failed-counter"
for _ in 1 2; do
    if reuse_stage failed-cache --reuse-passed -- bash -c 'printf "failed\n" >> "$1"; exit 1' _ "$failed_counter" >/dev/null; then
        fail "failing cache fixture reported success"
    fi
done
[ "$(wc -l < "$failed_counter" | tr -d ' ')" = 2 ] || fail "failed gate was reused"
# Every pass is cached, so a standalone run (no --reuse-passed: a first manual
# gate, or an inner stage a lane launches) is reusable by a later
# --reuse-passed run of the identical command; only the lookup is opt-in.
standalone_counter="$TEST_ROOT/reuse-standalone-counter"
reuse_stage standalone -- bash -c 'printf "run\n" >> "$1"' _ "$standalone_counter" >"$TEST_ROOT/standalone-first.out"
grep -q "reused passed deploy stage" "$TEST_ROOT/standalone-first.out" && fail "a run without --reuse-passed must never reuse"
reuse_stage standalone --reuse-passed -- bash -c 'printf "run\n" >> "$1"' _ "$standalone_counter" >"$TEST_ROOT/standalone.out"
[ "$(wc -l < "$standalone_counter" | tr -d ' ')" = 1 ] || fail "a pass recorded without --reuse-passed was not reusable"
grep -q "reused passed deploy stage: standalone (exact worktree + command)" "$TEST_ROOT/standalone.out" \
    || fail "standalone reuse was not disclosed with its scope"
# Process identity is not a deploy input: systemd stamps a fresh
# INVOCATION_ID/JOURNAL_STREAM/SYSTEMD_EXEC_PID on every transient unit and the
# terminal its own geometry, so a lane relaunched as a new unit must still match
# its own pass, while a changed gate input such as DEPLOY_GATE_OVERRIDES must not.
identity_counter="$TEST_ROOT/reuse-identity-counter"
INVOCATION_ID=0123abcd JOURNAL_STREAM=8:1 SYSTEMD_EXEC_PID=11 COLUMNS=80 LISTEN_PID=11 \
    reuse_stage identity --reuse-passed -- bash -c 'printf "run\n" >> "$1"' _ "$identity_counter" >/dev/null
INVOCATION_ID=4567ef01 JOURNAL_STREAM=8:2 SYSTEMD_EXEC_PID=22 COLUMNS=120 LISTEN_PID=22 \
    reuse_stage identity --reuse-passed -- bash -c 'printf "run\n" >> "$1"' _ "$identity_counter" >"$TEST_ROOT/identity.out"
[ "$(wc -l < "$identity_counter" | tr -d ' ')" = 1 ] \
    || fail "a new systemd unit identity defeated reuse of an identical pass"
grep -q "reused passed deploy stage" "$TEST_ROOT/identity.out" \
    || fail "identity-only relaunch was not disclosed as reuse"
DEPLOY_GATE_OVERRIDES=fixture:changed \
    reuse_stage identity --reuse-passed -- bash -c 'printf "run\n" >> "$1"' _ "$identity_counter" >/dev/null
[ "$(wc -l < "$identity_counter" | tr -d ' ')" = 2 ] || fail "a changed gate input reused stale evidence"
reuse_stage --finish >/dev/null

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
run_stage slow -- bash -c 'while [ ! -e "$1" ]; do sleep 0.05; done' _ "$TEST_ROOT/slow-release" >"$TEST_ROOT/slow.out" 2>&1 &
slow_pid=$!
for _ in $(seq 1 1200); do
    find "$RUN_ROOT/concurrent/admissions" -name '*.json' -print -quit 2>/dev/null | grep -q . && break
    sleep 0.05
done
find "$RUN_ROOT/concurrent/admissions" -name '*.json' -print -quit 2>/dev/null | grep -q . \
    || fail "slow stage did not publish its admission"
run_stage --finish >"$TEST_ROOT/concurrent-finish.out" 2>&1 &
finish_pid=$!
# Under a loaded /deploy host the finish supervisor can take seconds just to
# start Python and persist "finishing", or it can pass through that state so
# quickly a poll only sees "completed". Either way admission is closed. Wait on
# the event itself: stop as soon as either status is written or the finish
# process exits (it cannot exit cleanly without writing one), instead of a fixed
# wall-clock window. The iteration cap only prevents a hung test.
for _ in $(seq 1 1200); do
    grep -Eq '"status": "(finishing|completed)"' "$RUN_ROOT/concurrent/metadata.json" && break
    kill -0 "$finish_pid" 2>/dev/null || break
    sleep 0.05
done
grep -Eq '"status": "(finishing|completed)"' "$RUN_ROOT/concurrent/metadata.json" \
    || fail "finish did not close stage admission"
if run_stage late -- true >"$TEST_ROOT/concurrent-late.out" 2>&1; then
    fail "admitted a stage after finish began"
fi
touch "$TEST_ROOT/slow-release"
wait "$slow_pid" || fail "admitted stage failed during finish"
slow_pid=""
wait "$finish_pid" || fail "finish failed while waiting for an admitted stage"
finish_pid=""
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

# Lane-scoped reuse: a scoped lane (front-end, mac-app) survives a fix outside
# its inputs, including the commit of that fix, but every shared input (root
# manifest, shared contract, scripts, the benchmark catalog front-end reads,
# an unmapped new top-level path) invalidates it. Whole-worktree lanes still
# rerun on any change. Runs against a fixture repository so the real checkout
# is never edited.
LANE_REPO="$TEST_ROOT/lane-repo"
mkdir -p "$LANE_REPO/scripts" "$LANE_REPO/back-end/src" "$LANE_REPO/front-end/src" \
    "$LANE_REPO/agents/benchmarks/history" "$LANE_REPO/agents/tools" "$LANE_REPO/shared/contract" \
    "$LANE_REPO/mac-app/main" "$LANE_REPO/docs"
cp "$ROOT_DIR/scripts/run-deploy-stage" "$ROOT_DIR/scripts/run_deploy_stage.py" \
    "$ROOT_DIR/scripts/deploy_stage.py" "$ROOT_DIR/scripts/factory_metadata.py" \
    "$ROOT_DIR/scripts/factory_detail.py" "$LANE_REPO/scripts/"
for file in package.json back-end/src/server.ts front-end/src/app.ts agents/benchmarks/tasks.json \
    agents/benchmarks/history/task_attempts.jsonl \
    agents/tools/base.py shared/contract/fixtures.json mac-app/main/index.ts docs/guide.txt scripts/helper.sh; do
    printf 'original %s\n' "$file" > "$LANE_REPO/$file"
done
printf '.context/\n' > "$LANE_REPO/.gitignore"
git -C "$LANE_REPO" init -q
git -C "$LANE_REPO" add -A
git -C "$LANE_REPO" -c user.name=t -c user.email=t@t commit -qm fixture
lane_counter="$TEST_ROOT/lane-counter"
lane_stage() {
    (cd "$LANE_REPO" && DEPLOY_RUN_ROOT="$LANE_REPO/.context/deploy-runs" \
        bash scripts/run-deploy-stage "$1" --reuse-passed -- \
        bash -c 'printf "%s\n" "$1" >> "$2"' _ "$1" "$lane_counter" >/dev/null)
}
lane_runs() { grep -cx "$1" "$lane_counter" 2>/dev/null || true; }
expect_lane() {
    local stage="$1" expected="$2" why="$3"
    lane_stage "$stage"
    [ "$(lane_runs "$stage")" = "$expected" ] \
        || fail "$stage ran $(lane_runs "$stage") times after $why, expected $expected"
}
(cd "$LANE_REPO" && DEPLOY_RUN_ROOT="$LANE_REPO/.context/deploy-runs" \
    bash scripts/run-deploy-stage --start --run-id lanes >/dev/null)
for stage in frontend-coverage-blackbox mac-static typescript; do expect_lane "$stage" 1 "first run"; done
for stage in frontend-coverage-blackbox mac-static typescript; do expect_lane "$stage" 1 "no change"; done
# Back-end-only fix, uncommitted and then committed: only whole-worktree lanes rerun.
printf 'fix\n' >> "$LANE_REPO/back-end/src/server.ts"
expect_lane frontend-coverage-blackbox 1 "an uncommitted back-end fix"
expect_lane mac-static 1 "an uncommitted back-end fix"
expect_lane typescript 2 "an uncommitted back-end fix"
git -C "$LANE_REPO" -c user.name=t -c user.email=t@t commit -qam "back-end fix"
expect_lane frontend-coverage-blackbox 1 "committing the back-end fix"
expect_lane typescript 3 "committing the back-end fix"
printf 'agent fix\n' >> "$LANE_REPO/agents/tools/base.py"
expect_lane frontend-coverage-blackbox 1 "an agents-only fix"
expect_lane mac-static 1 "an agents-only fix"
printf 'docs\n' >> "$LANE_REPO/docs/guide.txt"
expect_lane frontend-coverage-blackbox 1 "a docs-only edit"
# Every shared or unmapped input invalidates the scoped lanes.
fe=1; mac=1
for shared_edit in package.json shared/contract/fixtures.json scripts/helper.sh \
    unmapped-top-level.json; do
    printf 'shared edit\n' >> "$LANE_REPO/$shared_edit"
    fe=$((fe + 1)); mac=$((mac + 1))
    expect_lane frontend-coverage-blackbox "$fe" "editing $shared_edit"
    expect_lane mac-static "$mac" "editing $shared_edit"
done
printf 'catalog edit\n' >> "$LANE_REPO/agents/benchmarks/tasks.json"
expect_lane frontend-coverage-blackbox $((fe + 1)) "editing the benchmark catalog"
expect_lane mac-static "$mac" "editing the benchmark catalog"
printf 'ui edit\n' >> "$LANE_REPO/front-end/src/app.ts"
expect_lane frontend-coverage-blackbox $((fe + 2)) "a front-end edit"
expect_lane mac-static $((mac + 1)) "a front-end edit (mac-app consumes front-end)"
rm "$LANE_REPO/front-end/src/app.ts"
expect_lane frontend-coverage-blackbox $((fe + 3)) "deleting a front-end file"
chmod +x "$LANE_REPO/shared/contract/fixtures.json"
expect_lane frontend-coverage-blackbox $((fe + 4)) "a mode-only change"
# A staged rename out of lane scope removes an in-scope file: git's default
# rename detection lists only the destination, so the source must still be
# seen as deleted (--no-renames) or a stale pass stays reusable.
printf 'moved\n' > "$LANE_REPO/front-end/src/moved.ts"
git -C "$LANE_REPO" add -A
git -C "$LANE_REPO" -c user.name=t -c user.email=t@t commit -qm "add moved.ts"
expect_lane frontend-coverage-blackbox $((fe + 5)) "adding a front-end file"
expect_lane frontend-coverage-blackbox $((fe + 5)) "no change after the add"
git -C "$LANE_REPO" mv front-end/src/moved.ts docs/moved.ts
expect_lane frontend-coverage-blackbox $((fe + 6)) "a staged rename of a front-end file out of scope"

# Append-only benchmark ledgers (agents/benchmarks/history/*, written by the
# smoke lane and local benchmark runs while the other gates run) invalidate
# only the lanes that read them: backend-coverage-blackbox
# (domains/benchmarks/config.ts reads task_attempts.jsonl) and the scripts/
# tests gates rerun, while eslint, typescript and backend-structural keep
# their pass. A tracked ledger row, an untracked ledger file and an ignored
# .context write are all exercised; a real source edit still invalidates.
for stage in eslint typescript backend-structural backend-coverage-blackbox deploy-command-structural; do
    lane_stage "$stage"
done
ts=$(lane_runs typescript); bs=$(lane_runs backend-structural); cov=$(lane_runs backend-coverage-blackbox)
dcs=$(lane_runs deploy-command-structural)
printf '{"task":"x","status":"passed"}\n' >> "$LANE_REPO/agents/benchmarks/history/task_attempts.jsonl"
expect_lane eslint 1 "a dirty tracked ledger row"
expect_lane typescript "$ts" "a dirty tracked ledger row"
expect_lane backend-structural "$bs" "a dirty tracked ledger row"
expect_lane backend-coverage-blackbox $((cov + 1)) "a dirty tracked ledger row (the backend reads task_attempts.jsonl)"
expect_lane deploy-command-structural $((dcs + 1)) "a dirty tracked ledger row (scripts/tests read the ledgers)"
printf '{"task":"y"}\n' > "$LANE_REPO/agents/benchmarks/history/span_durations.jsonl"
expect_lane eslint 1 "an untracked ledger file"
expect_lane typescript "$ts" "an untracked ledger file"
expect_lane backend-coverage-blackbox $((cov + 2)) "an untracked ledger file"
mkdir -p "$LANE_REPO/.context/deploy-durations"
printf '{}\n' > "$LANE_REPO/.context/deploy-durations/pipeline-lanes.json"
expect_lane eslint 1 "an ignored .context write"
expect_lane backend-coverage-blackbox $((cov + 2)) "an ignored .context write"
printf 'fix\n' >> "$LANE_REPO/back-end/src/server.ts"
expect_lane eslint 2 "a back-end edit"
expect_lane typescript $((ts + 1)) "a back-end edit"
expect_lane backend-structural $((bs + 1)) "a back-end edit"
git -C "$LANE_REPO" -c user.name=t -c user.email=t@t commit -qam "back-end edit"
expect_lane eslint 3 "committing the back-end edit (ledger-free lanes still hash HEAD)"

echo "run-deploy-stage regression tests passed"
