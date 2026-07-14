#!/usr/bin/env bash

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
    if [[ "$(docker inspect --format '{{.State.Running}}' "$candidate" 2>/dev/null || true)" == "true" ]] &&
      docker exec "$candidate" pg_isready -U postgres -q >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

system_db_fallback_is_safe() {
  [[ -z "$(docker ps --filter 'name=^victoria-db-' --format '{{.Names}}')" ]]
}
