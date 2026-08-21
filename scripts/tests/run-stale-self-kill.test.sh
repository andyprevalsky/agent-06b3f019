#!/usr/bin/env bash
# Regression: kill_stale_same_worktree_benchmark_stack must not kill the
# Cursor/agent parent whose argv merely *contains* `scripts/run.sh --benchmark`
# (pgrep -f match). That parent death SIGTERMs the real run.sh (exit -15).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_SH="$ROOT_DIR/scripts/run.sh"

grep -q 'Walk our ancestors' "$RUN_SH" || {
  echo "FAIL: is_current_process_family must protect ancestor launchers" >&2
  exit 1
}

# Extract just the helper + a tiny harness into a temp script.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# shellcheck disable=SC2016
sed -n '/^is_current_process_family()/,/^}/p' "$RUN_SH" > "$TMP/family.sh"
cat >> "$TMP/family.sh" <<'EOF'
# Simulate: parent argv contains the pgrep pattern; child is "run.sh" (us).
# The function under test must treat the parent as current-family.
parent_pid=$1
if is_current_process_family "$parent_pid"; then
  echo "PASS: launcher parent is treated as current process family"
  exit 0
fi
echo "FAIL: launcher parent was NOT treated as current process family" >&2
exit 1
EOF

# Parent whose command line includes the stale-kill pattern, child sources the helper.
bash -c '
  sleep 30 &
  child=$!
  # Re-exec check from a "run.sh-like" child process
  bash '"$TMP"'/family.sh $$ &
  checker=$!
  wait "$checker"
  rc=$?
  kill "$child" 2>/dev/null || true
  exit "$rc"
' scripts/run.sh --benchmark

echo "All run.sh stale-self-kill tests passed."
