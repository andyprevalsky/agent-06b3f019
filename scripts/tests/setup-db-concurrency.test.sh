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
  ps)   exit 0 ;;                       # daemon reachable; no container listed
  run)  stamp CREATE_CONTAINER; exit 0 ;;
  start|rm) exit 0 ;;
  port) exit 1 ;;
  exec)
    if printf '%s\n' "\$@" | grep -q 'pg_isready'; then exit 0; fi
    if printf '%s\n' "\$@" | grep -q 'DROP SCHEMA'; then stamp RESET; exit 0; fi
    exit 0 ;;
  *) exit 0 ;;
esac
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
  *seed-local.ts*)    stamp SEED_START; sleep 1.5; stamp SEED_END; exit 0 ;;
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

run_setup_db() { # run_setup_db <tag> <workspace-name>
  local tag="$1" ws="$2"
  (
    cd "$TMP/fake-repo"
    PATH="$TMP/bin:$PATH" \
    SETUP_DB_TEST_TAG="$tag" \
    CONDUCTOR_PORT=59000 \
    CONDUCTOR_WORKSPACE_NAME="$ws" \
    CONDUCTOR_WORKSPACE_PATH="$TMP/fake-repo" \
    ROSE_WORKSPACE_DB_LOCK_DIR="$TMP/locks" \
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

echo "PASS: setup-db.sh serializes its destructive reset/push/seed per workspace database"
