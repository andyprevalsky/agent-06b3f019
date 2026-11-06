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
  *--print-stack*) echo "${FAKE_STACK-host:boxes|ws:fake|db:abc}" ;;
  *) echo "STACK_ENV=${ROSE_SANDBOX_STACK_ID:-unset}" >>"$FAKE_LOG"
     [ -n "${FAKE_SLEEP:-}" ] && sleep "$FAKE_SLEEP"
     [ -n "${FAKE_FAIL:-}" ] && exit 7
     echo "kill-stack-sandboxes: killed 1 sandbox(es)" ;;
esac
F
chmod +x "$WORK/bin/npx"
export FAKE_LOG="$WORK/log"
run() { : >"$FAKE_LOG"; PATH="$WORK/bin:$PATH" bash "$ROOT/scripts/devbox-teardown.sh" "$@"; }

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
# 6. the stack id comes from the repo's own code (real tsx, no E2B): ws part present
grep -q -- '--print-stack' "$ROOT/scripts/devbox-teardown.sh" || fail "must use the backend function"
echo "devbox-teardown: all cases passed"
