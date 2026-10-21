#!/usr/bin/env python3
"""Run independent /deploy command-structural regression suites concurrently."""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Sequence


ROOT = Path(__file__).resolve().parents[1]
# Several suites (and the bash suites' own python3 calls) need the pinned
# Python 3.11 in agents/venv; a host python3 of 3.10 fails them on
# `BaseException.add_note` and looks like a product regression.
VENV_BIN = ROOT / "agents" / "venv" / "bin"


def venv_runs_the_gates() -> bool:
    """Whether agents/venv holds the pinned interpreter the suites need.

    cloud-build.sh builds the venv from whatever `python3` exists when Python
    3.11 setup fails, so the venv's presence alone does not make it usable.
    The venv records the interpreter it was built from in pyvenv.cfg.
    """
    if not (VENV_BIN / "python3").exists():
        return False
    try:
        config = (VENV_BIN.parent / "pyvenv.cfg").read_text()
    except OSError:
        return False
    for line in config.splitlines():
        key, _, value = line.partition("=")
        if key.strip() not in {"version", "version_info"}:
            continue
        parts = value.strip().split(".")
        try:
            return (int(parts[0]), int(parts[1])) >= (3, 11)
        except (IndexError, ValueError):
            return False
    return False


def gate_environment() -> dict[str, str]:
    env = dict(os.environ)
    if venv_runs_the_gates():
        env["PATH"] = f"{VENV_BIN}{os.pathsep}{env.get('PATH', '')}"
    return env


SIGNAL_GRACE_SECONDS = 1.0
DEFAULT_MAX_WORKERS = 8
# run.sh, kill-services.sh and run-process-cleanup.sh resolve listener and
# process ownership with lsof. Without it the kill-services, run-process-cleanup
# and run-port-collision fixtures fail as "listener did not start" / "process is
# still alive" / "PID does not own listener", which reads like a regression.
REQUIRED_HOST_TOOLS = ("lsof",)


@dataclass(frozen=True)
class Gate:
    name: str
    command: tuple[str, ...]


@dataclass
class RunningGate:
    gate: Gate
    process: subprocess.Popen[bytes]
    output: BinaryIO
    output_path: Path
    started: float


GATES = (
    Gate("swap-harness", ("python3", "scripts/tests/swap-harness.test.py")),
    Gate(
        "cloudbench-controller-linux",
        ("python3", "scripts/tests/cloudbench-controller-linux.test.py"),
    ),
    Gate("workspace-env", ("bash", "scripts/tests/workspace-env.test.sh")),
    Gate("kill-services", ("bash", "scripts/tests/kill-services.test.sh")),
    Gate(
        "deploy-worktree-preflight",
        ("bash", "scripts/tests/deploy-worktree-preflight.test.sh"),
    ),
    Gate("seed-cache-decision", ("bash", "scripts/tests/seed-cache-decision.test.sh")),
    Gate(
        "canonical-seed-whatsapp-content",
        ("bash", "scripts/tests/canonical-seed-whatsapp-content.test.sh"),
    ),
    Gate(
        "benchmark-sms-transport-mock",
        ("bash", "scripts/tests/benchmark-sms-transport-mock.test.sh"),
    ),
    Gate("descend-command", ("bash", "scripts/tests/descend-command.test.sh")),
    Gate("benchmark-live-results", ("python3", "scripts/tests/benchmark-live-results.test.py")),
    Gate("jev-progress-core", ("python3", "scripts/tests/jev-progress-core.test.py")),
    Gate("benchmark-scorecard", ("python3", "scripts/tests/cloudbench-scorecard.test.py")),
    Gate(
        "original600-portable-operator",
        ("python3", "scripts/tests/original600-portable-operator.test.py"),
    ),
    Gate(
        "benchmark-provider-capacity",
        ("python3", "scripts/tests/cloudbench-provider-capacity.test.py"),
    ),
    Gate("benchmark-campaign-grouping", ("bash", "scripts/tests/campaign-hub-grouping.test.sh")),
    Gate("cloudbench-fetch-ref", ("bash", "scripts/tests/cloudbench-fetch-ref.test.sh")),
    Gate(
        "benchmark-successful-llm-evidence",
        ("python3", "scripts/tests/verify-successful-llm-queries.test.py"),
    ),
    Gate(
        "cloudbench-composite-root-cleanup",
        ("python3", "scripts/tests/cloudbench-exact-session-multi-root.test.py"),
    ),
    Gate(
        "cloudbench-quiesced-forensic-retirement",
        ("python3", "scripts/tests/cloudbench-forensic-quiesced.test.py"),
    ),
    Gate("seed-memory-ratchet", ("bash", "scripts/tests/seed-memory-ratchet.test.sh")),
    Gate("semantic-deploy", ("bash", "scripts/tests/semantic-deploy-gate.test.sh")),
    Gate(
        "prompt-human-approval",
        ("bash", "scripts/tests/check-prompt-human-approval.test.sh"),
    ),
    Gate(
        "agent-behavior-approval",
        ("bash", "scripts/tests/check-agent-behavior-approval.test.sh"),
    ),
    Gate(
        "llm-trajectory-injection-approval",
        ("bash", "scripts/tests/check-llm-trajectory-injection-approval.test.sh"),
    ),
    Gate("approval-format", ("bash", "scripts/tests/approval-format.test.sh")),
    Gate(
        "durable-evidence-links",
        ("bash", "scripts/tests/durable-evidence-links.test.sh"),
    ),
    Gate(
        "publish-evidence-browser-validation",
        ("bash", "scripts/tests/publish_evidence_links_browser_validation.test.sh"),
    ),
    Gate(
        "publish-evidence-composite-projection",
        ("bash", "scripts/tests/publish_evidence_links_composite.test.sh"),
    ),
    Gate(
        "workflow-deployment-migration",
        ("bash", "scripts/tests/workflow-deployment-migration.test.sh"),
    ),
    Gate(
        "cooperative-cutover-monitor",
        ("bash", "scripts/tests/cooperative-cutover-monitor.test.sh"),
    ),
    Gate("agents-structural", ("bash", "scripts/tests/agents-structural.test.sh")),
    Gate(
        "deploy-agent-clone-recovery",
        ("bash", "scripts/tests/deploy-agent-clone-recovery.test.sh"),
    ),
    Gate(
        "agent-surface-hash",
        ("bash", "scripts/tests/agent-surface-hash.test.sh"),
    ),
    Gate("factory-review", ("python3", "scripts/tests/factory-review.test.py")),
    Gate("biz-review", ("python3", "scripts/biz_review.py", "self-test")),
    Gate(
        "cloudbench-rejected-start-recovery",
        ("python3", "scripts/tests/cloudbench-rejected-start-recovery.test.py"),
    ),
    Gate(
        "cloudbench-prestack-recovery",
        ("python3", "scripts/tests/cloudbench-prestack-recovery.test.py"),
    ),
    Gate(
        "cloudbench-explicit-idle-admission",
        ("python3", "scripts/tests/cloudbench-explicit-idle-admission.test.py"),
    ),
    Gate(
        "cloudbench-fixed-native-worker",
        ("python3", "scripts/tests/cloudbench-fixed-native-worker.test.py"),
    ),
    Gate(
        "cloudbench-protected-resources",
        ("python3", "scripts/tests/cloudbench-protected-resources.test.py"),
    ),
    Gate(
        "cloudbench-pool-run-token",
        ("python3", "scripts/tests/cloudbench-pool-run-token.test.py"),
    ),
    Gate(
        "cloudbench-live-primary-return",
        ("python3", "scripts/tests/cloudbench-live-primary-return.test.py"),
    ),
    Gate(
        "cloudbench-primary-exact-shape-reuse",
        ("python3", "scripts/tests/cloudbench-primary-exact-shape-reuse.test.py"),
    ),
    Gate(
        "cloudbench-maintenance-env",
        ("python3", "scripts/tests/cloudbench-maintenance-env.test.py"),
    ),
    Gate("cloudbench-staged-boot", ("python3", "scripts/tests/cloudbench-staged-boot.test.py")),
    Gate(
        "cloudbench-bootstrap-recovery",
        ("python3", "scripts/tests/cloudbench-bootstrap-recovery.test.py"),
    ),
    Gate(
        "cloudbench-static-service-observation",
        ("python3", "scripts/tests/cloudbench-static-service-observation.test.py"),
    ),
    Gate(
        "wait-for-code-review",
        ("python3", "scripts/tests/wait-for-code-review.test.py"),
    ),
    Gate(
        "deploy-review-cycle", ("python3", "scripts/tests/deploy-review-cycle.test.py")
    ),
    Gate("deploy-stage", ("bash", "scripts/tests/run-deploy-stage.test.sh")),
    Gate(
        "deploy-structural-runner",
        ("python3", "scripts/tests/run-deploy-structural-gates.test.py"),
    ),
    Gate("deploy-live-probes", ("python3", "scripts/tests/deploy-live-probes.test.py")),
    Gate("run-process-cleanup", ("bash", "scripts/tests/run-process-cleanup.test.sh")),
    Gate(
        "run-isolated-cloud-kill",
        ("bash", "scripts/tests/run-isolated-cloud-kill.test.sh"),
    ),
    Gate("run-seed-exit-code", ("bash", "scripts/tests/run-seed-exit-code.test.sh")),
    Gate(
        "run-public-tunnel-routing",
        ("bash", "scripts/tests/run-public-tunnel-routing.test.sh"),
    ),
    Gate(
        "setup-db-concurrency",
        ("bash", "scripts/tests/setup-db-concurrency.test.sh"),
    ),
    # Pins run.sh's per-workspace port/bundle isolation and its Docker-vs-system
    # Postgres selection. It was never wired into any suite, so a regression in
    # the Docker probe (which silently downgrades an isolated benchmark stack to
    # the shared system Postgres) could not be caught by any gate.
    Gate(
        "run-port-collision",
        ("bash", "scripts/tests/run-port-collision.test.sh"),
    ),
    Gate(
        "run-cloud-benchmark-workers",
        ("bash", "scripts/tests/run-cloud-benchmark-workers.test.sh"),
    ),
    Gate(
        "blackbox-archive-env",
        ("bash", "scripts/tests/blackbox-archive-env.test.sh"),
    ),
    # Agents blackbox files are not auto-discovered: an unregistered test_* never
    # runs while its domain still reports green, and no other /deploy lane runs
    # the agents structural suites.
    Gate(
        "agents-blackbox-registration",
        ("python3", "agents/tests/structural/structural_test_registration.py"),
    ),
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--max-workers", type=int)
    return parser


def _terminate(running: Sequence[RunningGate], signum: int) -> None:
    for item in running:
        if item.process.poll() is not None:
            continue
        try:
            os.killpg(item.process.pid, signum)
        except ProcessLookupError:
            pass


def _stop_running(running: Sequence[RunningGate]) -> None:
    _terminate(running, signal.SIGTERM)
    deadline = time.monotonic() + SIGNAL_GRACE_SECONDS
    while (
        any(item.process.poll() is None for item in running)
        and time.monotonic() < deadline
    ):
        time.sleep(0.02)
    _terminate(running, signal.SIGKILL)
    for item in running:
        item.process.wait()
        item.output.close()


def run_gates(gates: Sequence[Gate], max_workers: int) -> int:
    if max_workers < 1:
        raise ValueError("max_workers must be positive")

    pending = deque(gates)
    running: list[RunningGate] = []
    results: dict[str, tuple[int, float, str]] = {}
    received_signal = 0

    def forward(signum: int, _frame: object) -> None:
        nonlocal received_signal
        received_signal = received_signal or signum
        _terminate(running, signum)

    previous_handlers = {
        signum: signal.getsignal(signum)
        for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)
    }
    for signum in previous_handlers:
        signal.signal(signum, forward)

    try:
        with tempfile.TemporaryDirectory(prefix="deploy-structural-") as temporary:
            output_root = Path(temporary)
            while (running or pending) and not received_signal:
                while pending and len(running) < max_workers and not received_signal:
                    gate = pending.popleft()
                    output_path = output_root / f"{gate.name}.log"
                    output = output_path.open("wb")
                    process = subprocess.Popen(
                        gate.command,
                        cwd=ROOT,
                        env=gate_environment(),
                        stdout=output,
                        stderr=subprocess.STDOUT,
                        start_new_session=True,
                    )
                    running.append(
                        RunningGate(
                            gate=gate,
                            process=process,
                            output=output,
                            output_path=output_path,
                            started=time.monotonic(),
                        )
                    )

                completed = [
                    item for item in running if item.process.poll() is not None
                ]
                if not completed:
                    time.sleep(0.02)
                    continue
                for item in completed:
                    exit_code = item.process.wait()
                    duration = time.monotonic() - item.started
                    item.output.close()
                    rendered = item.output_path.read_text(errors="replace")
                    results[item.gate.name] = (exit_code, duration, rendered)
                    running.remove(item)

            if not received_signal:
                for gate in gates:
                    exit_code, duration, rendered = results[gate.name]
                    print(
                        f"\n== {gate.name}: exit={exit_code} duration={duration:.2f}s =="
                    )
                    if rendered:
                        print(rendered, end="" if rendered.endswith("\n") else "\n")
    finally:
        _stop_running(running)
        for signum, previous in previous_handlers.items():
            signal.signal(signum, previous)

    if received_signal:
        return 128 + received_signal
    failures = [name for name, (exit_code, _, _) in results.items() if exit_code != 0]
    if failures:
        print("failed deploy structural gates: " + ", ".join(failures), file=sys.stderr)
        return 1
    print(f"\nAll {len(gates)} deploy structural gates passed.")
    return 0


def main() -> int:
    args = _parser().parse_args()
    if args.list:
        for gate in GATES:
            print(gate.name)
        return 0
    missing = [tool for tool in REQUIRED_HOST_TOOLS if shutil.which(tool) is None]
    if missing:
        print(
            "deploy structural gates need host tools that are not installed: "
            + ", ".join(missing)
            + " (Linux: sudo apt-get install -y "
            + " ".join(missing)
            + ")",
            file=sys.stderr,
        )
        return 1
    if args.max_workers is None:
        return run_gates(GATES, max_workers=DEFAULT_MAX_WORKERS)
    return run_gates(GATES, max_workers=args.max_workers)


if __name__ == "__main__":
    raise SystemExit(main())
