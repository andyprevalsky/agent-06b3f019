#!/usr/bin/env python3
"""Run independent /deploy command-structural regression suites concurrently."""

from __future__ import annotations

import argparse
import os
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
    Gate("workspace-env", ("bash", "scripts/tests/workspace-env.test.sh")),
    Gate(
        "deploy-worktree-preflight",
        ("bash", "scripts/tests/deploy-worktree-preflight.test.sh"),
    ),
    Gate("seed-cache-decision", ("bash", "scripts/tests/seed-cache-decision.test.sh")),
    Gate("semantic-deploy", ("bash", "scripts/tests/semantic-deploy-gate.test.sh")),
    Gate(
        "agent-behavior-approval",
        ("bash", "scripts/tests/check-agent-behavior-approval.test.sh"),
    ),
    Gate("approval-format", ("bash", "scripts/tests/approval-format.test.sh")),
    Gate(
        "workflow-deployment-migration",
        ("bash", "scripts/tests/workflow-deployment-migration.test.sh"),
    ),
    Gate(
        "agent-surface-hash",
        ("bash", "scripts/tests/agent-surface-hash.test.sh"),
    ),
    Gate("factory-review", ("python3", "scripts/tests/factory-review.test.py")),
    Gate("wait-for-code-review", ("python3", "scripts/tests/wait-for-code-review.test.py")),
    Gate("deploy-review-cycle", ("python3", "scripts/tests/deploy-review-cycle.test.py")),
    Gate("deploy-stage", ("bash", "scripts/tests/run-deploy-stage.test.sh")),
    Gate(
        "deploy-structural-runner",
        ("python3", "scripts/tests/run-deploy-structural-gates.test.py"),
    ),
    Gate("deploy-live-probes", ("python3", "scripts/tests/deploy-live-probes.test.py")),
    Gate("run-process-cleanup", ("bash", "scripts/tests/run-process-cleanup.test.sh")),
    Gate("run-seed-exit-code", ("bash", "scripts/tests/run-seed-exit-code.test.sh")),
    Gate(
        "run-public-tunnel-routing",
        ("bash", "scripts/tests/run-public-tunnel-routing.test.sh"),
    ),
    Gate(
        "setup-db-concurrency",
        ("bash", "scripts/tests/setup-db-concurrency.test.sh"),
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

    previous_handlers = {signum: signal.getsignal(signum) for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)}
    for signum in previous_handlers:
        signal.signal(signum, forward)

    try:
        with tempfile.TemporaryDirectory(prefix="deploy-structural-") as temporary:
            output_root = Path(temporary)
            while running or (pending and not received_signal):
                while pending and len(running) < max_workers and not received_signal:
                    gate = pending.popleft()
                    output_path = output_root / f"{gate.name}.log"
                    output = output_path.open("wb")
                    process = subprocess.Popen(
                        gate.command,
                        cwd=ROOT,
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

                completed = [item for item in running if item.process.poll() is not None]
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
                    print(f"\n== {gate.name}: exit={exit_code} duration={duration:.2f}s ==")
                    if rendered:
                        print(rendered, end="" if rendered.endswith("\n") else "\n")
    finally:
        _terminate(running, signal.SIGTERM)
        for item in running:
            item.process.wait()
            item.output.close()
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
    if args.max_workers is None:
        return run_gates(GATES, max_workers=len(GATES))
    return run_gates(GATES, max_workers=args.max_workers)


if __name__ == "__main__":
    raise SystemExit(main())
