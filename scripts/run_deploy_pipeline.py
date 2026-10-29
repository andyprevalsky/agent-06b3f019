#!/usr/bin/env python3
"""Run /deploy Group 3 and Group 4 lanes concurrently on one frozen source.

Every lane still executes through ``scripts/run-deploy-stage`` so stage
records, logs, ``--reuse-passed`` receipts and factory timing stay unchanged.
This supervisor only schedules lanes and writes one atomic receipt:

* ``plan`` prints the standard Group 3/4 lanes with worker budgets scaled to
  the host (CPU count, MemTotal, MemAvailable and the watchdog cap); deploy.md values are
  the 14-core ceiling and never grow. Every lane declares ``memory_mb``.
* ``run``  starts every lane whose ``after`` dependencies have exited, with
  previously failed lanes (from the prior receipt in the same state dir)
  admitted first. At most ``--max-parallel`` lanes run at once (default from
  the host's cores and memory) and the declared ``memory_mb`` of the running
  lanes never exceeds the startup budget or current whole-box headroom below
  the watchdog cap, with a 2 GiB reserve. A lane that cannot fit alone is
  refused (``failed``, note ``refused: ...``) instead of being started into
  cgroup throttling or the memory watchdog. Lanes keep running after a
  sibling fails so one iteration collects every failure. When all lanes
  finish it re-hashes the source and marks the receipt ``stale`` if anything
  changed after the freeze, so an older snapshot can never be reported green.
* ``wait`` is the same event waiter as ``run-deploy-stage --wait``
  (``scripts/deploy_stage_wait.py``) over this pipeline's lanes: it watches
  the lanes' own stage receipts and adds only supervisor events (supervisor
  died, lane never started or refused, stale source). ``--since`` (epoch
  captured before launching ``run``) is required so a previous iteration's
  receipt can never satisfy the wait. Exit codes match that waiter:
  0 = all green, 1 = a lane failed, 2 = usage/receipt error, 3 = a lane
  runner or the supervisor died, 4 = stalled (``--stall-seconds``),
  124 = timeout, 5 = stale source.

Plan file (JSON): {"lanes": [{"name", "command": [...], "cwd": "back-end",
"env": {...}, "after": ["lane"], "reuse_passed": true, "group": "3",
"memory_mb": 1024}], "max_parallel": 4, "memory_budget_mb": 9000}
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import deploy_stage_wait  # scripts/ is sys.path[0]: one waiter for every /deploy gate

ROOT = Path(__file__).resolve().parents[1]
STAGE_WRAPPER = ROOT / "scripts" / "run-deploy-stage"
SOURCE_ROOT = ROOT
# boxes.dev's whole-machine memory watchdog records every TERM it sends here;
# a run copies the receipts inside its window so a killed lane is attributed.
WATCHDOG_LOG = Path(os.environ.get("DEPLOY_PIPELINE_WATCHDOG_LOG") or "/run/boxes-memory-terminations.jsonl")
HOST_SAMPLE_SECONDS = 1.0
RECEIPT_SCHEMA = 1
EXIT_STALE = 5
TERMINAL_LANE = {"passed", "failed"}
# run-deploy-stage rejects any other stage name before it writes a row.
LANE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")
# deploy.md's worker budgets were sized for this host; smaller hosts scale down.
CEILING_CPUS = 14
CEILING_MEM_MB = 32768
MIN_WORKERS = 1
STRUCTURAL_RUNNER_MAX_WORKERS = 8  # scripts/run-deploy-structural-gates.py DEFAULT_MAX_WORKERS
# 20261028-174430 stage receipt: largest structural child 1471.98 MiB.
# Round its 1.25x margin up, and reserve that footprint for every active suite.
STRUCTURAL_WORKER_MEMORY_MB = 1840
# Kept free for the agent harness, the Docker DB and the 15 GB memory watchdog.
MEMORY_RESERVE_MB = 2048
DEFAULT_LANE_MEMORY_MB = 1024


def host_resources(cpus: int | None = None, mem_available_mb: int | None = None,
                   mem_total_mb: int | None = None, watchdog_cap_mb: int | None = None) -> dict:
    """Whole-box resources; explicit memory values describe a different host."""
    explicit_memory = mem_available_mb is not None or mem_total_mb is not None
    if cpus is None:
        cpus = os.cpu_count() or 1
    memory = _memory_info()
    if mem_available_mb is None:
        mem_available_mb = memory.get("MemAvailable")
    if mem_total_mb is None:
        mem_total_mb = mem_available_mb if explicit_memory else memory.get("MemTotal")
    if watchdog_cap_mb is None and not explicit_memory:
        watchdog_cap_mb = _watchdog_cap_mb()
    # Without a watchdog receipt retain ten percent of physical memory below
    # the machine limit. The separate reserve protects unrelated processes.
    if watchdog_cap_mb is None and mem_total_mb is not None:
        watchdog_cap_mb = int(mem_total_mb * 0.9)
    return {"cpus": max(1, int(cpus)), "mem_available_mb": mem_available_mb,
            "mem_total_mb": mem_total_mb, "watchdog_cap_mb": watchdog_cap_mb}


def runtime_host_resources() -> dict:
    """A failed live probe is unknown headroom, never cached admission capacity."""
    try:
        return host_resources()
    except ValueError as error:
        print(f"PIPELINE_HOST_SAMPLE: unavailable: {error}", file=sys.stderr, flush=True)
        return {"error": str(error)}


def _memory_info() -> dict[str, int]:
    if sys.platform == "darwin":
        return _macos_memory_info()
    try:
        memory = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, _, value = line.partition(":")
            if key in {"MemAvailable", "MemTotal"}:
                memory[key] = int(value.split()[0]) // 1024
        return memory
    except (OSError, IndexError, ValueError):
        # Physical memory alone is not evidence of *available* memory.
        return {}


def _macos_memory_info() -> dict[str, int]:
    """Native live estimate: free + inactive + speculative pages.

    vm_stat subtracts speculative pages from its printed "Pages free", so
    these three counts are disjoint. Purgeable/file-backed counters overlap
    page queues and are not added; compressed/active/wired pages stay used.
    """
    try:
        def read(command: list[str]) -> str:
            return subprocess.check_output(command, text=True, stderr=subprocess.PIPE,
                                           env={**os.environ, "LC_ALL": "C"}, timeout=5)

        total = int(read(["/usr/sbin/sysctl", "-n", "hw.memsize"]).strip())
        stats = read(["/usr/bin/vm_stat"])
        page_match = re.search(r"page size of (\d+) bytes", stats)
        pages = dict(re.findall(r"^(Pages free|Pages inactive|Pages speculative):\s+(\d+)\.\s*$",
                                stats, re.MULTILINE))
        if page_match is None or len(pages) != 3:
            raise ValueError("vm_stat omitted page size or free/inactive/speculative counts")
        page_size = int(page_match.group(1))
        available = sum(int(count) for count in pages.values()) * page_size
        if total <= 0 or page_size <= 0 or not 0 <= available <= total:
            raise ValueError("invalid native memory counters")
        return {"MemTotal": total // (1024 * 1024), "MemAvailable": available // (1024 * 1024)}
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise ValueError("cannot sample macOS memory: verify `/usr/sbin/sysctl -n hw.memsize` "
                         "and `/usr/bin/vm_stat` succeed and report native page counts") from error


def _watchdog_cap_mb() -> int | None:
    try:
        for line in reversed(WATCHDOG_LOG.read_text().splitlines()):
            try:
                row = json.loads(line)
                value = int(row.get("workloadMaxBytes", 0))
                if value > 0:
                    return value // (1024 * 1024)
            except (ValueError, TypeError, AttributeError):
                continue
    except OSError:
        pass
    return None


def host_scale(host: dict) -> float:
    """1.0 at the 14-core/32 GB ceiling, proportionally less on smaller hosts."""
    scale = min(1.0, host["cpus"] / CEILING_CPUS)
    if host.get("mem_total_mb") is not None:
        scale = min(scale, host["mem_total_mb"] / CEILING_MEM_MB)
    budget = memory_budget_mb(host)
    if budget is not None:
        scale = min(scale, budget / (CEILING_MEM_MB * 0.75))
    return max(scale, 0.0)


def scale_workers(ceiling: int, host: dict) -> int:
    """Scale a deploy.md worker budget to the host; never above the ceiling."""
    if ceiling < 1:
        raise ValueError("worker budgets must be positive")
    return max(min(MIN_WORKERS, ceiling), int(ceiling * host_scale(host)))


def default_max_parallel(host: dict) -> int:
    """Bound concurrency by cores and usable memory, at most seven lanes."""
    cap = max(1, min(CEILING_CPUS // 2, host["cpus"] // 2))
    budget = memory_budget_mb(host)
    return min(cap, max(1, budget // DEFAULT_LANE_MEMORY_MB)) if budget is not None else 1


def structural_runner_workers(host: dict) -> int:
    """scripts/run-deploy-structural-gates.py's host default (same formula)."""
    return scale_workers(STRUCTURAL_RUNNER_MAX_WORKERS, host)


def memory_budget_mb(host: dict) -> int | None:
    """Whole-box budget: MemAvailable counts every process on the host
    (Postgres, Docker, other agents), not only this unit's cgroup."""
    if host.get("mem_available_mb") is None:
        return None
    headroom = int(host["mem_available_mb"])
    if host.get("mem_total_mb") is not None and host.get("watchdog_cap_mb") is not None:
        used = host["mem_total_mb"] - headroom
        headroom = min(headroom, host["watchdog_cap_mb"] - used)
    return max(0, headroom - MEMORY_RESERVE_MB)


def _load1() -> float | None:
    try:
        return float(Path("/proc/loadavg").read_text().split()[0])
    except (OSError, IndexError, ValueError):
        try:
            return os.getloadavg()[0]
        except (OSError, AttributeError):
            return None


def sample_host_peak(peak: dict, host: dict) -> dict:
    """Fold the current whole-box MemAvailable/load1 into the running extremes."""
    available = host.get("mem_available_mb")
    load1 = _load1()
    peak["samples"] = peak.get("samples", 0) + 1
    if available is not None:
        if peak.get("mem_available_min_mb") is None or available < peak["mem_available_min_mb"]:
            peak["mem_available_min_mb"] = available
            peak["mem_available_min_at"] = _now()
    if load1 is not None and (peak.get("load1_peak") is None or load1 > peak["load1_peak"]):
        peak["load1_peak"] = load1
    return peak


def _iso_epoch(value: object) -> float | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def watchdog_terminations(started_epoch: float, finished_epoch: float, log: Path = WATCHDOG_LOG) -> list[dict]:
    """Memory-watchdog TERM receipts whose ``at`` falls inside the run window."""
    try:
        lines = log.read_text().splitlines()
    except OSError:
        return []
    found = []
    for line in lines:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        at = _iso_epoch(row.get("at"))
        if at is not None and started_epoch <= at <= finished_epoch:
            found.append(row)
    return found


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def source_digest(root: Path | None = None) -> dict[str, str]:
    """HEAD plus every tracked/untracked non-ignored byte of the worktree."""
    root = SOURCE_ROOT if root is None else root

    def git(*arguments: str) -> bytes:
        return subprocess.run(
            ("git", *arguments), cwd=root, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=300,
        ).stdout

    digest = hashlib.sha256()
    head = git("rev-parse", "HEAD").strip()
    digest.update(head + b"\0")
    digest.update(git("diff", "--no-ext-diff", "--binary", "HEAD", "--", ".", ":(exclude)agents/benchmarks/history") + b"\0")
    untracked = git("ls-files", "--others", "--exclude-standard", "-z")
    for raw in sorted(path for path in untracked.split(b"\0") if path):
        if raw.startswith(b"agents/benchmarks/history/"):
            continue  # append-only ledger data written by the smoke lane
        path = root / os.fsdecode(raw)
        digest.update(raw + b"\0")
        try:
            digest.update(os.readlink(path).encode() if path.is_symlink() else path.read_bytes())
        except OSError as error:
            digest.update(f"unreadable:{type(error).__name__}".encode())
        digest.update(b"\0")
    return {"head": head.decode(), "digest": digest.hexdigest()}


@dataclass
class Lane:
    name: str
    command: list[str]
    cwd: str = "."
    env: dict[str, str] = field(default_factory=dict)
    after: list[str] = field(default_factory=list)
    reuse_passed: bool = True
    group: str = ""
    # Extra env applied only when this lane failed in the previous receipt
    # (e.g. the backend coverage lane's failed-first full sweep).
    retry_env: dict[str, str] = field(default_factory=dict)
    # Declared peak footprint; the supervisor admits lanes against the budget.
    memory_mb: int = DEFAULT_LANE_MEMORY_MB


def load_plan(path: Path) -> list[Lane]:
    return load_plan_payload(path)[0]


def load_plan_payload(path: Path) -> tuple[list[Lane], dict]:
    payload = json.loads(path.read_text())
    lanes = [Lane(**lane) for lane in payload["lanes"]]
    names = [lane.name for lane in lanes]
    if len(set(names)) != len(names):
        raise ValueError(f"duplicate lane names: {names}")
    for lane in lanes:
        if not LANE_NAME.match(lane.name):
            raise ValueError(f"invalid lane name {lane.name!r}: run-deploy-stage accepts [A-Za-z0-9._-]+")
        if not lane.command:
            raise ValueError(f"{lane.name}: empty command")
        if int(lane.memory_mb) < 0:
            raise ValueError(f"{lane.name}: memory_mb must be >= 0")
        for dependency in lane.after:
            if dependency not in names or dependency == lane.name:
                raise ValueError(f"{lane.name}: invalid dependency {dependency}")
    dependencies = {lane.name: lane.after for lane in lanes}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(name: str) -> None:
        if name in visiting:
            raise ValueError(f"cyclic lane dependency: {name}")
        if name in visited:
            return
        visiting.add(name)
        for dependency in dependencies[name]:
            visit(dependency)
        visiting.remove(name)
        visited.add(name)

    for name in names:
        visit(name)
    return lanes, payload


def failed_first(lanes: list[Lane], previous: dict | None) -> list[Lane]:
    """Stable order with the prior receipt's failed lanes admitted first."""

    failed = set()
    if previous:
        failed = {name for name, lane in previous.get("lanes", {}).items() if lane.get("status") == "failed"}
    return sorted(lanes, key=lambda lane: 0 if lane.name in failed else 1)


def write_receipt(path: Path, receipt: dict) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def overall(lanes: dict[str, dict]) -> str:
    statuses = [lane["status"] for lane in lanes.values()]
    if any(status == "failed" for status in statuses):
        return "failed" if all(s in TERMINAL_LANE for s in statuses) else "failing"
    if all(status == "passed" for status in statuses):
        return "passed"
    return "running"


def run(
    plan: Path,
    state_dir: Path,
    max_parallel: int | None = None,
    budget_mb: int | None = None,
) -> int:
    lanes, payload = load_plan_payload(plan)
    host = host_resources()
    live_budget = memory_budget_mb(host)
    if live_budget is None:
        raise ValueError("cannot establish whole-box memory headroom")
    if max_parallel is None:
        max_parallel = int(payload.get("max_parallel") or default_max_parallel(host))
    if max_parallel < 0 or (budget_mb is not None and budget_mb < 0):
        raise ValueError("resource limits must be nonnegative")
    if budget_mb is None:
        planned_budget = payload.get("memory_budget_mb")
        budget_mb = min(live_budget, planned_budget) if planned_budget is not None else live_budget
    budget_mb = min(budget_mb, live_budget)
    state_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = state_dir / "receipt.json"
    previous = None
    if receipt_path.exists():
        try:
            previous = json.loads(receipt_path.read_text())
        except json.JSONDecodeError:
            previous = None
        if previous:
            history = state_dir / "history.jsonl"
            with history.open("a") as handle:
                handle.write(json.dumps(previous, sort_keys=True) + "\n")
    order = failed_first(lanes, previous)
    previously_failed = {
        name for name, lane in (previous or {}).get("lanes", {}).items() if lane.get("status") == "failed"
    }
    frozen = source_digest()
    receipt: dict = {
        "schema_version": RECEIPT_SCHEMA,
        "plan": str(plan),
        "supervisor_pid": os.getpid(),
        "started_at": _now(),
        "started_epoch": time.time(),
        "source": frozen,
        "order": [lane.name for lane in order],
        "lanes": {
            lane.name: {"status": "pending", "group": lane.group, "memory_mb": lane.memory_mb} for lane in order
        },
        "status": "running",
        "stage_run_dir": _stage_run_dir(),
        "source_root": str(SOURCE_ROOT),
        "host": host,
        "host_peak": sample_host_peak({}, host),
        "host_samples": [{"at": _now(), **host, "headroom_mb": live_budget}],
        "max_parallel": max_parallel,
        "memory_budget_mb": budget_mb,
    }
    write_receipt(receipt_path, receipt)
    log_dir = state_dir / "logs"
    log_dir.mkdir(exist_ok=True)

    processes: dict[str, subprocess.Popen[bytes]] = {}
    stopping = 0

    def terminate(signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = signum
        for process in processes.values():
            if process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass

    for forwarded in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(forwarded, terminate)

    by_name = {lane.name: lane for lane in lanes}
    pending = list(order)
    last_sample = time.monotonic()
    while True:
        if time.monotonic() - last_sample >= HOST_SAMPLE_SECONDS:
            sample = runtime_host_resources()
            sample_host_peak(receipt["host_peak"], sample)
            receipt["host_samples"].append({"at": _now(), **sample,
                                            "headroom_mb": memory_budget_mb(sample)})
            last_sample = time.monotonic()
        # Reap exits before admitting successors, so a lane's finished_epoch
        # always precedes the started_epoch of a lane admitted into its share.
        changed = False
        for name, process in processes.items():
            lane_state = receipt["lanes"][name]
            if lane_state["status"] != "running":
                continue
            # wait4 returns this child's getrusage statistics, unlike the
            # process-wide RUSAGE_CHILDREN maximum shared by concurrent lanes.
            pid, status, usage = os.wait4(process.pid, os.WNOHANG)
            if pid:
                process.returncode = os.waitstatus_to_exitcode(status)
                lane_state.update(
                    status="passed" if process.returncode == 0 else "failed",
                    exit=process.returncode,
                    finished_epoch=time.time(),
                    wall_s=round(time.time() - lane_state["started_epoch"], 1),
                    peak_rss_mb=round(usage.ru_maxrss / (1024 * 1024 if sys.platform == "darwin" else 1024), 3),
                    rusage_source="wait4",
                )
                changed = True
        if changed:
            receipt["status"] = overall(receipt["lanes"])
            write_receipt(receipt_path, receipt)
        if not stopping:
            running = sum(1 for p in processes.values() if p.returncode is None)
            reserved = sum(
                by_name[name].memory_mb for name, p in processes.items() if p.returncode is None
            )
            pass_sample = None
            for lane in list(pending):
                if max_parallel and running >= max_parallel:
                    break
                if any(receipt["lanes"][d]["status"] not in TERMINAL_LANE for d in lane.after):
                    continue
                if budget_mb is not None:
                    if lane.memory_mb > budget_mb:
                        # It can never fit: fail loudly now instead of starting it
                        # into cgroup throttling or the host memory watchdog.
                        pending.remove(lane)
                        receipt["lanes"][lane.name].update(
                            status="failed",
                            exit=None,
                            finished_epoch=time.time(),
                            note=f"refused: needs {lane.memory_mb} MB, memory budget {budget_mb} MB",
                        )
                        continue
                    if reserved + lane.memory_mb > budget_mb:
                        continue  # admitted when running lanes release their share
                if pass_sample is None:
                    pass_sample = runtime_host_resources()
                    sample_host_peak(receipt["host_peak"], pass_sample)
                sample = pass_sample
                headroom = memory_budget_mb(sample)
                if headroom is None or reserved + lane.memory_mb > headroom:
                    if headroom is None and receipt["host_samples"][-1].get("error") != sample.get("error"):
                        receipt["host_samples"].append({"at": _now(), **sample, "headroom_mb": headroom})
                    if running:
                        continue  # this run can still release reservations
                    receipt["host_samples"].append({"at": _now(), **sample, "headroom_mb": headroom})
                    pending.remove(lane)
                    receipt["lanes"][lane.name].update(
                        status="failed", exit=None, finished_epoch=time.time(),
                        note=f"refused: needs {lane.memory_mb} MB, live headroom {headroom} MB",
                    )
                    continue
                receipt["host_samples"].append({"at": _now(), **sample, "headroom_mb": headroom})
                pending.remove(lane)
                argv = ["bash", str(STAGE_WRAPPER), lane.name]
                if lane.reuse_passed:
                    argv.append("--reuse-passed")
                argv += ["--", *lane.command]
                log_path = log_dir / f"{lane.name}.log"
                try:
                    with log_path.open("ab") as log_handle:
                        processes[lane.name] = subprocess.Popen(
                            argv,
                            cwd=ROOT / lane.cwd,
                            env={
                                **os.environ,
                                **lane.env,
                                **(lane.retry_env if lane.name in previously_failed else {}),
                            },
                            stdout=log_handle,
                            stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL,
                            start_new_session=True,
                        )
                except OSError as error:
                    # No stage row will ever exist for this lane; the receipt
                    # is its only record (wait reports it from here).
                    receipt["lanes"][lane.name].update(
                        status="failed",
                        exit=None,
                        finished_epoch=time.time(),
                        log=str(log_path),
                        note=f"spawn failed: {error}",
                    )
                    continue
                pass_sample = None  # a successful spawn changes live headroom
                receipt["lanes"][lane.name].update(
                    status="running", started_epoch=time.time(), log=str(log_path)
                )
                running += 1
                reserved += lane.memory_mb
            write_receipt(receipt_path, receipt)
        elif pending:
            for lane in pending:
                receipt["lanes"][lane.name].update(status="failed", exit=128 + stopping, note="not started")
            pending = []
        if not pending and all(state["status"] in TERMINAL_LANE for state in receipt["lanes"].values()):
            break
        time.sleep(0.2)

    receipt["finished_at"] = _now()
    receipt["wall_s"] = round(time.time() - receipt["started_epoch"], 1)
    sample = runtime_host_resources()
    sample_host_peak(receipt["host_peak"], sample)
    receipt["host_samples"].append({"at": _now(), **sample, "headroom_mb": memory_budget_mb(sample)})
    receipt["finished_epoch"] = time.time()
    receipt["watchdog_terminations"] = watchdog_terminations(receipt["started_epoch"], receipt["finished_epoch"])
    if receipt["watchdog_terminations"]:
        print(
            f"PIPELINE_WATCHDOG: {len(receipt['watchdog_terminations'])} memory-watchdog TERM(s) during this run: "
            + ", ".join(f"{r.get('comm')} pid={r.get('pid')} at={r.get('at')}" for r in receipt["watchdog_terminations"]),
            file=sys.stderr,
        )
    final_source = source_digest()
    receipt["final_source"] = final_source
    receipt["status"] = overall(receipt["lanes"])
    if final_source != frozen:
        receipt["status"] = "stale"
    write_receipt(receipt_path, receipt)
    return {"passed": 0, "failed": 1, "stale": EXIT_STALE}.get(receipt["status"], 1)


def _stage_run_dir() -> str | None:
    """The run-deploy-stage timing run every lane records into."""
    run_root = Path(os.environ.get("DEPLOY_RUN_ROOT") or ROOT / ".context" / "deploy-runs")
    try:
        run_id = (run_root / "current").read_text().splitlines()[0].strip()
    except (OSError, IndexError):
        return None
    return str(run_root / run_id) if run_id else None


def _read_receipt(path: Path) -> dict | None:
    try:
        receipt = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return receipt if isinstance(receipt, dict) else None


def _supervisor_alive(receipt: dict) -> bool:
    pid = receipt.get("supervisor_pid")
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _supervisor_event(receipt: dict) -> tuple[int, dict] | None:
    """Events only the supervisor knows; lane events come from stage receipts."""
    if receipt.get("status") == "stale":
        return EXIT_STALE, {"event": "stale"}
    unstarted = [
        name
        for name, lane in receipt["lanes"].items()
        if lane.get("status") == "failed" and lane.get("note") == "not started"
    ]
    if unstarted:
        return 1, {"event": "failed", "failed": unstarted}
    # A lane can fail before run-deploy-stage writes its row (refused by the
    # memory budget, spawn error, wrapper usage/admission error); the receipt
    # is then the only record, so the waiter must not hang on it.
    failed = sorted(name for name, lane in receipt["lanes"].items() if lane.get("status") == "failed")
    if failed:
        return 1, {"event": "failed", "failed": failed}
    if receipt.get("status") == "running" and not _supervisor_alive(receipt):
        return 3, {"event": "supervisor-died", "pid": receipt.get("supervisor_pid")}
    return None


def wait(state_dir: Path, timeout: float, stall_seconds: float = 0.0, since: float = 0.0) -> int:
    """One waiter for every /deploy gate: delegate lanes to deploy_stage_wait.

    ``since`` is the epoch captured before launching ``run``: a receipt
    started earlier belongs to a previous iteration and never satisfies the
    wait (it could report that older snapshot green while new lanes run).
    """
    receipt_path = state_dir / "receipt.json"
    limit = timeout if timeout else float("inf")
    started = time.monotonic()

    def fresh() -> dict | None:
        found = _read_receipt(receipt_path)
        if found is None or float(found.get("started_epoch") or 0) < since:
            return None  # absent, or the previous iteration's receipt
        return found

    receipt = fresh()
    while receipt is None:
        if time.monotonic() - started > min(limit, 30.0):
            print(f"PIPELINE_WAKE status=no-receipt exit=2 (no run started at or after since={since})")
            return 2
        time.sleep(0.2)
        receipt = fresh()
    if not receipt.get("stage_run_dir"):
        print("PIPELINE_WAKE status=no-stage-run exit=2 (start one with run-deploy-stage --start)")
        return 2
    lanes = list(receipt["lanes"])
    stage_run_dir = Path(receipt["stage_run_dir"])
    latest = {"receipt": receipt}

    def refresh() -> dict:
        latest["receipt"] = _read_receipt(receipt_path) or latest["receipt"]
        return latest["receipt"]

    code, payload = deploy_stage_wait.wait_for_stages(
        stage_run_dir,
        lanes,
        since=float(receipt["started_epoch"]),
        timeout=max(0.0, limit - (time.monotonic() - started)),
        stall_seconds=stall_seconds,
        extra_event=lambda: _supervisor_event(refresh()),
    )
    while code == 0:
        if time.monotonic() - started >= limit:
            code, payload = deploy_stage_wait.EXIT_TIMEOUT, {"event": "timeout"}
            break
        # Every lane passed; the supervisor still re-hashes the frozen source.
        current = refresh()
        status = current.get("status")
        if status in {"passed", "failed", "stale"}:
            code = {"passed": 0, "failed": 1, "stale": EXIT_STALE}[status]
            payload = {"event": status}
            break
        if not _supervisor_alive(current):
            code, payload = 3, {"event": "supervisor-died", "pid": current.get("supervisor_pid")}
            break
        time.sleep(0.2)
    final = latest["receipt"]
    rows = {
        row.get("stage"): row
        for row in deploy_stage_wait._rows(stage_run_dir)
        if row.get("stage") in lanes and float(row.get("started_epoch") or 0) >= final["started_epoch"]
    }
    failed = list(payload.get("failed", []))
    for name in failed:
        lane = final["lanes"].get(name, {})
        note = f" note={lane['note']!r}" if lane.get("note") else ""
        print(f"FAILED {name} exit={rows.get(name, {}).get('exit_code', lane.get('exit'))} log={lane.get('log')}{note}")
    running = sorted(set(lanes) - set(rows) - set(failed))
    print(
        f"PIPELINE_WAKE status={payload.get('event')} exit={code} head={final['source']['head']} "
        f"still_running={','.join(running) or '-'}"
    )
    payload["exit"] = code
    print(json.dumps(payload, sort_keys=True, default=str))
    return code


AGENTCARD_TASKS = (
    "agent-payment-test-shop",
    "agent-payment-setup-resume",
    "agent-payment-idempotent-abandonment",
    "agent-payment-abandonment",
)


def standard_plan(args: argparse.Namespace) -> dict:
    """Group 3 + Group 4 lanes exactly as deploy.md writes them, sized to the host.

    The worker flags carry deploy.md's values, which were tuned for the 14-core
    deploy host; they are a ceiling. Each lane declares ``memory_mb``, a
    whole-lane reservation grounded on the largest single-child peak RSS the
    stage runner recorded across every deploy run on the 2026-10-28 devbox
    (eslint 1928 MB, full-tree eslint-fix 2974, frontend vitest 1775, tsc
    1479, one structural suite 1472, AgentCard stack 1602, backend coverage
    shard 1021) with >= 1.25x margin plus a per-worker term for lanes that
    fork workers. The run that motivated this started twelve lanes with 28
    workers at once (unit MemoryPeak 12.9 GB, load1 39.8, MemAvailable 906
    MB, memory-watchdog TERMs) and tripped subprocess timeouts that
    pass in isolation.
    """

    host = host_resources(args.host_cpus, args.host_mem_mb, args.host_total_mem_mb, args.host_watchdog_mb)
    workers = {
        "backend_blackbox": scale_workers(min(4, args.backend_blackbox_workers), host),
        "backend_unit": scale_workers(min(6, args.backend_unit_workers), host),
        "frontend": scale_workers(min(4, args.frontend_workers), host),
        "agents": scale_workers(min(6, args.agents_workers), host),
        "structural": structural_runner_workers(host),
    }
    lanes: list[dict] = []

    def lane(name: str, command: list[str], cwd: str = ".", group: str = "3", *, memory_mb: int,
             **extra: object) -> None:
        lanes.append({"name": name, "command": command, "cwd": cwd, "group": group,
                      "memory_mb": int(memory_mb), **extra})

    if args.group in {"3", "all"}:
        lane("eslint", ["bash", "-c", "xargs node scripts/lint-affected.mjs < ../.context/deploy-lint-ts.txt"],
             "back-end", memory_mb=3072)
        lane("typescript", ["npx", "tsc", "--noEmit"], "back-end", memory_mb=2048)
        lane("backend-structural", ["npm", "run", "test:structural"], "back-end", memory_mb=512)
        lane("deploy-command-structural", ["python3", "scripts/run-deploy-structural-gates.py",
             "--max-workers", str(workers["structural"])],
             memory_mb=1024 + STRUCTURAL_WORKER_MEMORY_MB * workers["structural"])
        lane("seed-cache-decision", ["bash", "scripts/tests/seed-cache-decision.test.sh"], memory_mb=256)
        lane("canonical-seed-whatsapp-content", ["bash", "scripts/tests/canonical-seed-whatsapp-content.test.sh"],
             memory_mb=256)
        if args.backend:
            lane("backend-coverage-blackbox", ["npm", "run", "test:coverage:sharded"], "back-end", env={
                "BLACKBOX_TEST_CONCURRENCY": str(workers["backend_blackbox"]),
                "CONTRACT_TEST_CONCURRENCY": str(workers["backend_blackbox"]),
                "BACKEND_UNIT_CONCURRENCY": str(workers["backend_unit"]),
            }, retry_env={"BACKEND_COVERAGE_FAILED_FIRST": "1"},
                memory_mb=1536 + 512 * (workers["backend_blackbox"] + workers["backend_unit"]))
        if args.frontend:
            lane("frontend-coverage-blackbox",
                 ["npm", "run", "test:coverage", "--", f"--maxWorkers={workers['frontend']}"], "front-end",
                 memory_mb=2048 + 512 * workers["frontend"])
        if args.agents:
            lane("agents-coverage-blackbox", ["bash", "scripts/run-coverage.sh"], "agents",
                 env={"AGENTS_COVERAGE_CONCURRENCY": str(workers["agents"])},
                 memory_mb=768 + 384 * workers["agents"])
    if args.group in {"4", "all"}:
        if args.smoke == "cloud":
            lane("smoke", ["bash", "scripts/run-predeploy-cloud"], group="4", memory_mb=1024)
        elif args.smoke == "local":
            lane("smoke", ["bash", "scripts/run-predeploy-local"], group="4", memory_mb=4096)
        if args.agentcard:
            # Alongside smoke, never after it: its own isolated local stack.
            lane("agentcard-lifecycle",
                 ["bash", "scripts/run-bench", "--local", *AGENTCARD_TASKS, "--bootstrap",
                  "--max-concurrency", "1", "--no-dashboard"], group="4", env={
                     "BENCHMARK_SKIP_WMH_BUILD": "1",
                     "BENCHMARK_ATTEMPT_SUITE": "predeploy",
                     "BENCHMARK_COUNTS_FOR_DEPLOY_ELIGIBILITY": "0",
                     "BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL": "1",
                 }, reuse_passed=False, memory_mb=4096)
    for entry in lanes:
        if entry["group"] == "4":
            entry.setdefault("reuse_passed", False)
    return {
        "lanes": lanes,
        "host": host,
        "workers": workers,
        "max_parallel": default_max_parallel(host),
        "memory_budget_mb": memory_budget_mb(host),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="action", required=True)
    run_parser = sub.add_parser("run")
    run_parser.add_argument("--plan", type=Path, required=True)
    run_parser.add_argument("--state-dir", type=Path, required=True)
    run_parser.add_argument("--max-parallel", type=int, default=None,
                            help="concurrent lanes; default: host-scaled plan value (0 = memory-bounded only)")
    run_parser.add_argument("--memory-budget-mb", type=int, default=None,
                            help="tighten declared-memory budget; whole-box watchdog headroom always applies")
    wait_parser = sub.add_parser("wait")
    wait_parser.add_argument("--state-dir", type=Path, required=True)
    wait_parser.add_argument("--timeout", type=float, default=0)
    wait_parser.add_argument("--stall-seconds", type=float, default=0.0)
    wait_parser.add_argument("--since", type=float, required=True,
                             help="epoch captured before launching `run`; older receipts never satisfy the wait")
    plan_parser = sub.add_parser("plan", help="print the standard Group 3/4 plan JSON")
    plan_parser.add_argument("--group", choices=("3", "4", "all"), default="all")
    plan_parser.add_argument("--backend", action="store_true")
    plan_parser.add_argument("--frontend", action="store_true")
    plan_parser.add_argument("--agents", action="store_true")
    plan_parser.add_argument("--smoke", choices=("cloud", "local", "skip"), default="cloud")
    plan_parser.add_argument("--agentcard", action="store_true")
    plan_parser.add_argument("--backend-blackbox-workers", type=int, default=4)
    plan_parser.add_argument("--backend-unit-workers", type=int, default=6)
    plan_parser.add_argument("--frontend-workers", type=int, default=4)
    plan_parser.add_argument("--agents-workers", type=int, default=6)
    plan_parser.add_argument("--host-cpus", type=int, default=None, help="plan for this many cores (default: this host)")
    plan_parser.add_argument("--host-mem-mb", type=int, default=None,
                             help="plan for this MemAvailable in MB (default: this host)")
    plan_parser.add_argument("--host-total-mem-mb", type=int, default=None,
                             help="plan for this MemTotal in MB (default: this host)")
    plan_parser.add_argument("--host-watchdog-mb", type=int, default=None,
                             help="plan for this watchdog cap in MB (default: recorded cap or 90%% of MemTotal)")
    args = parser.parse_args(argv)
    if args.action == "plan":
        print(json.dumps(standard_plan(args), indent=2))
        return 0
    if args.action == "run":
        try:
            return run(args.plan, args.state_dir, args.max_parallel, args.memory_budget_mb)
        except ValueError as error:
            print(f"invalid plan {args.plan}: {error}", file=sys.stderr)
            return 2
    return wait(args.state_dir, args.timeout, args.stall_seconds, args.since)


if __name__ == "__main__":
    sys.exit(main())
