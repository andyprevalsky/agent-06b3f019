#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(cd "$(mktemp -d)" && pwd -P)"
PIDS=()

# Cleanup owns each fixture's complete tree, including wrapper grandchildren.
kill_pid_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_pid_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    kill_pid_tree "$pid"
  done
  for pid in "${PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

source "$ROOT_DIR/scripts/lib/run-process-cleanup.sh"

assert_required_service_exit_code() {
  local input="$1"
  local expected="$2"
  local actual

  actual="$(run_required_service_exit_code "$input")"
  if [ "$actual" = "$expected" ]; then
    echo "PASS: required service exit $input normalizes to $expected"
    return 0
  fi
  echo "FAIL: required service exit $input normalized to $actual, expected $expected" >&2
  exit 1
}

wait_for_process() {
  local pid="$1"
  local ready_file="$2"
  local attempt
  for attempt in $(seq 1 30); do
    if [ -f "$ready_file" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  echo "FAIL: process $pid did not publish fixture readiness" >&2
  exit 1
}

assert_dead() {
  local pid="$1"
  local label="$2"
  local attempt
  for attempt in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "PASS: $label"
      return 0
    fi
    sleep 0.1
  done
  echo "FAIL: $label: process $pid is still alive" >&2
  exit 1
}

assert_alive() {
  local pid="$1"
  local label="$2"
  if kill -0 "$pid" 2>/dev/null; then
    echo "PASS: $label"
    return 0
  fi
  echo "FAIL: $label: process $pid is not alive" >&2
  exit 1
}

assert_db_cleanup_guard() {
  local expected_id="$1"
  local fake_current_id="$2"
  local isolated_run="$3"
  local expected_calls="$4"
  local label="$5"
  local calls_file="$TMP_ROOT/docker-calls"
  local actual_calls

  : > "$calls_file"

  docker() {
    if [ "$1" = "inspect" ]; then
      printf '%s\n' "$fake_current_id"
      return 0
    fi
    printf '%s\n' "$*" >> "$calls_file"
    return 0
  }

  run_cleanup_owned_db_container "$expected_id" "victoria-db-test" "victoria-pgdata-test" "$isolated_run"
  unset -f docker
  actual_calls="$(cat "$calls_file")"

  if [ "$actual_calls" = "$expected_calls" ]; then
    echo "PASS: $label"
    return 0
  fi
  echo "FAIL: $label: expected calls '$expected_calls', got '$actual_calls'" >&2
  exit 1
}

workspace="$TMP_ROOT/salvador-v1"
other_workspace="$TMP_ROOT/delhi"
mkdir -p "$workspace/agents" "$other_workspace/agents"

queue="navi-agent-tasks-salvador-v1"
expected_backend="http://localhost:55070"
stale_backend="http://localhost:55010"
stale_ready="$TMP_ROOT/stale-ready"
current_ready="$TMP_ROOT/current-ready"
other_ready="$TMP_ROOT/other-ready"

(
  cd "$workspace/agents"
  TEMPORAL_TASK_QUEUE="$queue" BACKEND_API_URL="$stale_backend" exec python3 -c 'from pathlib import Path; import signal, sys; Path(sys.argv[1]).touch(); signal.pause()' "$stale_ready" worker.py
) &
stale_pid="$!"
PIDS+=("$stale_pid")
wait_for_process "$stale_pid" "$stale_ready"

(
  cd "$workspace/agents"
  TEMPORAL_TASK_QUEUE="$queue" BACKEND_API_URL="$expected_backend" exec python3 -c 'from pathlib import Path; import signal, sys; Path(sys.argv[1]).touch(); signal.pause()' "$current_ready" worker.py
) &
current_pid="$!"
PIDS+=("$current_pid")
wait_for_process "$current_pid" "$current_ready"

(
  cd "$other_workspace/agents"
  TEMPORAL_TASK_QUEUE="$queue" BACKEND_API_URL="$stale_backend" exec python3 -c 'from pathlib import Path; import signal, sys; Path(sys.argv[1]).touch(); signal.pause()' "$other_ready" worker.py
) &
other_pid="$!"
PIDS+=("$other_pid")
wait_for_process "$other_pid" "$other_ready"

run_kill_stale_same_task_queue_workers "$workspace" "$queue" "$expected_backend" "999999"

assert_dead "$stale_pid" "same-worktree worker with stale backend is killed"
assert_alive "$current_pid" "same-worktree worker with current backend survives"
assert_alive "$other_pid" "other-worktree worker survives"

# A fork is alive before its fixture's cwd/argv/environment are published.
# Hold a real child before exec so PID existence cannot certify readiness.
blocked_release="$TMP_ROOT/blocked-release"
blocked_ready="$TMP_ROOT/blocked-ready"
(
  while [ ! -f "$blocked_release" ]; do sleep 0.05; done
  exec python3 -c 'from pathlib import Path; import signal, sys; Path(sys.argv[1]).touch(); signal.pause()' "$blocked_ready"
) &
blocked_pid="$!"
PIDS+=("$blocked_pid")
if (wait_for_process "$blocked_pid" "$blocked_ready") > "$TMP_ROOT/blocked-readiness.log" 2>&1; then
  echo "FAIL: a live fixture was accepted before publishing readiness" >&2
  exit 1
fi
assert_alive "$blocked_pid" "a blocked fixture remains owned before exec"
touch "$blocked_release"
wait_for_process "$blocked_pid" "$blocked_ready"
echo "PASS: fixture readiness waits for exec instead of accepting a live fork"

assert_db_cleanup_guard "container-old" "container-old" true $'rm -f container-old\nvolume rm victoria-pgdata-test' "isolated owner removes its exact DB instance ID"
assert_db_cleanup_guard "container-old" "container-new" true "" "stale owner cannot remove a replacement DB container"
assert_db_cleanup_guard "container-old" "container-old" false "" "normal service cleanup preserves a shared DB instance"
assert_required_service_exit_code 0 1
assert_required_service_exit_code 17 17

# ── process_age_seconds: portable elapsed time (BSD + GNU ps) ──
#
# `ps -o etimes=` is GNU-only. On macOS BSD ps it is not a valid keyword and ps
# prints its whole keyword list instead, which the young-process guard captured
# as "$age" and compared numerically ("integer expression expected"). The guard
# then failed open and startup cleanup could kill a benchmark that had not yet
# published services.json. Pin the parse so that never silently regresses.
eval "$(awk '/^process_age_seconds\(\) \{/,/^\}/' "$ROOT_DIR/scripts/run.sh")"

assert_age_parses() {
  local etime="$1" expected="$2" label="$3" actual
  actual="$(printf '%s' "$etime" | awk -F'[-:]' '{
      if (NF == 4)      { print (($1 * 24 + $2) * 60 + $3) * 60 + $4 }
      else if (NF == 3) { print ($1 * 60 + $2) * 60 + $3 }
      else if (NF == 2) { print $1 * 60 + $2 }
      else              { print 0 }
  }')"
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $label — expected $expected, got $actual" >&2
    exit 1
  fi
  echo "PASS: $label"
}

assert_age_parses "00:07" 7 "mm:ss elapsed parses to seconds"
assert_age_parses "01:02:03" 3723 "hh:mm:ss elapsed parses to seconds"
assert_age_parses "2-03:04:05" 183845 "dd-hh:mm:ss elapsed parses to seconds"

# The real helper must return an integer this shell can compare numerically.
age_self="$(process_age_seconds "$$")"
case "$age_self" in
  ''|*[!0-9]*)
    echo "FAIL: process_age_seconds returned a non-integer: [$age_self]" >&2
    exit 1 ;;
esac
if [ "$age_self" -lt 0 ]; then
  echo "FAIL: process_age_seconds returned a negative age" >&2
  exit 1
fi
echo "PASS: process_age_seconds yields a comparable integer for a live pid"

# A dead pid must not yield garbage that breaks the caller's numeric test.
age_dead="$(process_age_seconds 999999 || true)"
case "$age_dead" in
  ''|[0-9]*) echo "PASS: process_age_seconds is empty-or-numeric for a dead pid" ;;
  *) echo "FAIL: process_age_seconds returned garbage for a dead pid: [$age_dead]" >&2; exit 1 ;;
esac

# A launched wrapper can finish before run.sh captures its birth. Its exact
# reaped PID needs no signal; a live child with unknown birth must remain owned.
bash -c 'exit 0' &
already_exited_pid=$!
wait "$already_exited_pid"
if ! run_wait_owned_agent_shutdown "$already_exited_pid" "" 1; then
  echo "FAIL: an already-reaped worker with no captured birth needs no drain" >&2
  exit 1
fi
echo "PASS: an already-reaped worker needs no birth or signal"
if run_wait_owned_agent_shutdown "$current_pid" "" 1; then
  echo "FAIL: a live worker with unknown birth must remain fail-closed" >&2
  exit 1
fi
assert_alive "$current_pid" "live worker with unknown birth is not signalled"

# A live supervisor remains owned when one post-signal identity read is empty.
# Join its actual graceful exit; do not treat a failed observation as release.
drain_ready="$TMP_ROOT/drain-ready"
drain_release="$TMP_ROOT/drain-release"
drain_signals="$TMP_ROOT/drain-signals"
python3 - "$drain_ready" "$drain_release" "$drain_signals" <<'PY' &
from pathlib import Path
import signal
import sys
import time

ready, release, signals = map(Path, sys.argv[1:])
def stop(_signum, _frame):
    if signals.exists():
        raise SystemExit(0)
    with signals.open("a") as handle:
        handle.write("TERM\n")
signal.signal(signal.SIGTERM, stop)
ready.touch()
while not release.exists():
    time.sleep(0.05)
PY
drain_pid=$!
PIDS+=("$drain_pid")
drain_ready_deadline=$((SECONDS + 10))
while [ ! -f "$drain_ready" ] && [ "$SECONDS" -lt "$drain_ready_deadline" ]; do
  kill -0 "$drain_pid" 2>/dev/null || { echo "FAIL: drain fixture exited before readiness" >&2; exit 1; }
  sleep 0.1
done
[ -f "$drain_ready" ] || { echo "FAIL: drain fixture did not become ready" >&2; exit 1; }
drain_birth="$(cloudbench_pid_start_time "$drain_pid")"
if run_wait_owned_agent_shutdown "$drain_pid" "foreign:$drain_birth" 10; then
  echo "FAIL: a foreign worker birth was accepted" >&2; exit 1
fi
assert_alive "$drain_pid" "foreign birth leaves a live supervisor untouched"
[ ! -f "$drain_signals" ] || { echo "FAIL: foreign birth signalled the supervisor" >&2; exit 1; }

eval "$(declare -f cloudbench_pid_start_time_like | sed '1s/cloudbench_pid_start_time_like/drain_original_start_time_like/')"
cloudbench_pid_start_time_like() {
  if [ "$1" = "$drain_pid" ] && [ "${RUN_AGENT_SIGNALLED_IDENTITY:-}" = "$drain_pid:$drain_birth" ]; then
    if [ ! -f "$TMP_ROOT/drain-empty-observation" ]; then
      touch "$TMP_ROOT/drain-empty-observation"
      return 0
    fi
    touch "$drain_release"
  fi
  drain_original_start_time_like "$@"
}
run_wait_owned_agent_shutdown "$drain_pid" "$drain_birth" 10 || {
  echo "FAIL: owned supervisor did not finish after a transient read" >&2; exit 1;
}
[ -f "$drain_release" ] || { echo "FAIL: empty identity read was mistaken for exit" >&2; exit 1; }
wait "$drain_pid" || { echo "FAIL: drained supervisor exited unsuccessfully" >&2; exit 1; }
[ "$(cat "$drain_signals")" = TERM ] || { echo "FAIL: drain must send exactly one graceful signal" >&2; exit 1; }
unset -f cloudbench_pid_start_time_like
eval "$(declare -f drain_original_start_time_like | sed '1s/drain_original_start_time_like/cloudbench_pid_start_time_like/')"
unset -f drain_original_start_time_like
echo "PASS: transient identity read joins the exact supervisor without a second signal"
# ── Service-kill patterns stop at argument boundaries ──
#
# pgrep -f matches its regex anywhere in argv. An unbounded
# `node_modules/.bin/vite` also matched `node_modules/.bin/vitest`, so bringing
# up the /deploy Step 5 stack SIGTERMed the frontend-coverage lane running in
# the same worktree (npm exit 143). Exercise the real sweep from run.sh against
# real processes so the patterns and the kill path are pinned together.
sweep_ws="$TMP_ROOT/sweep-ws"
mkdir -p "$sweep_ws/front-end" "$sweep_ws/agents"
# macOS resolves /var to /private/var in lsof cwd output. Use the same physical
# path that the cleanup sweep reads for its worktree comparison.
sweep_ws="$(cd "$sweep_ws" && pwd -P)"

SWEEP_FIXTURE_PID=""
spawn_sweep_fixture() {
  local dir="$1"
  local ready_file="$TMP_ROOT/sweep-ready-${#PIDS[@]}"
  shift
  ( cd "$dir" && exec python3 -c 'from pathlib import Path; import signal, sys; Path(sys.argv[1]).touch(); signal.pause()' "$ready_file" "$@" ) &
  SWEEP_FIXTURE_PID="$!"
  PIDS+=("$SWEEP_FIXTURE_PID")
  wait_for_process "$SWEEP_FIXTURE_PID" "$ready_file"
}

spawn_sweep_fixture "$sweep_ws/front-end" "$sweep_ws/node_modules/.bin/vitest" run --coverage --maxWorkers=3
vitest_pid="$SWEEP_FIXTURE_PID"
spawn_sweep_fixture "$sweep_ws/front-end" "$sweep_ws/node_modules/.bin/vite" preview --port 1 --strictPort
vite_pid="$SWEEP_FIXTURE_PID"
spawn_sweep_fixture "$sweep_ws/agents" -m pytest tests/unit/test_worker.py
pytest_pid="$SWEEP_FIXTURE_PID"
spawn_sweep_fixture "$sweep_ws/agents" worker.py
worker_pid="$SWEEP_FIXTURE_PID"
spawn_sweep_fixture "$sweep_ws/front-end" npx vitest run
npx_vitest_pid="$SWEEP_FIXTURE_PID"
spawn_sweep_fixture "$sweep_ws/front-end" npx vite preview
npx_vite_pid="$SWEEP_FIXTURE_PID"

pattern_matches_pid() {
  local pattern="$1" pid="$2"
  pgrep -f "$pattern" 2>/dev/null | grep -qx "$pid"
}

assert_cloud_kill_pattern() {
  local expected="$1" pid="$2" label="$3" pattern
  for pattern in "${RUN_CLOUD_SERVICE_KILL_PATTERNS[@]}"; do
    if pattern_matches_pid "$pattern" "$pid"; then
      [ "$expected" = match ] && { echo "PASS: $label"; return 0; }
      echo "FAIL: $label: cloud kill pattern '$pattern' matched PID $pid" >&2
      exit 1
    fi
  done
  [ "$expected" = none ] && { echo "PASS: $label"; return 0; }
  echo "FAIL: $label: no cloud kill pattern matched PID $pid" >&2
  exit 1
}

assert_cloud_kill_pattern none "$vitest_pid" "cloud kill patterns spare node_modules/.bin/vitest"
assert_cloud_kill_pattern none "$npx_vitest_pid" "cloud kill patterns spare npx vitest"
assert_cloud_kill_pattern none "$pytest_pid" "cloud kill patterns spare pytest on test_worker.py"
assert_cloud_kill_pattern match "$npx_vite_pid" "cloud kill patterns match npx vite"
assert_cloud_kill_pattern match "$worker_pid" "cloud kill patterns match worker.py"

sweep_harness="$TMP_ROOT/stale-stack-sweep.sh"
{
  printf 'set -uo pipefail\n'
  printf '. %q\n' "$ROOT_DIR/scripts/lib/run-process-cleanup.sh"
  for fn in is_current_process_family process_cwd_in_this_worktree kill_stale_tree \
    process_age_seconds pid_belongs_to_active_isolated_benchmark \
    kill_stale_same_worktree_benchmark_stack; do
    awk -v start="^${fn}\\\\(\\\\) \\\\{" '$0 ~ start {p=1} p {print} p && /^\}/ {exit}' "$ROOT_DIR/scripts/run.sh"
  done
  printf 'BENCHMARK_MODE=true\n'
  printf 'cd %q\n' "$sweep_ws"
  printf 'kill_stale_same_worktree_benchmark_stack\n'
} > "$sweep_harness"
grep -q '^kill_stale_same_worktree_benchmark_stack() {' "$sweep_harness" || {
  echo "FAIL: could not extract kill_stale_same_worktree_benchmark_stack from run.sh" >&2
  exit 1
}
# A separate shell keeps the fixtures out of the sweep's own process family.
bash "$sweep_harness" > "$TMP_ROOT/stale-stack-sweep.log" 2>&1

assert_dead "$vite_pid" "stale-stack sweep reaps a same-worktree vite server"
assert_dead "$worker_pid" "stale-stack sweep reaps a same-worktree worker.py"
assert_alive "$vitest_pid" "stale-stack sweep spares a same-worktree vitest coverage run"
assert_alive "$pytest_pid" "stale-stack sweep spares a same-worktree pytest run of test_worker.py"

# ── run_kill_tree: a wrapper's grandchildren die with it ──
#
# The isolated blackbox backend is `npx tsx src/bootstrap.ts`: npx -> tsx -> node.
# Its cleanup used to signal only the npx PID, so every passing run left the tsx
# launcher and the server alive under init, holding their port and DB pool.
grandchild_pid_file="$TMP_ROOT/grandchild.pid"
bash -c 'bash -c "sleep 300 & echo \$! >\"\$1\"; wait" _ "$1" & wait' _ "$grandchild_pid_file" &
wrapper_pid=$!
PIDS+=("$wrapper_pid")
for _ in $(seq 1 100); do
  [ -s "$grandchild_pid_file" ] && break
  sleep 0.05
done
grandchild_pid="$(cat "$grandchild_pid_file")"
run_kill_tree "$wrapper_pid"
wait "$wrapper_pid" 2>/dev/null || true
for _ in $(seq 1 40); do
  kill -0 "$grandchild_pid" 2>/dev/null || break
  sleep 0.05
done
if kill -0 "$grandchild_pid" 2>/dev/null; then
  echo "FAIL: run_kill_tree left grandchild $grandchild_pid alive" >&2
  exit 1
fi
echo "PASS: run_kill_tree reaps a wrapper's grandchildren"

blackbox_runner="$ROOT_DIR/back-end/scripts/run-blackbox-tests.sh"
grep -qF 'source "$ROOT_DIR/scripts/lib/cloudbench-env.sh"' "$blackbox_runner" \
  && grep -qF 'cloudbench_terminate_tree_and_wait 5 "$BACKEND_PID"' "$blackbox_runner" \
  || { echo "FAIL: run-blackbox-tests.sh cleanup must reap the npx backend tree with verified cloudbench ownership cleanup" >&2; exit 1; }
echo "PASS: run-blackbox-tests.sh cleanup reaps the whole backend tree"

# Isolated runs must delete their run-keyed frontend bundle on exit (36 leaked
# ~220MB bundles filled the disk); shared bundles and foreign paths stay.
frontend_fn="$TMP_ROOT/frontend-build-fn.sh"
awk '/^remove_isolated_frontend_build\(\) \{/ {p=1} p {print} p && /^\}/ {exit}' \
  "$ROOT_DIR/scripts/run.sh" > "$frontend_fn"
grep -q '^remove_isolated_frontend_build() {' "$frontend_fn" || {
  echo "FAIL: could not extract remove_isolated_frontend_build from run.sh" >&2
  exit 1
}
builds="$TMP_ROOT/ws/.context/frontend-builds"
mkdir -p "$builds/1790000000-1-1" "$builds/shared_55051" "$TMP_ROOT/elsewhere/1790000000-2-2"
check_frontend_cleanup() { # <isolated> <dir> <expect present|absent> <label>
  ( BENCHMARK_ISOLATED_RUN="$1" FRONTEND_DIST_DIR="$2"; . "$frontend_fn"; remove_isolated_frontend_build )
  if [ "$3" = absent ] && [ -e "$2" ]; then echo "FAIL: $4" >&2; exit 1; fi
  if [ "$3" = present ] && [ ! -e "$2" ]; then echo "FAIL: $4" >&2; exit 1; fi
  echo "PASS: $4"
}
check_frontend_cleanup false "$builds/1790000000-1-1" present "a shared stack keeps a run-keyed bundle it does not own"
check_frontend_cleanup true "$builds/shared_55051" present "an isolated run keeps the shared port-keyed bundle"
check_frontend_cleanup true "$TMP_ROOT/elsewhere/1790000000-2-2" present "cleanup never deletes outside .context/frontend-builds"
check_frontend_cleanup true "$builds/1790000000-1-1" absent "an isolated run deletes its own frontend bundle on exit"

# ── T112: a repeated TERM/INT/HUP must not abort a teardown in progress ──
# run.sh runs cleanup from its EXIT trap; bash dies on a second signal in the
# middle of that trap, which stranded the backend/worker/vite/tunnel of a stopped
# antibot run (cleanup receipt left pending). Fixture: the library's own signal
# functions around a slow, multi-step cleanup written like run.sh's.
grep -q '^run_install_teardown_signal_traps$' "$ROOT_DIR/scripts/run.sh" \
  || { echo "FAIL: run.sh must install the teardown signal traps" >&2; exit 1; }
grep -q '^    run_ignore_repeated_teardown_signals$' "$ROOT_DIR/scripts/run.sh" \
  || { echo "FAIL: run.sh cleanup must ignore repeated signals" >&2; exit 1; }
signal_fixture="$TMP_ROOT/teardown-signal-fixture.sh"
cat > "$signal_fixture" <<FIXTURE
#!/usr/bin/env bash
. "$ROOT_DIR/scripts/lib/run-process-cleanup.sh"
STEPS="\$1"
SHUTTING_DOWN=false
cleanup() {
  if \$SHUTTING_DOWN; then return; fi
  SHUTTING_DOWN=true
  run_ignore_repeated_teardown_signals
  echo started >> "\$STEPS"
  for step in 1 2 3 4 5; do sleep 0.4; echo "step\$step" >> "\$STEPS"; done
  # Stop the stand-in service like run.sh stops its services; never orphan it.
  kill "\$SERVICE_PID" 2>/dev/null || true
  echo done >> "\$STEPS"
}
trap cleanup EXIT
run_install_teardown_signal_traps
echo ready >> "\$STEPS"
sleep 60 &
SERVICE_PID=\$!
wait
FIXTURE
chmod +x "$signal_fixture"
run_signal_case() { # <label> <extra signals after the first TERM...>
  local label="$1"; shift
  local steps="$TMP_ROOT/steps-$label" status=0 sig
  : > "$steps"
  "$signal_fixture" "$steps" &
  local fixture_pid=$!
  PIDS+=("$fixture_pid")
  local deadline=$((SECONDS + 10))
  until grep -q '^ready$' "$steps"; do
    [ "$SECONDS" -lt "$deadline" ] || { echo "FAIL: $label fixture not ready" >&2; exit 1; }
    sleep 0.05
  done
  kill -TERM "$fixture_pid"
  until grep -q '^started$' "$steps"; do sleep 0.02; done
  sleep 0.5
  for sig in "$@"; do kill -"$sig" "$fixture_pid" 2>/dev/null || true; sleep 0.2; done
  wait "$fixture_pid" || status=$?
  [ "$status" = 143 ] || { echo "FAIL: $label exited $status, expected 143" >&2; exit 1; }
  [ "$(grep -c '^started$' "$steps")" = 1 ] || { echo "FAIL: $label cleanup did not run exactly once" >&2; exit 1; }
  tail -1 "$steps" | grep -q '^done$' || { echo "FAIL: $label cleanup was aborted: $(tr '\n' ' ' < "$steps")" >&2; exit 1; }
  echo "PASS: $label teardown completes once and exits 143"
}
run_signal_case "single-TERM"
run_signal_case "second-TERM" TERM
run_signal_case "TERM-INT-HUP-burst" TERM INT HUP TERM

# Regression (2026-10-26): the same-queue stale-worker sweep scoped by a bare
# "$root"/* prefix, so a canonical-checkout stack claimed workers whose cwd was
# a nested agent worktree (.claude/worktrees/<name>).
(
    scope_root="$(mktemp -d)"
    nested="$scope_root/.claude/worktrees/gate-x"
    mkdir -p "$nested/agents" "$scope_root/agents"
    printf 'gitdir: /nonexistent\n' > "$nested/.git"
    (cd "$nested/agents" && exec sleep 1000) &
    nested_pid=$!
    (cd "$scope_root/agents" && exec sleep 1000) &
    own_pid=$!
    trap 'kill "$nested_pid" "$own_pid" 2>/dev/null || true; rm -rf "$scope_root"' EXIT
    sleep 0.2
    run_process_cwd_in_tree "$own_pid" "$scope_root" || { echo "FAIL: own-tree worker not recognized" >&2; exit 1; }
    if run_process_cwd_in_tree "$nested_pid" "$scope_root"; then
        echo "FAIL: nested worktree worker claimed by the enclosing checkout" >&2
        exit 1
    fi
)
echo "PASS: run_process_cwd_in_tree never claims a nested worktree"

# An isolated benchmark stack runs in its own session; a SIGKILL of its
# controller (a wrapper's grace timer) skips the controller's teardown. run.sh
# must notice the exact owner is gone (pid + /proc start time) and shut down.
(
    export CONDUCTOR_PORT=61900 CONDUCTOR_WORKSPACE_NAME=owner-watch-test RUN_SH_SOURCE_ONLY=true
    # shellcheck source=/dev/null
    source "$ROOT_DIR/scripts/run.sh"
    set +e
    unset RUN_SH_OWNER_PID RUN_SH_OWNER_START
    stack_owner_process_gone && { echo "FAIL: a stack without an owner shut down" >&2; exit 1; }
    sleep 1000 >/dev/null 2>&1 &
    owner=$!
    trap 'kill -KILL "$owner" 2>/dev/null || true' EXIT
    export RUN_SH_OWNER_PID="$owner"
    if [ -r "/proc/$owner/stat" ]; then
        stat=$(cat "/proc/$owner/stat")
        export RUN_SH_OWNER_START=$(printf '%s\n' "${stat##*) }" | awk '{print $20}')
        stack_owner_process_gone && { echo "FAIL: live owner treated as gone" >&2; exit 1; }
        RUN_SH_OWNER_START=$((RUN_SH_OWNER_START + 1)) stack_owner_process_gone \
            || { echo "FAIL: a reused owner PID was treated as the owner" >&2; exit 1; }
    else
        stack_owner_process_gone && { echo "FAIL: live owner treated as gone" >&2; exit 1; }
    fi
    kill -KILL "$owner"; wait "$owner" 2>/dev/null
    stack_owner_process_gone || { echo "FAIL: SIGKILLed owner not detected" >&2; exit 1; }
    # A killed owner its parent has not reaped yet (zombie) is gone too.
    if [ -d /proc/self ]; then
        bash -c 'sleep 0.2 & echo $! > "$1"; exec sleep 30' _ "$TMP_ROOT/zombie.pid" >/dev/null 2>&1 &
        zombie_parent=$!
        for _ in $(seq 1 50); do [ -s "$TMP_ROOT/zombie.pid" ] && break; sleep 0.1; done
        zombie=$(cat "$TMP_ROOT/zombie.pid")
        for _ in $(seq 1 50); do
            state=$(awk '{print $3}' "/proc/$zombie/stat" 2>/dev/null || true)
            [ "$state" = Z ] && break
            sleep 0.1
        done
        RUN_SH_OWNER_PID="$zombie" RUN_SH_OWNER_START= stack_owner_process_gone \
            || { kill "$zombie_parent" 2>/dev/null; echo "FAIL: a zombie owner was treated as alive" >&2; exit 1; }
        kill "$zombie_parent" 2>/dev/null; wait "$zombie_parent" 2>/dev/null
    fi
    # The watcher runs from the moment the service cleanup trap exists.
    awk "/run_install_teardown_signal_traps\$/{getline; if (\$0 == \"start_stack_owner_watch\") found=1} END{exit !found}" \
        "$ROOT_DIR/scripts/run.sh" || { echo "FAIL: run.sh does not watch its owner once teardown traps exist" >&2; exit 1; }
    grep -q 'env\["RUN_SH_OWNER_PID"\] = str(os.getpid())' "$ROOT_DIR/agents/benchmarks/local.py" \
        || { echo "FAIL: local.py does not publish itself as the isolated stack owner" >&2; exit 1; }
)
echo "PASS: an isolated stack shuts down when its exact owner process is gone"

# Live: the watcher TERMs the stack script (its teardown trap) once the owner dies.
(
    sleep 1000 >/dev/null 2>&1 &
    owner=$!
    trap 'kill -KILL "$owner" 2>/dev/null || true' EXIT
    RUN_SH_OWNER_PID="$owner" RUN_SH_OWNER_START= ROOT_DIR="$ROOT_DIR" OUT="$TMP_ROOT/watch.out" \
        bash -c 'export CONDUCTOR_PORT=61901 CONDUCTOR_WORKSPACE_NAME=owner-watch-live RUN_SH_SOURCE_ONLY=true
            source "$ROOT_DIR/scripts/run.sh" >/dev/null 2>&1
            trap "echo TEARDOWN >> \"\$OUT\"; exit 143" TERM
            start_stack_owner_watch
            echo READY >> "$OUT"
            for _ in $(seq 1 300); do sleep 0.1; done
            echo NO_TEARDOWN >> "$OUT"' >/dev/null 2>&1 &
    stack=$!
    for _ in $(seq 1 50); do grep -q READY "$TMP_ROOT/watch.out" 2>/dev/null && break; sleep 0.1; done
    kill -KILL "$owner"; wait "$owner" 2>/dev/null || true
    wait "$stack" 2>/dev/null || true
    grep -q TEARDOWN "$TMP_ROOT/watch.out" && ! grep -q NO_TEARDOWN "$TMP_ROOT/watch.out" \
        || { echo "FAIL: watcher did not TERM the stack after its owner died: $(cat "$TMP_ROOT/watch.out")" >&2; exit 1; }
)
echo "PASS: the owner watcher tears the stack down within seconds of a SIGKILLed owner"

# A normal stop (owner still alive) must not wait on the watcher: teardown ends
# with a bare `wait`, and the watcher only exits once the stack is gone.
(
    sleep 1000 >/dev/null 2>&1 &
    owner=$!
    trap 'kill -KILL "$owner" 2>/dev/null || true' EXIT
    RUN_SH_OWNER_PID="$owner" RUN_SH_OWNER_START= ROOT_DIR="$ROOT_DIR" \
        timeout 20 bash -c 'export CONDUCTOR_PORT=61902 CONDUCTOR_WORKSPACE_NAME=owner-watch-stop RUN_SH_SOURCE_ONLY=true
            source "$ROOT_DIR/scripts/run.sh" >/dev/null 2>&1
            start_stack_owner_watch
            stop_stack_owner_watch
            wait' >/dev/null 2>&1 \
        || { echo "FAIL: teardown waited on the owner watcher while the owner was alive" >&2; exit 1; }
    awk '/^cleanup\(\) \{/{c=1} c && /stop_stack_owner_watch/{found=1; exit} c && /^}/{exit} END{exit !found}' \
        "$ROOT_DIR/scripts/run.sh" || { echo "FAIL: cleanup does not stop the owner watcher" >&2; exit 1; }
)
echo "PASS: a normal stop does not wait on the owner watcher"

echo "All run process cleanup tests passed."
