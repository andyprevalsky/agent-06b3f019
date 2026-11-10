#!/usr/bin/env python3
"""Run the focused live /deploy probes under one foreground supervisor.

Independent probes start together. A probe with ``after`` starts once that
probe exits, pass or fail, so two ``run-blackbox-tests.sh`` setups never race
the same local database's schema sync and runtime SQL hooks.
"""

from __future__ import annotations

import os
import hashlib
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import signal
import subprocess
import sys
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROGRESS_ENV = "DEPLOY_GATE_PROGRESS"


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


def workspace_tsx(root: Path = ROOT) -> str:
    """Return the installed tsx binary. Do not call through npx: the Cloud
    VM's /exec-daemon/npx (npm 11) crashes before the local binary starts.
    """
    for candidate in (root / "node_modules/.bin/tsx", root / "back-end/node_modules/.bin/tsx"):
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


def deploy_commands(root: Path = ROOT) -> tuple[Command, ...]:
    return (
        Command(
            "credential-health",
            (
                "bash",
                "../scripts/run-deploy-stage",
                "credential-health",
                "--",
                workspace_tsx(root),
                "src/tests/blackbox/integration-health.blackbox.ts",
            ),
            root / "back-end",
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
            root / "back-end",
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
            root / "back-end",
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
                workspace_tsx(root),
                "scripts/migration-preflight.ts",
            ),
            root / "back-end",
        ),
    )


def recipe(root: Path = ROOT, aggregate: dict | None = None) -> dict:
    """The same four probes, with portable paths and their original dependency."""
    cases = {"live-probes": aggregate if aggregate is not None else {
        "command": ["python3", "scripts/run_deploy_live_probes.py"], "cwd": ".", "env": {}, "aggregate": True}}
    for probe in deploy_commands(root):
        argv = [os.path.relpath(arg, probe.cwd) if Path(arg).is_absolute() and root in Path(arg).parents
                else arg for arg in probe.argv]
        cases[probe.name] = {"command": argv, "cwd": str(probe.cwd.relative_to(root))}
        if probe.after:
            cases[probe.name]["after"] = probe.after
    return {"cases": cases}


def execute(request: dict, root: Path) -> dict:
    """Emit native per-probe receipts while preserving the concurrent live sweep."""
    from deploy_test_cycle import digest, source, write
    from deploy_test_process import CANCEL, cancellation_handlers
    from deploy_test_worker import report_case, run_step

    bound = request["worker_recipe"]
    cases = bound["cases"]
    selected, skipped = request["checks"], request.get("skips", {})
    aggregate = cases.get("live-probes", {})
    if (request["gate"] != "live-probes" or aggregate.get("command") != ["python3", "scripts/run_deploy_live_probes.py"]
            or aggregate.get("cwd") != "." or aggregate.get("aggregate") is not True
            or bound != recipe(root, aggregate)):
        raise ValueError("live-probe recipe differs from the original probe commands")
    if (len(set(selected)) != len(selected) or set(selected) & set(skipped)
            or not set(selected) <= cases.keys() or not set(skipped) <= cases.keys()
            or (request["phase"] != "focused" and set(selected) | set(skipped) != cases.keys())):
        raise ValueError("live-probe case inventory mismatch")
    if source(root) != request["source"] or request.get("worker_root", str(root)) != str(root.resolve()):
        raise ValueError("live-probe source or worker root differs from requested freeze")
    folder = root / ".context/deploy-worker" / hashlib.sha256(request["token"].encode()).hexdigest()
    folder.mkdir(parents=True, exist_ok=False)
    rows = {}
    probes = [name for name in cases if name != "live-probes"]
    pending = [name for name in probes if name in selected or ("live-probes" in selected and name not in skipped)]
    with cancellation_handlers(), ThreadPoolExecutor(max_workers=len(probes)) as pool:
        running = {}
        while pending or running:
            for name in list(pending):
                if CANCEL.is_set():
                    rows[name] = {"status": "UNVERIFIED", "reason": "worker interrupted before probe start"}
                    pending.remove(name)
                elif cases[name].get("after") not in pending and cases[name].get("after") not in running.values():
                    spec = {**cases[name], "env": aggregate.get("env", {})}
                    running[pool.submit(run_step, name, spec, root, folder)] = name
                    pending.remove(name)
            if not running:
                break
            finished, _ = wait(running, return_when=FIRST_COMPLETED)
            for future in finished:
                name = running.pop(future)
                rows[name] = future.result()
                report_case(name, rows[name], folder)
    cleaned = not any(row.get("lingering_group") for row in rows.values())
    if source(root) != request["source"] or not cleaned:
        rows = {name: {**row, "status": "UNVERIFIED", "reason": "source changed or cleanup unverified"}
                for name, row in rows.items()}
    if "live-probes" in selected:
        statuses = [rows.get(name, {}).get("status", "UNVERIFIED") for name in probes]
        status = ("UNVERIFIED" if "UNVERIFIED" in statuses else "FAIL" if "FAIL" in statuses else "PASS")
        rows["live-probes"] = {"status": status, "native_exit": 0 if status == "PASS" else 1,
                               "probes": {name: rows.get(name, {}).get("status", "UNVERIFIED") for name in probes}}
        report_case("live-probes", rows["live-probes"], folder)
    statuses = {name: rows[name]["status"] for name in selected}
    result = {key: request[key] for key in ("token", "source", "gate")}
    result.update(cases=statuses, complete=all(s in ("PASS", "FAIL") for s in statuses.values()),
                  reused=False, evidence=rows, recipe_digest=digest(bound), cleanup_complete=cleaned,
                  worker_root=str(root.resolve()))
    write(folder / "result.json", result)
    return result


def main() -> int:
    results = run_commands(deploy_commands())
    for name, exit_code in results.items():
        print(f"live probe {name}: exit={exit_code}")
    return 0 if all(exit_code == 0 for exit_code in results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
