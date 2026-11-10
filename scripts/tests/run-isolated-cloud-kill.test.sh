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
window = text[max(0, idx - 250) : idx + 900]
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
loop = text[idx : idx + 900]
if "process_belongs_to_this_worktree" not in loop:
    raise SystemExit("FAIL: cloud pattern kills must be scoped to this worktree's processes")
# CodeRabbit #1592: a cwd-only check skipped every match whose cwd lsof could
# not read, leaving stale workers on this stack's ports. Ownership falls back
# to the command path, and the sweep never signals its own process family.
if "process_cwd_in_this_worktree" in loop:
    raise SystemExit("FAIL: cloud pattern kills must not depend on a readable cwd alone")
if "is_current_process_family" not in loop:
    raise SystemExit("FAIL: cloud pattern kills must skip run.sh's own process family")
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

# A cwd lsof cannot read (lsof missing or denied) must not hide a stale worker:
# its command path still decides ownership, and still stops at nested worktrees.
mkdir -p "$TMP/no-lsof"
printf '#!/bin/sh\nexit 1\n' > "$TMP/no-lsof/lsof"
chmod +x "$TMP/no-lsof/lsof"
(cd / && exec -a "$WT/agents/worker.py" sleep 1000) &
argv_pid=$!
(cd / && exec -a "$NESTED/agents/worker.py" sleep 1000) &
nested_argv_pid=$!
trap 'kill $nested_pid $own_pid $argv_pid $nested_argv_pid 2>/dev/null || true; rm -rf "$TMP"' EXIT
(
  cd "$WT"
  PATH="$TMP/no-lsof:$PATH"
  . "$TMP/scope.sh"
  sleep 0.2
  process_belongs_to_this_worktree "$argv_pid" || {
    echo "FAIL: a worker whose cwd is unreadable was not owned by its command path" >&2
    exit 1
  }
  if process_belongs_to_this_worktree "$nested_argv_pid"; then
    echo "FAIL: a nested worktree worker was claimed through its command path" >&2
    exit 1
  fi
)
kill "$argv_pid" "$nested_argv_pid" 2>/dev/null || true
wait "$argv_pid" "$nested_argv_pid" 2>/dev/null || true
echo "PASS: unreadable cwd falls back to the nested-worktree-aware command path"

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
# A manifest is live only with a live run.sh behind it (same predicate as
# kill-services.sh): a `running` manifest whose run_sh_pid is gone and that has
# no owner record must not shield its leftovers forever.
dead_pid=999999
while kill -0 "$dead_pid" 2>/dev/null; do dead_pid=$((dead_pid - 1)); done
mkdir -p "$TMP3/wt/.context/benchmarks/run-live" "$TMP3/wt/.context/benchmarks/run-done" \
  "$TMP3/wt/.context/benchmarks/run-orphan"
(cd "$TMP3/wt" && exec -a "bash scripts/run.sh --benchmark" sleep 1000) &
live_runsh_pid=$!
printf '{"status": "starting", "run_sh_pid": %s, "services": []}\n' "$live_runsh_pid" > "$TMP3/wt/.context/benchmarks/run-live/services.json"
printf '{"status": "stopped", "run_sh_pid": %s, "services": []}\n' "$dead_pid" > "$TMP3/wt/.context/benchmarks/run-done/services.json"
printf '{"status": "running", "run_sh_pid": %s, "services": []}\n' "$dead_pid" > "$TMP3/wt/.context/benchmarks/run-orphan/services.json"
(cd "$TMP3/wt" && BENCHMARK_RUN_ID=run-live exec sleep 1000) &
run_pid=$!
(cd "$TMP3/wt" && BENCHMARK_RUN_ID=run-done exec sleep 1000) &
done_pid=$!
(cd "$TMP3/wt" && BENCHMARK_RUN_ID=run-orphan exec sleep 1000) &
orphan_pid=$!
trap 'kill $nested_pid $own_pid $run_pid $done_pid $orphan_pid $live_runsh_pid 2>/dev/null || true; rm -rf "$TMP" "$TMP3"' EXIT
{
  printf '. %q\n' "$ROOT_DIR/scripts/lib/run-process-cleanup.sh"
  sed -n '/^process_age_seconds()/,/^}/p' "$RUN_SH"
  sed -n '/^benchmark_startup_grace_seconds()/,/^}/p' "$RUN_SH"
  sed -n '/^isolated_run_still_starting()/,/^}/p' "$RUN_SH"
  sed -n '/^isolated_manifest_is_live()/,/^}/p' "$RUN_SH"
  sed -n '/^pid_belongs_to_active_isolated_benchmark()/,/^}/p' "$RUN_SH"
} > "$TMP3/guard.sh"
grep -q 'isolated_manifest_is_live() {' "$TMP3/guard.sh" || {
  echo "FAIL: could not extract isolated_manifest_is_live from run.sh" >&2
  exit 1
}
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
  if pid_belongs_to_active_isolated_benchmark "$orphan_pid"; then
    echo "FAIL: a running manifest whose run.sh is gone must not protect its leftovers" >&2
    exit 1
  fi
  kill "$live_runsh_pid"
  wait "$live_runsh_pid" 2>/dev/null || true
  if pid_belongs_to_active_isolated_benchmark "$run_pid"; then
    echo "FAIL: a live manifest stayed live after its run.sh exited" >&2
    exit 1
  fi
)
echo "PASS: ACTIVE isolated run identity protects its detached processes while its run.sh lives"

# CodeRabbit #1592: a run directory with no services.json protected its
# processes for as long as it existed, so a stack that died before publishing
# left an unkillable child. Only an in-flight bootstrap is protected: the live
# owner local.py recorded (pid + `ps lstart` birth), or a run directory younger
# than the startup grace.
for name in run-dead run-owned run-fresh; do
  mkdir -p "$TMP3/wt/.context/benchmarks/$name"
done
(sleep 1000) &
owner_pid=$!
owner_birth="$(ps -p "$owner_pid" -o lstart= | sed 's/^ *//;s/ *$//')"
printf '{"version": 1, "pid": %s, "birth": "%s"}\n' "$owner_pid" "$owner_birth" > "$TMP3/wt/.context/benchmarks/run-owned/local-stack-owner.json"
printf '{"version": 1, "pid": 999997, "birth": "Thu Jan  1 00:00:00 1970"}\n' > "$TMP3/wt/.context/benchmarks/run-dead/local-stack-owner.json"
touch -t 202001010000 "$TMP3/wt/.context/benchmarks/run-dead" "$TMP3/wt/.context/benchmarks/run-owned"
for name in run-dead run-owned run-fresh; do
  (cd "$TMP3/wt" && BENCHMARK_RUN_ID="$name" exec sleep 1000) &
  eval "pid_$(printf '%s' "$name" | tr - _)=\$!"
done
trap 'kill $nested_pid $own_pid $run_pid $done_pid $orphan_pid $live_runsh_pid $owner_pid $pid_run_dead $pid_run_owned $pid_run_fresh 2>/dev/null || true; rm -rf "$TMP" "$TMP3"' EXIT
(
  cd "$TMP3/wt"
  . "$TMP3/guard.sh"
  sleep 0.2
  export BENCHMARK_STARTUP_GRACE_SECONDS=0
  if pid_belongs_to_active_isolated_benchmark "$pid_run_dead"; then
    echo "FAIL: an unpublished run whose owner is gone must not protect its leftovers" >&2
    exit 1
  fi
  pid_belongs_to_active_isolated_benchmark "$pid_run_owned" || {
    echo "FAIL: an unpublished run with its live owner was not protected" >&2
    exit 1
  }
  export BENCHMARK_STARTUP_GRACE_SECONDS=90
  pid_belongs_to_active_isolated_benchmark "$pid_run_fresh" || {
    echo "FAIL: an unpublished run inside the startup grace was not protected" >&2
    exit 1
  }
  kill "$owner_pid"
  wait "$owner_pid" 2>/dev/null || true
  export BENCHMARK_STARTUP_GRACE_SECONDS=0
  if pid_belongs_to_active_isolated_benchmark "$pid_run_owned"; then
    echo "FAIL: an unpublished run stayed protected after its owner exited" >&2
    exit 1
  fi
)
echo "PASS: an unpublished isolated run is protected only while it is still starting"
# ── The semantic lane's startup sweep beside a LIVE isolated smoke stack ──────
#
# Follow-up "an" (2026-10-31): kill_stale_same_worktree_benchmark_stack is the
# first sweep a non-isolated `run.sh --benchmark` (the deploy's semantic stack)
# runs, and /deploy serialized `semantic-stack` after the smoke lane on the
# belief that it would kill the smoke lane's isolated stack in the same
# worktree. The real sweep, extracted from run.sh and executed against fixtures
# (not only its predicates): a worker carrying a live isolated run's
# BENCHMARK_RUN_ID survives past the young-process grace, while this
# workspace's stale run.sh stack, a stale worker with no run identity and the
# leftover of a stopped run are reaped, and another worktree's worker is never
# a candidate. The sweep runs as a separate process so the fixtures are not its
# own process family.
TMP4="$(mktemp -d)"
WT4="$TMP4/wt"
OTHER4="$TMP4/other"
mkdir -p "$WT4/.context/benchmarks/smoke-live" "$WT4/.context/benchmarks/smoke-done" \
  "$WT4/.context/benchmarks/smoke-orphan" "$WT4/agents" "$WT4/scripts" "$OTHER4/agents"
printf '#!/usr/bin/env bash\nsleep 1000\n' > "$WT4/scripts/run.sh"
# The live run's own run.sh: a sweep candidate itself (argv + cwd), and the
# manifest's run_sh_pid that keeps the run live.
(cd "$WT4" && BENCHMARK_RUN_ID=smoke-live exec bash scripts/run.sh --benchmark) &
liverunsh4=$!
printf '{"status": "running", "run_sh_pid": %s, "services": []}\n' "$liverunsh4" > "$WT4/.context/benchmarks/smoke-live/services.json"
printf '{"status": "stopped", "run_sh_pid": %s, "services": []}\n' "$dead_pid" > "$WT4/.context/benchmarks/smoke-done/services.json"
printf '{"status": "running", "run_sh_pid": %s, "services": []}\n' "$dead_pid" > "$WT4/.context/benchmarks/smoke-orphan/services.json"
(cd "$WT4" && BENCHMARK_RUN_ID=smoke-live exec -a "$WT4/agents/worker.py" sleep 1000) &
live4=$!
(cd "$WT4" && BENCHMARK_RUN_ID=smoke-done exec -a "$WT4/agents/worker.py" sleep 1000) &
done4=$!
(cd "$WT4" && BENCHMARK_RUN_ID=smoke-orphan exec -a "$WT4/agents/worker.py" sleep 1000) &
orphan4=$!
(cd "$WT4" && exec -a "$WT4/agents/worker.py" sleep 1000) &
stale4=$!
(cd "$WT4" && exec bash scripts/run.sh --benchmark) &
ownstack4=$!
(cd "$OTHER4" && exec -a "$OTHER4/agents/worker.py" sleep 1000) &
other4=$!
cleanup4() {
  local parent child
  for parent in "$ownstack4" "$liverunsh4"; do
    for child in $(pgrep -P "$parent" 2>/dev/null); do kill "$child" 2>/dev/null || true; done
  done
  kill "$live4" "$done4" "$orphan4" "$stale4" "$ownstack4" "$liverunsh4" "$other4" 2>/dev/null || true
  rm -rf "$TMP4"
}
trap 'cleanup4; kill $nested_pid $own_pid $run_pid $done_pid $orphan_pid $live_runsh_pid $owner_pid $pid_run_dead $pid_run_owned $pid_run_fresh 2>/dev/null || true; rm -rf "$TMP" "$TMP3"' EXIT
{
  printf '. %q\n' "$ROOT_DIR/scripts/lib/run-process-cleanup.sh"
  sed -n '/^process_cwd_in_this_worktree()/,/^}/p' "$RUN_SH"
  sed -n '/^is_current_process_family()/,/^}/p' "$RUN_SH"
  sed -n '/^kill_stale_tree()/,/^}/p' "$RUN_SH"
  sed -n '/^process_age_seconds()/,/^}/p' "$RUN_SH"
  sed -n '/^benchmark_startup_grace_seconds()/,/^}/p' "$RUN_SH"
  sed -n '/^isolated_run_still_starting()/,/^}/p' "$RUN_SH"
  sed -n '/^isolated_manifest_is_live()/,/^}/p' "$RUN_SH"
  sed -n '/^pid_belongs_to_active_isolated_benchmark()/,/^}/p' "$RUN_SH"
  sed -n '/^kill_stale_same_worktree_benchmark_stack()/,/^}/p' "$RUN_SH"
  printf 'BENCHMARK_MODE=true\nexport BENCHMARK_STARTUP_GRACE_SECONDS=0\ncd %q || exit 1\nkill_stale_same_worktree_benchmark_stack\n' "$WT4"
} > "$TMP4/sweep.sh"
grep -q 'kill_stale_same_worktree_benchmark_stack() {' "$TMP4/sweep.sh" || {
  echo "FAIL: could not extract kill_stale_same_worktree_benchmark_stack from run.sh" >&2
  exit 1
}
sleep 0.3
for fixture in "$liverunsh4" "$live4" "$done4" "$orphan4" "$stale4" "$ownstack4" "$other4"; do
  kill -0 "$fixture" 2>/dev/null || { echo "FAIL: fixture $fixture did not start" >&2; exit 1; }
done
bash "$TMP4/sweep.sh" > "$TMP4/sweep.log" 2>&1 || true
assert_fate4() {  # <pid> <alive|dead> <label>
  local attempt
  for attempt in $(seq 1 30); do
    if [ "$2" = dead ] && ! kill -0 "$1" 2>/dev/null; then return 0; fi
    [ "$2" = dead ] || break
    sleep 0.1
  done
  if [ "$2" = alive ]; then
    kill -0 "$1" 2>/dev/null && return 0
    echo "FAIL: $3 was killed by the startup sweep (PID $1)" >&2
  else
    echo "FAIL: $3 survived the startup sweep (PID $1)" >&2
  fi
  cat "$TMP4/sweep.log" >&2
  exit 1
}
assert_fate4 "$liverunsh4" alive "the live isolated run's own run.sh"
assert_fate4 "$live4" alive "worker carrying a live isolated run's BENCHMARK_RUN_ID"
assert_fate4 "$other4" alive "another worktree's worker"
assert_fate4 "$stale4" dead "stale same-worktree worker with no run identity"
assert_fate4 "$done4" dead "leftover worker of a stopped isolated run"
assert_fate4 "$orphan4" dead "leftover worker of a running-manifest run whose run.sh is gone"
assert_fate4 "$ownstack4" dead "this worktree's own stale run.sh stack"
echo "PASS: the startup sweep spares a live isolated run and reaps only this worktree's stale stack"

echo "All isolated-cloud-kill tests passed."
