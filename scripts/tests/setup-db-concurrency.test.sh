#!/usr/bin/env bash
# Focused test for setup-db.sh's destructive critical section
# (reset schema → push schema → seed prod data → publish benchmark dump).
#
# RCA cement (descend ecommerce-minus-antibot, epoch 1, I-01). A fresh Conductor
# workspace runs `bash scripts/setup-db.sh` as the tail of its `setup` hook
# (.conductor/settings.toml) at the same moment the first `/sync` in that
# workspace runs the very same script. Both target ONE database — the workspace
# container victoria-db-$CONDUCTOR_WORKSPACE_NAME — and nothing serialized them,
# so the second invocation ran
#
#     DROP SCHEMA public CASCADE; CREATE SCHEMA public;   +   prisma db push
#
# straight through the first invocation's in-flight seed. Observed on
# 2026-07-27 at 22:52:17-22:52:20 UTC in the workspace Postgres log, mid-seed:
#
#   ERROR: relation "public.LocalStorageOrigin" does not exist
#   ERROR: relation "public.IndexedDBOrigin" does not exist
#   ERROR: there is no unique or exclusion constraint matching the ON CONFLICT
#          specification            (BrowserPermission's unique index not re-created yet)
#   ERROR: insert or update on table "PasskeyCredential" violates foreign key
#          constraint "PasskeyCredential_userId_fkey"   (User row wiped mid-seed)
#
# — i.e. tables, indexes, and rows the seed had already written vanished under
# it. The seed aborted, so `/sync` had no trustworthy local database and the
# whole descent was blocked on an unexplained "seed failed".
#
# This suite drives the SHIPPED script with stubbed docker/npx so it is
# hermetic and fast. Two invocations race on one workspace identity; the stub
# seed records the window it occupies and the stub reset/push record when they
# fire. The invariant is the one the bug broke:
#
#   case 1 — no reset or schema push from either invocation may land inside the
#            other invocation's seed window.
#   case 2 — both invocations still complete successfully (the loser waits its
#            turn instead of aborting).
#   case 3 — a crashed holder's lock does not deadlock a later invocation.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP_DB="${SETUP_DB_CONCURRENCY_SCRIPT:-$ROOT_DIR/scripts/setup-db.sh}"
[ -f "$SETUP_DB" ] || { echo "FATAL: missing $SETUP_DB" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

EVENTS="$TMP/events.log"
: > "$EVENTS"

mkdir -p "$TMP/bin"

# ── Stub docker ───────────────────────────────────────────────────────────────
# Only the calls setup-db.sh makes are modelled. `docker exec … psql -c 'DROP
# SCHEMA…'` is the destructive reset; it is recorded so the invariant can see it.
cat > "$TMP/bin/docker" <<STUB
#!/usr/bin/env bash
set -uo pipefail
EVENTS="$EVENTS"
stamp() { printf '%s %s %s\n' "\$(date +%s%N)" "\${SETUP_DB_TEST_TAG:-?}" "\$1" >> "\$EVENTS"; }
case "\$1" in
  ps)
    if [ "\${SETUP_DB_TEST_CONFLICT:-}" = 1 ] && [[ "\$*" == *--format* ]]; then
      printf '%s\n' 'victoria-db-sibling 0.0.0.0:59005->5432/tcp'
      if [[ "\$*" == *-a* ]]; then printf '%s\n' 'victoria-db-fake-repo'; fi
    fi
    exit 0 ;;                           # daemon reachable
  inspect)
    if [ "\${SETUP_DB_TEST_CONFLICT:-}" = 1 ]; then printf '%s\n' 'postgres:16-alpine'; fi
    exit 0 ;;
  run)  stamp CREATE_CONTAINER; [ "\${SETUP_DB_TEST_DOCKER_FAIL:-0}" != 1 ] ;;
  start) exit 0 ;;
  rm) stamp RM_CONTAINER; exit 0 ;;
  port) printf '%s\n' '0.0.0.0:59006'; exit 0 ;;
  exec)
    if printf '%s\n' "\$@" | grep -q 'pg_isready'; then exit 0; fi
    if printf '%s\n' "\$@" | grep -q 'DROP SCHEMA'; then stamp RESET; exit 0; fi
    exit 0 ;;
  *) exit 0 ;;
esac
STUB

# If a buggy setup-db falls back to system Postgres on a port collision, keep
# this hermetic test from touching the host's shared database.
cat > "$TMP/bin/pg_isready" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$TMP/bin/psql" <<STUB
#!/usr/bin/env bash
printf '%s\n' SYSTEM_PG >> "$EVENTS"
exit 1
STUB

# ── Stub npx ──────────────────────────────────────────────────────────────────
# `prisma db push` is the schema (re)creation; `seed-local.ts` is the long
# critical write window the reset destroyed.
cat > "$TMP/bin/npx" <<STUB
#!/usr/bin/env bash
set -uo pipefail
EVENTS="$EVENTS"
stamp() { printf '%s %s %s\n' "\$(date +%s%N)" "\${SETUP_DB_TEST_TAG:-?}" "\$1" >> "\$EVENTS"; }
args="\$*"
case "\$args" in
  *"prisma db push"*) stamp PUSH; sleep 0.2; exit 0 ;;
  *seed-local.ts*)
    stamp SEED_START
    # Case 6 swaps in a long-lived seed so signal handling is observable.
    if [ -n "\${SETUP_DB_TEST_SEED_COMMAND:-}" ]; then
      "\$SETUP_DB_TEST_SEED_COMMAND"
    else
      sleep 1.5
    fi
    stamp SEED_END; exit 0 ;;
  *)                  exit 0 ;;
esac
STUB

# ── Stub the sibling scripts setup-db.sh shells out to ────────────────────────
mkdir -p "$TMP/fake-repo"
cp -R "$ROOT_DIR/scripts" "$TMP/fake-repo/scripts"
# SETUP_DB_CONCURRENCY_SCRIPT lets the RCA point this same suite at a historical
# setup-db.sh to confirm it goes red on the buggy revision. Deploy always runs
# the shipped one.
cp "$SETUP_DB" "$TMP/fake-repo/scripts/setup-db.sh"
mkdir -p "$TMP/fake-repo/back-end/scripts"
cat > "$TMP/fake-repo/back-end/scripts/apply-local-workflow-ddl.sh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$TMP/fake-repo/scripts/benchmark-seed-cache" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "/tmp/fake-seed.dump"
STUB
touch "$TMP/fake-repo/back-end/prisma-schema-placeholder"
mkdir -p "$TMP/fake-repo/back-end/prisma"
touch "$TMP/fake-repo/back-end/prisma/schema.prisma"
chmod +x "$TMP/bin"/* "$TMP/fake-repo/back-end/scripts/apply-local-workflow-ddl.sh" \
  "$TMP/fake-repo/scripts/benchmark-seed-cache"

# A failed Mac container must never redirect a destructive setup to shared PG.
cp "$TMP/bin/pg_isready" "$TMP/mac-control-pg_isready"
cp "$TMP/bin/psql" "$TMP/mac-control-psql"
cat > "$TMP/bin/uname" <<'STUB'
#!/usr/bin/env bash
echo Darwin
STUB
cat > "$TMP/bin/pg_isready" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$TMP/bin/psql" <<STUB
#!/usr/bin/env bash
printf '%s\n' SYSTEM_PG_TOUCHED >> "$EVENTS"
exit 0
STUB
cat > "$TMP/bin/createdb" <<STUB
#!/usr/bin/env bash
printf '%s\n' SYSTEM_PG_TOUCHED >> "$EVENTS"
exit 0
STUB
chmod +x "$TMP/bin/uname" "$TMP/bin/pg_isready" "$TMP/bin/psql" "$TMP/bin/createdb"
set +e
(
  cd "$TMP/fake-repo"
  PATH="$TMP/bin:$PATH" SETUP_DB_TEST_DOCKER_FAIL=1 \
    CONDUCTOR_PORT=59000 CONDUCTOR_WORKSPACE_NAME=fake-repo \
    CONDUCTOR_WORKSPACE_PATH="$TMP/fake-repo" ROSE_USE_SYSTEM_PG=false \
    ROSE_WORKSPACE_DB_LOCK_DIR="$TMP/locks" \
    bash scripts/setup-db.sh > "$TMP/mac-fallback.out" 2>&1
)
mac_fallback_rc=$?
set -e
[ "$mac_fallback_rc" -ne 0 ] || fail "failed Mac Docker setup unexpectedly succeeded through shared Postgres"
! grep -q SYSTEM_PG_TOUCHED "$EVENTS" || fail "failed Mac Docker setup touched shared Postgres"
! grep -q 'PUSH\|SEED_START' "$EVENTS" || fail "failed Mac Docker setup reached destructive schema/seed work"
rm "$TMP/bin/uname" "$TMP/bin/createdb"
mv "$TMP/mac-control-pg_isready" "$TMP/bin/pg_isready"
mv "$TMP/mac-control-psql" "$TMP/bin/psql"
: > "$EVENTS"

run_setup_db() { # run_setup_db <tag> <workspace-name>
  local tag="$1" ws="$2"
  # Hermetic suite stubs Docker; force ROSE_USE_SYSTEM_PG=false so an inherited
  # Cloud ROSE_USE_SYSTEM_PG=true cannot divert into the host-Postgres path.
  # (Do not put comments inside the env\ continuation — they break PATH=.)
  (
    cd "$TMP/fake-repo"
    PATH="$TMP/bin:$PATH" \
    SETUP_DB_TEST_TAG="$tag" \
    CONDUCTOR_PORT=59000 \
    CONDUCTOR_WORKSPACE_NAME="$ws" \
    CONDUCTOR_WORKSPACE_PATH="$TMP/fake-repo" \
    ROSE_WORKSPACE_DB_LOCK_DIR="$TMP/locks" \
    ROSE_USE_SYSTEM_PG=false \
    SETUP_DB_TEST_SEED_COMMAND="${SETUP_DB_TEST_SEED_COMMAND:-}" \
      bash "$TMP/fake-repo/scripts/setup-db.sh" > "$TMP/$tag.out" 2>&1
    printf '%s\n' "$?" > "$TMP/$tag.rc"
  )
}

# Return the [start,end] nanosecond window of <tag>'s seed, or empty when absent.
seed_window() { # seed_window <tag>
  local tag="$1" start end
  start="$(awk -v t="$tag" '$2 == t && $3 == "SEED_START" { print $1; exit }' "$EVENTS")"
  end="$(awk -v t="$tag" '$2 == t && $3 == "SEED_END" { print $1; exit }' "$EVENTS")"
  [ -n "$start" ] && [ -n "$end" ] && printf '%s %s\n' "$start" "$end"
}

# ── Case 1 + 2: two concurrent invocations on ONE workspace database ──────────
# B is released only once A is provably inside its seed. Sleeping a fixed amount
# instead would let B finish its reset/push before A's seed even started, so the
# suite would go green on the buggy script purely by scheduling luck.
: > "$EVENTS"
run_setup_db A shared-ws &
pid_a=$!
for _ in $(seq 1 100); do
  grep -q ' A SEED_START$' "$EVENTS" && break
  sleep 0.05
done
grep -q ' A SEED_START$' "$EVENTS" || fail "setup: invocation A never reached its seed
--- A output ---
$(cat "$TMP/A.out" 2>/dev/null)"
run_setup_db B shared-ws &
pid_b=$!
wait "$pid_a" "$pid_b" || true

for tag in A B; do
  rc="$(cat "$TMP/$tag.rc" 2>/dev/null || echo missing)"
  [ "$rc" = "0" ] || fail "case 2: invocation $tag exited rc=$rc (expected 0)
--- $tag output ---
$(cat "$TMP/$tag.out" 2>/dev/null)"
done

for tag in A B; do
  read -r w_start w_end <<<"$(seed_window "$tag")"
  [ -n "${w_start:-}" ] || fail "case 1: invocation $tag never ran its seed"
  other="$([ "$tag" = A ] && echo B || echo A)"
  intruder="$(awk -v o="$other" -v s="$w_start" -v e="$w_end" \
    '$2 == o && ($3 == "RESET" || $3 == "PUSH") && $1 >= s && $1 <= e { print $3; exit }' "$EVENTS")"
  [ -z "$intruder" ] || fail \
    "case 1: invocation $other ran a destructive $intruder inside $tag's seed window — \
a concurrent setup-db.sh wipes the peer's in-flight prod sync
--- events ---
$(cat "$EVENTS")"
done

# ── Case 3: a dead holder's lock must not deadlock the next invocation ────────
mkdir -p "$TMP/locks"
# 2147483646 is above every real PID on macOS/Linux, so it is guaranteed dead.
printf '%s\n' "2147483646" > "$TMP/locks/victoria-db-stale-ws.lock"
: > "$EVENTS"
run_setup_db C stale-ws
rc="$(cat "$TMP/C.rc" 2>/dev/null || echo missing)"
[ "$rc" = "0" ] || fail "case 3: a stale lock from a dead holder blocked setup-db.sh (rc=$rc)
--- C output ---
$(cat "$TMP/C.out" 2>/dev/null)"
grep -q ' C SEED_END$' "$EVENTS" || fail "case 3: setup-db.sh never completed its seed after breaking a stale lock"

# ── Case 4: a LIVE holder must make the waiter time out, not wait forever ────
# The wait budget exists so a blocked workspace setup fails loudly instead of
# hanging indefinitely. Case 3 covers the dead-holder break; this covers the
# opposite branch, which nothing exercised: the holder is ALIVE, so the lock is
# never broken and the loop must terminate at the configured budget.
mkdir -p "$TMP/locks"
sleep 120 &
live_holder=$!
printf '%s\n' "$live_holder" > "$TMP/locks/victoria-db-live-ws.lock"

timeout_start="$(date +%s)"
set +e
ROSE_WORKSPACE_DB_LOCK_DIR="$TMP/locks" \
  ROSE_WORKSPACE_DB_LOCK_WAIT_SECONDS=4 \
  ROSE_WORKSPACE_DB_LOCK_POLL_SECONDS=1 \
  bash -c '. "$1/lib/workspace-db-lock.sh"; acquire_workspace_db_lock victoria-db-live-ws' \
  _ "$ROOT_DIR/scripts" >"$TMP/D.out" 2>&1
timeout_rc=$?
set -e
timeout_elapsed=$(( $(date +%s) - timeout_start ))
kill "$live_holder" 2>/dev/null || true
wait "$live_holder" 2>/dev/null || true

[ "$timeout_rc" != "0" ] || fail "case 4: acquiring a lock held by a LIVE pid succeeded; the budget never applied
--- D output ---
$(cat "$TMP/D.out" 2>/dev/null)"
grep -q 'Timed out (4s)' "$TMP/D.out" || fail "case 4: no timeout diagnostic naming the budget
--- D output ---
$(cat "$TMP/D.out" 2>/dev/null)"
# Bounded above so a regression that ignores the budget and falls back to the
# 1800s default cannot pass by eventually failing for some unrelated reason.
[ "$timeout_elapsed" -lt 30 ] || fail \
  "case 4: waiter took ${timeout_elapsed}s to honor a 4s budget"

# ── Case 5: system-PG lock keys contain '/' and must still acquire ───────────
# Key shape from setup-db.sh: `system-pg:localhost:5432/victoria`. A naive
# `$lock_dir/${key}.lock` nests under a missing subdirectory; shlock then fails
# every claim and waiters hang for the full budget on Cloud VMs.
mkdir -p "$TMP/locks"
set +e
ROSE_WORKSPACE_DB_LOCK_DIR="$TMP/locks" \
  ROSE_WORKSPACE_DB_LOCK_WAIT_SECONDS=4 \
  ROSE_WORKSPACE_DB_LOCK_POLL_SECONDS=1 \
  bash -c '. "$1/lib/workspace-db-lock.sh"; acquire_workspace_db_lock "system-pg:localhost:5432/victoria"' \
  _ "$ROOT_DIR/scripts" >"$TMP/E.out" 2>&1
slash_rc=$?
set -e
[ "$slash_rc" = "0" ] || fail "case 5: system-PG lock key with '/' failed to acquire (rc=$slash_rc)
--- E output ---
$(cat "$TMP/E.out" 2>/dev/null)"
[ -f "$TMP/locks/system-pg:localhost:5432_victoria.lock" ] || fail \
  "case 5: expected flattened lock file system-pg:localhost:5432_victoria.lock
--- locks ---
$(ls -la "$TMP/locks" 2>/dev/null)"

# ── Case 6: TERM must stop the seed child, not just the script ───────────────
# Releasing the lock on EXIT is not enough. The destructive section spawns
# long-lived children (`prisma db push`, `seed-local.ts`); bash signals only the
# script, so a TERM'd setup-db released its lock and returned while its seed
# child kept writing prod rows into a database another process had just claimed.
# Observed 2026-08-19 during /deploy: stopping a mid-flight setup-db left
# `tsx scripts/seed-local.ts` alive against victoria-db-dallas and it corrupted a
# concurrent back-end coverage run (11 domains failing with 500s). "Stopped"
# must mean stopped.
: > "$EVENTS"
mkdir -p "$TMP/locks"
CHILD_MARKER="$TMP/orphan-child-alive"
rm -f "$CHILD_MARKER"
# The seed stub for this case parks a long-lived grandchild exactly the way the
# real seed does, ignores graceful termination, and keeps touching a marker so
# survival is observable. Teardown must retain the lock through its grace window
# and then force this child to stop.
cat > "$TMP/fake-repo/back-end/scripts/long-seed.sh" <<STUB
#!/usr/bin/env bash
trap '' INT TERM
for _ in \$(seq 1 200); do
  printf '%s\n' "alive" > "$CHILD_MARKER"
  sleep 0.1
done
STUB
chmod +x "$TMP/fake-repo/back-end/scripts/long-seed.sh"
# Launch setup-db as a real process-group leader. This is the production branch
# that used to signal itself before it could release the workspace lock.
(
  cd "$TMP/fake-repo"
  exec env \
    PATH="$TMP/bin:$PATH" \
    SETUP_DB_TEST_TAG=F \
    CONDUCTOR_PORT=59000 \
    CONDUCTOR_WORKSPACE_NAME=term-ws \
    CONDUCTOR_WORKSPACE_PATH="$TMP/fake-repo" \
    ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1 \
    ROSE_WORKSPACE_DB_LOCK_DIR="$TMP/locks" \
    ROSE_USE_SYSTEM_PG=false \
    SETUP_DB_TEARDOWN_GRACE_SECONDS=1 \
    SETUP_DB_TEST_SEED_COMMAND="$TMP/fake-repo/back-end/scripts/long-seed.sh" \
    python3 -c 'import os, sys; os.setsid(); os.execv("/bin/bash", ["bash", sys.argv[1]])' \
      "$TMP/fake-repo/scripts/setup-db.sh"
) > "$TMP/F.out" 2>&1 &
term_pid=$!
for _ in $(seq 1 200); do
  [ -f "$CHILD_MARKER" ] && break
  sleep 0.05
done
if [ -f "$CHILD_MARKER" ]; then
  kill -TERM "$term_pid" 2>/dev/null || true
  # Give TERM a moment to enter teardown (which masks INT) before the follow-up
  # stress signal. Product path also preserves the first teardown signal.
  sleep 0.2
  kill -INT "$term_pid" 2>/dev/null || true
  sleep 0.1
  [ -f "$TMP/locks/victoria-db-term-ws.lock" ] || fail \
    "case 6: teardown released the workspace DB lock while a TERM-resistant seed child was still alive"
  set +e
  wait "$term_pid" 2>/dev/null
  term_status=$?
  set -e
  # 143 = TERM (15); 130 = INT (2) only if INT won delivery before TERM. Both
  # prove signal teardown completed; child-death + lock-release are the invariants.
  [ "$term_status" -eq 143 ] || [ "$term_status" -eq 130 ] || fail \
    "case 6: TERM'd setup-db.sh exited rc=$term_status instead of 143/130"
  rm -f "$CHILD_MARKER"
  sleep 0.3
  [ ! -f "$CHILD_MARKER" ] || fail \
    "case 6: a TERM'd setup-db.sh left its seed child running — it keeps writing to a
database the next holder already claimed"
  [ ! -f "$TMP/locks/victoria-db-term-ws.lock" ] || fail \
    "case 6: process-group teardown exited before releasing the workspace DB lock"
  pkill -f "$TMP/fake-repo/back-end/scripts/long-seed.sh" 2>/dev/null || true
else
  kill -TERM "$term_pid" 2>/dev/null || true
  wait "$term_pid" 2>/dev/null || true
  pkill -f "$TMP/fake-repo/back-end/scripts/long-seed.sh" 2>/dev/null || true
  echo "case 6: skipped (could not observe a live seed child on this host)" >&2
fi

# ── Case 7: grace cleanup must TERM descendants discovered after teardown starts ─
# In a shared caller process group, cleanup signals PIDs individually. A wrapper
# can react to its first TERM by forking one final child; that child must receive
# TERM during the grace rescan, not its first signal as KILL after grace expires.
grace_loop="$({
  sed -n '/while \[ \$((SECONDS - grace_started)) -lt "\$grace" \]; do/,/^[[:space:]]*done$/p' \
    "$SETUP_DB"
} 2>/dev/null)"
grep -q 'setup_db_child_records' <<<"$grace_loop" || fail \
  "case 7: graceful cleanup does not rescan for late descendants"
grep -q 'setup_db_term_records' <<<"$grace_loop" || fail \
  "case 7: descendants discovered during grace are remembered but never sent TERM"

# ── Case 8: force cleanup must keep discovering late descendants ─────────────
# A TERM-resistant wrapper can fork after the first KILL target snapshot. The
# force window must rescan inside every iteration; a one-time pre-loop scan can
# release the DB lock while that late child is still writing.
force_loop="$({
  sed -n '/while \[ \$((SECONDS - force_started)) -lt 2 \]; do/,/^[[:space:]]*done$/p' \
    "$SETUP_DB"
} 2>/dev/null)"
grep -q 'setup_db_child_records' <<<"$force_loop" || fail \
  "case 8: force-cleanup loop does not rescan descendants before releasing the DB lock"
grep -q 'kill -KILL' <<<"$force_loop" || fail \
  "case 8: force-cleanup loop discovers descendants but does not stop late arrivals"

# ── Case 8b: surviving descendants must be visible before lock release ───────
post_force="$({
  sed -n '/for pid in \$reap_pids; do/,/release_workspace_db_lock/p' "$SETUP_DB"
} 2>/dev/null)"
grep -q 'setup_db_child_records' <<<"$post_force" || fail \
  "case 8b: teardown does not make a final descendant scan before releasing the DB lock"
grep -q 'setup_db_pid_matches_record' <<<"$post_force" || fail \
  "case 8b: teardown warns about descendants without revalidating process identity"
grep -q 'survived SIGKILL.*PID\|PID .*survived SIGKILL' <<<"$post_force" || fail \
  "case 8b: teardown silently releases the DB lock while a descendant survives SIGKILL"

# ── Case 9: retained PIDs must be identity-checked before force cleanup ───────
# A short-lived child can exit during the grace phase and its numeric PID can be
# reused before a later force-loop iteration. PID plus start time distinguish the
# owned process incarnation from the unrelated replacement process; parent/group
# values are capture-time provenance because descendants may detach or reparent.
grep -q 'setup_db_pid_matches_record' <<<"$force_loop" || fail \
  "case 9: force cleanup can SIGKILL a recycled PID without revalidating identity"
grep -q 'lstart=' "$SETUP_DB" || fail \
  "case 9: descendant identity does not include process start time"
grep -q 'current_started.*expected_started' "$SETUP_DB" || fail \
  "case 9: process start time is captured but never revalidated"

# ── Case 10: retained identity must survive setsid plus reparenting ───────────
# A seed can detach from its original process group while its wrapper exits.
# PPID and PGID then both differ from the capture-time descendant record, but it
# is still the same live process and must remain eligible for force cleanup.
DETACHED_TRIGGER="$TMP/detached-child-trigger"
DETACHED_READY="$TMP/detached-child-ready"
DETACHED_PID_FILE="$TMP/detached-child.pid"
rm -f "$DETACHED_TRIGGER" "$DETACHED_READY" "$DETACHED_PID_FILE"
cat > "$TMP/detaching-child.py" <<STUB
#!/usr/bin/env python3
import os
import time
from pathlib import Path

trigger = Path("$DETACHED_TRIGGER")
ready = Path("$DETACHED_READY")
if os.fork():
    while True:
        time.sleep(0.1)

pid_file = Path("$DETACHED_PID_FILE")
pending = pid_file.with_suffix(".tmp")
with pending.open("w") as handle:
    # Existence must imply a complete PID, even with a delayed write.
    time.sleep(0.2)
    handle.write(str(os.getpid()))
pending.replace(pid_file)
while not trigger.exists():
    time.sleep(0.02)
os.setsid()
ready.write_text("detached")
while True:
    time.sleep(0.1)
STUB
python3 "$TMP/detaching-child.py" &
detach_parent_pid=$!
detached_pid=""
case10_cleanup() {
  [ -z "$detached_pid" ] || kill -KILL "$detached_pid" 2>/dev/null || true
  kill -KILL "$detach_parent_pid" 2>/dev/null || true
  wait "$detach_parent_pid" 2>/dev/null || true
}
case10_fail() {
  local message="$1"
  case10_cleanup
  fail "$message"
}
for _ in $(seq 1 200); do
  [ -f "$DETACHED_PID_FILE" ] && break
  sleep 0.05
done
[ -f "$DETACHED_PID_FILE" ] || case10_fail \
  "case 10: could not observe the forked seed child"
detached_pid="$(cat "$DETACHED_PID_FILE")"
# `|| true`: under errexit + pipefail a failed probe would exit silently and skip
# the diagnostic below.
detached_record="$(ps -o pid=,ppid=,pgid=,lstart= -p "$detached_pid" 2>/dev/null | awk '
  NR == 1 { print $1 "|" $2 "|" $3 "|" $4 " " $5 " " $6 " " $7 " " $8 }
' || true)"
[ -n "$detached_record" ] || case10_fail \
  "case 10: could not capture the seed child's original identity"
IFS='|' read -r _ expected_parent expected_group _ <<< "$detached_record"

: > "$DETACHED_TRIGGER"
for _ in $(seq 1 100); do
  [ -f "$DETACHED_READY" ] && break
  sleep 0.05
done
[ -f "$DETACHED_READY" ] || case10_fail \
  "case 10: seed child did not call setsid"
# Reparent only after setsid so the regression covers both identity changes in
# the same order as a detaching child whose wrapper subsequently exits.
kill -TERM "$detach_parent_pid" 2>/dev/null || true
wait "$detach_parent_pid" 2>/dev/null || true
for _ in $(seq 1 100); do
  current_parent_group="$(ps -o ppid=,pgid= -p "$detached_pid" 2>/dev/null | awk \
    'NR == 1 { print $1 "|" $2 }' || true)"
  IFS='|' read -r current_parent current_group <<< "$current_parent_group"
  if [ -n "$current_parent" ] \
      && [ "$current_parent" != "$expected_parent" ] \
      && [ "$current_group" != "$expected_group" ]; then
    break
  fi
  sleep 0.05
done
[ -n "${current_parent:-}" ] \
  && [ "$current_parent" != "$expected_parent" ] \
  && [ "$current_group" != "$expected_group" ] || case10_fail \
    "case 10: child did not change both PPID and PGID after setsid/reparenting"

matcher_impl="$(sed -n '/^setup_db_pid_matches_record() {$/,/^}$/p' "$SETUP_DB")"
[ -n "$matcher_impl" ] || case10_fail \
  "case 10: could not load setup_db_pid_matches_record"
eval "$matcher_impl"
setup_db_pid_matches_record "$detached_record" || case10_fail \
  "case 10: retained child identity was lost after setsid plus reparenting"
case10_cleanup

echo "PASS: setup-db.sh serializes its destructive reset/push/seed per workspace database"

# Case 11: a foreign port owner must stop setup before stale-image migration
# removes the workspace container or the fallback resets shared system PG.
: > "$EVENTS"
collision_status=0
(
  cd "$TMP/fake-repo"
  PATH="$TMP/bin:$PATH" \
  SETUP_DB_TEST_CONFLICT=1 \
  CONDUCTOR_PORT=59000 \
  CONDUCTOR_WORKSPACE_NAME=fake-repo \
  CONDUCTOR_WORKSPACE_PATH="$TMP/fake-repo" \
  ROSE_USE_SYSTEM_PG=false \
    bash "$TMP/fake-repo/scripts/setup-db.sh"
) > "$TMP/collision.out" 2>&1 || collision_status=$?
[ "$collision_status" -eq 42 ] || fail "case 11: collision exited $collision_status, expected 42
$(cat "$TMP/collision.out")"
grep -q "already bound by container 'victoria-db-sibling'" "$TMP/collision.out" || \
  fail "case 11: error did not name the foreign port owner"
if grep -Eq 'RM_CONTAINER|CREATE_CONTAINER|SYSTEM_PG|RESET|PUSH|SEED_START' "$EVENTS"; then
  fail "case 11: collision changed a database: $(cat "$EVENTS")"
fi
echo "PASS: setup-db.sh preserves the workspace DB and shared system PG on a port collision"

# Case 12: system Postgres is one server shared by every workspace on the host.
# RCA 2026-10-19: a sub-agent ran `ROSE_USE_SYSTEM_PG=true CONDUCTOR_PORT=3720
# CONDUCTOR_WORKSPACE_NAME=<unique> bash scripts/setup-db.sh` on a Linux devbox;
# setup-db.sh hard-coded `localhost:5432/victoria`, so its DROP SCHEMA + seed
# wiped every other stack's rows. A named workspace must reset only its own
# database (victoria_stack_<workspace>, distinct from the victoria_<workspace>
# test-fixture database). Only the single-tenant cloud identity recorded in
# .cloud-env (same name AND port), an unset workspace, or an explicit
# ROSE_SYSTEM_PG_DB_NAME may reset the shared `victoria`.
SYS="$TMP/system-pg"
mkdir -p "$SYS/bin"
SYS_EVENTS="$SYS/events.log"
cat > "$SYS/bin/pg_isready" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
# Record every database a psql/createdb call targets and whether it is the
# destructive reset. No real server is ever contacted.
cat > "$SYS/bin/psql" <<STUB
#!/usr/bin/env bash
db=""; prev=""; reset=0
for arg in "\$@"; do
  [ "\$prev" = "-d" ] && db="\$arg"
  case "\$arg" in *"DROP SCHEMA"*) reset=1 ;; esac
  prev="\$arg"
done
if [ "\$reset" = 1 ]; then
  printf 'RESET %s\n' "\$db" >> "$SYS_EVENTS"
else
  printf 'PSQL %s\n' "\$db" >> "$SYS_EVENTS"
fi
exit 0
STUB
cat > "$SYS/bin/createdb" <<STUB
#!/usr/bin/env bash
printf 'CREATEDB %s\n' "\${@: -1}" >> "$SYS_EVENTS"
exit 0
STUB
cat > "$SYS/bin/docker" <<STUB
#!/usr/bin/env bash
printf 'DOCKER %s\n' "\$*" >> "$SYS_EVENTS"
exit 1
STUB
cat > "$SYS/bin/npx" <<STUB
#!/usr/bin/env bash
case "\$*" in
  *"prisma db push"*) printf 'PUSH %s\n' "\${DATABASE_URL##*/}" >> "$SYS_EVENTS" ;;
  *seed-local.ts*) printf 'SEED %s\n' "\${DATABASE_URL##*/}" >> "$SYS_EVENTS" ;;
esac
exit 0
STUB
chmod +x "$SYS/bin"/*

make_system_repo() { # make_system_repo <dir>
  mkdir -p "$1/back-end/scripts" "$1/back-end/prisma"
  cp -R "$TMP/fake-repo/scripts" "$1/scripts"
  cp "$TMP/fake-repo/back-end/scripts/apply-local-workflow-ddl.sh" "$1/back-end/scripts/"
  touch "$1/back-end/prisma/schema.prisma"
  cat > "$1/scripts/benchmark-seed-cache" <<STUB
#!/usr/bin/env bash
printf 'SEED_CACHE %s\n' "\${6:-victoria}" >> "$SYS_EVENTS"
printf '%s\n' /tmp/fake-seed.dump
STUB
  chmod +x "$1/scripts/benchmark-seed-cache"
}

run_system_setup_db() { # run_system_setup_db <repo> <port> <workspace> [env...]
  local repo="$1" port="$2" ws="$3"
  shift 3
  : > "$SYS_EVENTS"
  (
    cd "$repo"
    # An isolated deploy worktree exports its own identity and name trust;
    # inheriting them would let the passed name beat the repo's .cloud-env.
    env -u ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME -u ROSE_DEPLOY_WORKTREE \
      -u ROSE_DEPLOY_WORKTREE_PATH -u ROSE_DEPLOY_SOURCE_WORKSPACE \
      PATH="$SYS/bin:$PATH" CONDUCTOR_PORT="$port" CONDUCTOR_WORKSPACE_NAME="$ws" \
      CONDUCTOR_WORKSPACE_PATH="$repo" ROSE_USE_SYSTEM_PG=true \
      ROSE_WORKSPACE_DB_LOCK_DIR="$SYS/locks" "$@" \
      bash "$repo/scripts/setup-db.sh"
  ) > "$SYS/last.out" 2>&1 || fail "case 12: setup-db.sh failed for $ws:$port
$(cat "$SYS/last.out")"
}

expect_system_db() { # expect_system_db <label> <database>
  local label="$1" db="$2" kind
  for kind in RESET PUSH SEED SEED_CACHE; do
    grep -qx "$kind $db" "$SYS_EVENTS" || fail "case 12 ($label): $kind did not target $db:
$(cat "$SYS_EVENTS")"
  done
  if grep -Ev " $db\$| postgres\$" "$SYS_EVENTS" | grep -q .; then
    fail "case 12 ($label): setup-db.sh touched a database other than $db:
$(cat "$SYS_EVENTS")"
  fi
}

make_system_repo "$SYS/ws-alpha"
run_system_setup_db "$SYS/ws-alpha" 3720 ws-alpha
expect_system_db "named workspace" victoria_stack_ws_alpha
grep -qx 'CREATEDB victoria_stack_ws_alpha' "$SYS_EVENTS" \
  || fail "case 12: a missing per-workspace database was not created"

run_system_setup_db "$SYS/ws-alpha" 3720 ws-alpha ROSE_SYSTEM_PG_DB_NAME=victoria
expect_system_db "explicit shared opt-in" victoria

# The cloud VM's own identity keeps the database cloud-init seeds.
make_system_repo "$SYS/cloud"
(
  cd "$SYS/cloud"
  bash -c ". scripts/lib/workspace-env.sh; write_cloud_env .cloud-env 3001 cloud-feedbeef '$SYS/cloud' \"\$(cloud_env_boot_id)\""
)
run_system_setup_db "$SYS/cloud" 3001 cloud-feedbeef
expect_system_db "cloud primary" victoria
# A second stack on that VM inherits the .cloud-env name (the file wins over an
# untrusted CONDUCTOR_WORKSPACE_NAME) but runs on its own port range.
run_system_setup_db "$SYS/cloud" 3720 some-unique-subagent
expect_system_db "second stack on a cloud VM" victoria_stack_cloud_feedbeef_p3720

if ROSE_SYSTEM_PG_DB_NAME='victoria; DROP DATABASE postgres' \
    bash -c ". '$ROOT_DIR/scripts/lib/workspace-env.sh'; workspace_system_pg_db_name ." >/dev/null 2>&1; then
  fail "case 12: an unsafe ROSE_SYSTEM_PG_DB_NAME was accepted"
fi
# run.sh's non-benchmark system-Postgres stack must resolve the same database
# setup-db.sh seeded, not the shared `victoria`.
awk '/System Postgres fallback \(no Docker\)/,/Fast Mode cache is intentionally shared/' \
    "$ROOT_DIR/scripts/run.sh" | grep -q 'LOCAL_DB_NAME="$(workspace_system_pg_db_name ' \
  || fail "case 12: run.sh's system-Postgres stack does not use workspace_system_pg_db_name"
echo "PASS: system-Postgres setup-db.sh resets only the workspace's own database"
