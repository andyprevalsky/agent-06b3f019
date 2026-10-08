#!/usr/bin/env bash

# Isolated benchmark runs (`run-bench --local`, `run-predeploy-local`) spend the
# same Cerebras and OpenRouter org quotas as every local chat request, so a
# latency measurement taken while one is live also measures their rate limits.

# Prints one line per isolated benchmark run under <repo>/.context/benchmarks
# that is still live. A generated run id embeds its benchmarks/local.py
# controller PID, which covers the bootstrap before services.json exists; a
# custom run id is live while its manifest is starting/running with a live run.sh.
# A stack retained after failed owned cleanup keeps run.sh (and a "running"
# manifest) only as recovery authority; once its recorded benchmark child has
# exited it runs no agents and spends no model quota.
live_isolated_benchmark_runs() {
  python3 - "$1" <<'PY'
import glob
import json
import os
import re
import subprocess
import sys


def command_of(pid):
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "command="],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip()


def retained_after_benchmark_exit(run_dir):
    try:
        with open(os.path.join(run_dir, "local-benchmark-owner.json")) as handle:
            owner = json.load(handle)
    except (OSError, ValueError):
        return False
    if not isinstance(owner, dict) or owner.get("state") != "failed_retained":
        return False
    pid = owner.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return False
    return not command_of(pid)


root = os.path.join(sys.argv[1], ".context", "benchmarks")
for run_dir in sorted(glob.glob(os.path.join(root, "*", ""))):
    run_id = os.path.basename(os.path.dirname(run_dir))
    generated = re.fullmatch(r"\d+-(\d+)-\d+", run_id)
    if generated and "benchmarks/local.py" in command_of(generated.group(1)):
        print(f"{run_id} (controller PID {generated.group(1)})")
        continue
    try:
        with open(os.path.join(run_dir, "services.json")) as handle:
            manifest = json.load(handle)
    except (OSError, ValueError):
        continue
    if not isinstance(manifest, dict):
        continue
    if str(manifest.get("status", "")).strip().lower() not in {"starting", "running"}:
        continue
    pid = manifest.get("run_sh_pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        continue
    if "run.sh" in command_of(pid) and not retained_after_benchmark_exit(run_dir):
        print(f"{run_id} (run.sh PID {pid})")
PY
}

indent_isolated_benchmark_runs() {
  local line
  while IFS= read -r line; do
    printf '  %s\n' "$line"
  done <<<"$1"
}

# Blocks until no isolated benchmark run under <repo> is live. Fails closed
# after <timeout_s> rather than measuring through a run that never ends.
wait_for_isolated_benchmarks() {
  local repo_dir="$1" timeout_s="$2" poll_s="${3:-30}"
  local started=$SECONDS live="" reported=""
  if [[ ! "$timeout_s" =~ ^[0-9]{1,6}$ ]] || [[ ! "$poll_s" =~ ^[1-9][0-9]{0,3}$ ]]; then
    echo "FAIL: isolated benchmark wait needs integer seconds (timeout=$timeout_s poll=$poll_s)" >&2
    return 1
  fi
  while true; do
    if ! live="$(live_isolated_benchmark_runs "$repo_dir")"; then
      echo "FAIL: could not inspect isolated benchmark runs under $repo_dir/.context/benchmarks" >&2
      return 1
    fi
    [ -n "$live" ] || return 0
    if [ $((SECONDS - started)) -ge "$timeout_s" ]; then
      echo "FAIL: isolated benchmark runs still live after ${timeout_s}s:" >&2
      indent_isolated_benchmark_runs "$live" >&2
      return 1
    fi
    if [ "$live" != "$reported" ]; then
      echo "Waiting for isolated benchmark runs to finish before measuring latency:"
      indent_isolated_benchmark_runs "$live"
      reported="$live"
    fi
    sleep "$poll_s"
  done
}
