#!/usr/bin/env python3
"""Serialize the fleet infra-canary check, execution, and PASS stamp."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import runpy
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


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


def _cohort_context(args):
    """A local receipt is authority only inside the live sealed cleanup cohort."""
    directory = os.environ.get("RUN_BENCH_CLEANUP_COHORT_DIR")
    if not directory:
        raise ValueError("shared preflight requires a cleanup cohort")
    base = Path(directory).absolute() / "cleanup-budget"
    helper = Path(__file__).resolve().parent / "cloudbench-cleanup-tickets.py"
    budget_path = base / "budget.json"
    with budget_path.open("rb") as stream:
        budget = json.load(stream)
    if hashlib.sha256(helper.read_bytes()).hexdigest() != budget.get(
        "canary_ticket_sha256"
    ):
        raise ValueError("shared preflight cleanup interpreter changed")
    tickets = runpy.run_path(str(helper))
    budget = tickets["validate_budget"](base)
    if not tickets["parent_active"](budget):
        raise ValueError("shared preflight campaign owner retired")
    if (
        budget["cohort_id"] != os.environ.get("RUN_BENCH_CLEANUP_COHORT_ID")
        or not isinstance(budget.get("canary_source_ref"), str)
        or re.fullmatch("[0-9a-f]{40}", budget["canary_source_ref"]) is None
        or hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        != budget["canary_sha256"]
        or hashlib.sha256(args.canary.read_bytes()).hexdigest()
        != budget["canary_runner_sha256"]
        or str(args.lock) != budget["canary_lock"]
    ):
        raise ValueError("shared preflight source/cohort changed")
    deadline = budget["deadline"]
    if deadline is not None and time.monotonic() >= deadline:
        raise ValueError("original shared preflight deadline exhausted")
    policy = {
        "width": args.width,
        "ttl_seconds": args.ttl_seconds,
        "stamp": str(args.stamp),
        "lock": str(args.lock),
        "nested_controller_lock": args.nested_controller_lock,
        "cold_bootstrap": os.environ.get("CLOUDBENCH_INFRA_CANARY_COLD_BOOTSTRAP", "0"),
        "bench_ref": os.environ.get("CLOUDBENCH_INFRA_CANARY_REF", ""),
    }
    identity = {
        "schema": "cloudbench-cohort-preflight-pass-v1",
        "cohort": budget["cohort"],
        "cohort_id": budget["cohort_id"],
        "parent_pid": budget["parent_pid"],
        "parent_start": budget["parent_start"],
        "budget_sha256": tickets["digest"](budget),
        "source_ref": budget["canary_source_ref"],
        "helper_sha256": budget["canary_sha256"],
        "canary_sha256": budget["canary_runner_sha256"],
        "policy": policy,
        "original_deadline_monotonic": deadline,
    }
    return tickets, budget, identity


def _publish_parent_receipt(args, context, kind):
    tickets, budget, identity = _cohort_context(args)
    if (
        budget != context[1]
        or identity != context[2]
        or not tickets["parent_active"](budget)
    ):
        raise ValueError("shared preflight campaign identity changed")
    stamp = args.stamp.read_bytes()
    observed = args.stamp.stat()
    if _fresh_age(args.stamp, args.ttl_seconds) is None:
        raise ValueError("shared preflight stamp expired before receipt")
    tickets["write"](
        Path(budget["cohort"]) / "infra-canary-preflight.pass.json",
        dict(
            identity,
            checked_at_epoch=time.time(),
            canary_pass_epoch=observed.st_mtime_ns / 1000000000,
            check_kind=kind,
            stamp_observation={
                "mtime_ns": observed.st_mtime_ns,
                "sha256": hashlib.sha256(stamp).hexdigest(),
            },
        ),
    )


def _consume_receipt(args):
    tickets, budget, expected = _cohort_context(args)
    path = Path(os.environ["CLOUDBENCH_COHORT_PREFLIGHT_RECEIPT"])
    if path != Path(budget["cohort"]) / "infra-canary-preflight.pass.json":
        raise ValueError("foreign shared preflight receipt path")
    raw = path.read_bytes()
    if (
        hashlib.sha256(raw).hexdigest()
        != os.environ["CLOUDBENCH_COHORT_PREFLIGHT_SHA256"]
    ):
        raise ValueError("shared preflight receipt checksum differs")
    value = tickets["read"](path)
    checked = value.pop("checked_at_epoch")
    passed = value.pop("canary_pass_epoch")
    stamp = value.pop("stamp_observation")
    kind = value.pop("check_kind")
    if (
        value != expected
        or kind not in ("FRESH_STAMP", "N2_PASS")
        or type(stamp.get("mtime_ns")) is not int
        or not isinstance(stamp.get("sha256"), str)
        or re.fullmatch("[0-9a-f]{64}", stamp["sha256"]) is None
        or set(stamp) != {"mtime_ns", "sha256"}
        or not 0 <= time.time() - checked < args.ttl_seconds
        or passed != stamp["mtime_ns"] / 1000000000
        or not 0 <= int(time.time() - stamp["mtime_ns"] / 1000000000) < args.ttl_seconds
    ):
        raise ValueError("shared preflight receipt identity/policy expired or changed")
    job = os.environ.get("RUN_BENCH_CAMPAIGN_JOB_ID", "")
    tickets["selected"](Path(budget["cohort"]) / "cleanup-budget", job)
    print("infra canary preflight: source-bound cohort PASS receipt")


def _run_owned_canary(argv, environment, lock_handle, blocked):
    cancelled = []
    handlers = {
        sig: signal.signal(sig, lambda sig, _: cancelled.append(sig))
        for sig in (signal.SIGINT, signal.SIGTERM)
    }
    child = None
    try:
        deadline = environment.get("RUN_BENCH_CAMPAIGN_E2E_DEADLINE_MONOTONIC")
        if cancelled or blocked() or deadline and time.monotonic() >= float(deadline):
            return 128 + cancelled[0] if cancelled else 1
        child = subprocess.Popen(
            argv, env=environment, pass_fds=(lock_handle.fileno(),)
        )
        terminated = False
        while child.poll() is None:
            deadline = environment.get("RUN_BENCH_CAMPAIGN_E2E_DEADLINE_MONOTONIC")
            if not terminated and (
                cancelled
                or blocked()
                or deadline
                and time.monotonic() >= float(deadline)
            ):
                child.terminate()
                terminated = True
            try:
                child.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                pass
        return 128 + cancelled[0] if cancelled else _shell_status(child.returncode)
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            child.wait()
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


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
    if os.environ.get("CLOUDBENCH_COHORT_PREFLIGHT_RECEIPT"):
        _consume_receipt(args)
        return 0
    parent_preflight = os.environ.get("CLOUDBENCH_CAMPAIGN_PARENT_PREFLIGHT") == "1"
    parent_context = _cohort_context(args) if parent_preflight else None
    if parent_context and os.getppid() != parent_context[1]["parent_pid"]:
        raise ValueError("shared preflight is not the exact campaign child")
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
            if parent_context:
                _publish_parent_receipt(args, parent_context, "FRESH_STAMP")
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
            "BENCHMARK_HUB_PARENT_RUN_ID",
            "RUN_BENCH_CAMPAIGN_RUN",
            "RUN_BENCH_CAMPAIGN_STARTED_AT",
            "RUN_BENCH_CAMPAIGN_TOTAL_JOBS",
            "CLOUDBENCH_CAMPAIGN_SEED_PROOF",
            "CLOUDBENCH_COHORT_PREFLIGHT_RECEIPT",
            "CLOUDBENCH_COHORT_PREFLIGHT_SHA256",
            "CLOUDBENCH_CAMPAIGN_PARENT_PREFLIGHT",
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
            status = _run_owned_canary(
                ["bash", str(args.canary), str(args.width)],
                environment,
                lock_handle,
                cohort_blocked,
            )
        except OSError as exc:
            print(
                f"❌ infra canary preflight FAILED (exit=1): {exc}",
                file=sys.stderr,
            )
            record_cohort_failure(1)
            return 1

        if status != 0:
            # Publish before releasing the transaction lock. Peers in this
            # same cohort must not each repeat a failed infrastructure probe
            # while the campaign parent is publishing its abort marker.
            record_cohort_failure(status)
            return status

        if parent_context:
            tickets, budget, _identity = _cohort_context(args)
            if not tickets["parent_active"](budget) or cohort_blocked():
                return 1
        _write_stamp(args.stamp)
        if parent_context:
            _publish_parent_receipt(args, parent_context, "N2_PASS")
        print(f"🛡  infra canary preflight PASS — stamped {args.stamp}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
