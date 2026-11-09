#!/usr/bin/env bash
# scripts/devbox-teardown.sh: computes this devbox's stack id via the backend's own
# function, passes it explicitly to the killer, honours --dry-run and the time
# budget, and ALWAYS exits 0. A fake `npx` stands in for tsx; nothing reaches E2B.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/devbox-teardown-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
fail() { echo "FAIL: $*" >&2; exit 1; }

cat >"$WORK/bin/npx" <<'F'
#!/usr/bin/env bash
echo "npx $*" >>"$FAKE_LOG"
case "$*" in
  *--print-stack*) echo "DB_URL_FOR_STACK=${DATABASE_URL:-unset}" >>"$FAKE_LOG"
     echo "${FAKE_STACK-host:boxes|ws:fake|db:abc}" ;;
  *) echo "STACK_ENV=${ROSE_SANDBOX_STACK_ID:-unset}" >>"$FAKE_LOG"
     echo "DB_URL_FOR_KILL=${DATABASE_URL:-unset}" >>"$FAKE_LOG"
     [ -n "${FAKE_SLEEP:-}" ] && sleep "$FAKE_SLEEP"
     [ -n "${FAKE_FAIL:-}" ] && exit 7
     echo "kill-stack-sandboxes: killed 1 sandbox(es)" ;;
esac
F
chmod +x "$WORK/bin/npx"
# A fake docker standing in for the workspace's Postgres container (run.sh's Docker path).
cat >"$WORK/bin/docker" <<'F'
#!/usr/bin/env bash
case "$1" in
  inspect) [ -n "${FAKE_DOCKER_CONTAINER:-}" ] && [[ "$*" == *"$FAKE_DOCKER_CONTAINER"* ]] && echo true || exit 1 ;;
  exec) exit 0 ;;
  port) echo "0.0.0.0:${FAKE_DOCKER_PORT:-55432}" ;;
  *) exit 1 ;;
esac
F
chmod +x "$WORK/bin/docker"
export FAKE_LOG="$WORK/log"
# The database selection below depends on ROSE_USE_SYSTEM_PG; a runner or devbox that exports it must not
# decide the default and Docker cases. The forced-system case sets it explicitly.
unset ROSE_USE_SYSTEM_PG
# The teardown also sources <root>/.cloud-env, which exists only on boxes.dev devboxes and exports
# ROSE_USE_SYSTEM_PG=true and the cloud workspace name. Run the unchanged script from a root without one
# (the files it reads, copied byte for byte) so the host's cloud identity cannot decide these cases either.
FIXTURE_ROOT="$WORK/root"
mkdir -p "$FIXTURE_ROOT/scripts/lib" "$FIXTURE_ROOT/back-end/scripts"
cp "$ROOT/scripts/devbox-teardown.sh" "$FIXTURE_ROOT/scripts/"
cp "$ROOT/scripts/lib/workspace-env.sh" "$FIXTURE_ROOT/scripts/lib/"
cp "$ROOT/back-end/scripts/local-db-container.sh" "$FIXTURE_ROOT/back-end/scripts/"
run() { : >"$FAKE_LOG"; PATH="$WORK/bin:$PATH" bash "$FIXTURE_ROOT/scripts/devbox-teardown.sh" "$@"; }

# 1. the explicit stack id computed by the backend function reaches the killer
out="$(run)"; rc=$?
[ "$rc" = 0 ] || fail "rc=$rc"
grep -q 'STACK_ENV=host:boxes|ws:fake|db:abc' "$FAKE_LOG" || fail "killer did not get the computed stack id"
grep -q 'killed 1' <<<"$out" || fail "did not print what it killed"
# 2. --dry-run is forwarded
run --dry-run >/dev/null; grep -q 'kill-stack-sandboxes.ts --dry-run' "$FAKE_LOG" || fail "--dry-run not forwarded"
# 3. a failing killer still exits 0
FAKE_FAIL=1 run >/dev/null || fail "failing killer must exit 0"
# 4. no stack id computed -> nothing killed, exit 0
FAKE_STACK="" run >/dev/null || fail "empty stack must exit 0"
grep -q 'STACK_ENV' "$FAKE_LOG" && fail "killer must not run without a stack id"
# 5. budget respected: a hung killer is stopped, exit 0
start=$SECONDS
FAKE_SLEEP=30 TEARDOWN_BUDGET_SECONDS=2 run >/dev/null || fail "hung killer must exit 0"
[ $((SECONDS - start)) -lt 10 ] || fail "budget not respected ($((SECONDS - start))s)"
# 6. the database url the stack id and the kill use follows run.sh's selection:
#    system Postgres by default, the workspace's Docker container when it runs
ws="$(basename "$FIXTURE_ROOT")"
run >/dev/null
grep -q "DB_URL_FOR_STACK=postgresql://postgres:postgres@localhost:5432/victoria" "$FAKE_LOG" || fail "default is system Postgres: $(grep DB_URL_FOR_STACK "$FAKE_LOG")"
grep -q "DB_URL_FOR_KILL=postgresql://postgres:postgres@localhost:5432/victoria" "$FAKE_LOG" || fail "kill must use the same database"
FAKE_DOCKER_CONTAINER="victoria-db-$ws" FAKE_DOCKER_PORT=55441 run >/dev/null
grep -q "DB_URL_FOR_STACK=postgresql://postgres:postgres@localhost:55441/victoria$" "$FAKE_LOG" || fail "docker devbox must use the container port: $(grep DB_URL_FOR_STACK "$FAKE_LOG")"
grep -q "DB_URL_FOR_KILL=postgresql://postgres:postgres@localhost:55441/victoria$" "$FAKE_LOG" || fail "kill must use the container database"
ROSE_USE_SYSTEM_PG=true FAKE_DOCKER_CONTAINER="victoria-db-$ws" FAKE_DOCKER_PORT=55441 run >/dev/null
grep -q "DB_URL_FOR_STACK=postgresql://postgres:postgres@localhost:5432/victoria" "$FAKE_LOG" || fail "ROSE_USE_SYSTEM_PG=true must ignore the container"
# 7. the stack id comes from the repo's own code (real tsx, no E2B): ws part present
grep -q -- '--print-stack' "$ROOT/scripts/devbox-teardown.sh" || fail "must use the backend function"
echo "devbox-teardown: all cases passed"
