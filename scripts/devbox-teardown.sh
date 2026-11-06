#!/usr/bin/env bash
# Devbox-destroy teardown: kill the E2B sandboxes of THIS devbox's stack only.
# Runs in the destroyed devbox's checkout (boxes lifecycle teardown, 30 s limit)
# and never fails the destroy: always exits 0.
#
#   .cloud-env ─► CONDUCTOR_WORKSPACE_NAME ─► roseSandboxIdentity() (backend code)
#     └─► ROSE_SANDBOX_STACK_ID=<this stack> ─► kill-stack-sandboxes.ts
#         (kills only sandboxes tagged with it AND recorded in this local DB)
#
# usage: scripts/devbox-teardown.sh [--dry-run]
# TEARDOWN_BUDGET_SECONDS (default 25) bounds the whole run.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUDGET="${TEARDOWN_BUDGET_SECONDS:-25}"
ARGS=()
[ "${1:-}" = "--dry-run" ] && ARGS+=(--dry-run)

run() {
  [ -f "$ROOT/.cloud-env" ] && . "$ROOT/.cloud-env"
  export CONDUCTOR_WORKSPACE_NAME="${CONDUCTOR_WORKSPACE_NAME:-$(basename "$ROOT")}"
  # The backend tags with the LOCAL stack database (run.sh's LOCAL_DB_URL), not
  # back-end/.env's production URL, so build the same one before computing the id.
  . "$ROOT/scripts/lib/workspace-env.sh" 2>/dev/null || return 0
  local db_name
  db_name="$(workspace_system_pg_db_name "$ROOT" 2>/dev/null)" || return 0
  export DATABASE_URL="postgresql://postgres:postgres@localhost:${SYSTEM_PG_PORT:-5432}/$db_name"
  export DIRECT_URL="$DATABASE_URL"
  cd "$ROOT/back-end" || return 0
  # The same function the backend tags sandboxes with, not a copy of its format.
  local stack
  stack="$(npx tsx scripts/kill-stack-sandboxes.ts --print-stack 2>/dev/null | tail -1)" || return 0
  if [ -z "$stack" ]; then
    echo "devbox-teardown: could not compute the stack id; nothing killed"
    return 0
  fi
  echo "devbox-teardown: stack $stack"
  ROSE_SANDBOX_STACK_ID="$stack" npx tsx scripts/kill-stack-sandboxes.ts ${ARGS[@]+"${ARGS[@]}"}
}

# Subshell in its own timeout so a hang cannot outlive the budget.
export -f run 2>/dev/null || true
ROOT="$ROOT" ARGS_STR="${ARGS[*]-}" timeout "$BUDGET" bash -c "
  ROOT='$ROOT'; ARGS=(\$ARGS_STR); $(declare -f run)
  run
" || echo "devbox-teardown: stopped after ${BUDGET}s budget or error; continuing"
exit 0
