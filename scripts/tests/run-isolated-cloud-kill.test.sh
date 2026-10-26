#!/usr/bin/env bash
# Isolated benchmark stacks must not pattern-kill sibling workers on cloud.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_SH="$ROOT_DIR/scripts/run.sh"

grep -q 'BENCHMARK_ISOLATED_RUN" != "true"' "$RUN_SH" || {
  echo "FAIL: cloud pattern kills must be gated on BENCHMARK_ISOLATED_RUN" >&2
  exit 1
}

# Ensure the gate wraps the worker.py pattern loop specifically, and that a
# non-isolated cloud stack still preserves ACTIVE isolated sibling PIDs.
RUN_SH="$RUN_SH" python3 - <<'PY'
import os
from pathlib import Path

# Resolve from the caller, not a hardcoded /workspace: that path only exists in
# the container image, so this gate failed on every developer machine.
text = Path(os.environ["RUN_SH"]).read_text()
idx = text.find('for pattern in "${RUN_CLOUD_SERVICE_KILL_PATTERNS[@]}"')
if idx < 0:
    raise SystemExit("FAIL: cloud service kill pattern loop missing")
window = text[max(0, idx - 250) : idx + 600]
if "BENCHMARK_ISOLATED_RUN" not in window:
    raise SystemExit(
        "FAIL: worker.py pattern kill is not guarded by BENCHMARK_ISOLATED_RUN"
    )
if "pid_belongs_to_active_isolated_benchmark" not in window:
    raise SystemExit(
        "FAIL: cloud pattern kills must skip ACTIVE isolated benchmark PIDs"
    )
print("PASS: isolated cloud stacks skip worktree-wide pattern kills")
print("PASS: non-isolated cloud stacks preserve ACTIVE isolated siblings")
PY

grep -q 'docker_can_create_container' "$RUN_SH" || {
  echo "FAIL: docker create probe missing" >&2
  exit 1
}
echo "PASS: docker_can_create_container probe is wired"
# Regression (2026-10-26): `.cloud-env` marks the canonical checkout, but agent
# worktrees nest inside it at .claude/worktrees/<name>. The non-isolated cloud
# pattern kill matched worker.py/tsx/vite box-wide, and run.sh's own-worktree
# predicates used a bare "$PWD"/* prefix, so they claimed nested worktrees'
# stacks. Both must scope through the nested-worktree-aware helpers.
RUN_SH="$RUN_SH" python3 - <<'PY'
import os
from pathlib import Path

text = Path(os.environ["RUN_SH"]).read_text()
idx = text.find('for pattern in "${RUN_CLOUD_SERVICE_KILL_PATTERNS[@]}"')
loop = text[idx : idx + 700]
if "process_cwd_in_this_worktree" not in loop:
    raise SystemExit("FAIL: cloud pattern kills must be scoped to this worktree's processes")
if '"$PWD"/*' in text or 'grep -q "$PWD"' in text or 'grep -Fq "$PWD"' in text:
    raise SystemExit("FAIL: run.sh still scopes processes with a bare $PWD prefix/substring")
print("PASS: run.sh process scope never claims a nested worktree by path prefix")
PY

TMP="$(mktemp -d)"
nested_pid=""
own_pid=""
trap 'kill $nested_pid $own_pid 2>/dev/null || true; rm -rf "$TMP"' EXIT
WT="$TMP/rose"
NESTED="$WT/.claude/worktrees/gate-x"
mkdir -p "$NESTED/agents" "$WT/agents"
printf 'gitdir: /nonexistent\n' > "$NESTED/.git"
(cd "$NESTED/agents" && exec sleep 1000) &
nested_pid=$!
(cd "$WT/agents" && exec sleep 1000) &
own_pid=$!
{
  printf '. %q\n' "$ROOT_DIR/scripts/lib/run-process-cleanup.sh"
  sed -n '/^process_cwd_in_this_worktree()/,/^}/p' "$RUN_SH"
  sed -n '/^process_belongs_to_this_worktree()/,/^}/p' "$RUN_SH"
} > "$TMP/scope.sh"
(
  cd "$WT"
  . "$TMP/scope.sh"
  sleep 0.2
  process_cwd_in_this_worktree "$own_pid" || { echo "FAIL: own worktree process not recognized" >&2; exit 1; }
  process_belongs_to_this_worktree "$own_pid" || { echo "FAIL: own worktree process not owned" >&2; exit 1; }
  if process_cwd_in_this_worktree "$nested_pid" || process_belongs_to_this_worktree "$nested_pid"; then
    echo "FAIL: nested worktree process claimed by the enclosing checkout" >&2
    exit 1
  fi
)
echo "PASS: run.sh never claims a nested worktree's process"

# Regression (2026-10-12): a non-isolated run.sh startup sweep killed a
# bootstrapping isolated stack. The guard protected only manifest-listed PIDs
# and their ancestry, so a detached (reparented) tunnel or service of an
# isolated run that had already published a `starting` manifest was reaped.
# Every process launched by an active isolated run carries its
# BENCHMARK_RUN_ID; that identity must protect it.
TMP3="$(mktemp -d)"
run_pid=""
done_pid=""
trap 'kill $nested_pid $own_pid $run_pid $done_pid 2>/dev/null || true; rm -rf "$TMP" "$TMP3"' EXIT
mkdir -p "$TMP3/wt/.context/benchmarks/run-live" "$TMP3/wt/.context/benchmarks/run-done"
printf '{"status": "starting", "run_sh_pid": 999999, "services": []}\n' > "$TMP3/wt/.context/benchmarks/run-live/services.json"
printf '{"status": "stopped", "run_sh_pid": 999998, "services": []}\n' > "$TMP3/wt/.context/benchmarks/run-done/services.json"
(cd "$TMP3/wt" && BENCHMARK_RUN_ID=run-live exec sleep 1000) &
run_pid=$!
(cd "$TMP3/wt" && BENCHMARK_RUN_ID=run-done exec sleep 1000) &
done_pid=$!
{
  printf '. %q\n' "$ROOT_DIR/scripts/lib/run-process-cleanup.sh"
  sed -n '/^process_age_seconds()/,/^}/p' "$RUN_SH"
  sed -n '/^pid_belongs_to_active_isolated_benchmark()/,/^}/p' "$RUN_SH"
} > "$TMP3/guard.sh"
(
  cd "$TMP3/wt"
  . "$TMP3/guard.sh"
  # Past the young-process grace: only the run identity can protect it.
  export BENCHMARK_STARTUP_GRACE_SECONDS=0
  sleep 0.2
  pid_belongs_to_active_isolated_benchmark "$run_pid" || {
    echo "FAIL: process carrying an ACTIVE isolated run's BENCHMARK_RUN_ID was not protected" >&2
    exit 1
  }
  if pid_belongs_to_active_isolated_benchmark "$done_pid"; then
    echo "FAIL: a stopped isolated run's BENCHMARK_RUN_ID must not protect its leftovers" >&2
    exit 1
  fi
)
echo "PASS: ACTIVE isolated run identity protects its detached processes"
echo "All isolated-cloud-kill tests passed."
