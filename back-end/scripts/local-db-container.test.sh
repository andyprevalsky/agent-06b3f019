#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/local-db-container.sh"

EXISTING_CONTAINERS=""
RUNNING_CONTAINERS=""
READY_CONTAINERS=""
RUNNING_DB_LIST=""
docker() {
  if [[ "$1" == "inspect" && "$2" == "--format" ]]; then
    [[ " $EXISTING_CONTAINERS " == *" $4 "* ]] || return 1
    if [[ " $RUNNING_CONTAINERS " == *" $4 "* ]]; then echo true; else echo false; fi
    return 0
  fi
  if [[ "$1" == "inspect" ]]; then
    [[ " $EXISTING_CONTAINERS " == *" $2 "* ]]
    return
  fi
  if [[ "$1" == "exec" ]]; then
    [[ " $READY_CONTAINERS " == *" $2 "* ]]
    return
  fi
  if [[ "$1" == "ps" ]]; then
    printf '%s\n' "$RUNNING_DB_LIST"
    return 0
  fi
  return 1
}

EXISTING_CONTAINERS="victoria-db-yaounde"
RUNNING_CONTAINERS="$EXISTING_CONTAINERS"
READY_CONTAINERS="$EXISTING_CONTAINERS"
if ! resolved="$(resolve_local_db_container "sms-agent-bugs" "yaounde")"; then
  echo "Expected worktree-directory fallback, got no container" >&2
  exit 1
fi
[[ "$resolved" == "victoria-db-yaounde" ]] || {
  echo "Expected worktree-directory fallback, got: $resolved" >&2
  exit 1
}

EXISTING_CONTAINERS="victoria-db-sms-agent-bugs victoria-db-yaounde"
RUNNING_CONTAINERS="$EXISTING_CONTAINERS"
READY_CONTAINERS="$EXISTING_CONTAINERS"
resolved="$(resolve_local_db_container "sms-agent-bugs" "yaounde")"
[[ "$resolved" == "victoria-db-sms-agent-bugs" ]] || {
  echo "Expected exact workspace match to win, got: $resolved" >&2
  exit 1
}

EXISTING_CONTAINERS="victoria-db-sms-agent-bugs victoria-db-yaounde"
RUNNING_CONTAINERS="victoria-db-yaounde"
READY_CONTAINERS="victoria-db-yaounde"
resolved="$(resolve_local_db_container "sms-agent-bugs" "yaounde")"
[[ "$resolved" == "victoria-db-yaounde" ]] || {
  echo "Expected stopped display-name container to yield to ready worktree container, got: $resolved" >&2
  exit 1
}

EXISTING_CONTAINERS=""
RUNNING_CONTAINERS=""
READY_CONTAINERS=""
if resolve_local_db_container "sms-agent-bugs" "yaounde" >/dev/null; then
  echo "Expected resolver to fail when neither isolated container exists" >&2
  exit 1
fi

RUNNING_DB_LIST="victoria-db-boston victoria-db-guangzhou"
if system_db_fallback_is_safe; then
  echo "Expected shared system Postgres fallback to be rejected" >&2
  exit 1
fi

RUNNING_DB_LIST=""
system_db_fallback_is_safe || {
  echo "Expected system Postgres fallback when no isolated DB is active" >&2
  exit 1
}

echo "Local DB container resolution tests passed"
