#!/usr/bin/env bash
# Isolated benchmark stacks must not pattern-kill sibling workers on cloud.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_SH="$ROOT_DIR/scripts/run.sh"

grep -q 'BENCHMARK_ISOLATED_RUN" != "true"' "$RUN_SH" || {
  echo "FAIL: cloud pattern kills must be gated on BENCHMARK_ISOLATED_RUN" >&2
  exit 1
}

# Ensure the gate wraps the worker.py pattern loop specifically.
RUN_SH="$RUN_SH" python3 - <<'PY'
import os
from pathlib import Path

# Resolve from the caller, not a hardcoded /workspace: that path only exists in
# the container image, so this gate failed on every developer machine.
text = Path(os.environ["RUN_SH"]).read_text()
idx = text.find('for pattern in "worker\\.py"')
if idx < 0:
    raise SystemExit("FAIL: worker.py cloud kill pattern missing")
window = text[max(0, idx - 250) : idx]
if "BENCHMARK_ISOLATED_RUN" not in window:
    raise SystemExit(
        "FAIL: worker.py pattern kill is not guarded by BENCHMARK_ISOLATED_RUN"
    )
print("PASS: isolated cloud stacks skip worktree-wide pattern kills")
PY

grep -q 'docker_can_create_container' "$RUN_SH" || {
  echo "FAIL: docker create probe missing" >&2
  exit 1
}
echo "PASS: docker_can_create_container probe is wired"
echo "All isolated-cloud-kill tests passed."
