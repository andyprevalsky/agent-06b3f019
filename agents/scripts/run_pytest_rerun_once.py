#!/usr/bin/env python3
"""Run a direct pytest step of run-coverage.sh under coverage, rerunning only its failed node ids once.

The blackbox domains get one rerun from run_coverage_blackbox_parallel.py; the
direct pytest steps (tests/demo_cache, tests/unit) get the same contract here:

    pytest <targets> ─fail─> rerun only the failed node ids once ─pass─> FLAKY (exit 0)
           │                                                     └─fail─> FAIL  (exit 1)
           └─pass─> PASS        interrupted / usage / internal error ─> its exit code, no rerun

Each FLAKY node prints ``TEST_FLAKY unit=<nodeid> attempts=2 attribution=REQUIRED``
and, when DEPLOY_GATE_PROGRESS names a file, appends a FLAKY row (a node that
fails again gets a FAIL row). Never a third run. Both attempts run as
``coverage run --append`` so their data lands in the same combined file.

    run_pytest_rerun_once.py <label> <pytest target>...
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parent.parent
ROOT_DIR = AGENTS_ROOT.parent
PROGRESS_ENV = "DEPLOY_GATE_PROGRESS"
PROGRESS_HELPER_DIR = ROOT_DIR / "scripts"
# pytest: 1 = tests failed. 2 interrupted, 3 internal error, 4 usage error and
# 5 no tests are not test failures and are never rerun.
TESTS_FAILED = 1


def coverage_bin() -> str:
    value = os.environ.get("COVERAGE_BIN", str(AGENTS_ROOT / "venv" / "bin" / "coverage"))
    # run-coverage.sh passes a path relative to its own cwd; a bare name stays a PATH lookup.
    return str(Path(value).resolve()) if os.sep in value else value


def run_attempt(args: list[str], cache_dir: Path, log_path: Path) -> tuple[int, str, list[str]]:
    """One ``coverage run --append -m pytest`` attempt; stream its output, return (code, output, failed ids)."""
    command = [coverage_bin(), "run", "--append", "-m", "pytest", *args, "-q", "-o", f"cache_dir={cache_dir}"]
    process = subprocess.Popen(
        command, cwd=AGENTS_ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace"
    )
    lines = []
    assert process.stdout is not None
    for line in process.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        lines.append(line)
    code = process.wait()
    output = "".join(lines)
    log_path.write_text(output)
    try:
        failed = list(json.loads((cache_dir / "v" / "cache" / "lastfailed").read_text()))
    except (OSError, ValueError):
        failed = []
    return code, output, failed


def report(unit: str, status: str, detail: str, log: Path, attempts: int | None = None) -> None:
    """Advisory progress row; a missing helper or unwritable file never changes the result."""
    if not os.environ.get(PROGRESS_ENV):
        return
    sys.path.insert(0, str(PROGRESS_HELPER_DIR))
    try:
        import deploy_gate_progress

        deploy_gate_progress.report(unit, status, scope="test", detail=detail, log=str(log), attempts=attempts)
    except (ImportError, OSError, ValueError):
        return
    finally:
        sys.path.remove(str(PROGRESS_HELPER_DIR))


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: run_pytest_rerun_once.py <label> <pytest target>...", file=sys.stderr)
        return 2
    label, targets = argv[0], argv[1:]
    run_dir = ROOT_DIR / ".context" / "test-runs" / f"agents-pytest-{label}-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}"
    run_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pytest-rerun-") as scratch:
        first_log = run_dir / "attempt-1.log"
        code, output, failed = run_attempt(targets, Path(scratch) / "attempt-1", first_log)
        if code != TESTS_FAILED or not failed:
            return code
        print(f"RERUN {label}: attempt 2 of 2 for {len(failed)} failed node id(s): {' '.join(failed)}", flush=True)
        code, rerun_output, still_failed = run_attempt(failed, Path(scratch) / "attempt-2", run_dir / "attempt-2.log")
    if code not in (0, TESTS_FAILED):
        return code
    # A failed rerun without a readable failure list keeps every node failed.
    still = set(still_failed or failed) if code == TESTS_FAILED else set()
    for nodeid in failed:
        if nodeid in still:
            report(nodeid, "FAIL", rerun_output, run_dir / "attempt-2.log")
        else:
            print(f"TEST_FLAKY unit={nodeid} attempts=2 attribution=REQUIRED", flush=True)
            report(nodeid, "FLAKY", output, first_log, attempts=2)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
