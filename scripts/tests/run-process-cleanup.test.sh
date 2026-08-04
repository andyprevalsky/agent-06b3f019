#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
PIDS=()

# Kill a pid and every descendant. Signalling only the direct pid orphans
# grandchildren, which then hold this script's stdout pipe open long after it
# exits and make the suite look hung.
kill_tree() {
  local root="$1" child
  for child in $(pgrep -P "$root" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -TERM "$root" 2>/dev/null || true
  kill -KILL "$root" 2>/dev/null || true
}

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    kill_tree "$pid"
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
  TEMPORAL_TASK_QUEUE="$queue" BACKEND_API_URL="$stale_backend" python3 -c 'import time; time.sleep(300)' worker.py
) &
stale_pid="$!"
PIDS+=("$stale_pid")
wait_for_process "$stale_pid"

(
  cd "$workspace/agents"
  TEMPORAL_TASK_QUEUE="$queue" BACKEND_API_URL="$expected_backend" python3 -c 'import time; time.sleep(300)' worker.py
) &
current_pid="$!"
PIDS+=("$current_pid")
wait_for_process "$current_pid"

(
  cd "$other_workspace/agents"
  TEMPORAL_TASK_QUEUE="$queue" BACKEND_API_URL="$stale_backend" python3 -c 'import time; time.sleep(300)' worker.py
) &
other_pid="$!"
PIDS+=("$other_pid")
wait_for_process "$other_pid"

run_kill_stale_same_task_queue_workers "$workspace" "$queue" "$expected_backend" "999999"

assert_dead "$stale_pid" "same-worktree worker with stale backend is killed"
assert_alive "$current_pid" "same-worktree worker with current backend survives"
assert_alive "$other_pid" "other-worktree worker survives"

assert_agent_tool_shell_protected() {
  local worktree="$TMP_ROOT/kill-services-worktree"
  local snapshot="$worktree/.claude/shell-snapshots/snapshot-zsh-test.sh"
  mkdir -p "$worktree/scripts" "$(dirname "$snapshot")"
  : > "$snapshot"

  cat > "$worktree/scripts/run.sh" <<'RUNSH'
#!/usr/bin/env bash
sleep 300
RUNSH
  cat > "$worktree/scripts/launch.sh" <<'LAUNCHSH'
#!/usr/bin/env bash
cd "$(dirname "$0")/.." || exit 1
exec bash scripts/run.sh --benchmark
LAUNCHSH
  chmod +x "$worktree/scripts/run.sh" "$worktree/scripts/launch.sh"

  # Mimic the Claude Code Bash tool: a shell that sources a generated snapshot,
  # launches the service tree, and keeps polling afterwards. Its own argv must
  # NOT contain scripts/run.sh, so it can only be reached through the
  # worktree-local ancestor walk.
  (cd "$worktree" && exec bash -c "source '$snapshot'; bash '$worktree/scripts/launch.sh'; sleep 300") &
  local agent_pid="$!"
  PIDS+=("$agent_pid")
  wait_for_process "$agent_pid"

  local service_pid="" attempt
  for attempt in $(seq 1 50); do
    service_pid="$(pgrep -P "$agent_pid" 2>/dev/null | head -1)"
    [ -n "$service_pid" ] && break
    sleep 0.1
  done
  if [ -z "$service_pid" ]; then
    echo "FAIL: decoy run.sh child never started" >&2
    exit 1
  fi

  local targets
  targets="$(cd "$worktree" && bash "$ROOT_DIR/scripts/kill-services.sh" --dry-run 2>/dev/null)"

  if echo "$targets" | grep -Eq "^ +$agent_pid  "; then
    echo "FAIL: agent tool shell $agent_pid was targeted for kill" >&2
    echo "$targets" >&2
    exit 1
  fi
  echo "PASS: agent tool shell is never killed as a service ancestor"

  if ! echo "$targets" | grep -Eq "^ +$service_pid  "; then
    echo "FAIL: run.sh service $service_pid was not targeted" >&2
    echo "$targets" >&2
    exit 1
  fi
  echo "PASS: run.sh service under an agent tool shell is still targeted"

  # The real kill path is what actually regressed: the service tree must die
  # while the agent's own shell keeps running.
  (cd "$worktree" && bash "$ROOT_DIR/scripts/kill-services.sh" >/dev/null 2>&1) || true
  assert_dead "$service_pid" "run.sh service under an agent tool shell is killed"
  assert_alive "$agent_pid" "agent tool shell survives a real kill-services run"

  kill_tree "$agent_pid"
}

assert_agent_tool_shell_protected

assert_db_cleanup_guard "container-old" "container-old" true $'rm -f container-old\nvolume rm victoria-pgdata-test' "isolated owner removes its exact DB instance ID"
assert_db_cleanup_guard "container-old" "container-new" true "" "stale owner cannot remove a replacement DB container"
assert_db_cleanup_guard "container-old" "container-old" false "" "normal service cleanup preserves a shared DB instance"
assert_required_service_exit_code 0 1
assert_required_service_exit_code 17 17

echo "All run process cleanup tests passed."
