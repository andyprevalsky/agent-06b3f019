#!/usr/bin/env bash

run_wait_owned_agent_shutdown() {  # <pid> <birth> <deadline-seconds>
  local pid="$1" birth="$2" timeout="$3" current state deadline
  [ -n "$pid" ] || return 1
  if ! declare -F cloudbench_pid_start_time_like >/dev/null; then
    . "${BASH_SOURCE[0]%/*}/cloudbench-env.sh" || return 1
  fi
  case "$birth" in
    proc-start:*) ;;
    *) birth="$(printf '%s\n' "$birth" | awk '{$1=$1; print}')" ;;
  esac
  current="$(cloudbench_pid_start_time_like "$pid" "$birth")"
  if [ -z "$current" ]; then
    if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
    echo "❌ Owned worker birth observation is unavailable: pid=$pid" >&2
    return 1
  fi
  [ -n "$birth" ] || { echo "❌ Owned worker birth was not captured: pid=$pid" >&2; return 1; }
  [ "$current" = "$birth" ] || { echo "❌ Owned worker birth does not match: pid=$pid recorded=$birth observed=$current" >&2; return 1; }
  # The supervisor owns worker cancellation. A group/tree signal would also
  # reach its workers, producing the second signal that requests forced exit.
  if [ "${RUN_AGENT_SIGNALLED_IDENTITY:-}" != "$pid:$birth" ]; then
    RUN_AGENT_SIGNALLED_IDENTITY="$pid:$birth"
    kill -TERM "$pid" 2>/dev/null || return 1
  fi
  deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    current="$(cloudbench_pid_start_time_like "$pid" "$birth")"
    if [ -z "$current" ]; then
      if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
      # A missing observation is not proof of termination. Keep joining the
      # exact owner within the existing graceful-shutdown budget.
      sleep 0.1
      continue
    fi
    [ "$current" = "$birth" ] || return 0
    state="$(ps -p "$pid" -o stat= 2>/dev/null | tr -d ' ')"
    case "$state" in Z*) return 0 ;; esac
    sleep 0.1
  done
  echo "❌ Owned worker supervisor did not finish graceful cleanup" >&2
  return 1
}

run_drain_owned_agents() {
  if [ "${AGENTS_DRAINED:-false}" = true ]; then
    [ "${AGENTS_DRAIN_FAILED:-false}" != true ]
    return $?
  fi
  [ -n "${AGENTS_PID:-}" ] || return 0
  local drain_seconds worker_exit=0
  drain_seconds="$(python3 "$SCRIPT_DIR/../agents/scripts/local_worker_supervisor.py" --shutdown-timeout)" || return 1
  run_wait_owned_agent_shutdown "$AGENTS_PID" "${AGENTS_BIRTH:-}" "$drain_seconds" || return 1
  wait "$AGENTS_PID" 2>/dev/null || worker_exit=$?
  AGENTS_DRAINED=true
  if [ "$worker_exit" != 0 ]; then
    AGENTS_DRAIN_FAILED=true
    return 1
  fi
}

# A TERM/INT/HUP that kills run.sh runs its EXIT trap, but bash dies on a SECOND
# signal in the middle of that trap: an operator re-sending TERM to a slow
# teardown (T112: a worker held ~7 min by archive uploads) aborted cleanup after
# its first step, stranding the backend, worker, vite and tunnel with a pending
# cleanup receipt. Fatal signals therefore become an explicit `exit`, so cleanup
# runs once from the EXIT trap, and cleanup silences further signals for itself.
run_install_teardown_signal_traps() {
  trap 'exit 143' TERM
  trap 'exit 130' INT
  trap 'exit 129' HUP
}

run_note_teardown_signal() {  # <name>
  echo "⚠️  Ignoring repeated $1: stack teardown is already running; it is bounded by the worker drain deadline. If this run's owner is gone, recover with: scripts/run-bench --local --run-id <id> --reconcile-cleanup" >&2
}

run_ignore_repeated_teardown_signals() {
  trap 'run_note_teardown_signal TERM' TERM
  trap 'run_note_teardown_signal INT' INT
  trap 'run_note_teardown_signal HUP' HUP
}

run_publish_stack_cleanup_status() {  # <state>
  local state="$1" path="${RUN_STACK_CLEANUP_STATUS_FILE:-}" temporary birth native_identity
  [ -n "$path" ] || return 0
  [ -n "${RUN_STACK_CLEANUP_TOKEN:-}" ] || return 1
  temporary="${path}.tmp.$$"
  birth="$(ps -p "$$" -o lstart= | sed 's/^ *//;s/ *$//')" || return 1
  [ -n "$birth" ] || return 1
  native_identity="$(python3 "$SCRIPT_DIR/process-identity.py" "$$")" || return 1
  [ -n "$native_identity" ] || return 1
  printf 'version=2\ntoken=%s\nstate=%s\nstack_pid=%s\nstack_birth=%s\nstack_native_identity=%s\n' "$RUN_STACK_CLEANUP_TOKEN" "$state" "$$" "$birth" "$native_identity" > "$temporary" \
    && mv -f "$temporary" "$path"
}
# pgrep -f matches its regex anywhere in argv, so every service token must stop
# at an argument boundary: an unbounded `node_modules/.bin/vite` also matches
# `.bin/vitest` and `worker\.py` matches `test_worker.py`, which let stack
# startup kill same-worktree test runs.
RUN_STALE_BENCHMARK_STACK_PATTERN='scripts/run\.sh --benchmark|(^|[[:space:]/])worker\.py([[:space:]]|$)|tsx.*src/server\.ts|node_modules/\.bin/vite([[:space:]]|$)|ngrok http|cloudflared tunnel|localtunnel --port'
RUN_CLOUD_SERVICE_KILL_PATTERNS=(
  '(^|[[:space:]/])worker\.py([[:space:]]|$)'
  'tsx.*server\.ts'
  'npx vite([[:space:]]|$)'
  'run_local_worker'
)

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

# Agent worktrees live INSIDE the canonical checkout (`.claude/worktrees/<n>`),
# so a bare "$root"/* prefix test claims every nested worktree's processes as
# this stack's. On 2026-10-26 a canonical-checkout sweep SIGTERMed a gate
# worker's run.sh in .claude/worktrees/gate-GH that way. A path is in <root>
# only when no directory between <root> (exclusive) and the path has its own
# `.git` — i.e. it does not cross into a nested worktree or checkout.
run_path_in_worktree() {  # <path> <root>
  local path="$1" root="${2%/}" dir
  [ -n "$path" ] && [ -n "$root" ] || return 1
  case "$path" in
    "$root") return 0 ;;
    "$root"/*) ;;
    *) return 1 ;;
  esac
  dir="${path%/}"
  while [ -n "$dir" ] && [ "$dir" != "$root" ]; do
    [ -e "$dir/.git" ] && return 1
    dir="${dir%/*}"
  done
  return 0
}

# argv form of run_path_in_worktree: some token names a path inside <root>
# (bounded at a path separator, so `<root>-other` and nested worktrees miss).
run_cmd_mentions_worktree() {  # <command> <root>
  local cmd="$1" root="${2%/}" token rest
  [ -n "$root" ] || return 1
  local -a tokens
  read -r -a tokens <<<"$cmd" || true
  for token in ${tokens[@]+"${tokens[@]}"}; do
    case "$token" in *"$root"*) ;; *) continue ;; esac
    rest="${token#*"$root"}"
    case "$rest" in ""|/*) ;; *) continue ;; esac
    run_path_in_worktree "$root$rest" "$root" && return 0
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

  run_path_in_worktree "$cwd" "$root_physical"
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
