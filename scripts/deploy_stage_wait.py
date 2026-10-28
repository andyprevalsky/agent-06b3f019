#!/usr/bin/env python3
"""Block until timed /deploy stages finish, so the caller wakes on the event.

``scripts/run-deploy-stage STAGE -- CMD`` already writes two durable receipts:
an admission file while the stage runs and an atomic ``stages.jsonl`` row when
it finishes. This waiter watches those receipts instead of making the deploy
agent sleep a fixed 60 seconds between polls. It returns as soon as:

* every requested stage has a finish row newer than ``--since`` (exit 0, or 1
  when any of them failed);
* any requested stage fails (exit 1, immediately: fix-forward starts while the
  other lanes keep running; nothing is cancelled);
* a stage runner died without writing its finish row (exit 3);
* a running stage's log has not grown for ``--stall-seconds`` (exit 4);
* ``--timeout`` elapses with healthy lanes still running (exit 124).

Run it with the Bash tool's ``run_in_background`` so the harness re-invokes the
agent when it exits. Every outcome prints one JSON object on stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Callable

TOKEN_PATTERN = re.compile(r"^(?P<stage>[A-Za-z0-9._-]+)-(?P<pid>\d+)-[0-9a-f]{8}\.json$")
EXIT_PASSED = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_DIED = 3
EXIT_STALLED = 4
EXIT_TIMEOUT = 124
# An exact-input reuse (``run-deploy-stage --reuse-passed`` cache hit) records
# ``reused``: it is a pass that executed nothing, never a failure.
PASSING_STATUSES = frozenset({"passed", "reused"})


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _rows(run_dir: Path) -> list[dict]:
    try:
        text = (run_dir / "stages.jsonl").read_text()
    except FileNotFoundError:
        return []
    rows = []
    for line in text.splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue  # a partially visible line is retried on the next tick
        if isinstance(row, dict):
            rows.append(row)
    return rows


def _admissions(run_dir: Path) -> dict[str, list[int]]:
    running: dict[str, list[int]] = {}
    for path in (run_dir / "admissions").glob("*.json"):
        match = TOKEN_PATTERN.match(path.name)
        if match is None:
            continue
        try:
            pid = int(json.loads(path.read_text())["pid"])
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            continue  # released between glob and read
        running.setdefault(match.group("stage"), []).append(pid)
    return running


def _log_size(run_dir: Path, stage: str, pid: int) -> int | None:
    sizes = [path.stat().st_size for path in (run_dir / "logs").glob(f"{stage}-*-{pid}.log")]
    return max(sizes) if sizes else None


def resolve_run_dir(run_root: Path, run_id: str | None) -> Path:
    if run_id is None:
        try:
            run_id = (run_root / "current").read_text().splitlines()[0].strip()
        except (OSError, IndexError) as error:
            raise SystemExit(f"no active deploy timing run under {run_root}: {error}")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", run_id) or run_id in {".", ".."}:
        raise SystemExit(f"invalid deploy run id: {run_id}")
    return run_root / run_id


def wait_for_stages(
    run_dir: Path,
    stages: list[str],
    *,
    since: float,
    timeout: float,
    stall_seconds: float = 0.0,
    tick: float = 0.2,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    extra_event: Callable[[], tuple[int, dict] | None] | None = None,
) -> tuple[int, dict]:
    """Wake on the first stage event; ``extra_event`` lets a supervisor add its own."""
    started = clock()
    progress: dict[tuple[str, int], tuple[int, float]] = {}
    while True:
        finished: dict[str, dict] = {}
        for row in _rows(run_dir):
            stage = row.get("stage")
            if stage in stages and float(row.get("started_epoch") or 0) >= since:
                finished[stage] = row  # newest row per stage wins
        admitted = _admissions(run_dir)
        running: dict[str, list[int]] = {}
        for stage in stages:
            for pid in admitted.get(stage, []):
                if _pid_alive(pid):
                    running.setdefault(stage, []).append(pid)
                elif stage not in finished:
                    # The runner appends its row before releasing admission, so
                    # a dead PID without a row means no receipt will ever come.
                    return EXIT_DIED, {"event": "died", "stage": stage, "pid": pid}
        # A rerun admitted after a failed row supersedes that row.
        failed = [
            s for s, row in finished.items() if row.get("status") not in PASSING_STATUSES and s not in running
        ]
        if failed:
            return EXIT_FAILED, {"event": "failed", "failed": failed, "finished": finished}
        if extra_event is not None:
            event = extra_event()
            if event is not None:
                return event
        if all(stage in finished and stage not in running for stage in stages):
            return EXIT_PASSED, {"event": "passed", "finished": finished}
        now = clock()
        if stall_seconds > 0:
            for stage, pids in running.items():
                for pid in pids:
                    size = _log_size(run_dir, stage, pid)
                    previous = progress.get((stage, pid))
                    if previous is None or (size is not None and size != previous[0]):
                        progress[(stage, pid)] = (size if size is not None else -1, now)
                    elif now - previous[1] >= stall_seconds:
                        return EXIT_STALLED, {
                            "event": "stalled",
                            "stage": stage,
                            "pid": pid,
                            "log_bytes": size,
                            "quiet_seconds": round(now - previous[1], 1),
                        }
        if now - started >= timeout:
            return EXIT_TIMEOUT, {
                "event": "timeout",
                "finished": sorted(finished),
                "running": sorted(s for s in stages if s in running),
                "not_started": sorted(s for s in stages if s not in running and s not in finished),
            }
        sleep(tick)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--run-id")
    parser.add_argument(
        "--since",
        type=float,
        required=True,
        help="epoch seconds captured before launching the lanes; older rows never satisfy the wait",
    )
    parser.add_argument("--timeout", type=float, default=540.0)
    parser.add_argument("--stall-seconds", type=float, default=0.0)
    parser.add_argument("stages", nargs="+")
    args = parser.parse_args(argv)
    for stage in args.stages:
        if not re.fullmatch(r"[A-Za-z0-9._-]+", stage):
            print(f"invalid stage: {stage}", file=sys.stderr)
            return EXIT_USAGE
    run_dir = resolve_run_dir(args.run_root, args.run_id)
    code, payload = wait_for_stages(
        run_dir,
        args.stages,
        since=args.since,
        timeout=args.timeout,
        stall_seconds=args.stall_seconds,
    )
    payload["run_id"] = run_dir.name
    payload["exit"] = code
    print(json.dumps(payload, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
