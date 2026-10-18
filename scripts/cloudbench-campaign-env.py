#!/usr/bin/env python3
"""Share one successful canonical read-only env check within a live cohort."""

import argparse
import fcntl
import hashlib
import json
import math
import os
import re
import runpy
import signal
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path

SEED = runpy.run_path(str(Path(__file__).with_name("cloudbench-campaign-seed.py")))


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def file_bytes(path):
    path = Path(path)
    with os.fdopen(
        os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb"
    ) as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > 16 * 1024 * 1024:
            raise ValueError("bounded regular environment input required")
        raw = stream.read(before.st_size + 1)
        after = os.fstat(stream.fileno())
        fields = (
            "st_dev",
            "st_ino",
            "st_mode",
            "st_uid",
            "st_nlink",
            "st_size",
            "st_mtime_ns",
            "st_ctime_ns",
        )
        if (
            any(getattr(after, key) != getattr(before, key) for key in fields)
            or len(raw) != before.st_size
        ):
            raise ValueError("environment input changed during read")
        return raw


def save(path, value):
    with os.fdopen(
        os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "w"
    ) as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def selected_authentication(root):
    """Match run-bench-cloud's resolver without binding ignored config fields."""

    def result(source, value):
        return {"source": source, "credential_sha256": digest(value.encode())}

    def first_value(raw, prefix, spaces=False):
        for line in raw.decode().split("\n"):
            if not line.startswith(prefix):
                continue
            value = line[len(prefix) :]
            if spaces:
                value = value.lstrip(" ")
            if value[:1] in ("'", '"'):
                value = value[1:]
            if value[-1:] in ("'", '"'):
                value = value[:-1]
            return value
        return ""

    bench = os.environ.get("FLY_BENCH_API_TOKEN", "")
    if len(bench) >= 20:
        return result("FLY_BENCH_API_TOKEN", bench)
    config = Path.home() / ".fly/config.yml"
    if config.is_file():
        token = first_value(
            file_bytes(config.resolve(strict=True)), "access_token:", spaces=True
        )
        if token:
            return result("config.access_token", token)
    token = os.environ.get("FLY_API_TOKEN", "")
    if token:
        return result("FLY_API_TOKEN", token)
    token = first_value(file_bytes(root / "agents/.env"), "FLY_API_TOKEN=")
    return result("agents.env.FLY_API_TOKEN" if token else "none", token)


def identity(args):
    authority = SEED["owner"](args.inventory, args.barrier)
    cohort = SEED["manifest"](args.barrier)
    if (
        args.controller_pid != os.getppid()
        or args.job not in cohort["jobs"]
        or not re.fullmatch("[0-9a-f]{40}", args.source_ref)
    ):
        raise ValueError("environment check is not owned by this cohort controller")
    # The campaign launches all children before atomically publishing their
    # PID projection. A declared-but-unassigned job is pending, not foreign.
    while cohort["jobs"][args.job] is None:
        remaining = args.deadline - time.time()
        if remaining <= 0:
            raise ValueError("original environment-check registration deadline expired")
        time.sleep(min(0.1, remaining))
        current_owner = SEED["owner"](args.inventory, args.barrier)
        current = SEED["manifest"](args.barrier)
        if (
            current_owner != authority
            or current["cohort_id"] != cohort["cohort_id"]
            or args.job not in current["jobs"]
            or os.getppid() != args.controller_pid
        ):
            raise ValueError("environment-check owner changed before registration")
        cohort = current
    if cohort["jobs"][args.job] != args.controller_pid:
        raise ValueError("environment check is not owned by this cohort controller")
    paths = {
        "agents_env": args.root / "agents/.env",
        "backend_env": args.root / "back-end/.env",
        "helper": Path(__file__),
        "verifier": Path(__file__).with_name("run-bench-cloud"),
    }
    return {
        "owner": authority,
        "cohort_id": cohort["cohort_id"],
        "members": sorted(cohort["jobs"]),
        "app": authority["app"],
        "source_ref": args.source_ref,
        "files": {
            role: digest(file_bytes(path.resolve(strict=True)))
            for role, path in paths.items()
        },
        "authentication": selected_authentication(args.root),
    }


def private_directory(path):
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = path.lstat()
    if (
        path.resolve(strict=True) != path
        or not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
    ):
        raise ValueError("private cohort env directory required")


def same_identity(args, expected, directory, phase):
    current = identity(args)
    if current == expected:
        return True

    def changes(before, after, prefix=""):
        if isinstance(before, dict) and isinstance(after, dict):
            return [
                item
                for key in sorted(before.keys() | after.keys())
                for item in changes(before.get(key), after.get(key), prefix + "." + key)
            ]
        return [prefix.removeprefix(".")] if before != after else []

    receipt = directory / ("identity-mismatch-" + uuid.uuid4().hex + ".json")
    save(
        receipt,
        {
            "phase": phase,
            "job": args.job,
            "controller_pid": args.controller_pid,
            "observed_epoch": time.time(),
            "changed_fields": changes(expected, current),
            "expected": expected,
            "current": current,
        },
    )
    print(
        "Environment identity mismatch; private diagnostic: " + str(receipt),
        file=sys.stderr,
    )
    return False


def check(args):
    os.umask(0o077)
    if not math.isfinite(args.deadline) or time.time() >= args.deadline:
        raise ValueError("original environment-check startup deadline expired")
    actual_ref = subprocess.check_output(
        ["git", "-C", str(args.root), "rev-parse", "HEAD"],
        text=True,
        timeout=max(0.001, args.deadline - time.time()),
    ).strip()
    if actual_ref != args.source_ref:
        raise ValueError(
            "environment-check source differs from actual campaign checkout"
        )
    expected = identity(args)
    directory = args.barrier / "environment-preflight"
    private_directory(directory)
    key = digest(json.dumps(expected, sort_keys=True).encode())
    proof = directory / (key + ".pass.json")
    lock_fd = os.open(
        directory / (key + ".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    stopped = [False]
    old = {
        number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)
    }
    for number in old:
        signal.signal(number, lambda *_: stopped.__setitem__(0, True))
    process = None
    try:
        info = os.fstat(lock_fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_nlink != 1
            or info.st_mode & 0o077
        ):
            raise ValueError("private cohort env lock required")
        while True:
            if stopped[0] or time.time() >= args.deadline:
                raise ValueError(
                    "environment check cancelled or original startup deadline expired"
                )
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(0.2)
        if not same_identity(args, expected, directory, "after-lock"):
            raise ValueError("environment-check identity changed while waiting")
        if proof.exists():
            value = json.loads(file_bytes(proof))
            if (
                value.get("binding") != expected
                or value.get("status") != "PASS"
                or value.get("exit_code") != 0
            ):
                raise ValueError("invalid successful environment proof")
            if stopped[0] or time.time() >= args.deadline:
                raise ValueError(
                    "environment check cancelled or original startup deadline expired"
                )
            print(
                "Shared benchmark app environment verified (same live cohort; read-only)"
            )
            return 0
        attempt = directory / ("attempt-" + uuid.uuid4().hex)
        attempt.mkdir(mode=0o700)
        stdout, stderr = attempt / "stdout.private.log", attempt / "stderr.private.log"
        started = time.time()
        with stdout.open("xb") as output, stderr.open("xb") as errors:
            process = subprocess.Popen(
                [
                    "bash",
                    str(Path(__file__).with_name("run-bench-cloud")),
                    "--verify-secrets",
                ],
                cwd=args.root,
                stdout=output,
                stderr=errors,
                start_new_session=True,
                pass_fds=(lock_fd,),
            )
            while process.poll() is None:
                if stopped[0] or time.time() >= args.deadline:
                    raise ValueError(
                        "environment check cancelled or original startup deadline expired"
                    )
                time.sleep(0.1)
            code = process.wait()
            output.flush()
            os.fsync(output.fileno())
            errors.flush()
            os.fsync(errors.fileno())
        result = {
            "binding": expected,
            "exit_code": code,
            "started_epoch": started,
            "finished_epoch": time.time(),
            "stdout_sha256": digest(file_bytes(stdout)),
            "stderr_sha256": digest(file_bytes(stderr)),
            "attempt_directory": str(attempt),
            "status": "PASS" if code == 0 else "FAILED",
        }
        save(attempt / "result.json", result)
        if code:
            print(
                "Canonical read-only environment check failed; private diagnostics: "
                + str(attempt)
            )
            return code if code > 0 else 128 - code
        if (
            stopped[0]
            or time.time() >= args.deadline
            or not same_identity(args, expected, directory, "before-publication")
        ):
            raise ValueError(
                "environment-check identity/deadline changed before publication"
            )
        save(proof, result)
        print(
            "Shared benchmark app environment verified (read-only); cohort proof saved"
        )
        return 0
    finally:
        try:
            if process is not None:
                SEED["stop_get"](process)
        finally:
            os.close(lock_fd)
            for number, handler in old.items():
                signal.signal(number, handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--barrier", type=Path, required=True)
    parser.add_argument("--source-ref", required=True)
    parser.add_argument("--job", required=True)
    parser.add_argument("--controller-pid", type=int, required=True)
    parser.add_argument("--deadline", type=float, required=True)
    return check(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
