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

echo "All run process cleanup tests passed."
