#!/usr/bin/env python3
"""Run the focused live /deploy probes under one foreground supervisor.

Independent probes start together. A probe with ``after`` starts once that
probe exits, pass or fail, so two ``run-blackbox-tests.sh`` setups never race
the same local database's schema sync and runtime SQL hooks.

``--only NAME`` runs one probe by itself. The staged /deploy cycle binds each
probe as its own case (deploy_gates.live_probes_recipe) and runs those cases
one after another in PROBE_NAMES order, which keeps every ``after`` ordering, so
one probe's result is recorded on its own instead of as one aggregate exit.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from collections.abc import Sequence
from dataclasses import dataclass, replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROGRESS_ENV = "DEPLOY_GATE_PROGRESS"
# The Tilion region production reaches. back.tilion.dev is an accelerator that picks the
# region nearest the client: production (Render Navi in ohio, Fly workers in iad) lands on
# east, while the Blacksmith gate VM lands on west, a region production never uses, whose
# direct-exit DNS failed every lookup on both workers on 2026-11-15 (case
# 2026-11-08-tilion-parity-dns-resolution-failure). The live provider probe tests production's region.
TILION_PRODUCTION_REGION_BASE_URL = "https://east.back.tilion.dev"
# deploy_commands() names in an order that satisfies every ``after`` edge when run one by one.
PROBE_NAMES = (
    "credential-health",
    "amplitude-live",
    "chat-router-failover-live",
    "browser-provider-live",
    "report-bug-storage-live",
    "migration-preflight",
)


def report_progress(probe: str, exit_code: int) -> None:
    """Append one DEPLOY_GATE_PROGRESS row (scripts/deploy_gate_progress.py) per finished probe.

    Probes write straight to this runner's stdout, so the row carries the exit
    code, not an output tail. Advisory: without the variable nothing is imported
    or written, and a missing helper or unwritable file changes nothing.
    """
    if not os.environ.get(PROGRESS_ENV):
        return
    scripts = str(Path(__file__).resolve().parent)
    try:
        sys.path.insert(0, scripts)
        try:
            import deploy_gate_progress
        finally:
            sys.path.remove(scripts)
        deploy_gate_progress.report(
            probe,
            "PASS" if exit_code == 0 else "FAIL",
            scope="suite",
            detail="" if exit_code == 0 else f"live probe {probe}: exit={exit_code}",
        )
    except (ImportError, OSError, ValueError):
        return


def workspace_tsx() -> str:
    """Return the installed tsx binary. Do not call through npx: the Cloud
    VM's /exec-daemon/npx (npm 11) crashes before the local binary starts.
    """
    for candidate in (ROOT / "node_modules/.bin/tsx", ROOT / "back-end/node_modules/.bin/tsx"):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    raise FileNotFoundError("tsx is not installed in node_modules/.bin")


@dataclass(frozen=True)
class Command:
    name: str
    argv: tuple[str, ...]
    cwd: Path
    after: str | None = None


def run_commands(commands: Sequence[Command]) -> dict[str, int]:
    names = [command.name for command in commands]
    if len(set(names)) != len(names):
        raise ValueError(f"duplicate live probe names: {names}")
    for command in commands:
        if command.after is not None and command.after not in names:
            raise ValueError(f"{command.name} waits for unknown probe {command.after}")
        if command.after == command.name:
            raise ValueError(f"{command.name} cannot wait for itself")

    processes: dict[str, subprocess.Popen[bytes]] = {}
    results: dict[str, int] = {}
    pending = list(commands)
    stopped: list[int] = []

    def terminate(signum: int) -> None:
        for process in processes.values():
            if process.poll() is not None:
                continue
            try:
                os.killpg(process.pid, signum)
            except ProcessLookupError:
                pass

    def forward(signum: int, _frame: object) -> None:
        stopped.append(signum)
        terminate(signum)

    def launch_ready() -> None:
        if stopped:
            return
        for command in list(pending):
            if command.after is not None and command.after not in results:
                continue
            pending.remove(command)
            processes[command.name] = subprocess.Popen(
                command.argv,
                cwd=command.cwd,
                start_new_session=True,
            )

    previous_handlers = {
        signum: signal.getsignal(signum)
        for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)
    }
    for signum in previous_handlers:
        signal.signal(signum, forward)
    try:
        launch_ready()
        while processes:
            for name, process in list(processes.items()):
                exit_code = process.poll()
                if exit_code is None:
                    continue
                results[name] = process.wait()
                del processes[name]
                report_progress(name, results[name])
                launch_ready()
            if processes:
                time.sleep(0.02)
    finally:
        terminate(signal.SIGTERM)
        for name, process in processes.items():
            results[name] = process.wait()
        for signum, previous in previous_handlers.items():
            signal.signal(signum, previous)
    for command in pending:
        results[command.name] = 128 + (stopped[0] if stopped else signal.SIGTERM)
    return {command.name: results[command.name] for command in commands}


def deploy_commands() -> tuple[Command, ...]:
    return (
        Command(
            "credential-health",
            (
                "bash",
                "../scripts/run-deploy-stage",
                "credential-health",
                "--",
                workspace_tsx(),
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
        Command(
            "chat-router-failover-live",
            (
                "bash",
                "../scripts/run-deploy-stage",
                "chat-router-failover-live",
                "--",
                "env",
                "CHAT_ROUTER_FAILOVER_LIVE=1",
                "BLACKBOX_TEST_CONCURRENCY=1",
                "bash",
                "scripts/run-blackbox-tests.sh",
                "chat-router-failover",
            ),
            ROOT / "back-end",
            after="amplitude-live",
        ),
        # Real-internet provider cases kept out of the hermetic coverage gate.
        # Same workspace test database as the stages above, so serialized.
        Command(
            "browser-provider-live",
            (
                "bash",
                "../scripts/run-deploy-stage",
                "browser-provider-live",
                "--",
                "env",
                "BROWSER_PROVIDER_LIVE=1",
                f"TILION_BASE_URL={TILION_PRODUCTION_REGION_BASE_URL}",
                "BLACKBOX_TEST_CONCURRENCY=1",
                "bash",
                "scripts/run-blackbox-tests.sh",
                "browser-provider",
            ),
            ROOT / "back-end",
            after="chat-router-failover-live",
        ),
        Command(
            "report-bug-storage-live",
            (
                "bash",
                "../scripts/run-deploy-stage",
                "report-bug-storage-live",
                "--",
                "env",
                "REPORT_BUG_STORAGE_LIVE=1",
                "BLACKBOX_TEST_CONCURRENCY=1",
                "bash",
                "scripts/run-blackbox-tests.sh",
                "report-bug",
            ),
            ROOT / "back-end",
            after="browser-provider-live",
        ),
        # Read-only: EXPLAINs and counts every migration production has not applied
        # yet against its data, which local and CI databases never contain.
        Command(
            "migration-preflight",
            (
                "bash",
                "../scripts/run-deploy-stage",
                "migration-preflight",
                "--",
                workspace_tsx(),
                "scripts/migration-preflight.ts",
            ),
            ROOT / "back-end",
        ),
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", choices=PROBE_NAMES, help="run this one probe by itself")
    args = parser.parse_args(argv)
    commands = deploy_commands()
    if args.only:
        # Its predecessors ran as earlier cases (or not at all); it must not wait for them here.
        commands = tuple(replace(command, after=None) for command in commands if command.name == args.only)
    results = run_commands(commands)
    for name, exit_code in results.items():
        print(f"live probe {name}: exit={exit_code}")
    return 0 if all(exit_code == 0 for exit_code in results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
