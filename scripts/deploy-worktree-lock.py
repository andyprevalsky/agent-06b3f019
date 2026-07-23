#!/usr/bin/env python3
"""Run one deploy-worktree preparation transaction under an owner lock."""

from __future__ import annotations

import argparse
import fcntl
import os
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required after --")

    args.lock.parent.mkdir(parents=True, exist_ok=True)
    with args.lock.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        # Keep the lock descriptor open across exec and every descendant. If
        # the shell wrapper is terminated while a child command is still
        # running, that child retains the lock until the transaction actually
        # stops instead of allowing a second preparation to overlap it.
        os.set_inheritable(handle.fileno(), True)
        os.execvp(command[0], command)
    raise AssertionError("execvp returned unexpectedly")


if __name__ == "__main__":
    raise SystemExit(main())
