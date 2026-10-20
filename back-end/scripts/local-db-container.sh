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

# measure-seed-memory.sh's throwaway seedmem/seedsrc containers never host a
# workspace stack, so they must not block another workspace's system fallback.
system_db_fallback_is_safe() {
  local running
  running=$(docker_quick ps --filter 'name=^victoria-db-' --format '{{.Names}}') || return 1
  running=$(printf '%s\n' "$running" | grep -vE '^victoria-db-seed(mem|src)-[0-9]+$' || true)
  [[ -z "$running" ]]
}

# Shared system Postgres hosts every workspace's test database and the dev
# stack's `victoria`. A test runner must never select `victoria` itself: its
# schema sync is `prisma db push --accept-data-loss`, so a worktree on an older
# schema drops other branches' tables. Each workspace gets victoria_<hint>.
workspace_system_db_name() {
  local hint="${1:-}"
  [[ "$hint" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,53}$ ]] || return 1
  printf 'victoria_%s\n' "$hint"
}

# Create the workspace database on system Postgres when it is missing.
# Idempotent and race-safe: a concurrent creator winning is success.
ensure_workspace_system_db() {
  local port="$1" name="$2"
  local admin="postgresql://postgres:postgres@localhost:$port/postgres"
  local exists="SELECT 1 FROM pg_database WHERE datname = '$name'"
  [[ "$name" =~ ^victoria_[A-Za-z0-9][A-Za-z0-9_-]{0,53}$ ]] || return 1
  [[ "$(psql "$admin" -Atc "$exists" </dev/null 2>/dev/null)" == "1" ]] && return 0
  psql "$admin" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$name\"" </dev/null >/dev/null 2>&1 ||
    [[ "$(psql "$admin" -Atc "$exists" </dev/null 2>/dev/null)" == "1" ]]
}

