#!/usr/bin/env python3
"""Join the owning local campaign before a fleet releases its existing barrier."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import time
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--deadline", type=float, required=True)
    parser.add_argument("--controller-pid", type=int, required=True)
    args = parser.parse_args()
    raw_directory = os.environ.get("RUN_BENCH_CAMPAIGN_BARRIER_DIR")
    if not raw_directory:
        return 0
    directory = Path(raw_directory)
    job_id = os.environ["RUN_BENCH_CAMPAIGN_JOB_ID"]
    cohort_id = os.environ["RUN_BENCH_CAMPAIGN_COHORT"]
    if Path(job_id).name != job_id or args.controller_pid < 1:
        raise ValueError("invalid campaign job identity")
    with (directory.parent / "parent.lock").open() as parent_lock:

        def parent_alive() -> bool:
            try:
                fcntl.flock(parent_lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            fcntl.flock(parent_lock, fcntl.LOCK_UN)
            return False

        while time.time() < args.deadline:
            if (directory / "abort.json").exists() or not parent_alive():
                print("campaign startup barrier aborted before release", flush=True)
                return 1
            manifest = json.loads((directory / "manifest.json").read_text())
            if manifest["cohort_id"] != cohort_id or job_id not in manifest["jobs"]:
                raise ValueError("campaign cohort does not own this job")
            controller_pid = manifest["jobs"][job_id]
            if controller_pid is None:
                time.sleep(0.1)
                continue
            if controller_pid != args.controller_pid:
                raise ValueError("campaign cohort does not own this controller")
            break
        else:
            print(
                "campaign startup barrier exhausted the existing startup budget",
                flush=True,
            )
            return 1

        ready = directory / "ready" / f"{job_id}.json"
        temporary = ready.with_name(f".{ready.name}.{os.getpid()}")
        temporary.write_text(
            json.dumps(
                {
                    "cohort_id": cohort_id,
                    "job_id": job_id,
                    "controller_pid": args.controller_pid,
                    "ready_at": time.time(),
                    # The campaign excludes a peer that is still not ready
                    # before the earliest ready copy's own deadline expires.
                    "deadline": args.deadline,
                }
            )
        )
        temporary.replace(ready)
        print(f"campaign startup barrier ready: {cohort_id}/{job_id}", flush=True)
        while time.time() < args.deadline:
            if (directory / "abort.json").exists() or not parent_alive():
                print("campaign startup barrier aborted before release", flush=True)
                return 1
            release = directory / "release.json"
            if release.is_file():
                receipt = json.loads(release.read_text())
                if receipt["cohort_id"] != cohort_id:
                    raise ValueError("campaign release belongs to a different cohort")
                if receipt["jobs"].get(job_id) != args.controller_pid:
                    raise ValueError("campaign release does not own this controller")
                return 0
            time.sleep(0.1)
    print("campaign startup barrier exhausted the existing startup budget", flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
