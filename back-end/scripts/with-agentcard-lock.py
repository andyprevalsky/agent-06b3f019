#!/usr/bin/env python3
"""Run a sandbox payment test under the benchmark host-wide AgentCard lock."""

import fcntl
import os
import sys
import tempfile
from pathlib import Path


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: with-agentcard-lock.py COMMAND [ARG ...]")
    lock_path = Path(
        os.environ.get("BENCHMARK_AGENTCARD_LOCK_PATH")
        or Path(tempfile.gettempdir()) / "rose-agentcard-sandbox-benchmark.lock"
    )
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    # Keep the lock open in the test process, including after this launcher execs.
    os.set_inheritable(fd, True)
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    main()
