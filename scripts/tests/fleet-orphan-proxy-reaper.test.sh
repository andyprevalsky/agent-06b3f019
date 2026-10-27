#!/usr/bin/env bash
# run-bench-fleet reaps flyctl data-plane proxy tunnels leaked by a dead
# controller (SIGKILL bypasses the EXIT-trap cleanup, orphaning them to init).
# Left unreaped they pile up across days (observed: 100+ two-day-old orphans)
# until new runs' status proxies can't connect (http 000) and the start barrier
# never sees readiness. The reaper must kill ONLY orphaned (ppid==1) app-scoped
# proxies and must NEVER touch a concurrent live run's proxies (live parent).
#
# This test plants two real fake-flyctl-proxy processes — one orphaned, one with
# a live parent — exercises the reaper's exact selection+kill, and asserts the
# orphan dies while the live-parented one survives. It also asserts the fleet
# actually WIRES the reaper into its startup path, so the behavior can't silently
# regress by dropping the call.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLEET="$ROOT_DIR/scripts/run-bench-fleet"
# Keep the fake app scope unique. Other workspaces may run this same test (or
# the real startup reaper) concurrently, and the production app name would let
# their correctly scoped reaper kill this fixture before its parent is read.
APP="navi-whisper-lux-bench-reaper-test-$$"
TMP="$(mktemp -d)"
LIVE_PID=""
cleanup() {
    [ -n "$LIVE_PID" ] && kill "$LIVE_PID" 2>/dev/null || true
    pkill -f "$TMP/flyctl" 2>/dev/null || true
    rm -rf "$TMP"
}
trap cleanup EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

# 1) The reaper is defined AND wired into the startup path (before provisioning).
grep -q 'reap_orphaned_fleet_proxies()' "$FLEET" || fail "reaper function is missing"
grep -qE '^[[:space:]]*reap_orphaned_fleet_proxies$' "$FLEET" || fail "reaper is not called at fleet startup"

# 2) Real-process behavior. A fake 'flyctl' whose ps line matches the reaper's
#    selector (contains 'flyctl proxy' and '-a <APP>'). It must NOT exec — exec
#    would replace argv with the sleep's, hiding the 'flyctl proxy' args from ps.
printf '%s\n' \
    '#!/usr/bin/env bash' \
    'sleep 300 &' \
    'child=$!' \
    'trap '\''kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; exit 0'\'' TERM INT' \
    'wait "$child"' > "$TMP/flyctl"
chmod +x "$TMP/flyctl"

# Orphan: the subshell backgrounds the proxy then exits, so it reparents to init
# (ppid == 1) on both macOS (launchd) and Linux.
( "$TMP/flyctl" proxy 65001:8011 dead.vm.$APP.internal -a "$APP" --bind-addr 127.0.0.1 -q & )
# Live-parented: a child of THIS shell — must be preserved.
"$TMP/flyctl" proxy 65002:8011 live.vm.$APP.internal -a "$APP" --bind-addr 127.0.0.1 -q &
LIVE_PID=$!
sleep 1

orphan_ppid="$(ps -o ppid= -p "$(pgrep -f "dead.vm.$APP.internal" | head -1)" 2>/dev/null | tr -d ' ')"
[ "$orphan_ppid" = "1" ] || fail "test setup: planted orphan is not reparented to init (ppid=$orphan_ppid)"

# Exact selection+kill the reaper uses.
# This intentionally mirrors the production ps selector.
# shellcheck disable=SC2009
ps -o pid,ppid,command -ax 2>/dev/null | grep "flyctl proxy" | grep -F -- "-a $APP" \
    | awk '$2==1{print $1}' | while read -r pid; do [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null; done
sleep 1

pgrep -f "dead.vm.$APP.internal" >/dev/null && fail "orphaned proxy was NOT reaped"
kill -0 "$LIVE_PID" 2>/dev/null || fail "a LIVE run's proxy was wrongly reaped (rule 27 violation)"

echo "PASS: orphaned data-plane proxies are reaped; live-run proxies are preserved"
