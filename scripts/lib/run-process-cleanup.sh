#!/usr/bin/env bash

run_required_service_exit_code() {
  local exit_code="$1"

  # A required long-running service has no successful terminal state while
  # run.sh is supervising it. Node services commonly translate SIGTERM into a
  # clean exit, so preserving zero here would leave the rest of the stack alive
  # and make callers poll a dead service until their much longer task timeout.
  if [ "$exit_code" -eq 0 ]; then
    printf '%s\n' 1
    return 0
  fi
  printf '%s\n' "$exit_code"
}

run_process_env_value() {
  local pid="$1"
  local key="$2"
  local environ="/proc/${pid}/environ"
  local value=""

  # Prefer /proc/<pid>/environ: it is the process's real env block. `ps eww`
  # can surface duplicate/redacted KEY=value tokens under sandboxed hosts, and
  # `tail -1` then picks a value that never matches the worker's real queue or
  # backend URL — leaving stale same-queue workers alive across restarts.
  if [ -r "$environ" ]; then
    value="$(tr '\0' '\n' <"$environ" | sed -n "s/^${key}=//p" | head -1)"
  fi
  if [ -z "$value" ]; then
    value="$(ps eww -p "$pid" 2>/dev/null | tr ' ' '\n' | sed -n "s/^${key}=//p" | head -1)"
  fi
  printf '%s\n' "$value"
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

run_db_container_instance_is_owned() {
  local expected_id="$1"
  local container_name="$2"
  local current_id

  [ -n "$expected_id" ] || return 1
  current_id="$(docker inspect --format='{{.Id}}' "$container_name" 2>/dev/null || true)"
  [ "$current_id" = "$expected_id" ]
}

run_cleanup_owned_db_container() {
  local expected_id="$1"
  local container_name="$2"
  local volume_name="$3"
  local isolated_run="$4"

  # The normal per-workspace database is shared across sequential run.sh
  # invocations, so service cleanup must leave it running for a newer owner.
  [ "$isolated_run" = "true" ] || return 0
  if ! run_db_container_instance_is_owned "$expected_id" "$container_name"; then
    echo "⚠️  Skipping DB cleanup: $container_name was replaced by another run"
    return 0
  fi

  # Act on the immutable instance ID so a name replacement after the ownership
  # check cannot redirect this cleanup to another run's container.
  docker rm -f "$expected_id" 2>/dev/null || true
  docker volume rm "$volume_name" 2>/dev/null || true
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
