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

RUNNING_DB_LIST=$'victoria-db-seedmem-513046\nvictoria-db-seedsrc-513046'
system_db_fallback_is_safe || {
  echo "Expected cold-seed measurement containers not to block the system Postgres fallback" >&2
  exit 1
}

RUNNING_DB_LIST=$'victoria-db-seedmem-513046\nvictoria-db-boston'
if system_db_fallback_is_safe; then
  echo "Expected a workspace DB alongside seed measurement containers to reject the fallback" >&2
  exit 1
fi

# ── System Postgres fallback: each workspace's own database, never `victoria` ──
[[ "$(workspace_system_db_name "agent-a8eed88f04ecb85c0")" == "victoria_agent-a8eed88f04ecb85c0" ]] || {
  echo "Expected victoria_<workspace> for a worktree hint" >&2
  exit 1
}
for bad in "" "../x" "a b" "x;drop" "-lead" "$(printf 'x%.0s' {1..60})"; do
  if workspace_system_db_name "$bad" >/dev/null; then
    echo "Expected workspace hint '$bad' to be rejected" >&2
    exit 1
  fi
done

PSQL_CALLS=""
DB_PRESENT=""
psql() {
  PSQL_CALLS+="$*"$'\n'
  if [[ "$*" == *"SELECT 1 FROM pg_database"* ]]; then
    [[ -n "$DB_PRESENT" ]] && echo 1
    return 0
  fi
  if [[ "$*" == *"CREATE DATABASE"* ]]; then
    DB_PRESENT=1
    return 0
  fi
  return 1
}
ensure_workspace_system_db 5432 "victoria_agent-x" || {
  echo "Expected a missing workspace database to be created" >&2
  exit 1
}
[[ "$PSQL_CALLS" == *'CREATE DATABASE "victoria_agent-x"'* ]] || {
  echo "Expected CREATE DATABASE for the workspace database, got: $PSQL_CALLS" >&2
  exit 1
}
PSQL_CALLS=""
ensure_workspace_system_db 5432 "victoria_agent-x" || exit 1
[[ "$PSQL_CALLS" != *"CREATE DATABASE"* ]] || {
  echo "Expected an existing workspace database to be reused" >&2
  exit 1
}
if ensure_workspace_system_db 5432 "victoria"; then
  echo "Expected the shared victoria database to be refused" >&2
  exit 1
fi
unset -f psql

# Both runners' system fallback must go through the workspace database. A
# coverage shard appends its own suffix to the same workspace hint
# ("$WORKSPACE_HINT$SHARD_DB_SUFFIX"), which stays workspace-scoped.
for runner in run-blackbox-tests.sh run-coverage.sh; do
  hint='$WORKSPACE_HINT'
  [[ "$runner" != "run-coverage.sh" ]] || hint='$WORKSPACE_HINT$SHARD_DB_SUFFIX'
  grep -Fq "workspace_system_db_name \"$hint\"" "$SCRIPT_DIR/$runner" || {
    echo "Expected $runner's system Postgres fallback to use workspace_system_db_name with $hint" >&2
    exit 1
  }
done

# A workspace-owned Docker container also hosts the dev stack's seeded
# `victoria` (run.sh): the standalone runners select the workspace database in
# that container too. Only an existing-backend run may use the stack database.
DOCKER_BRANCH="$(sed -n '/^# Try Docker container first/,/^# Fall back to system Postgres/p' "$SCRIPT_DIR/run-blackbox-tests.sh")"
grep -q 'ENSURE_SYSTEM_DB_NAME="$(workspace_system_db_name "$WORKSPACE_HINT")"' <<<"$DOCKER_BRANCH" &&
  grep -q 'SELECTED_DB_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/$ENSURE_SYSTEM_DB_NAME"' <<<"$DOCKER_BRANCH" || {
  echo "Expected run-blackbox-tests.sh's Docker branch to select the victoria_<workspace> database URL" >&2
  exit 1
}
grep -q 'LOCAL_PSQL_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/$ENSURE_SYSTEM_DB_NAME"' "$SCRIPT_DIR/run-coverage.sh" || {
  echo "Expected run-coverage.sh's container helper to select the victoria_<workspace> database URL" >&2
  exit 1
}
[[ "$(grep -c 'use_workspace_container_db$' "$SCRIPT_DIR/run-coverage.sh")" -eq 2 ]] || {
  echo "Expected both run-coverage.sh Docker branches to select the workspace database" >&2
  exit 1
}

# ── Existing-backend runs seed the database the stack's backend reads ──
# run.sh records that database in .context/services.json; a non-default stack
# (victoria_stack_<workspace>) seeded through `victoria` hid every Prisma fixture
# from the backend under test.
MANIFEST_DIR="$(mktemp -d)"
printf '{"database":{"name":"victoria_stack_ws-a","use_system_postgres":true}}\n' > "$MANIFEST_DIR/named.json"
printf '{"database":{"use_system_postgres":true}}\n' > "$MANIFEST_DIR/default.json"
printf '{"database":{"name":"x; drop"}}\n' > "$MANIFEST_DIR/bad.json"
[[ "$(stack_manifest_db_name "$MANIFEST_DIR/named.json")" == "victoria_stack_ws-a" ]] || {
  echo "Expected the stack manifest's database name" >&2
  exit 1
}
[[ "$(stack_manifest_db_name "$MANIFEST_DIR/default.json")" == "victoria" ]] || {
  echo "Expected run.sh's default stack database when the manifest names none" >&2
  exit 1
}
for manifest in "$MANIFEST_DIR/bad.json" "$MANIFEST_DIR/missing.json"; do
  if stack_manifest_db_name "$manifest" >/dev/null; then
    echo "Expected $manifest to be refused" >&2
    exit 1
  fi
done
rm -rf "$MANIFEST_DIR"
STACK_BRANCH="$(sed -n '/^# When testing an already-running stack/,/^# Try Docker container first/p' "$SCRIPT_DIR/run-blackbox-tests.sh")"
grep -q 'STACK_DB_NAME="$(stack_manifest_db_name "$STACK_MANIFEST")"' <<<"$STACK_BRANCH" &&
  [[ "$(grep -c 'SELECTED_DB_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/$STACK_DB_NAME"' <<<"$STACK_BRANCH")" -eq 2 ]] || {
  echo "Expected both existing-stack branches of run-blackbox-tests.sh to select the manifest's database" >&2
  exit 1
}

echo "Local DB container resolution tests passed"
