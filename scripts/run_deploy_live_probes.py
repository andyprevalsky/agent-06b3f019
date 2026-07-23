#!/usr/bin/env python3
"""Run the independent credential and Amplitude /deploy probes concurrently."""

from __future__ import annotations

import os
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Command:
    name: str
    argv: tuple[str, ...]
    cwd: Path


def run_commands(commands: Sequence[Command]) -> dict[str, int]:
    processes: dict[str, subprocess.Popen[bytes]] = {}
    results: dict[str, int] = {}

    def forward(signum: int, _frame: object) -> None:
        for process in processes.values():
            if process.poll() is not None:
                continue
            try:
                os.killpg(process.pid, signum)
            except ProcessLookupError:
                pass

    previous_handlers = {
        signum: signal.getsignal(signum)
        for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)
    }
    for signum in previous_handlers:
        signal.signal(signum, forward)
    try:
        for command in commands:
            processes[command.name] = subprocess.Popen(
                command.argv,
                cwd=command.cwd,
                start_new_session=True,
            )
        while processes:
            for name, process in list(processes.items()):
                exit_code = process.poll()
                if exit_code is None:
                    continue
                results[name] = process.wait()
                del processes[name]
            if processes:
                time.sleep(0.02)
    finally:
        forward(signal.SIGTERM, None)
        for name, process in processes.items():
            results[name] = process.wait()
        for signum, previous in previous_handlers.items():
            signal.signal(signum, previous)
    return {command.name: results[command.name] for command in commands}


def main() -> int:
    commands = (
        Command(
            "credential-health",
            (
                "bash",
                "../scripts/run-deploy-stage",
                "credential-health",
                "--",
                "npx",
                "tsx",
                "src/tests/blackbox/integration-health.blackbox.ts",
            ),
            ROOT / "back-end",
        ),
        Command(
            "amplitude-live",
            (
                "bash",
                "../scripts/run-deploy-stage",
                "amplitude-live",
                "--",
                "env",
                "ADMIN_HEALTH_LIVE_ONLY=1",
                "BLACKBOX_TEST_CONCURRENCY=1",
                "bash",
                "scripts/run-blackbox-tests.sh",
                "admin-health",
            ),
            ROOT / "back-end",
        ),
    )
    results = run_commands(commands)
    for name, exit_code in results.items():
        print(f"live probe {name}: exit={exit_code}")
    return 0 if all(exit_code == 0 for exit_code in results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
