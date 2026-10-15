#!/usr/bin/env bash
# Regression: run.sh's kill_tree_hard must SIGKILL SIGTERM survivors at EVERY
# depth of a service tree. Isolated benchmark teardown relies on it alone (no
# kill-services.sh sweep), and on 2026-09-08 a `python worker.py` grandchild that
# hung after its graceful shutdown outlived the stack, polling a dead per-run
# Temporal queue. The functions are extracted from run.sh so this test cannot
# drift from the real reaper.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_SH="$ROOT_DIR/scripts/run.sh"

extract_fn() {
    sed -n "/^$1() {/,/^}/p" "$RUN_SH"
}
eval "$(extract_fn kill_tree)"
eval "$(extract_fn descendant_pids)"
eval "$(extract_fn kill_tree_hard)"

fail() { echo "❌ $1" >&2; exit 1; }

# wrapper -> inner bash (ignores SIGTERM, like a hung worker) -> sleep.
# The trailing `true` stops bash from exec-ing sleep in place of the inner shell,
# so the tree really is three levels deep.
MARK="300.$$"   # unique per test run so stale processes from other runs cannot match
bash -c "bash -c 'trap \"\" TERM; sleep $MARK; true' & wait" &
WRAPPER=$!
LEAF=""
for _ in $(seq 1 50); do
    LEAF="$(ps -eo pid,comm,args | awk -v m="$MARK" '$2=="sleep" && $NF==m {print $1}' | head -1 || true)"
    [ -n "$LEAF" ] && break
    sleep 0.1
done
[ -n "$LEAF" ] || fail "test setup: leaf sleep never started"
INNER="$(ps -o ppid= -p "$LEAF" | tr -d ' ')"
[ -n "$INNER" ] && [ "$INNER" != "$WRAPPER" ] || fail "test setup: leaf is not a grandchild (inner=$INNER wrapper=$WRAPPER)"
[ "$(ps -o ppid= -p "$INNER" | tr -d ' ')" = "$WRAPPER" ] || fail "test setup: inner shell is not the wrapper's child"

# The snapshot must include every level before any signal is sent.
DESC="$(descendant_pids "$WRAPPER")"
grep -qx "$INNER" <<<"$DESC" || fail "descendant_pids missed the inner shell ($INNER) in: $DESC"
grep -qx "$LEAF" <<<"$DESC" || fail "descendant_pids missed the leaf ($LEAF) in: $DESC"

kill_tree_hard "$WRAPPER"
sleep 0.5
LEAKED=""
for victim in "$INNER" "$LEAF" "$WRAPPER"; do
    if kill -0 "$victim" 2>/dev/null; then
        LEAKED="$LEAKED $victim"
        kill -9 "$victim" 2>/dev/null || true
    fi
done
wait "$WRAPPER" 2>/dev/null || true
[ -z "$LEAKED" ] || fail "kill_tree_hard leaked SIGTERM-ignoring descendants:$LEAKED"
echo "✅ run.sh kill_tree_hard reaps SIGTERM-ignoring descendants at every depth"
