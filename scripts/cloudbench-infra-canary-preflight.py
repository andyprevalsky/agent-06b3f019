#!/usr/bin/env python3
"""Serialize the fleet infra-canary check, execution, and PASS stamp."""

from __future__ import annotations

import argparse
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _fresh_age(stamp: Path, ttl_seconds: int) -> int | None:
    try:
        age = int(time.time() - stamp.stat().st_mtime)
    except FileNotFoundError:
        return None
    return age if 0 <= age < ttl_seconds else None


def _write_stamp(stamp: Path, source: str | None = None) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        dir=stamp.parent,
        prefix=f".{stamp.name}.",
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(time.strftime("%Y-%m-%dT%H:%M:%SZ\n", time.gmtime()))
            if source is not None:
                handle.write(f"{source}\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, stamp)
    finally:
        temporary.unlink(missing_ok=True)


def _shell_status(returncode: int) -> int:
    return returncode if returncode >= 0 else 128 - returncode


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stamp", required=True, type=Path)
    parser.add_argument("--lock", required=True, type=Path)
    parser.add_argument("--ttl-seconds", required=True, type=_positive_int)
    parser.add_argument("--width", required=True, type=_positive_int)
    parser.add_argument("--canary", required=True, type=Path)
    parser.add_argument("--nested-controller-lock", required=True)
    args = parser.parse_args()

    args.stamp.parent.mkdir(parents=True, exist_ok=True)
    args.lock.parent.mkdir(parents=True, exist_ok=True)
    cohort_directory = os.environ.get("RUN_BENCH_CAMPAIGN_BARRIER_DIR")
    cohort = Path(cohort_directory) if cohort_directory else None
    failure = cohort / "infra-canary.failed" if cohort else None

    def cohort_blocked() -> bool:
        return bool(
            cohort
            and ((cohort / "abort.json").exists() or (failure and failure.exists()))
        )

    def record_cohort_failure(status: int) -> None:
        if failure:
            _write_stamp(failure, f"exit={status}")

    with args.lock.open("a+", encoding="utf-8") as lock_handle:
        if cohort:
            while True:
                if cohort_blocked():
                    print(
                        "infra canary preflight: campaign already failed",
                        file=sys.stderr,
                    )
                    return 1
                try:
                    fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    time.sleep(1)
            if cohort_blocked():
                return 1
        else:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        lock_handle.seek(0)
        lock_handle.truncate()
        lock_handle.write(f"{os.getpid()}\n")
        lock_handle.flush()

        age = _fresh_age(args.stamp, args.ttl_seconds)
        if age is not None:
            print(
                "🛡  infra canary preflight: "
                f"stamp fresh ({age}s < {args.ttl_seconds}s) — {args.stamp}"
            )
            return 0

        print(
            "🛡  infra canary preflight: "
            f"stamp missing/stale — running N={args.width} before capability fleet"
        )
        environment = os.environ.copy()
        # This substrate check must finish before its caller can join the
        # campaign. The nested controller does not own the caller's slot.
        for key in (
            "RUN_BENCH_CAMPAIGN_BARRIER_DIR",
            "RUN_BENCH_CAMPAIGN_COHORT",
            "RUN_BENCH_CAMPAIGN_JOB_ID",
            "BENCHMARK_HUB_GROUP_RUN_ID",
            "RUN_BENCH_CAMPAIGN_RUN",
            "RUN_BENCH_CAMPAIGN_STARTED_AT",
            "RUN_BENCH_CAMPAIGN_TOTAL_JOBS",
        ):
            environment.pop(key, None)
        environment.update(
            {
                "CLOUDBENCH_INFRA_CANARY_PREFLIGHT_ACTIVE": "1",
                "CLOUDBENCH_SKIP_INFRA_CANARY_PREFLIGHT": "1",
                "CLOUDBENCH_CONTROLLER_LOCK_NAME": args.nested_controller_lock,
                # The parent already owns its audit directory. This nested
                # controller must create and retire a separate resource ledger.
                "CLOUDBENCH_FLEET_OWNER_TOKEN": uuid.uuid4().hex,
            }
        )
        try:
            completed = subprocess.run(
                ["bash", str(args.canary), str(args.width)],
                env=environment,
                check=False,
                pass_fds=(lock_handle.fileno(),),
            )
        except OSError as exc:
            print(
                f"❌ infra canary preflight FAILED (exit=1): {exc}",
                file=sys.stderr,
            )
            record_cohort_failure(1)
            return 1

        status = _shell_status(completed.returncode)
        if status != 0:
            # Publish before releasing the transaction lock. Peers in this
            # same cohort must not each repeat a failed infrastructure probe
            # while the campaign parent is publishing its abort marker.
            record_cohort_failure(status)
            return status

        _write_stamp(args.stamp)
        print(f"🛡  infra canary preflight PASS — stamped {args.stamp}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
