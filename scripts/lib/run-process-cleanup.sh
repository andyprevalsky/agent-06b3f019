#!/usr/bin/env bash

run_process_env_value() {
  local pid="$1"
  local key="$2"
  ps eww -p "$pid" 2>/dev/null | tr ' ' '\n' | sed -n "s/^${key}=//p" | tail -1
}

run_process_env_value_wait() {
  local pid="$1"
  local key="$2"
  local value attempt

  for attempt in $(seq 1 10); do
    value="$(run_process_env_value "$pid" "$key")"
    if [ -n "$value" ]; then
      printf '%s\n' "$value"
      return 0
    fi
    sleep 0.05
  done
  return 1
}

run_process_cwd_in_tree() {
  local pid="$1"
  local root="$2"
  local cwd root_physical

  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)" || true
  [ -n "$cwd" ] || return 1
  root_physical="$(cd "$root" && pwd -P)" || return 1

  case "$cwd" in
    "$root_physical"|"$root_physical"/*) return 0 ;;
  esac
  return 1
}

run_process_has_ancestor() {
  local pid="$1"
  local ancestor="$2"

  [ -n "$ancestor" ] && [ "$ancestor" != "0" ] || return 1
  while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ]; do
    [ "$pid" = "$ancestor" ] && return 0
    pid="$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')" || return 1
  done
  return 1
}

run_kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    run_kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

run_kill_stale_same_task_queue_workers() {
  local worktree="$1"
  local task_queue="$2"
  local expected_backend_url="$3"
  local current_pid="${4:-$$}"
  local killed_any=false
  local pid cmd worker_queue worker_backend

  [ -n "$task_queue" ] || return 0
  [ -n "$expected_backend_url" ] || return 0

  for pid in $(pgrep -f "worker\\.py" 2>/dev/null); do
    [ "$pid" != "$$" ] || continue
    if run_process_has_ancestor "$pid" "$current_pid"; then
      continue
    fi
    run_process_cwd_in_tree "$pid" "$worktree" || continue

    worker_queue="$(run_process_env_value_wait "$pid" "TEMPORAL_TASK_QUEUE" || true)"
    [ "$worker_queue" = "$task_queue" ] || continue

    worker_backend="$(run_process_env_value_wait "$pid" "BACKEND_API_URL" || true)"
    if [ -z "$worker_backend" ]; then
      worker_backend="$(run_process_env_value_wait "$pid" "BACKEND_URL" || true)"
    fi
    [ "$worker_backend" != "$expected_backend_url" ] || continue

    cmd="$(ps -p "$pid" -o command= 2>/dev/null)" || cmd="worker.py"
    echo "🧹 Killing stale worker on $task_queue (PID $pid, backend=${worker_backend:-unknown}, expected=$expected_backend_url)"
    echo "   $cmd"
    run_kill_tree "$pid"
    killed_any=true
  done

  if $killed_any; then
    sleep 1
    for pid in $(pgrep -f "worker\\.py" 2>/dev/null); do
      [ "$pid" != "$$" ] || continue
      if run_process_has_ancestor "$pid" "$current_pid"; then
        continue
      fi
      run_process_cwd_in_tree "$pid" "$worktree" || continue
      worker_queue="$(run_process_env_value_wait "$pid" "TEMPORAL_TASK_QUEUE" || true)"
      [ "$worker_queue" = "$task_queue" ] || continue
      worker_backend="$(run_process_env_value_wait "$pid" "BACKEND_API_URL" || true)"
      if [ -z "$worker_backend" ]; then
        worker_backend="$(run_process_env_value_wait "$pid" "BACKEND_URL" || true)"
      fi
      [ "$worker_backend" != "$expected_backend_url" ] || continue
      kill -9 "$pid" 2>/dev/null || true
    done
    echo "✅ Stale same-queue workers stopped"
  fi
}
