#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
PIDS=()

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

source "$ROOT_DIR/scripts/lib/run-process-cleanup.sh"

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

workspace="$TMP_ROOT/salvador-v1"
other_workspace="$TMP_ROOT/delhi"
mkdir -p "$workspace/agents" "$other_workspace/agents"

queue="navi-agent-tasks-salvador-v1"
expected_backend="http://localhost:55070"
stale_backend="http://localhost:55010"

(
  cd "$workspace/agents"
  TEMPORAL_TASK_QUEUE="$queue" BACKEND_API_URL="$stale_backend" python3 -c 'import time; time.sleep(60)' worker.py
) &
stale_pid="$!"
PIDS+=("$stale_pid")
wait_for_process "$stale_pid"

(
  cd "$workspace/agents"
  TEMPORAL_TASK_QUEUE="$queue" BACKEND_API_URL="$expected_backend" python3 -c 'import time; time.sleep(60)' worker.py
) &
current_pid="$!"
PIDS+=("$current_pid")
wait_for_process "$current_pid"

(
  cd "$other_workspace/agents"
  TEMPORAL_TASK_QUEUE="$queue" BACKEND_API_URL="$stale_backend" python3 -c 'import time; time.sleep(60)' worker.py
) &
other_pid="$!"
PIDS+=("$other_pid")
wait_for_process "$other_pid"

run_kill_stale_same_task_queue_workers "$workspace" "$queue" "$expected_backend" "999999"

assert_dead "$stale_pid" "same-worktree worker with stale backend is killed"
assert_alive "$current_pid" "same-worktree worker with current backend survives"
assert_alive "$other_pid" "other-worktree worker survives"

echo "All run process cleanup tests passed."
