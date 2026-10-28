#!/usr/bin/env python3
"""Run independent /deploy command-structural regression suites concurrently."""

from __future__ import annotations

import argparse
import hashlib
import json
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


# A gate with no recorded cost is bounded by this wall-clock limit; one hung
# suite once held Static verify for 689 minutes. Gates with a recorded cost get
# TIMEOUT_FACTOR times that cost (never less than the default).
DEFAULT_GATE_TIMEOUT_SECONDS = 600.0
TIMEOUT_FACTOR = 3.0
TIMEOUT_EXIT_CODE = 124
SHARD_ENV = "DEPLOY_GATE_SHARD"
PASS_CACHE = ROOT / ".context" / "deploy-structural" / "passes.json"


@dataclass(frozen=True)
class Gate:
    name: str
    command: tuple[str, ...]
    # Observed full-suite seconds on the 8-worker deploy host (unsharded).
    # Orders the queue longest-first and derives the per-gate timeout.
    expected_seconds: float = 0.0
    # Split into this many processes; each gets DEPLOY_GATE_SHARD=i/N and the
    # suite selects every N-th test (scripts/tests/deploy_gate_shard.py).
    shards: int = 1


@dataclass(frozen=True)
class Job:
    gate: Gate
    shard: int  # 1-based; 0 means unsharded

    @property
    def label(self) -> str:
        if not self.shard:
            return self.gate.name
        return f"{self.gate.name}[{self.shard}/{self.gate.shards}]"

    @property
    def expected_seconds(self) -> float:
        return self.gate.expected_seconds / max(self.gate.shards, 1)

    @property
    def timeout_seconds(self) -> float:
        return max(DEFAULT_GATE_TIMEOUT_SECONDS, TIMEOUT_FACTOR * self.expected_seconds)

    def environment(self) -> dict[str, str]:
        env = gate_environment()
        if self.shard:
            env[SHARD_ENV] = f"{self.shard}/{self.gate.shards}"
        else:
            env.pop(SHARD_ENV, None)
        return env


@dataclass
class RunningGate:
    gate: Job
    process: subprocess.Popen[bytes]
    output: BinaryIO
    output_path: Path
    started: float
    timed_out: bool = False


def expand_jobs(gates: Sequence[Gate]) -> list[Job]:
    """Shard expansion, longest expected job first; ties keep registry order."""
    jobs = []
    for gate in gates:
        if gate.shards > 1:
            jobs.extend(Job(gate, shard) for shard in range(1, gate.shards + 1))
        else:
            jobs.append(Job(gate, 0))
    return sorted(jobs, key=lambda job: -job.expected_seconds)


def input_fingerprint() -> str | None:
    """Over-inclusive digest of everything a gate could read, or None if unknown.

    Covers the committed tree, every tracked/untracked non-ignored change in
    the worktree (content, not names), the ignored env files and dependency
    installs the suites use, the interpreters and host tools. Any change to
    any of these invalidates every cached pass.
    """
    digest = hashlib.sha256()

    def git(*args: str) -> bytes:
        return subprocess.run(
            ("git", "-C", str(ROOT), *args), check=True, capture_output=True, timeout=120
        ).stdout

    try:
        digest.update(git("rev-parse", "HEAD^{tree}"))
        status = git("status", "--porcelain=v1", "-z", "--untracked-files=all")
        digest.update(status)
        for entry in status.split(b"\0"):
            if len(entry) < 4:
                continue
            path = ROOT / os.fsdecode(entry[3:])
            if path.is_file():
                digest.update(entry[3:] + b"\0" + hashlib.sha256(path.read_bytes()).digest())
        for relative in (
            "agents/.env",
            "back-end/.env",
            "front-end/.env",
            "node_modules/.package-lock.json",
            "back-end/node_modules/.package-lock.json",
            "front-end/node_modules/.package-lock.json",
            "agents/venv/pyvenv.cfg",
        ):
            path = ROOT / relative
            digest.update(relative.encode() + b"\0")
            if path.exists():
                digest.update(os.path.realpath(path).encode())
                digest.update(hashlib.sha256(path.read_bytes()).digest())
        for directory in sorted((ROOT / "agents/venv/lib").glob("python*/site-packages")):
            names = sorted(entry.name for entry in os.scandir(directory))
            digest.update("\0".join(names).encode())
        search_path = gate_environment().get("PATH")
        for tool in ("python3", "node", "bash", "git", "lsof", "psql"):
            located = shutil.which(tool, path=search_path)
            digest.update(f"{tool}={located and os.path.realpath(located)}".encode())
        digest.update(sys.version.encode())
        digest.update(sys.platform.encode())
    except (OSError, subprocess.SubprocessError):
        return None
    return digest.hexdigest()


def _cache_key(job: Job, fingerprint: str) -> str:
    material = json.dumps([job.label, list(job.gate.command), fingerprint])
    return hashlib.sha256(material.encode()).hexdigest()


def _load_cache() -> dict[str, dict[str, object]]:
    try:
        loaded = json.loads(PASS_CACHE.read_text())
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _store_cache(entries: dict[str, dict[str, object]]) -> None:
    PASS_CACHE.parent.mkdir(parents=True, exist_ok=True)
    temporary = PASS_CACHE.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(entries, indent=1, sort_keys=True))
    os.replace(temporary, PASS_CACHE)


GATES = (
    Gate("swap-harness", ("python3", "scripts/tests/swap-harness.test.py")),
    Gate(
        "cloudbench-controller-linux",
        ("python3", "scripts/tests/cloudbench-controller-linux.test.py"),
    ),
    Gate("workspace-env", ("bash", "scripts/tests/workspace-env.test.sh")),
    Gate("temporal-namespace-isolation", ("python3", "scripts/tests/temporal-namespace-isolation.test.py")),
    Gate("kill-services", ("bash", "scripts/tests/kill-services.test.sh"), expected_seconds=55),
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
    Gate("descend-command", ("bash", "scripts/tests/descend-command.test.sh"), expected_seconds=118),
    Gate("benchmark-live-results", ("python3", "scripts/tests/benchmark-live-results.test.py"), expected_seconds=700, shards=6),
    Gate("jev-progress-core", ("python3", "scripts/tests/jev-progress-core.test.py")),
    Gate(
        "benchmark-history-latest-only",
        ("python3", "scripts/tests/benchmark-history-latest-only.test.py"),
    ),
    Gate(
        "cloudbench-full-selection",
        ("python3", "scripts/tests/cloudbench-full-selection.test.py"),
    ),
    Gate(
        "live-agent-display",
        ("python3", "-m", "unittest", "discover", "-s", "scripts/live_display", "-p", "test_*.py"),
    ),
    Gate("benchmark-scorecard", ("python3", "scripts/tests/cloudbench-scorecard.test.py")),
    Gate(
        "original600-portable-operator",
        ("python3", "scripts/tests/original600-portable-operator.test.py"), expected_seconds=134
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
        ("python3", "scripts/tests/cloudbench-forensic-quiesced.test.py"), expected_seconds=83
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
    Gate(
        "cloudbench-resume-controller-export",
        ("python3", "scripts/tests/cloudbench-resume-controller-export.test.py"),
    ),
    Gate(
        "cloudbench-controller-orphan-drain",
        ("python3", "scripts/tests/cloudbench-controller-orphan-drain.test.py"),
    ),
    Gate("cloudbench-staged-boot", ("python3", "scripts/tests/cloudbench-staged-boot.test.py")),
    Gate(
        "cloudbench-prelaunch-cancel",
        ("python3", "scripts/tests/cloudbench-prelaunch-cancel.test.py"),
    ),
    Gate(
        "cloudbench-controller-gate-flyctl-bounds",
        ("python3", "scripts/tests/cloudbench-controller-gate-flyctl-bounds.test.py"),
    ),
    Gate(
        "cloudbench-bootstrap-recovery",
        ("python3", "scripts/tests/cloudbench-bootstrap-recovery.test.py"), expected_seconds=440, shards=4
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
        "read-graphide-review",
        ("python3", "scripts/tests/read-graphide-review.test.py"),
    ),
    Gate(
        "deploy-review-cycle", ("python3", "scripts/tests/deploy-review-cycle.test.py")
    ),
    Gate("deploy-stage", ("bash", "scripts/tests/run-deploy-stage.test.sh")),
    Gate(
        "deploy-structural-runner",
        ("python3", "scripts/tests/run-deploy-structural-gates.test.py"), expected_seconds=117
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
        ("bash", "scripts/tests/run-public-tunnel-routing.test.sh"), expected_seconds=76
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
    # Render runs back-end/scripts/render-build.sh; it must build a clean checkout
    # from back-end/package-lock.json alone, never the unlocked root workspace.
    Gate(
        "render-backend-build",
        ("bash", "scripts/tests/render-backend-build.test.sh"), expected_seconds=107
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
    parser.add_argument(
        "--reuse-passes",
        action="store_true",
        help=(
            "skip jobs that passed before with byte-identical inputs "
            "(whole worktree, env files, dependencies, tools); a retry after "
            "a flaky failure reruns only the failed jobs"
        ),
    )
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


def _enforce_timeouts(running: Sequence[RunningGate]) -> None:
    now = time.monotonic()
    for item in running:
        if item.timed_out or item.process.poll() is not None:
            continue
        if now - item.started < item.gate.timeout_seconds:
            continue
        item.timed_out = True
        print(
            f"TIMEOUT: deploy structural gate {item.gate.label} exceeded "
            f"{item.gate.timeout_seconds:.0f}s; terminating its process group",
            file=sys.stderr,
            flush=True,
        )
        try:
            os.killpg(item.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            continue
        deadline = time.monotonic() + SIGNAL_GRACE_SECONDS
        while item.process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        try:
            os.killpg(item.process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def run_gates(gates: Sequence[Gate], max_workers: int, reuse_passes: bool = False) -> int:
    if max_workers < 1:
        raise ValueError("max_workers must be positive")

    jobs = expand_jobs(gates)
    fingerprint = input_fingerprint() if reuse_passes else None
    cache = _load_cache() if fingerprint else {}
    reused: dict[str, str] = {}
    if fingerprint:
        for job in jobs:
            entry = cache.get(_cache_key(job, fingerprint))
            if isinstance(entry, dict) and entry.get("exit") == 0:
                reused[job.label] = str(entry.get("recorded_at", "unknown"))
    elif reuse_passes:
        print(
            "deploy structural gates: inputs unknown; running every gate",
            file=sys.stderr,
        )
    pending = deque(job for job in jobs if job.label not in reused)
    running: list[RunningGate] = []
    results: dict[str, tuple[int, float, str]] = {}
    timed_out: set[str] = set()
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
                    job = pending.popleft()
                    output_path = output_root / (job.label.replace("/", "-of-") + ".log")
                    output = output_path.open("wb")
                    process = subprocess.Popen(
                        job.gate.command,
                        cwd=ROOT,
                        env=job.environment(),
                        stdout=output,
                        stderr=subprocess.STDOUT,
                        start_new_session=True,
                    )
                    running.append(
                        RunningGate(
                            gate=job,
                            process=process,
                            output=output,
                            output_path=output_path,
                            started=time.monotonic(),
                        )
                    )

                _enforce_timeouts(running)
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
                    if item.timed_out:
                        exit_code = TIMEOUT_EXIT_CODE
                        timed_out.add(item.gate.label)
                        rendered += (
                            f"\nTIMEOUT: {item.gate.label} killed after "
                            f"{item.gate.timeout_seconds:.0f}s\n"
                        )
                    results[item.gate.label] = (exit_code, duration, rendered)
                    running.remove(item)

            if not received_signal:
                for job in jobs:
                    if job.label in reused:
                        print(
                            f"\n== {job.label}: exit=0 REUSED pass recorded "
                            f"{reused[job.label]} for identical inputs =="
                        )
                        continue
                    exit_code, duration, rendered = results[job.label]
                    print(
                        f"\n== {job.label}: exit={exit_code} duration={duration:.2f}s =="
                    )
                    if rendered:
                        print(rendered, end="" if rendered.endswith("\n") else "\n")
                print("\nSlowest deploy structural gates:")
                for label, (_, duration, _) in sorted(
                    results.items(), key=lambda item: -item[1][1]
                )[:10]:
                    print(f"  {duration:8.2f}s  {label}")
    finally:
        _stop_running(running)
        for signum, previous in previous_handlers.items():
            signal.signal(signum, previous)

    if received_signal:
        return 128 + received_signal
    if fingerprint:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for job in jobs:
            outcome = results.get(job.label)
            if outcome is not None and outcome[0] == 0:
                cache[_cache_key(job, fingerprint)] = {
                    "exit": 0,
                    "gate": job.label,
                    "recorded_at": now,
                }
        try:
            _store_cache(cache)
        except OSError as error:
            print(f"deploy structural gates: pass cache not saved: {error}", file=sys.stderr)
    failures = [
        name + (" (timed out)" if name in timed_out else "")
        for name, (exit_code, _, _) in results.items()
        if exit_code != 0
    ]
    if failures:
        print("failed deploy structural gates: " + ", ".join(failures), file=sys.stderr)
        return 1
    print(
        f"\nAll {len(gates)} deploy structural gates passed"
        + (f" ({len(reused)} job(s) reused from identical inputs)." if reused else ".")
    )
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
    workers = DEFAULT_MAX_WORKERS if args.max_workers is None else args.max_workers
    if args.reuse_passes:
        return run_gates(GATES, max_workers=workers, reuse_passes=True)
    return run_gates(GATES, max_workers=workers)


if __name__ == "__main__":
    raise SystemExit(main())
