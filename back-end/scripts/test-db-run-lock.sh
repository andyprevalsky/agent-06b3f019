#!/usr/bin/env bash
# Per-database run lock for the backend blackbox and coverage runners.
#
# RCA cement (2026-10-26 07:18Z): the database name comes from env
# (CONDUCTOR_WORKSPACE_NAME), not from the worktree, so two runners with the
# same workspace identity share victoria_<workspace>. The second runner's
# `prisma db push` + apply-local-runtime-sql-hooks.sh (`DROP TRIGGER`) ran under
# the first runner's live cases and deadlocked them (Postgres 40P01), failing an
# unrelated iphone-control case. A runner that prepares a database therefore
# holds it, exclusively, until it exits; a second runner fails fast and names
# the holder instead of waiting (a coverage run holds it for tens of minutes).
#
# The kernel lock is held by coverage-process-lock.py (fcntl.flock, available on
# macOS where the `flock` CLI is not). It is released the moment its keeper
# exits, and the keeper exits as soon as its runner shell is gone, so a crashed
# or SIGKILLed holder never strands the lock and no stale-owner sweep is needed.
#
# Tunables (env, optional):
#   ROSE_TEST_DB_LOCK_DIR  shared lock directory (default /tmp/rose-test-db-locks)
#
# The default does not follow TMPDIR: runners with different TMPDIR values
# (/var/tmp vs /tmp) must still contend for the same database's lock file.

TEST_DB_RUN_LOCK_KEEPER_PID=""
TEST_DB_RUN_LOCK_FILE=""
TEST_DB_RUN_LOCK_KEY=""

# Canonical lock key for a local Postgres URL: host:port/database, ignoring
# credentials and query parameters so Prisma-tuned and psql URLs match.
test_db_run_lock_key() {  # <postgres-url>
  local rest="${1#*://}" hostport database host port
  case "$rest" in *@*) rest="${rest#*@}" ;; esac
  rest="${rest%%\?*}"
  rest="${rest%%#*}"
  hostport="${rest%%/*}"
  database="${rest#*/}"
  [ "$database" != "$rest" ] && [ -n "$database" ] || return 1
  case "$hostport" in
    \[*\]*)
      # Bracketed IPv6 ([::1]:5432): the address holds colons, so split at `]`.
      host="${hostport%%]*}"
      host="${host#[}"
      port="${hostport#*]}"
      port="${port#:}"
      ;;
    *)
      host="${hostport%%:*}"
      port="${hostport#*:}"
      [ "$port" != "$hostport" ] || port=""
      ;;
  esac
  [ -n "$port" ] || port=5432
  case "$host" in ""|127.0.0.1|::1) host=localhost ;; esac
  printf '%s:%s/%s\n' "$host" "$port" "$database"
}

test_db_run_lock_file() {  # <lock-key>
  local fs_key
  fs_key="$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"
  printf '%s/%s.lock\n' "${ROSE_TEST_DB_LOCK_DIR:-/tmp/rose-test-db-locks}" "$fs_key"
}

# A coverage parent that already holds the lock hands its skip-sync blackbox
# child ROSE_TEST_DB_LOCK_INHERITED_KEY/PID. The child runs under that lock only
# when the key is its own database and the live holder named in the lock's
# owner record is that pid; any other runner acquires the lock itself.
test_db_run_lock_inherited() {  # <postgres-url>
  local key holder="${ROSE_TEST_DB_LOCK_INHERITED_PID:-}" owner
  [ -n "${ROSE_TEST_DB_LOCK_INHERITED_KEY:-}" ] && [[ "$holder" =~ ^[1-9][0-9]*$ ]] || return 1
  key="$(test_db_run_lock_key "$1")" || return 1
  [ "$key" = "$ROSE_TEST_DB_LOCK_INHERITED_KEY" ] || return 1
  kill -0 "$holder" 2>/dev/null || return 1
  owner="$(head -1 "$(test_db_run_lock_file "$key").owner" 2>/dev/null || true)"
  case "$owner" in "pid=$holder "*) return 0 ;; esac
  return 1
}

# acquire_test_db_run_lock <postgres-url> <runner-label>
# Returns 0 holding the lock until this shell exits (or release is called).
acquire_test_db_run_lock() {
  local url="$1" label="${2:-backend test runner}" key status_file keeper attempt status owner holder
  key="$(test_db_run_lock_key "$url")" || {
    echo "❌ Cannot derive a test database lock key from the selected database URL." >&2
    return 1
  }
  TEST_DB_RUN_LOCK_FILE="$(test_db_run_lock_file "$key")"
  mkdir -p "$(dirname "$TEST_DB_RUN_LOCK_FILE")" || return 1
  status_file="$(mktemp "${TMPDIR:-/tmp}/rose-test-db-lock-status.XXXXXX")" || return 1

  python3 "$(dirname "${BASH_SOURCE[0]}")/coverage-process-lock.py" \
    "$TEST_DB_RUN_LOCK_FILE" "$status_file" "$$" &
  keeper=$!
  for attempt in $(seq 1 250); do
    [ -s "$status_file" ] && break
    kill -0 "$keeper" 2>/dev/null || break
    sleep 0.02
  done
  status="$(cat "$status_file" 2>/dev/null || printf 'failed')"
  rm -f "$status_file"

  if [ "$status" = "acquired" ]; then
    TEST_DB_RUN_LOCK_KEEPER_PID="$keeper"
    TEST_DB_RUN_LOCK_KEY="$key"
    # Holder description for a blocked peer. Written only after the kernel
    # lock is ours, so it always describes the live holder.
    printf 'pid=%s runner=%s workspace=%s cwd=%s started=%s\n' \
      "$$" "$label" "${CONDUCTOR_WORKSPACE_NAME:-unset}" "$PWD" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > "$TEST_DB_RUN_LOCK_FILE.owner.tmp.$$" && mv -f "$TEST_DB_RUN_LOCK_FILE.owner.tmp.$$" "$TEST_DB_RUN_LOCK_FILE.owner"
    return 0
  fi

  wait "$keeper" 2>/dev/null || true
  # The kernel lock file names the holder's pid; trust the richer description
  # only when it is about that same pid (a previous holder's may remain).
  holder="${status#blocked:}"
  owner="$(head -1 "$TEST_DB_RUN_LOCK_FILE.owner" 2>/dev/null || true)"
  case "$owner" in "pid=$holder "*) ;; *) owner="pid=$holder" ;; esac
  echo "❌ Test database $key is in use by another backend test runner: $owner" >&2
  echo "   A second runner's schema sync deadlocks the first runner's live cases. Wait for it to finish, or give this" >&2
  echo "   worker its own identity (export CONDUCTOR_WORKSPACE_NAME=<unique> CONDUCTOR_PORT=<unused-port>)." >&2
  TEST_DB_RUN_LOCK_FILE=""
  return 1
}

release_test_db_run_lock() {
  [ -n "$TEST_DB_RUN_LOCK_KEEPER_PID" ] || return 0
  kill "$TEST_DB_RUN_LOCK_KEEPER_PID" 2>/dev/null || true
  wait "$TEST_DB_RUN_LOCK_KEEPER_PID" 2>/dev/null || true
  TEST_DB_RUN_LOCK_KEEPER_PID=""
}
