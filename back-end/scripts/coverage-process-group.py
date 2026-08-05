#!/usr/bin/env python3
"""Exec a command as a dedicated process group and register its PGID."""

from __future__ import annotations

import fcntl
import os
import select
import signal
import subprocess
import sys
import time
from pathlib import Path

from coverage_process_registry import (
    RegisteredProcessGroup,
    process_start_identity,
    serialize_process_group,
)

REGISTRY_CLOSED_MARKERS = {"disarmed", "shutdown"}
IDENTITY_SENTINEL_ARG = "--identity-sentinel"
SENTINEL_READY_BYTE = b"1"
SENTINEL_READY_TIMEOUT_SECONDS = 10.0


def process_group_member_pids(pgid: int) -> set[int] | None:
    try:
        result = subprocess.run(
            ["ps", "-e", "-o", "pid=", "-o", "pgid="],
            check=False,
            capture_output=True,
            start_new_session=True,
            text=True,
            timeout=1,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    members: set[int] = set()
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) != 2:
            continue
        try:
            pid, candidate_pgid = map(int, fields)
        except ValueError:
            continue
        if candidate_pgid == pgid:
            members.add(pid)
    return members


def run_identity_sentinel(parent_pid: int, pgid: int, ready_fd: int) -> int:
    # The guardian sends TERM to the whole group before escalating. Keep this
    # identity process alive until the leader and every other member are gone,
    # so the guardian can safely revalidate ownership immediately before KILL.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    # Readiness is published only after TERM is ignored. Until this point the
    # sentinel still carries the default disposition, so a group TERM would kill
    # it; the launcher must not register an identity that a concurrent shutdown
    # can invalidate, because the guardian then skips KILL and leaks the group.
    try:
        os.write(ready_fd, SENTINEL_READY_BYTE)
    finally:
        os.close(ready_fd)
    while os.getppid() == parent_pid:
        time.sleep(0.02)
    own_pid = os.getpid()
    while True:
        members = process_group_member_pids(pgid)
        if members is not None and not (members - {own_pid}):
            return 0
        time.sleep(0.02)


def wait_for_sentinel_ready(read_fd: int, sentinel: subprocess.Popen[bytes], timeout: float) -> bool:
    """Block until the sentinel reports it is TERM-proof, or the bound elapses."""
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        readable, _, _ = select.select([read_fd], [], [], min(remaining, 0.05))
        if readable:
            # A dead sentinel closes its write end, so EOF (b"") reads as not-ready.
            return os.read(read_fd, 1) == SENTINEL_READY_BYTE
        if sentinel.poll() is not None:
            return False


def stop_identity_sentinel(sentinel: subprocess.Popen[bytes]) -> None:
    # Only signal a sentinel that is still running. Once Popen has reaped the
    # child (poll() returns an exit status), the numeric pid is released back to
    # the OS and may already name an unrelated process — signalling it then is
    # not a no-op, it is a kill of somebody else's process.
    if sentinel.poll() is None:
        try:
            os.kill(sentinel.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        sentinel.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass


def main() -> int:
    if len(sys.argv) == 5 and sys.argv[1] == IDENTITY_SENTINEL_ARG:
        return run_identity_sentinel(int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]))
    if len(sys.argv) < 3:
        print("usage: coverage-process-group.py REGISTRY COMMAND [ARG ...]", file=sys.stderr)
        return 2

    registry = Path(sys.argv[1])
    registry.parent.mkdir(parents=True, exist_ok=True)
    os.setsid()
    pgid = os.getpgrp()
    ready_read_fd, ready_write_fd = os.pipe()
    try:
        sentinel = subprocess.Popen(
            [
                sys.executable,
                __file__,
                IDENTITY_SENTINEL_ARG,
                str(os.getpid()),
                str(pgid),
                str(ready_write_fd),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            pass_fds=(ready_write_fd,),
        )
    finally:
        os.close(ready_write_fd)
    try:
        sentinel_ready = wait_for_sentinel_ready(ready_read_fd, sentinel, SENTINEL_READY_TIMEOUT_SECONDS)
    finally:
        os.close(ready_read_fd)
    if not sentinel_ready:
        stop_identity_sentinel(sentinel)
        print(
            f"coverage process group sentinel {sentinel.pid} never signalled readiness",
            file=sys.stderr,
        )
        return 1
    start_identity = None
    for _attempt in range(100):
        start_identity = process_start_identity(sentinel.pid)
        if start_identity is not None:
            break
        time.sleep(0.01)
    if start_identity is None:
        stop_identity_sentinel(sentinel)
        print(f"could not identify coverage process group sentinel {sentinel.pid}", file=sys.stderr)
        return 1
    registration = serialize_process_group(
        RegisteredProcessGroup(
            pgid=pgid,
            identity_pid=sentinel.pid,
            start_identity=start_identity,
        )
    )
    try:
        with registry.open("a+", encoding="utf-8") as handle:
            # Hold the registry lock through exec. A successful exec closes
            # this non-inheritable descriptor and releases the lock, at which
            # point the guardian's shutdown snapshot includes this group.
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            handle.seek(0)
            contents = handle.read()
            state = set(contents.splitlines())
            if state & REGISTRY_CLOSED_MARKERS:
                return 125
            handle.seek(0, os.SEEK_END)
            if contents and not contents.endswith("\n"):
                handle.write("\n")
            handle.write(f"{registration}\n")
            handle.flush()
            os.fsync(handle.fileno())
            os.execvp(sys.argv[2], sys.argv[2:])
    except FileNotFoundError:
        print(f"coverage child executable not found: {sys.argv[2]}", file=sys.stderr)
        return 127
    except PermissionError:
        print(f"coverage child executable is not runnable: {sys.argv[2]}", file=sys.stderr)
        return 126
    finally:
        # A successful exec replaces this process and never reaches finally.
        stop_identity_sentinel(sentinel)


if __name__ == "__main__":
    raise SystemExit(main())
