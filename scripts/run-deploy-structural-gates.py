#!/usr/bin/env python3
"""Run independent /deploy command-structural regression suites concurrently.

A failed job (one suite or shard) is rerun once on the same source, never a third time:

    job ─fail─> unittest output names every failure? ─yes─> rerun just those ids (no shard filter)
     │                                                └─no──> rerun the same job once
     │          rerun passes (ids: confirmed "Ran N" + OK) ─> FLAKY (gate passes, /RCA attribution
     │                                                         required: TEST_FLAKY line, FLAKY row)
     │          rerun fails ─> FAIL
     └─ timeout or a signal to the runner ─> no rerun

Quarantined tests (scripts/lib/test_quarantine.py) write rows to a per-attempt file that this
runner forwards for the counted attempt; their ids read <suite>::<test id>.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from collections import Counter, deque
from dataclasses import dataclass, replace
from pathlib import Path
from typing import BinaryIO, Mapping, Sequence


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


# Live per-suite rows for the gate's worker (scripts/deploy_gate_progress.py).
# Only this runner writes them: its suites run without the variable, so a suite
# that exercises this runner with failing fixture gates cannot report those
# fixtures as failures of the real gate.
PROGRESS_ENV = "DEPLOY_GATE_PROGRESS"


def _script_helper(name: str, directory: Path | None = None):
    path = str(directory or Path(__file__).resolve().parent)
    sys.path.insert(0, path)
    try:
        return __import__(name)
    finally:
        sys.path.remove(path)


def forward_quarantine(rows: Path, log: str) -> list[str]:
    """Forward a finished job's quarantined-test rows; return their TEST_QUARANTINE lines."""
    try:
        quarantine = _script_helper("test_quarantine", Path(__file__).resolve().parent / "lib")
        return [quarantine.progress.stdout_line(row) for row in quarantine.forward(rows, log=log)]
    except (ImportError, OSError, ValueError):
        return []


# unittest's failure headers and summary (3.11: "FAIL: name (module.Class.name)"; 3.10 omits
# the method from the parenthesis). Subtest suffixes make the count disagree: rerun the job.
UNITTEST_FAILURE = re.compile(r"^(?:FAIL|ERROR): (\S+) \(([^()\s]+)\)(.*)$", re.M)
UNITTEST_FAILED = re.compile(r"^FAILED \(([^)]*)\)\s*$", re.M)
UNITTEST_RAN = re.compile(r"^Ran (\d+) tests? in ", re.M)
UNITTEST_OK = re.compile(r"^OK(?: \(([^)]*)\))?\s*$", re.M)


def flaky_detail(labels: Sequence[str], first_outputs: Sequence[str]) -> str:
    """FLAKY progress detail: the last failed first attempt, ending with EVERY flaky shard's failure headers.

    The progress row keeps only the detail's tail (deploy_gate_progress.DETAIL_LIMIT); a long traceback
    would otherwise cut the "FAIL: name (module.Class.name)" lines that suite-level /RCA attribution
    matches against the quarantine marker (deploy_test_quarantine.failed_unittest_names), and a suite
    with several flaky shards must name all of their failures so each one needs attribution.
    """
    headers = [m.group(0) for output in first_outputs for m in UNITTEST_FAILURE.finditer(output)]
    tail = ("\nfailed unittest headers:\n" + "\n".join(headers)) if headers else ""
    return f"passed on rerun: {', '.join(labels)}\n" + (first_outputs[-1] if first_outputs else "") + tail


def failed_unittest_ids(command: Sequence[str], output: str) -> tuple[str, ...]:
    """The exact unittest ids to rerun, or () when the output does not name every failure.

    Only `python3 <suite>.py` commands, the run's last summary, and test methods of the suite's
    own __main__ module qualify; anything else (bash, nested fixture output, setUpClass errors,
    subtests, unexpected successes) reruns the whole job instead.
    """
    if len(command) != 2 or not Path(command[0]).name.startswith("python") or not command[1].endswith(".py"):
        return ()
    summaries = UNITTEST_FAILED.findall(output)
    if not summaries:
        return ()
    counts = {}
    for part in summaries[-1].split(","):
        key, _, value = part.strip().partition("=")
        if not value.isdigit():
            return ()
        counts[key] = int(value)
    if set(counts) - {"failures", "errors", "skipped", "expected failures"}:
        return ()
    expected = counts.get("failures", 0) + counts.get("errors", 0)
    ids = []
    for name, where, rest in UNITTEST_FAILURE.findall(output):
        if rest.strip() or not name.startswith("test"):
            return ()
        qualified = where if where.endswith(f".{name}") else f"{where}.{name}"
        module, _, test = qualified.partition(".")
        if module != "__main__" or test.count(".") != 1:
            return ()
        if test not in ids:
            ids.append(test)
    return tuple(ids) if expected and len(ids) == expected else ()


def rerun_confirms(ids: Sequence[str], output: str) -> bool:
    """An id rerun passes only when unittest ran exactly those tests, all OK, none skipped."""
    ran = UNITTEST_RAN.findall(output)
    ok = UNITTEST_OK.findall(output)
    return bool(ran) and int(ran[-1]) == len(ids) and bool(ok) and not ok[-1]


def report_progress(suite: str, status: str, *, detail: str = "", log: str = "") -> None:
    """Append one suite row to the worker's progress file, if it named one.

    Advisory: without the variable nothing is imported or written, and a
    missing helper or unwritable file never changes the result or output.
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
        deploy_gate_progress.report(suite, status, scope="suite", detail=detail, log=log,
                                    attempts=2 if status == "FLAKY" else None)
    except (ImportError, OSError, ValueError):
        return


SIGNAL_GRACE_SECONDS = 1.0
# Ceiling for the default worker count; sized for the 14-core deploy host.
DEFAULT_MAX_WORKERS = 8


def default_max_workers(cpu_count: int | None = None) -> int:
    """CPU-scaled default, capped at the existing 14-core worker budget.

    Eight concurrent suites on an 8-core/16 GB devbox (inside a /deploy
    pipeline that also ran coverage lanes) drove load1 to 39.8 and tripped
    10 s / 120 s subprocess timeouts that pass in isolation (2026-10-28).
    The pipeline supplies --max-workers explicitly after also considering
    whole-box memory, so its declared lane reservation matches the command.
    """
    cpus = cpu_count if cpu_count is not None else (os.cpu_count() or 1)
    return max(1, min(DEFAULT_MAX_WORKERS, DEFAULT_MAX_WORKERS * cpus // 14))
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
# Every gate child starts with this umask, not the invoker's. The deploy lane
# runs inside a transient systemd service (UMask 0022) while interactive devbox
# shells use 077; a fixture that only passed because 077 made its files private
# (cloudbench-controller-orphan-drain, 2026-10-28) must fail the same way
# everywhere. 022 is the conventional default (macOS, systemd) and the stricter
# check for fixtures that feed owner-only readers.
GATE_UMASK = 0o022
# The CLI records which gates failed so a retry can run them first. Every
# retry still runs the full registry; ordering never skips a gate.
FAILURE_STATE = Path(".context") / "deploy-structural" / "last-failures.json"
# Observed per-gate seconds from the previous run on this host (sum of its
# shard jobs). They replace the registry estimates for longest-first ordering,
# per-gate timeouts and timing-balanced splitting; the registry constants are
# the cold-start fallback. Planning never adds or drops a gate.
DURATIONS_STATE = Path(".context") / "deploy-structural" / "durations.json"
# Buildkite-style balancing: a gate whose recorded cost exceeds this fraction
# of the per-worker budget (total work / workers) is split into more shards
# when its suite supports DEPLOY_GATE_SHARD (registry ``shards > 1``).
SPLIT_FRACTION = 0.7
MAX_AUTO_SHARDS = 8


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
    # Jobs sharing a non-empty group never run at the same time. A suite that
    # parks a real non-dumpable same-user child (PR_SET_DUMPABLE=0: unreadable
    # cwd) as its fixture, or scans the whole /proc table and refuses on any
    # such process, must not overlap another suite doing either: the scan
    # cannot tell a sibling suite's fixture from a leaked process.
    exclusive: str = ""


@dataclass(frozen=True)
class Job:
    gate: Gate
    shard: int  # 1-based; 0 means unsharded
    # 2 for the one rerun of a failed job; `tests` narrows it to the failed unittest ids.
    attempt: int = 1
    tests: tuple[str, ...] = ()

    @property
    def label(self) -> str:
        if not self.shard:
            return self.gate.name
        return f"{self.gate.name}[{self.shard}/{self.gate.shards}]"

    @property
    def command(self) -> tuple[str, ...]:
        return self.gate.command + self.tests

    @property
    def log_name(self) -> str:
        return self.label.replace("/", "-of-") + (".rerun.log" if self.attempt > 1 else ".log")

    @property
    def expected_seconds(self) -> float:
        return self.gate.expected_seconds / max(self.gate.shards, 1)

    @property
    def timeout_seconds(self) -> float:
        return max(DEFAULT_GATE_TIMEOUT_SECONDS, TIMEOUT_FACTOR * self.expected_seconds)

    def environment(self) -> dict[str, str]:
        env = gate_environment()
        # An id rerun names its tests exactly; a shard filter could drop one of them.
        if self.shard and not self.tests:
            env[SHARD_ENV] = f"{self.shard}/{self.gate.shards}"
        else:
            env.pop(SHARD_ENV, None)
        env.pop(PROGRESS_ENV, None)
        return env


@dataclass
class RunningGate:
    gate: Job
    process: subprocess.Popen[bytes]
    output: BinaryIO
    output_path: Path
    started: float
    timed_out: bool = False
    quarantine_rows: Path | None = None


def next_launchable(pending: Sequence[Job], running: Sequence[RunningGate]) -> Job | None:
    """First pending job (queue order) whose exclusive group no running job holds."""
    held = {item.gate.gate.exclusive for item in running if item.gate.gate.exclusive}
    for job in pending:
        if not job.gate.exclusive or job.gate.exclusive not in held:
            return job
    return None


def expand_jobs(gates: Sequence[Gate], first: frozenset[str] = frozenset()) -> list[Job]:
    """Shard expansion: previously failed gates first, then longest expected
    job first; ties keep registry order."""
    jobs = []
    for gate in gates:
        if gate.shards > 1:
            jobs.extend(Job(gate, shard) for shard in range(1, gate.shards + 1))
        else:
            jobs.append(Job(gate, 0))
    return sorted(
        jobs, key=lambda job: (job.gate.name not in first, -job.expected_seconds)
    )


def load_previous_failures(path: Path) -> set[str]:
    try:
        recorded = json.loads(path.read_text())
    except (OSError, ValueError):
        return set()
    failed = recorded.get("failed") if isinstance(recorded, dict) else None
    return {name for name in failed if isinstance(name, str)} if isinstance(failed, list) else set()


def record_failures(path: Path, failed: Sequence[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(
            {
                "failed": sorted(failed),
                "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        )
    )
    os.replace(temporary, path)


def load_durations(path: Path) -> dict[str, float]:
    """Recorded whole-gate seconds (``{"gates": {name: {"seconds": s}}}``)."""
    try:
        recorded = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    gates = recorded.get("gates") if isinstance(recorded, dict) else None
    if not isinstance(gates, dict):
        return {}
    durations: dict[str, float] = {}
    for name, entry in gates.items():
        seconds = entry.get("seconds") if isinstance(entry, dict) else entry
        if isinstance(name, str) and isinstance(seconds, (int, float)) and seconds > 0:
            durations[name] = float(seconds)
    return durations


def record_durations(
    path: Path, jobs: Sequence[Job], results: Mapping[str, tuple[int, float, str]]
) -> dict[str, float]:
    """Persist this run's per-gate seconds; gates that did not finish keep their old value."""
    previous = load_durations(path)
    totals: dict[str, float] = {}
    for gate in {job.gate.name: job.gate for job in jobs}.values():
        labels = [job.label for job in jobs if job.gate is gate]
        if not all(label in results and results[label][0] == 0 for label in labels):
            # Stopped early, killed, failed or timed out: not a cost observation.
            # Recording a timeout would triple the next run's deadline for the
            # same hung gate (timeout = 3x expected) and a fast failure would
            # distort longest-first ordering; the previous value is kept.
            continue
        totals[gate.name] = round(sum(results[label][1] for label in labels), 2)
    merged = {**previous, **totals}
    payload = {
        "schema_version": 1,
        "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "gates": {
            name: {
                "seconds": seconds,
                "shards": next((max(job.gate.shards, 1) for job in jobs if job.gate.name == name), None),
            }
            for name, seconds in sorted(merged.items())
        },
        "jobs": {label: round(result[1], 2) for label, result in sorted(results.items())},
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n")
    os.replace(temporary, path)
    return merged


def plan_gates(
    gates: Sequence[Gate], recorded: Mapping[str, float], max_workers: int
) -> list[Gate]:
    """Timing-balanced plan: recorded costs replace estimates; long shardable
    gates split so no job exceeds SPLIT_FRACTION of the per-worker budget.

    Only gates the registry already shards (their suites honour
    DEPLOY_GATE_SHARD) and that have a recorded cost can split further; the
    registry count is the minimum and MAX_AUTO_SHARDS the ceiling. Registry
    estimates alone never reshape the plan. The gate set itself never changes.
    """
    if max_workers < 1:
        raise ValueError("max_workers must be positive")
    costed = [replace(gate, expected_seconds=recorded.get(gate.name, gate.expected_seconds)) for gate in gates]
    budget = sum(gate.expected_seconds for gate in costed) / max_workers
    threshold = SPLIT_FRACTION * budget
    planned = []
    for gate in costed:
        shards = gate.shards
        if gate.shards > 1 and gate.name in recorded and threshold > 0 and gate.expected_seconds > threshold:
            shards = min(MAX_AUTO_SHARDS, max(gate.shards, math.ceil(gate.expected_seconds / threshold)))
        planned.append(replace(gate, shards=shards))
    return planned


# Suites that create or scan unreadable same-user processes (see Gate.exclusive):
# deploy-test-cycle (local-cleanup quiet()), deploy-test-plan (namespace_quiet())
# and deploy-structural-runner (a foreign non-dumpable sibling fixture).
PROC_OBSERVATION = "proc-observation"

GATES = (
    Gate("deploy-test-cycle", ("python3", "scripts/tests/deploy-test-cycle.test.py"), exclusive=PROC_OBSERVATION),
    Gate("deploy-test-user-omission", ("python3", "scripts/tests/deploy-test-user-omission.test.py")),
    Gate("deploy-test-plan", ("python3", "scripts/tests/deploy-test-plan.test.py"), exclusive=PROC_OBSERVATION),
    Gate("deploy-test-worker", ("python3", "scripts/tests/deploy-test-worker.test.py")),
    Gate("deploy-test-semantic", ("python3", "scripts/tests/deploy-test-semantic.test.py")),
    Gate("deploy-test-static", ("python3", "scripts/tests/deploy-test-static.test.py")),
    Gate("deploy-cli", ("python3", "scripts/tests/deploy-cli.test.py")),
    Gate("deploy-gates", ("python3", "scripts/tests/deploy-gates.test.py")),
    Gate("deploy-test-github", ("python3", "scripts/tests/deploy-test-github.test.py")),
    Gate("deploy-cloud-smoke-speed", ("python3", "scripts/tests/deploy-cloud-smoke-speed.test.py")),
    Gate("deploy-gate-progress", ("python3", "scripts/tests/deploy-gate-progress.test.py")),
    Gate("deploy-test-quarantine", ("python3", "scripts/tests/deploy-test-quarantine.test.py")),
    Gate("cloudbench-private-source-snapshot-read", ("python3", "scripts/tests/cloudbench-private-source-snapshot-read.test.py")),
    # In-definition @quarantine marker (scripts/lib/test_quarantine.py): runs, never blocks.
    Gate("test-quarantine", ("python3", "scripts/tests/test-quarantine.test.py")),
    Gate("deploy-prod", ("python3", "scripts/tests/deploy-prod.test.py")),
    Gate("mac-app-release-drift", ("bash", "scripts/tests/mac-app-release-drift.test.sh")),
    Gate("swap-harness", ("python3", "scripts/tests/swap-harness.test.py")),
    Gate(
        "cloudbench-controller-linux",
        ("python3", "scripts/tests/cloudbench-controller-linux.test.py"),
    ),
    Gate("workspace-env", ("bash", "scripts/tests/workspace-env.test.sh")),
    Gate("rose-startup-script", ("bash", "scripts/tests/rose-startup-script.test.sh")),
    Gate("temporal-namespace-isolation", ("python3", "scripts/tests/temporal-namespace-isolation.test.py")),
    Gate("kill-services", ("bash", "scripts/tests/kill-services.test.sh"), expected_seconds=55),
    Gate("devbox-teardown", ("bash", "scripts/tests/devbox-teardown.test.sh"), expected_seconds=15),
    Gate(
        "deploy-worktree-preflight",
        ("bash", "scripts/tests/deploy-worktree-preflight.test.sh"),
    ),
    Gate("deploy-gate-release-tool", ("bash", "scripts/tests/deploy-gate-release-tool.test.sh")),
    Gate("seed-cache-decision", ("bash", "scripts/tests/seed-cache-decision.test.sh")),
    Gate("canonical-seed-migration-readiness", ("python3", "scripts/tests/migrate-canonical-seed.test.py")),
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
    Gate("select-affected-tests", ("python3", "scripts/tests/select-affected-tests.test.py")),
    Gate(
        "benchmark-history-latest-only",
        ("python3", "scripts/tests/benchmark-history-latest-only.test.py"),
    ),
    Gate(
        "benchmark-history-backfill",
        ("python3", "scripts/tests/benchmark-history-backfill.test.py"),
    ),
    Gate(
        "concurrent-pr-shared-paths",
        ("python3", "scripts/tests/concurrent-pr-shared-paths.test.py"),
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
    # Linux pidfd fixtures select a capable runtime or the offline controller image.
    Gate(
        "cloudbench-export-recovery",
        ("bash", "scripts/tests/cloudbench-export-recovery.test.sh"),
    ),
    Gate(
        "original600-portable-operator",
        ("python3", "scripts/tests/original600-portable-operator.test.py"), expected_seconds=134
    ),
    Gate(
        "benchmark-provider-capacity",
        ("python3", "scripts/tests/cloudbench-provider-capacity.test.py"),
    ),
    Gate("cloudbench-provider-contract", ("python3", "scripts/tests/cloudbench-provider-contract.test.py")),
    Gate("worker-pool-cutover", ("python3", "scripts/tests/worker-pool-cutover.test.py")),
    Gate("retained-agent-machine", ("python3", "scripts/tests/retained-agent-machine.test.py")),
    Gate("benchmark-campaign-grouping", ("bash", "scripts/tests/campaign-hub-grouping.test.sh")),
    Gate("cloudbench-fetch-ref", ("bash", "scripts/tests/cloudbench-fetch-ref.test.sh")),
    Gate("cloudbench-warm-pool", ("python3", "scripts/tests/cloudbench-warm-pool.test.py")),
    Gate(
        "cloudbench-cross-devbox-admission",
        ("python3", "scripts/tests/cloudbench-cross-devbox-admission.test.py"),
    ),
    Gate("cloudbench-warm-source", ("python3", "scripts/tests/cloudbench-warm-source.test.py")),
    Gate("cloudbench-prepare-source", ("python3", "scripts/tests/cloudbench-prepare-source.test.py")),
    Gate("cloudbench-prepare-source-create", ("python3", "scripts/tests/cloudbench-prepare-source-create.test.py")),
    Gate("cloudbench-source-version", ("python3", "scripts/tests/cloudbench-source-version.test.py")),
    Gate("cloudbench-original-image-failure", ("python3", "scripts/tests/cloudbench-original-image-failure.test.py")),
    Gate("cloudbench-source-lease", ("python3", "scripts/tests/cloudbench-source-lease.test.py")),
    Gate("cloudbench-source-lease-fleet", ("python3", "scripts/tests/cloudbench-source-lease-fleet.test.py")),
    Gate("cloudbench-source-lease-recovery", ("python3", "scripts/tests/cloudbench-source-lease-recovery.test.py")),
    Gate("cloudbench-source-guest-env", ("python3", "scripts/tests/cloudbench-source-guest-env.test.py")),
    Gate("cloudbench-source-env", ("python3", "scripts/tests/cloudbench-source-env.test.py")),
    Gate("cloudbench-source-env-handoff", ("python3", "scripts/tests/cloudbench-source-env-handoff.test.py")),
    Gate("cloudbench-kernel-custody", ("python3", "scripts/tests/cloudbench-kernel-custody.test.py")),
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
    Gate("cloudbench-lost-evidence-release", ("python3", "scripts/tests/cloudbench-lost-evidence-release.test.py")),
    Gate("seed-memory-ratchet", ("bash", "scripts/tests/seed-memory-ratchet.test.sh")),
    Gate("test-sleep-ratchet", ("python3", "scripts/tests/condition-waits.test.py")),
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
    Gate("factory-metadata", ("python3", "scripts/tests/factory-metadata.test.py")),
    Gate("predeploy-receipts", ("python3", "scripts/tests/predeploy-receipts.test.py")),
    Gate("final-review-script-regressions", ("python3", "scripts/tests/final-review-script-regressions.test.py")),
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
    Gate("cloudbench-cohort-reconcile", ("python3", "scripts/tests/cloudbench-cohort-reconcile.test.py")),
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
        "cloudbench-shard-coordinator",
        ("python3", "scripts/tests/cloudbench-shard-coordinator.test.py"),
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
        "cloudbench-shared-transport-integration",
        ("python3", "scripts/tests/cloudbench-shared-transport-integration.test.py"),
    ),
    Gate(
        "cloudbench-bootstrap-recovery",
        ("python3", "scripts/tests/cloudbench-bootstrap-recovery.test.py"), expected_seconds=200, shards=2
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
        "claude-review-fallback",
        ("bash", "scripts/tests/claude-review-fallback.test.sh"),
    ),
    Gate(
        "claude-review-fallback-diagnose",
        ("python3", "scripts/tests/claude-review-fallback-diagnose.test.py"),
    ),
    Gate(
        "read-graphide-review",
        ("python3", "scripts/tests/read-graphide-review.test.py"),
    ),
    Gate(
        "deploy-review-cycle", ("python3", "scripts/tests/deploy-review-cycle.test.py")
    ),
    Gate(
        "deploy-failure-policy", ("python3", "scripts/tests/deploy-failure-policy.test.py")
    ),
    Gate("deploy-stage", ("bash", "scripts/tests/run-deploy-stage.test.sh")),
    Gate("deploy-stage-wait", ("python3", "scripts/tests/deploy-stage-wait.test.py")),
    Gate(
        "deploy-approval-batch",
        ("python3", "scripts/tests/deploy-approval-batch.test.py"),
    ),
    Gate(
        "prebuild-agents-image",
        ("bash", "scripts/tests/prebuild-agents-image.test.sh"),
    ),
    Gate("deploy-pipeline", ("python3", "scripts/tests/run-deploy-pipeline.test.py")),
    Gate("deploy-semantic-stack", ("bash", "scripts/tests/run-deploy-semantic-stack.test.sh")),
    Gate("backend-coverage-sharded", ("bash", "scripts/tests/backend-coverage-sharded.test.sh")),
    Gate(
        "deploy-structural-runner",
        ("python3", "scripts/tests/run-deploy-structural-gates.test.py"), expected_seconds=117,
        exclusive=PROC_OBSERVATION,
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
    # Scripts rank GITHUB_TOKEN, GITHUB_TOKEN_2..9 and GITHUB_DISPATCH_TOKEN by
    # remaining quota; one shared user token was drained twice in an hour.
    Gate("github-token-pool", ("python3", "scripts/tests/github-token-pool.test.py")),
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--max-workers", type=int)
    parser.add_argument(
        "--no-failed-first",
        action="store_true",
        help="ignore the recorded failures of the previous run when ordering",
    )
    parser.add_argument(
        "--no-recorded-durations",
        action="store_true",
        help="plan from the registry estimates only (ignore .context/deploy-structural/durations.json)",
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


def run_gates(
    gates: Sequence[Gate],
    max_workers: int,
    failure_state: Path | None = None,
    durations_state: Path | None = None,
) -> int:
    if max_workers < 1:
        raise ValueError("max_workers must be positive")

    previously_failed = load_previous_failures(failure_state) if failure_state else set()
    previously_failed &= {gate.name for gate in gates}
    jobs = expand_jobs(gates, frozenset(previously_failed))
    if previously_failed:
        print(
            "deploy structural gates: running previously failed gate(s) first: "
            + ", ".join(sorted(previously_failed))
            + "; the full registry still runs unless one fails again",
            file=sys.stderr,
            flush=True,
        )
    pending = deque(jobs)
    began = time.monotonic()
    repeated_failure = ""
    running: list[RunningGate] = []
    results: dict[str, tuple[int, float, str]] = {}
    timed_out: set[str] = set()
    # Jobs still to finish per suite, and suites whose progress row is written:
    # a suite fails with its first failed shard and passes with its last shard.
    unfinished = Counter(job.gate.name for job in jobs)
    reported: set[str] = set()
    # First failed attempt of each rerun job (exit, duration, output), and jobs whose rerun passed.
    first_attempts: dict[str, tuple[int, float, str]] = {}
    first_quarantine_rows: dict[str, Path] = {}
    flaky: dict[str, str] = {}
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
            while (running or pending) and not received_signal and not repeated_failure:
                while (
                    pending
                    and len(running) < max_workers
                    and not received_signal
                    and not repeated_failure
                ):
                    job = next_launchable(pending, running)
                    if job is None:
                        break  # everything pending waits for a running exclusive job
                    pending.remove(job)
                    output_path = output_root / job.log_name
                    output = output_path.open("wb")
                    quarantine_rows = output_path.with_suffix(".quarantine.jsonl")
                    env = job.environment()
                    env["DEPLOY_GATE_QUARANTINE_PROGRESS"] = str(quarantine_rows)
                    env["DEPLOY_GATE_QUARANTINE_UNIT_PREFIX"] = job.gate.name
                    process = subprocess.Popen(
                        job.command,
                        cwd=ROOT,
                        env=env,
                        stdout=output,
                        stderr=subprocess.STDOUT,
                        start_new_session=True,
                        umask=GATE_UMASK,
                    )
                    running.append(
                        RunningGate(
                            gate=job,
                            process=process,
                            output=output,
                            output_path=output_path,
                            started=time.monotonic(),
                            quarantine_rows=quarantine_rows,
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
                    job = item.gate
                    if item.timed_out:
                        exit_code = TIMEOUT_EXIT_CODE
                        timed_out.add(job.label)
                        rendered += (
                            f"\nTIMEOUT: {job.label} killed after "
                            f"{job.timeout_seconds:.0f}s\n"
                        )
                    running.remove(item)
                    attempt_note = f" attempt={job.attempt}/2" if job.attempt > 1 else ""
                    print(
                        f"[+{time.monotonic() - began:7.1f}s] {job.label} "
                        f"exit={exit_code} duration={duration:.1f}s{attempt_note}",
                        file=sys.stderr,
                        flush=True,
                    )
                    if exit_code != 0 and job.attempt == 1 and not item.timed_out and not received_signal:
                        # Rerun once, at the head of the queue; this attempt is not the verdict.
                        tests = failed_unittest_ids(job.gate.command, rendered)
                        first_attempts[job.label] = (exit_code, duration, rendered)
                        if item.quarantine_rows is not None:
                            first_quarantine_rows[job.label] = item.quarantine_rows
                        pending.appendleft(replace(job, attempt=2, tests=tests))
                        print(
                            f"deploy structural gates: rerunning {job.label} once ("
                            + (f"{len(tests)} failed test(s): {' '.join(tests)}" if tests else "whole job")
                            + ")",
                            file=sys.stderr,
                            flush=True,
                        )
                        continue
                    if job.attempt > 1:
                        first_exit, first_duration, first_rendered = first_attempts[job.label]
                        if exit_code == 0 and job.tests and not rerun_confirms(job.tests, rendered):
                            exit_code = first_exit
                            rendered += (
                                f"\nRERUN UNCONFIRMED: expected unittest to run exactly "
                                f"{len(job.tests)} test(s) OK; keeping the first failure\n"
                            )
                        rendered = (
                            first_rendered
                            + f"\n--- rerun of {job.label} (attempt 2 of 2"
                            + (f": {' '.join(job.tests)}" if job.tests else "")
                            + ") ---\n"
                            + rendered
                        )
                        duration += first_duration
                        if exit_code == 0:
                            flaky[job.label] = first_rendered
                            print(f"TEST_FLAKY unit={job.gate.name} attempts=2 attribution=REQUIRED", flush=True)
                    results[job.label] = (exit_code, duration, rendered)
                    # Quarantined tests count from the counted attempt; an id rerun ran only the
                    # failed ids, so the first attempt's quarantined rows still count too.
                    counted = [item.quarantine_rows]
                    if job.tests and job.label in first_quarantine_rows:
                        counted.insert(0, first_quarantine_rows[job.label])
                    for rows_path in counted:
                        if rows_path is None:
                            continue
                        for line in forward_quarantine(rows_path, str(item.output_path)):
                            print(line, flush=True)
                    suite = job.gate.name
                    unfinished[suite] -= 1
                    if suite not in reported and (exit_code != 0 or not unfinished[suite]):
                        reported.add(suite)
                        suite_flaky = [label for label in flaky if label.split("[", 1)[0] == suite]
                        if exit_code != 0:
                            report_progress(suite, "FAIL", detail=rendered, log=str(item.output_path))
                        elif suite_flaky:
                            report_progress(
                                suite,
                                "FLAKY",
                                detail=flaky_detail(suite_flaky, [flaky[label] for label in suite_flaky]),
                                # The failed first attempt is the evidence /RCA attributes.
                                log=str(output_root / (suite_flaky[-1].replace("/", "-of-") + ".log")),
                            )
                        else:
                            report_progress(
                                suite, "PASS", log=str(item.output_path) if not job.shard else ""
                            )
                    if exit_code != 0 and suite in previously_failed:
                        repeated_failure = job.label

            if not received_signal:
                for job in jobs:
                    if job.label not in results:
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
    # Queue order, not completion order: a rerun must not reorder the summary.
    failures = [
        job.label + (" (timed out)" if job.label in timed_out else "")
        for job in jobs
        if results.get(job.label, (0,))[0] != 0
    ]
    failed_gates = {
        job.gate.name for job in jobs if results.get(job.label, (0,))[0] != 0
    }
    # A failed job whose rerun never finished (signal or early stop) stays failed.
    failed_gates |= {job.gate.name for job in jobs if job.label in first_attempts and job.label not in results}
    if repeated_failure:
        failed_gates |= previously_failed
        skipped = [job.label for job in jobs if job.label not in results]
        print(
            f"deploy structural gates: previously failed {repeated_failure} failed "
            f"again; stopped early, {len(skipped)} job(s) not run. "
            "Fix it and rerun; the gate passes only after a full sweep.",
            file=sys.stderr,
        )
    if failure_state is not None:
        try:
            record_failures(failure_state, sorted(failed_gates))
        except OSError as error:
            print(f"deploy structural gates: failure record not saved: {error}", file=sys.stderr)
    if flaky:
        print(
            f"deploy structural gates: {len(flaky)} job(s) failed and passed their one rerun "
            "(FLAKY; /RCA attribution required): " + ", ".join(sorted(flaky)),
            file=sys.stderr,
        )
    if durations_state is not None and not received_signal:
        try:
            # A rerun job's two attempts are not one cost observation.
            clean = {label: result for label, result in results.items() if label not in first_attempts}
            record_durations(durations_state, jobs, clean)
        except OSError as error:
            print(f"deploy structural gates: duration record not saved: {error}", file=sys.stderr)
    if failures or repeated_failure:
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
    state = None if args.no_failed_first else ROOT / FAILURE_STATE
    max_workers = default_max_workers() if args.max_workers is None else args.max_workers
    durations_state = ROOT / DURATIONS_STATE
    recorded = {} if args.no_recorded_durations else load_durations(durations_state)
    gates = plan_gates(GATES, recorded, max_workers)
    resharded = [
        f"{planned.name} {registered.shards}->{planned.shards}"
        for registered, planned in zip(GATES, gates)
        if planned.shards != registered.shards
    ]
    if recorded or resharded:
        print(
            f"deploy structural gates: {len(recorded)} recorded gate duration(s) from "
            f"{durations_state}; timing split: {', '.join(resharded) or 'none'}",
            file=sys.stderr,
            flush=True,
        )
    return run_gates(gates, max_workers=max_workers, failure_state=state, durations_state=durations_state)


if __name__ == "__main__":
    raise SystemExit(main())
