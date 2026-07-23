#!/usr/bin/env python3
"""Run one deploy-worktree preparation transaction under an owner lock."""

from __future__ import annotations

import argparse
import fcntl
import os
import subprocess
import sys
from pathlib import Path


def _exit_code(status: int) -> int:
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


def _run_guardian(lock: Path, command: list[str]) -> None:
    """Hold the lock in a detached transaction guardian until the command exits."""
    try:
        os.setsid()
        lock.parent.mkdir(parents=True, exist_ok=True)
        with lock.open("a+", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            result = subprocess.run(command, check=False)
        os._exit(result.returncode if 0 <= result.returncode <= 255 else 1)
    except BaseException as error:
        print(f"deploy worktree transaction failed: {error}", file=sys.stderr)
        os._exit(1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required after --")

    # The shell-visible wrapper is deliberately separate from the transaction
    # guardian. Terminating the wrapper must not release the owner lock while a
    # provisioning subprocess is still mutating that worktree. The detached
    # guardian therefore keeps both the lock and command alive, while the
    # wrapper normally mirrors its exit status.
    guardian_pid = os.fork()
    if guardian_pid == 0:
        _run_guardian(args.lock, command)

    while True:
        try:
            _, status = os.waitpid(guardian_pid, 0)
            return _exit_code(status)
        except InterruptedError:
            continue


if __name__ == "__main__":
    raise SystemExit(main())
