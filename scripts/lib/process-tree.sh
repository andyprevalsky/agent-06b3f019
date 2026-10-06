#!/usr/bin/env bash
# Stop a background service together with everything it started. Wrappers such
# as `npx` and `tsx` do not forward SIGTERM to the program they launch, so
# signalling only the wrapper's PID orphans the real server, which keeps its
# port and memory after the launching script exits. The tree stays in the
# caller's process group, so a signal to that group still reaches it.

# Prints <pid> and all of its current descendants, parents first.
process_tree_pids() {
  local pid="$1" child
  echo "$pid"
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    process_tree_pids "$child"
  done
}

# Zombies count as stopped: they hold no memory or ports, and an exited child
# stays a zombie until its parent reaps it.
process_running() {
  local state
  state=$(ps -o stat= -p "$1" 2>/dev/null) || return 1
  [[ -n "$state" && "$state" != Z* ]]
}

# stop_process_tree <pid> [grace-seconds]
# Sends TERM to the process and every descendant, sends KILL to whatever is
# still running after the grace period (default 10s), then reaps <pid>.
stop_process_tree() {
  local root="$1" grace="${2:-10}" pid started
  local -a pids=() alive=()
  [[ -n "$root" ]] || return 0
  while read -r pid; do
    pids+=("$pid")
  done < <(process_tree_pids "$root")
  kill -TERM "${pids[@]}" 2>/dev/null || true
  # Bound the grace by wall clock. Counting 0.1s sleeps also counted every
  # per-pid `ps`, so a loaded host stretched a 1s grace past 13s.
  started=$SECONDS
  while :; do
    alive=()
    for pid in "${pids[@]}"; do
      if process_running "$pid"; then alive+=("$pid"); fi
    done
    ((${#alive[@]} > 0)) || break
    ((SECONDS - started <= grace)) || break
    sleep 0.1
  done
  if ((${#alive[@]} > 0)); then kill -KILL "${alive[@]}" 2>/dev/null || true; fi
  wait "$root" 2>/dev/null || true
}
