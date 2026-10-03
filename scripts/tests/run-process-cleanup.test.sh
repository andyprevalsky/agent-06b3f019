#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
PIDS=()

# Each fixture is spawned as `( cd ...; python3 ... ) &`, so $! is the SUBSHELL,
# not the python process it forks. Signalling only the recorded PID orphaned every
# surviving fixture to init, where it kept this test's inherited stdout open: a
# `bash this-test.sh | tail` pipeline never saw EOF and hung indefinitely, and the
# stubs accumulated across runs (observed: pairs still alive 13h later). Always
# reap descendants before the recorded PID.
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
  local attempt
  for attempt in $(seq 1 30); do
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  echo "FAIL: process $pid did not stay alive" >&2
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

(
  cd "$workspace/agents"
  TEMPORAL_TASK_QUEUE="$queue" BACKEND_API_URL="$stale_backend" python3 -c 'import signal; signal.pause()' worker.py
) &
stale_pid="$!"
PIDS+=("$stale_pid")
wait_for_process "$stale_pid"

(
  cd "$workspace/agents"
  TEMPORAL_TASK_QUEUE="$queue" BACKEND_API_URL="$expected_backend" python3 -c 'import signal; signal.pause()' worker.py
) &
current_pid="$!"
PIDS+=("$current_pid")
wait_for_process "$current_pid"

(
  cd "$other_workspace/agents"
  TEMPORAL_TASK_QUEUE="$queue" BACKEND_API_URL="$stale_backend" python3 -c 'import signal; signal.pause()' worker.py
) &
other_pid="$!"
PIDS+=("$other_pid")
wait_for_process "$other_pid"

run_kill_stale_same_task_queue_workers "$workspace" "$queue" "$expected_backend" "999999"

assert_dead "$stale_pid" "same-worktree worker with stale backend is killed"
assert_alive "$current_pid" "same-worktree worker with current backend survives"
assert_alive "$other_pid" "other-worktree worker survives"

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
  shift
  ( cd "$dir" && exec python3 -c 'import signal; signal.pause()' "$@" ) &
  SWEEP_FIXTURE_PID="$!"
  PIDS+=("$SWEEP_FIXTURE_PID")
  wait_for_process "$SWEEP_FIXTURE_PID"
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
grep -qF 'source "$ROOT_DIR/scripts/lib/process-tree.sh"' "$blackbox_runner" \
  && grep -qF 'stop_process_tree "$BACKEND_PID"' "$blackbox_runner" \
  || { echo "FAIL: run-blackbox-tests.sh cleanup must reap the npx backend tree with stop_process_tree" >&2; exit 1; }
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

echo "All run process cleanup tests passed."
