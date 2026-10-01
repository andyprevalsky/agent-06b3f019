#!/usr/bin/env bash

# `npx` exits on SIGTERM without forwarding it to `tsx`, so signalling only the
# PID that `&` returns leaves tsx and the server it runs alive under PID 1.
# Stopping a long-lived child therefore signals its whole descendant tree. The
# child stays in the caller's process group, so a supervisor that signals that
# group still reaches every process in the tree.

# process_tree_pids PID: PID and every live descendant, parents first.
process_tree_pids() {
  local pid="$1"
  local child
  echo "$pid"
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    process_tree_pids "$child"
  done
}

# stop_process_tree PID [GRACE_SECONDS]
# Sends TERM to PID and every descendant, KILLs whichever of them is still
# alive after the grace period (default 5s), and reaps PID.
stop_process_tree() {
  local root="$1"
  local grace_ticks=$(( ${2:-5} * 10 ))
  local -a pids=()
  local -a alive=()
  local pid _tick
  [[ -n "$root" ]] || return 0
  read -r -a pids <<<"$(process_tree_pids "$root" | tr '\n' ' ')"
  kill -TERM "${pids[@]}" >/dev/null 2>&1 || true
  for ((_tick = 0; _tick < grace_ticks; _tick++)); do
    alive=()
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        alive+=("$pid")
      fi
    done
    ((${#alive[@]} > 0)) || break
    sleep 0.1
  done
  if ((${#alive[@]} > 0)); then
    kill -KILL "${alive[@]}" >/dev/null 2>&1 || true
  fi
  wait "$root" 2>/dev/null || true
}
