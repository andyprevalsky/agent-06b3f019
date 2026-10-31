#!/usr/bin/env python3
"""Hold a process-bound advisory lock for a backend coverage shell.

The lock file is intentionally persistent. `flock` owns the exclusion, so a
SIGKILL/OOM cannot strand a directory lock; this helper also exits as soon as
its shell parent is gone.
"""

from __future__ import annotations

import fcntl
import os
import signal
import sys
import time
from pathlib import Path

from coverage_process_registry import (
    RegisteredProcessGroup,
    parse_process_group,
    process_start_identity,
)


def write_status(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")


def close_registry_and_snapshot_process_groups(path: Path) -> set[RegisteredProcessGroup]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as registry:
        fcntl.flock(registry.fileno(), fcntl.LOCK_EX)
        registry.seek(0)
        contents = registry.read()
        values = contents.splitlines()
        if "disarmed" in values:
            return set()

        # Publish shutdown while holding the same lock launchers take through
        # exec. No launcher can register after this final snapshot: a launcher
        # already at exec is included, and a delayed one observes shutdown.
        if "shutdown" not in values:
            registry.seek(0, os.SEEK_END)
            # An unterminated tail would fuse into "…recordshutdown", leaving no
            # complete closed marker for a waiting launcher to observe — it would
            # then register and exec after this final snapshot, and its group
            # would never be terminated.
            if contents and not contents.endswith("\n"):
                registry.write("\n")
            registry.write("shutdown\n")
            registry.flush()
            os.fsync(registry.fileno())

        own_group = os.getpgrp()
        groups = {group for value in values if (group := parse_process_group(value)) is not None}
        return {group for group in groups if group.pgid != own_group}


def process_group_exists(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def process_group_identity_matches(group: RegisteredProcessGroup) -> bool:
    if not process_group_exists(group.pgid):
        return False
    # macOS reads the identity through `ps`, which can time out under the
    # parallel coverage load. A single missed read must not abandon a live
    # registered group and leave its descendants running after the test exits.
    # A concrete mismatched identity still fails immediately to avoid PID reuse.
    for attempt in range(3):
        identity = process_start_identity(group.identity_pid)
        if identity is not None:
            return identity == group.start_identity
        if attempt < 2:
            time.sleep(0.05)
    return False


# A process that ignores SIGKILL is stuck in the kernel (uninterruptible I/O) or is
# an unreaped zombie; neither is recoverable by waiting longer.
SIGKILL_REAP_TIMEOUT_SECONDS = 5


def terminate_registered_process_groups(path: Path) -> None:
    terminate_process_groups(close_registry_and_snapshot_process_groups(path))


def terminate_process_groups(groups: set[RegisteredProcessGroup]) -> None:
    """SIGTERM, then escalate to SIGKILL, every group whose identity still matches."""
    live: set[RegisteredProcessGroup] = set()
    for group in groups:
        if not process_group_identity_matches(group):
            continue
        try:
            os.killpg(group.pgid, signal.SIGTERM)
            live.add(group)
        except ProcessLookupError:
            pass
        except PermissionError:
            # A group we are not allowed to signal (e.g. one reduced to a zombie
            # we do not own) will never be reaped by us. Escalating or waiting on
            # it would only stall cleanup while the lock is held.
            pass

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        live = {group for group in live if process_group_exists(group.pgid)}
        if not live:
            return
        time.sleep(0.02)

    escalated: set[RegisteredProcessGroup] = set()
    for group in live:
        if not process_group_identity_matches(group):
            continue
        try:
            os.killpg(group.pgid, signal.SIGKILL)
            escalated.add(group)
        except ProcessLookupError:
            pass
        except PermissionError:
            pass
    # Bound the post-SIGKILL wait. A zombie or uninterruptible process keeps its
    # process group visible to kill(pgid, 0) indefinitely, and this loop runs
    # while the guardian still holds lock_file — an unbounded wait here would
    # block every later coverage run rather than just this one.
    kill_deadline = time.monotonic() + SIGKILL_REAP_TIMEOUT_SECONDS
    while time.monotonic() < kill_deadline:
        escalated = {group for group in escalated if process_group_exists(group.pgid)}
        if not escalated:
            return
        time.sleep(0.02)

    print(
        "coverage-process-lock: process group(s) survived SIGKILL and were abandoned: "
        + ", ".join(str(group.pgid) for group in sorted(escalated, key=lambda g: g.pgid)),
        file=sys.stderr,
    )


def main() -> int:
    if len(sys.argv) not in {4, 5}:
        print(
            "usage: coverage-process-lock.py LOCK_FILE STATUS_FILE PARENT_PID [PROCESS_GROUPS_FILE]",
            file=sys.stderr,
        )
        return 2

    lock_path = Path(sys.argv[1])
    status_path = Path(sys.argv[2])
    expected_parent_pid = int(sys.argv[3])
    process_groups_path = Path(sys.argv[4]) if len(sys.argv) == 5 else None
    # Keep the lock guardian outside the coverage shell's process group. A hard
    # kill of that group must not also kill the only process capable of reaping
    # the separately-sessioned backend and test descendants.
    os.setsid()

    # Install the stop handlers before anything an owner can observe. The owner
    # sends SIGTERM as soon as it reads "acquired"; with the handlers installed
    # only after that publication, a guardian descheduled between the status
    # write and signal.signal() (ordinary CPU contention) dies under the default
    # disposition and never terminates its registered process groups.
    stopping = False

    def stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    lock_path.parent.mkdir(parents=True, exist_ok=True)

    with lock_path.open("a+", encoding="utf-8") as lock_file:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock_file.seek(0)
            owner = lock_file.read().strip() or "unknown"
            write_status(status_path, f"blocked:{owner}")
            return 73

        lock_file.seek(0)
        lock_file.truncate()
        lock_file.write(f"{expected_parent_pid}\n")
        lock_file.flush()
        os.fsync(lock_file.fileno())
        write_status(status_path, "acquired")

        while not stopping and os.getppid() == expected_parent_pid:
            time.sleep(0.02)

        if process_groups_path is not None:
            terminate_registered_process_groups(process_groups_path)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
