#!/usr/bin/env python3
"""Record which repo files each agents blackbox domain executes.

Runs the unchanged deploy runner (agents/scripts/run_coverage_blackbox_parallel.py)
with a COVERAGE_BIN shim that gives every domain its own coverage data file,
then writes scripts/test-map/agents-coverage.json = {domain: [repo files]}.

The map only ADDS selections (select_affected_tests.py unions it with the
static graph), so a stale map can never drop a test; new domains are mapped
by the static graph until the next refresh.

  scripts/test-map/build_agents_coverage_map.py [--concurrency 6]
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AGENTS = ROOT / "agents"
OUT = ROOT / "scripts" / "test-map" / "agents-coverage.json"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--concurrency", default="6")
    parser.add_argument("--out", default=str(OUT))
    args = parser.parse_args()
    real_coverage = AGENTS / "venv" / "bin" / "coverage"
    with tempfile.TemporaryDirectory(prefix="agents-covmap-") as tmp:
        data_dir = Path(tmp) / "data"
        data_dir.mkdir()
        shim = Path(tmp) / "coverage-shim"
        shim.write_text(
            "#!/usr/bin/env bash\n"
            'domain="${@: -1}"\n'
            f'export COVERAGE_FILE="{data_dir}/cov.$domain"\n'
            f'exec "{real_coverage}" "$@"\n'
        )
        shim.chmod(shim.stat().st_mode | stat.S_IXUSR)
        env = {
            **os.environ,
            "COVERAGE_BIN": str(shim),
            "AGENTS_COVERAGE_CONCURRENCY": args.concurrency,
        }
        started = time.monotonic()
        proc = subprocess.run(
            [str(AGENTS / "venv" / "bin" / "python"), "scripts/run_coverage_blackbox_parallel.py"],
            cwd=AGENTS, env=env,
        )
        elapsed = time.monotonic() - started
        from coverage import CoverageData  # type: ignore[import-not-found]

        files: dict[str, set[str]] = defaultdict(set)
        for data_file in data_dir.iterdir():
            domain = data_file.name.split(".", 2)[1]
            data = CoverageData(basename=str(data_file))
            data.read()
            for measured in data.measured_files():
                path = Path(measured).resolve()
                try:
                    rel = path.relative_to(ROOT).as_posix()
                except ValueError:
                    continue
                if "/venv/" not in f"/{rel}":
                    files[domain].add(rel)
    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runner_exit": proc.returncode,
        "wall_seconds": round(elapsed, 1),
        "domains": {d: sorted(v) for d, v in sorted(files.items())},
    }
    Path(args.out).write_text(json.dumps(payload, indent=0, sort_keys=False) + "\n")
    print(f"wrote {args.out}: {len(files)} domains, runner exit {proc.returncode}, {elapsed:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
