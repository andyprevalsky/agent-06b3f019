#!/usr/bin/env bash

# Docker Desktop can wedge while its VM is under pressure. Database discovery
# is setup work, so never let a daemon probe consume an unbounded gate lifetime.
# Successful stdout is preserved for inspect/port/ps callers.
docker_quick() {
  local tmp pid status tick
  tmp=$(mktemp)
  docker "$@" >"$tmp" 2>/dev/null &
  pid=$!
  for ((tick = 0; tick < ${DOCKER_PROBE_TICKS:-25}; tick++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      status=0
      wait "$pid" || status=$?
      cat "$tmp"
      rm -f "$tmp"
      return "$status"
    fi
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$tmp"
  return 124
}

docker_info_quick() {
  docker_quick info >/dev/null
}

# Resolve the isolated Postgres container using both Conductor's mutable
# workspace label and the stable worktree directory name.
resolve_local_db_container() {
  local workspace_hint="${1:-}"
  local worktree_hint="${2:-}"
  local candidates=()
  local candidate

  if [[ -n "$workspace_hint" ]]; then
    candidates+=("victoria-db-$workspace_hint")
  fi
  if [[ -n "$worktree_hint" && "$worktree_hint" != "$workspace_hint" ]]; then
    candidates+=("victoria-db-$worktree_hint")
  fi

  for candidate in "${candidates[@]}"; do
    if [[ "$(docker_quick inspect --format '{{.State.Running}}' "$candidate" || true)" == "true" ]] &&
      docker_quick exec "$candidate" pg_isready -U postgres -q >/dev/null; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

system_db_fallback_is_safe() {
  local running
  running=$(docker_quick ps --filter 'name=^victoria-db-' --format '{{.Names}}') || return 1
  [[ -z "$running" ]]
}
