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
  the host's cores and memory); the declared ``memory_mb`` of the running
  lanes plus the candidate never exceeds the startup budget, and against the
  current whole-box headroom below the watchdog cap (2 GiB reserve) a phased
  lane is charged only the running lanes' still-unmaterialized declarations
  (see *Admission accounting* below). A lane that cannot fit alone is
  refused (``failed``, note ``refused: ...``) instead of being started into
  cgroup throttling or the memory watchdog. Lanes keep running after a
  sibling fails so one iteration collects every failure. When all lanes
  finish it re-hashes the source and marks the receipt ``stale`` if anything
  changed after the freeze, so an older snapshot can never be reported green.

Admission accounting (follow-up ah, measured on #1640, 2026-10-30). Two
checks admit a pending lane. The startup budget (``memory_budget_mb``, the
smaller of the plan's and the headroom at attempt start) caps the declared
total of the running lanes plus the candidate; it is a static ceiling and
never double-counts. The live check samples the host again and requires the
candidate to fit ``memory_budget_mb`` of that sample (MemAvailable and the
watchdog cap, less the 2 GiB reserve). That headroom already contains what
the running lanes use, so charging their whole declarations against it again
double-counted them: on #1640 attempt 1 the two coverage lanes (2560 + 1152 MB
declared) had taken MemAvailable to ~8300 MB (headroom ~4700 MB) and the 4096
MB smoke lane waited 16 min (18:15:06 -> 18:31:08) for ``3712 + 4096 <= 4700``
although the box held ~11.2 GB below the watchdog cap; on #1639 the same three
lanes started together only because no co-tenant held memory at 15:06:22.
``run`` therefore samples every running lane's process tree at 1 Hz (PSS of
every descendant of its stage wrapper, ``tree_rss_mb`` / ``tree_peak_rss_mb``
on the lane; Linux /proc) and, for a phased lane (Group 3 or a declared
coverage-phase lane), reserves only ``sum(max(0, declared - observed))`` of
the running lanes: exactly the growth their declarations still allow. A lane
whose usage is unobserved (macOS, unreadable /proc, not yet sampled) keeps
its whole declaration, and the declarations themselves are unchanged. An
unphased lane (``semantic-stack``: its ``run.sh --benchmark`` startup runs
``kill-services.sh``, which terminates a running smoke stack) keeps the
declared-peak accounting, so this change cannot admit it beside a stack it
would kill. Every decision is kept on the lane for audit: ``admission``
(``admitted``/``refused`` with headroom, budget, declared and live
reservations, the running lanes with their observed usage, and the deferral
history) and ``waiting`` while deferred. The smoke lane stays at 4096 MB: the
only window in which it ran with idle siblings (#1639 attempt 1, 14:28-14:41Z,
backend/agents idle at 66/126 MB) measured a whole-box footprint of 3492 MB
median / 4905 MB peak, so it is not shown to be over-declared; right-size from
recorded ``tree_peak_rss_mb`` once passed runs carry it.

  With ``--follow-source`` the supervisor keeps hashing the source while lanes
  run. Once a change has settled (``--settle-seconds`` without further edits)
  it supersedes the attempt: running lanes are terminated, their results are
  discarded, and a new attempt starts on the new bytes with the superseded
  attempt's failed lanes first. Every attempt is bound to HEAD plus the source
  digest it ran on; ``verify`` refuses a receipt whose bytes are not the
  current worktree. Speculation never touches the bounded review ledger
  (``deploy_review_cycle.py``): it only starts gates earlier.

  ``--fix-loop-cap N`` (default 2, env ``DEPLOY_FIX_LOOP_CAP``) refuses a
  blind N+1th full round: after N completed failed rounds in this state dir
  the driver prints ``FIX_LOOP_CAP`` with the failure classes and exits 6.
  ``--after-rca REF`` records the RCA that justifies the next round and
  restarts the count.
* ``wait`` is the same event waiter as ``run-deploy-stage --wait``
  (``scripts/deploy_stage_wait.py``) over this pipeline's lanes: it watches
  the lanes' own stage receipts and adds only supervisor events (supervisor
  died, lane never started or refused, stale source, superseded attempt).
  ``--since`` (epoch captured before launching ``run``) is required so a
  previous iteration's receipt can never satisfy the wait. Exit codes match
  that waiter: 0 = all green, 1 = a lane failed, 2 = usage/receipt error, 3 = a lane
  runner or the supervisor died, 4 = stalled (``--stall-seconds``),
  124 = timeout, 5 = stale source, 6 = fix-loop cap.
* ``verify`` exits 0 only when the receipt passed on exactly the current
  HEAD and worktree bytes (never merge a HEAD whose gates ran on other bytes).

* ``simulate`` projects the Group 3 union wall of the phased schedule against
  the legacy all-at-once admission from the same recorded lane durations,
  naming every lane whose isolated duration is unrecorded as UNMEASURED.

* ``production`` is the post-merge Fly lane (deploy.md Step 13/13ab): when the
  merge (``merged_sha^1..merged_sha``) touches agent runtime files per
  ``scripts/classify-agent-runtime-changes.sh`` or ``deploy-agents.yml``, it
  waits for the exact ``deploy-agents.yml`` run whose headSha is the merged SHA
  to complete (any conclusion), recovers the durable job id from its log, and
  requires the Step 13ab proof that the Fly lane is live: the durable job
  (``worker-deployment-queue.ts read``) is ``SUCCEEDED`` and bound to the
  merged SHA and ``<run_id>-<attempt>``, and
  ``monitor-cooperative-cutover.ts --verify`` passes. Only then does it run the
  dispatch command after ``--`` (the Step 13b production semantic dispatch).
  The run's GitHub conclusion is recorded but is not the authority: a run that
  concluded failure and was resumed through the queue CLI keeps that
  conclusion. ``production.json`` in the state dir records the decision, run
  id/attempt/job id, job stage and every GitHub wait; a still-running run, a
  job that is not SUCCEEDED, an identity mismatch or a failed monitor exits 1
  with the operator's next action (the exact resume command) and never
  dispatches (the #1639 chain dispatched while Fly was still cutting over and
  4/5 production semantic jobs failed, 2026-10-30).

Group 3 admission schedule (EXP-L). Lanes that ran concurrently on the
8-core/15 GB devbox thrashed each other (deploy-command-structural 1,555 s
beside the coverage lanes; frontend coverage 1,059 s beside them versus
260 s alone). ``run`` therefore phases Group 3 from recorded per-lane
durations (``.context/deploy-durations/pipeline-lanes.json``, written after
every attempt from the lanes' own wall clocks and seeded from the stage
receipts under ``.context/deploy-runs``): the quick lanes (recorded <= 90 s:
eslint, typescript, backend-structural, seed checks) start together, then
every ``exclusive`` lane (deploy-command-structural) runs alone at the full
host width the memory budget allows, then the coverage lanes start together
under the existing budgets, longest recorded first, so frontend and backend
overlap inside the agents window. Phases are implied ``after`` dependencies:
no lane is skipped, every lane remains a full sweep, failed lanes still run
first within their phase and Group 4 lanes are untouched unless they declare
``"phase": "coverage"``: such a lane joins the coverage phase (after the quick
and exclusive phases) instead of starting at attempt start. The 4096 MB local
smoke lane declares it, because admitted first it held the memory the
exclusive structural lane (6544 MB of a 7752 MB budget) needed and the
pipeline ran smoke alone for ~22 min on #1638 attempt 5 (11-24 min across
attempts, 2026-10-30); beside
backend-coverage-blackbox (2560 MB) it fits the budget. A plan with
``"schedule": {"policy": "legacy"}`` keeps the previous all-at-once admission.

The deploy.md ``semantic-stack`` lane (4096 MB; its own ``run.sh --benchmark``
stack, Playwright semantics, latency ratchet, E2B smoke) deliberately keeps its
``after`` edges on backend coverage and live-probes instead of joining the
coverage phase, and trails every stack-owning lane for an ownership reason,
not a memory one: its startup runs ``scripts/kill-services.sh``, which
terminates every runtime process owned by this worktree, including the
coverage shards' instrumented backends, the local smoke lane's per-run
benchmark stack and the AgentCard lifecycle lane's ``run-bench --local``
stack. The plan loader therefore appends implied ``after`` edges from each
``STACK_KILLER_LANES`` lane to every ``STACK_OWNER_LANES`` lane in the plan
(``implied_stack_dependencies``; the receipt's ``after`` map shows them and
declared edges are kept), so semantic-stack can never be admitted while smoke
or agentcard-lifecycle is running, whatever the memory accounting says (on
#1640 only 4096 + 4096 MB against an 8188 MB budget kept them apart).
Memory still rules out the overlap with the coverage lanes on this host:
measured on #1639 (8 cores / 16007 MB, watchdog cap 14471 MB), the coverage
phase's whole-box MemAvailable floor was 6485 MB (9522 MB used) and
semantic-stack alone took MemAvailable from 11392 to 6741 MB (~4650 MB
footprint; 1652.8 MB largest child RSS from the stage row), so overlapping
them would reach ~14172 MB used, inside the 2048 MB reserve below the cap, and
the declared reservations (7808 + 4096 MB) exceed the 8065 MB budget.
Overlapping it with the coverage lanes needs a smaller stack or a larger host,
not a schedule change.

Plan file (JSON): {"lanes": [{"name", "command": [...], "cwd": "back-end",
"env": {...}, "after": ["lane"], "reuse_passed": true, "group": "3",
"memory_mb": 1024, "exclusive": false, "phase": ""}], "max_parallel": 4,
"memory_budget_mb": 9000, "schedule": {"policy": "phased"}}
"""

from __future__ import annotations

import argparse
import hashlib
from collections.abc import Mapping
import json
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field, replace
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
RECEIPT_SCHEMA = 2
EXIT_STALE = 5
EXIT_FIX_LOOP_CAP = 6
DEFAULT_FIX_LOOP_CAP = 2
DEFAULT_SETTLE_SECONDS = 10.0
DEFAULT_POLL_SECONDS = 2.0
DEFAULT_MAX_ATTEMPTS = 20
TERMINAL_LANE = {"passed", "failed", "superseded"}
# Internal waiter event: the supervisor superseded the attempt being waited on.
_SUPERSEDED_EVENT = -1
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
# ── Group 3 admission schedule (EXP-L) ────────────────────────────────────────
# Recorded per-lane wall clocks, per worktree (next to the backend blackbox
# domain ledger the sharded coverage coordinator keeps).
LANE_DURATIONS = Path(".context") / "deploy-durations" / "pipeline-lanes.json"
LANE_DURATION_SAMPLES = 20
# A lane whose recorded duration is at most this many seconds is "quick": it
# finishes before any heavy lane would benefit from the freed cores.
QUICK_LANE_SECONDS = 90.0
SCHEDULE_PHASED = "phased"
SCHEDULE_LEGACY = "legacy"
# The only phase a lane outside Group 3 may declare (``Lane.phase``).
PHASE_COVERAGE = "coverage"
LANE_PHASES = ("", PHASE_COVERAGE)
# Safe default order when no duration has been recorded yet (seconds observed
# on the 2026-10-29 deploy-1627 runs; only their relative order matters).
DEFAULT_LANE_SECONDS = {
    "seed-cache-decision": 3.0,
    "canonical-seed-whatsapp-content": 2.5,
    "eslint": 24.0,
    "typescript": 27.0,
    "backend-structural": 37.0,
    "deploy-command-structural": 1555.0,
    "backend-coverage-blackbox": 1505.0,
    "frontend-coverage-blackbox": 1000.0,
    "agents-coverage-blackbox": 800.0,
    # Local smoke lane, 2026-10-30 #1638 (22.6 min alone); orders it within the
    # coverage phase and lets ``simulate`` project it on a fresh host.
    "smoke": 1358.0,
}


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


def sample_lane_tree_rss(pids: set[int]) -> dict[int, float]:
    """Resident memory (MB) of each lane's whole process tree.

    Descendants are followed by parent links from the lane's stage wrapper, so
    the stage runner's command (started in its own session) and everything it
    forks are attributed to the lane; a process that daemonized away from the
    tree is missed, which only under-credits the lane. PSS
    (``/proc/<pid>/smaps_rollup``) shares pages between the lane's own
    processes the way MemAvailable gives them back; RSS is the fallback where
    the rollup is unreadable. Linux only: elsewhere, or when /proc cannot be
    read, the result is empty and the lane's usage stays unobserved, which
    keeps its whole declaration reserved.
    """
    if not pids or sys.platform != "linux":
        return {}
    page_mb = os.sysconf("SC_PAGE_SIZE") / (1024 * 1024)
    try:
        entries = os.listdir("/proc")
    except OSError:
        return {}
    parents: dict[int, int] = {}
    rss_pages: dict[int, int] = {}
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            stat = Path(f"/proc/{entry}/stat").read_text()
        except OSError:
            continue  # exited between listdir and read
        fields = stat[stat.rindex(")") + 2:].split()
        try:
            parents[int(entry)], rss_pages[int(entry)] = int(fields[1]), int(fields[21])
        except (IndexError, ValueError):
            continue
    children: dict[int, list[int]] = {}
    for pid, parent in parents.items():
        children.setdefault(parent, []).append(pid)

    def resident_mb(pid: int) -> float:
        try:
            for line in Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines():
                if line.startswith("Pss:"):
                    return int(line.split()[1]) / 1024
        except (OSError, IndexError, ValueError):
            pass
        return rss_pages[pid] * page_mb

    totals: dict[int, float] = {}
    for root in pids:
        total, seen, stack = 0.0, set(), [int(root)]
        while stack:
            pid = stack.pop()
            if pid in seen or pid not in parents:
                continue
            seen.add(pid)
            total += resident_mb(pid)
            stack.extend(children.get(pid, []))
        totals[int(root)] = round(total, 1)
    return totals


def unmaterialized_mb(memory_mb: int, observed_mb: float | None) -> int:
    """The part of a running lane's declared reservation not yet visible in
    MemAvailable: its headroom for growth still to come. Unobserved usage
    keeps the whole declaration."""
    if observed_mb is None:
        return int(memory_mb)
    return max(0, int(memory_mb) - int(observed_mb))


def _admission_inputs(lane: Lane, headroom: int | None, budget_mb: int | None, reserved: int, live_reserved: int,
                      accounting: str, running_states: dict[str, dict], by_name: dict[str, Lane]) -> dict:
    """Every input of one admission decision, kept on the lane for audit."""
    return {"at": _now(), "headroom_mb": headroom, "budget_mb": budget_mb, "memory_mb": lane.memory_mb,
            "reserved_declared_mb": reserved, "reserved_live_mb": live_reserved, "accounting": accounting,
            "running": {name: {"memory_mb": by_name[name].memory_mb, "tree_rss_mb": state.get("tree_rss_mb")}
                        for name, state in running_states.items()}}


def _record_waiting(state: dict, inputs: dict, reason: str) -> None:
    waiting = state.setdefault("waiting", {"since": _now(), "checks": 0})
    waiting["checks"] += 1
    waiting["reason"] = reason
    waiting["last"] = inputs


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


def _source_label(source: Mapping[str, object] | None) -> str:
    """``head=<sha> digest=<12 hex>`` for log lines; a freeze without those keys
    (tests patch ``source_digest`` to ``{}``) renders ``-`` instead of raising."""
    source = source or {}
    head = source.get("head") or "-"
    digest = str(source.get("digest") or "")[:12] or "-"
    return f"head={head} digest={digest}"


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
    # Runs alone in its own phase at full host width (deploy-command-structural).
    exclusive: bool = False
    # Declared phase for a lane outside Group 3: "coverage" admits it with the
    # coverage lanes, after the quick and exclusive phases (the local smoke
    # lane). Empty keeps a Group 4 lane unphased; Group 3 lanes are phased from
    # their recorded durations regardless.
    phase: str = ""


def load_plan(path: Path) -> list[Lane]:
    return load_plan_payload(path)[0]


# Ownership boundary, not a memory question: the deploy.md ``semantic-stack``
# lane starts its own ``run.sh --benchmark`` stack, whose startup runs
# ``scripts/kill-services.sh`` against every runtime process this worktree
# owns. A lane that owns such a stack (the local smoke lane's per-run
# benchmark stack, the AgentCard lifecycle lane's ``run-bench --local`` stack)
# must therefore have exited before it starts. On #1640 only memory kept them
# apart (4096 + 4096 MB against an 8188 MB budget, 4 MB from admitting both),
# so the loader adds the edge explicitly; declared edges are never removed.
STACK_KILLER_LANES = ("semantic-stack",)
STACK_OWNER_LANES = ("smoke", "agentcard-lifecycle")


def implied_stack_dependencies(lanes: list[Lane]) -> list[Lane]:
    """``after`` edges from every stack-killing lane to each stack-owning lane
    present in the plan, appended to the lane's declared edges."""
    names = {lane.name for lane in lanes}
    result: list[Lane] = []
    for lane in lanes:
        if lane.name in STACK_KILLER_LANES:
            owners = [owner for owner in STACK_OWNER_LANES
                      if owner in names and owner != lane.name and owner not in lane.after]
            if owners:
                lane = replace(lane, after=[*lane.after, *owners])
        result.append(lane)
    return result


def load_plan_payload(path: Path) -> tuple[list[Lane], dict]:
    payload = json.loads(path.read_text())
    lanes = implied_stack_dependencies([Lane(**lane) for lane in payload["lanes"]])
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
        if lane.phase not in LANE_PHASES:
            raise ValueError(f"{lane.name}: unknown phase {lane.phase!r} (expected one of {LANE_PHASES})")
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


def _failed_lanes(receipt: dict | None) -> set[str]:
    if not receipt:
        return set()
    return {name for name, lane in receipt.get("lanes", {}).items() if lane.get("status") == "failed"}


def failed_first(lanes: list[Lane], previous: dict | None) -> list[Lane]:
    """Stable order with the prior receipt's failed lanes admitted first."""

    failed = _failed_lanes(previous)
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


def lane_durations_path() -> Path:
    override = os.environ.get("DEPLOY_PIPELINE_LANE_DURATIONS")
    return Path(override) if override else ROOT / LANE_DURATIONS


def load_lane_durations(path: Path | None = None) -> dict[str, list[dict]]:
    """Recorded samples per lane: [{"wall_s", "status", "concurrent", "at", ...}]."""
    path = lane_durations_path() if path is None else path
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    lanes = payload.get("lanes") if isinstance(payload, dict) else None
    if not isinstance(lanes, dict):
        return {}
    clean: dict[str, list[dict]] = {}
    for name, samples in lanes.items():
        rows = []
        for sample in samples if isinstance(samples, list) else []:
            try:
                wall = float(sample["wall_s"])
            except (KeyError, TypeError, ValueError):
                continue
            if wall > 0 and sample.get("status") in {"passed", "failed"}:
                rows.append({**sample, "wall_s": wall})
        if rows:
            clean[str(name)] = rows
    return clean


def _lane_stage_row(receipt: dict, name: str) -> dict | None:
    """The run-deploy-stage row this receipt's lane wrote (matched by start time)."""
    lane = receipt.get("lanes", {}).get(name, {})
    run_dir = receipt.get("stage_run_dir")
    started = lane.get("started_epoch")
    if not run_dir or started is None:
        return None
    best: tuple[float, dict] | None = None
    for row in deploy_stage_wait._rows(Path(run_dir)):
        if row.get("stage") != name:
            continue
        try:
            row_started = float(row.get("started_epoch") or 0)
        except (TypeError, ValueError):
            continue
        if abs(row_started - float(started)) <= 5.0 and (best is None or row_started > best[0]):
            best = (row_started, row)
    return best[1] if best else None


def record_lane_durations(receipt: dict, path: Path | None = None) -> dict[str, list[dict]]:
    """Append every executed lane's own wall clock to the ledger.

    Exact-input ``--reuse-passed`` hits (stage status ``reused``) and
    superseded, refused or never-started lanes record nothing: only a lane
    that actually ran is evidence of its duration. ``concurrent`` counts the
    lanes of this attempt whose run overlapped the sample's.
    """
    path = lane_durations_path() if path is None else path
    ledger = load_lane_durations(path)
    lanes = receipt.get("lanes", {})
    for name, lane in lanes.items():
        if lane.get("status") not in {"passed", "failed"} or not lane.get("wall_s") or lane.get("started_epoch") is None:
            continue
        row = _lane_stage_row(receipt, name)
        if row is not None and row.get("status") == "reused":
            continue
        overlap = 1
        for other, state in lanes.items():
            if other == name or state.get("started_epoch") is None or state.get("finished_epoch") is None:
                continue
            if state["started_epoch"] < lane["finished_epoch"] and state["finished_epoch"] > lane["started_epoch"]:
                overlap += 1
        sample = {"wall_s": round(float(lane["wall_s"]), 1), "status": lane["status"], "concurrent": overlap,
                  "at": receipt.get("started_at"), "head": (receipt.get("source") or {}).get("head"),
                  "attempt": receipt.get("attempt"), "source": "receipt",
                  # Footprint telemetry for right-sizing ``memory_mb``: the largest
                  # single child (wait4) and the lane's whole process tree (PSS, 1 Hz).
                  "peak_rss_mb": lane.get("peak_rss_mb"), "tree_peak_rss_mb": lane.get("tree_peak_rss_mb")}
        ledger.setdefault(name, []).append(sample)
        ledger[name] = ledger[name][-LANE_DURATION_SAMPLES:]
    path.parent.mkdir(parents=True, exist_ok=True)
    write_receipt(path, {"schema_version": 1, "lanes": ledger})
    return ledger


def stage_receipt_samples(names: list[str], run_root: Path | None = None) -> dict[str, list[dict]]:
    """Seed estimates from the stage receipts of every deploy run in this
    worktree: a lane that ran before the ledger existed still has data."""
    if run_root is None:
        run_root = Path(os.environ.get("DEPLOY_RUN_ROOT") or ROOT / ".context" / "deploy-runs")
    wanted = set(names)
    found: dict[str, list[dict]] = {}
    try:
        stage_files = sorted(run_root.glob("*/stages.jsonl"))
    except OSError:
        return found
    for stage_file in stage_files:
        for row in deploy_stage_wait._rows(stage_file.parent):
            name = row.get("stage")
            if name not in wanted or row.get("status") not in {"passed", "failed"}:
                continue
            try:
                wall = float(row.get("duration_seconds") or 0)
            except (TypeError, ValueError):
                continue
            if wall <= 0:
                continue
            timing = ((row.get("detail") or {}).get("timing") or {})
            found.setdefault(name, []).append({
                "wall_s": wall, "status": row.get("status"), "concurrent": int(timing.get("concurrent_stages") or 1),
                "at": row.get("started_at"), "source": "stage-receipt"})
    return {name: rows[-LANE_DURATION_SAMPLES:] for name, rows in found.items()}


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2.0


def _passed(samples: list[dict] | None) -> list[dict]:
    return [sample for sample in samples or [] if sample.get("status") == "passed"]


def lane_estimates(lanes: list[Lane], ledger: dict[str, list[dict]] | None = None,
                   stage_samples: dict[str, list[dict]] | None = None) -> dict[str, dict]:
    """Per-lane duration estimate and where it came from.

    Passed ledger samples win, then passed stage receipts, then the safe
    default table; a lane known nowhere is ``unknown`` and scheduled as heavy
    (never quick). Only a pass measures a lane: a lane that FAILED in 2.5 s (a
    stale-Prisma refusal) was re-phased as quick ahead of the exclusive lane,
    and a 4.9 s failed live-probes sample deadlocked attempt 7 (2026-10-30).
    Failed samples stay in the ledger as telemetry only. ``isolated_s`` is the
    median of passed samples that ran with nothing else, when any exist;
    ``seconds`` is the median of every passed sample.
    """
    ledger = load_lane_durations() if ledger is None else ledger
    stage_samples = {} if stage_samples is None else stage_samples
    estimates: dict[str, dict] = {}
    for lane in lanes:
        passed_ledger = _passed(ledger.get(lane.name))
        samples = passed_ledger or _passed(stage_samples.get(lane.name))
        if samples:
            source = "ledger" if passed_ledger else "stage-receipts"
            walls = [float(sample["wall_s"]) for sample in samples]
            alone = [float(s["wall_s"]) for s in samples if int(s.get("concurrent") or 1) <= 1]
            estimates[lane.name] = {"seconds": round(_median(walls), 1), "samples": len(samples), "source": source,
                                    "isolated_s": round(_median(alone), 1) if alone else None}
        elif lane.name in DEFAULT_LANE_SECONDS:
            estimates[lane.name] = {"seconds": DEFAULT_LANE_SECONDS[lane.name], "samples": 0, "source": "default",
                                    "isolated_s": None}
        else:
            estimates[lane.name] = {"seconds": None, "samples": 0, "source": "unknown", "isolated_s": None}
    return estimates


def assert_acyclic(after: dict[str, list[str]]) -> None:
    """Fail loudly on a dependency that never starts: an unknown lane name or a
    cycle. The admission loop would otherwise idle forever with every lane
    pending (attempt 7, 2026-10-30)."""
    for name, dependencies in after.items():
        unknown = sorted(set(dependencies) - set(after))
        if unknown:
            raise ValueError(f"lane {name!r} waits for unknown lane(s) {', '.join(unknown)}")
    state: dict[str, int] = {}  # 1 visiting, 2 done
    stack: list[str] = []

    def visit(name: str) -> None:
        if state.get(name) == 2:
            return
        if state.get(name) == 1:
            cycle = stack[stack.index(name):] + [name]
            raise ValueError(f"dependency cycle: {' -> '.join(cycle)}")
        state[name] = 1
        stack.append(name)
        for dependency in after[name]:
            visit(dependency)
        stack.pop()
        state[name] = 2

    for name in after:
        visit(name)


def _closed_subset(candidates: list[Lane], explicit: dict[str, list[str]], placed: set[str]) -> list[Lane]:
    """The candidates whose explicit dependencies all lie in earlier phases or
    in the same phase (an edge inside a phase is honoured by admission; an
    edge to a later phase would be a cycle with the implied phase edges)."""
    chosen = {lane.name for lane in candidates}
    while True:
        dropped = {name for name in chosen
                   if any(d not in placed and d not in chosen for d in explicit[name])}
        if not dropped:
            return [lane for lane in candidates if lane.name in chosen]
        chosen -= dropped


def phased_lanes(lanes: list[Lane]) -> list[Lane]:
    """Group 3 plus every lane that declares a phase (the local smoke lane)."""
    return [lane for lane in lanes if lane.group == "3" or lane.phase == PHASE_COVERAGE]


def phased_dependencies(lanes: list[Lane]) -> dict[str, list[str]]:
    """For every phased lane, the phased lanes it waits for: its direct
    ``after`` edges plus every edge reached through a chain of unphased lanes.
    A quick lane ``q`` that waits for the unphased ``u``, which waits for the
    coverage lane ``p``, must wait for ``p``'s phase as well; dropping ``u``
    placed ``q`` in the quick phase and the implied edge p -> q closed the
    cycle p -> u -> q -> p (CodeRabbit on #1639, 2026-10-30). Order follows
    the lane's own ``after`` list, depth first; unknown names are left to
    ``assert_acyclic`` on the full plan."""
    by_name = {lane.name: lane for lane in lanes}
    names = {lane.name for lane in phased_lanes(lanes)}
    dependencies: dict[str, list[str]] = {}
    for lane in phased_lanes(lanes):
        found: list[str] = []
        seen: set[str] = set()
        stack = list(reversed(lane.after))
        while stack:
            dependency = stack.pop()
            if dependency in seen:
                continue
            seen.add(dependency)
            if dependency in names:
                found.append(dependency)
            elif dependency in by_name:
                stack.extend(reversed(by_name[dependency].after))
        dependencies[lane.name] = found
    return dependencies


def schedule_phases(lanes: list[Lane], estimates: dict[str, dict]) -> list[dict]:
    """Ordered Group 3 phases: quick lanes, each exclusive lane alone, then the
    rest (longest recorded first). Other groups are not phased unless a lane
    declares ``phase: "coverage"``, which places it in the coverage phase.

    Phases are layered over the plan's own ``after`` DAG: a lane joins a phase
    only once every explicit dependency (direct, or reached through unphased
    lanes; ``phased_dependencies``) is in an earlier phase or in that same
    phase, so the implied edges (phase k waits for phases < k) can never form
    a cycle with an explicit edge. A quick lane that waits for the exclusive
    lane therefore runs with the coverage lanes instead of deadlocking it.
    Pass every plan lane, not only the phased ones: the unphased lanes carry
    the chains.
    """
    phased = phased_lanes(lanes)
    explicit = phased_dependencies(lanes)
    assert_acyclic(explicit)

    def seconds(lane: Lane) -> float:
        value = (estimates.get(lane.name) or {}).get("seconds")
        return float("inf") if value is None else float(value)

    phases: list[dict] = []
    placed: set[str] = set()
    remaining = list(phased)
    while remaining:
        emitted: list[Lane] = []
        if not phases:
            quick = [l for l in remaining if not l.exclusive and not l.phase and seconds(l) <= QUICK_LANE_SECONDS]
            emitted = sorted(_closed_subset(quick, explicit, placed), key=seconds)
            if emitted:
                phases.append({"phase": "quick", "lanes": [l.name for l in emitted]})
        if not emitted:
            ready_exclusive = sorted((l for l in remaining if l.exclusive and all(d in placed for d in explicit[l.name])),
                                     key=seconds, reverse=True)
            if ready_exclusive:
                emitted = [ready_exclusive[0]]
                phases.append({"phase": "exclusive", "lanes": [emitted[0].name]})
        if not emitted:
            heavy = [l for l in remaining if not l.exclusive]
            emitted = sorted(_closed_subset(heavy, explicit, placed), key=seconds, reverse=True)
            if emitted:
                phases.append({"phase": "coverage", "lanes": [l.name for l in emitted]})
        if not emitted:  # unreachable after assert_acyclic; never idle silently
            raise ValueError(f"no schedulable phased lane among {', '.join(sorted(l.name for l in remaining))}")
        placed.update(lane.name for lane in emitted)
        remaining = [lane for lane in remaining if lane.name not in placed]
    return phases


def implied_dependencies(phases: list[dict]) -> dict[str, list[str]]:
    """Every lane of phase k waits for every lane of phases < k."""
    implied: dict[str, list[str]] = {}
    earlier: list[str] = []
    for phase in phases:
        for name in phase["lanes"]:
            implied[name] = list(earlier)
        earlier.extend(phase["lanes"])
    return implied


def apply_schedule(lanes: list[Lane], payload: dict) -> dict:
    """Add the phase-implied ``after`` edges to ``lanes``; return the receipt record."""
    policy = str((payload.get("schedule") or {}).get("policy") or SCHEDULE_PHASED)
    # The plan's own edges must be satisfiable before any lane starts.
    assert_acyclic({lane.name: list(lane.after) for lane in lanes})
    if policy == SCHEDULE_LEGACY:
        return {"policy": SCHEDULE_LEGACY, "phases": [], "estimates": {}, "implied_after": {}}
    if policy != SCHEDULE_PHASED:
        raise ValueError(f"unknown schedule policy {policy!r} (expected {SCHEDULE_PHASED} or {SCHEDULE_LEGACY})")
    ledger = load_lane_durations()
    stage_samples = stage_receipt_samples([lane.name for lane in lanes])
    estimates = lane_estimates(lanes, ledger, stage_samples)
    phases = schedule_phases(lanes, estimates)
    implied = implied_dependencies(phases)
    for lane in lanes:
        for dependency in implied.get(lane.name, []):
            if dependency != lane.name and dependency not in lane.after:
                lane.after.append(dependency)
    # Explicit plus implied edges together: a cycle here would idle the attempt.
    assert_acyclic({lane.name: list(lane.after) for lane in lanes})
    return {"policy": SCHEDULE_PHASED, "phases": phases, "estimates": estimates, "implied_after": implied}


def exclusive_structural_workers(host: dict) -> int:
    """Width of the structural runner when it runs alone: every core the
    whole-box memory budget can back at the measured per-worker floor."""
    budget = memory_budget_mb(host)
    by_memory = STRUCTURAL_RUNNER_MAX_WORKERS if budget is None else (budget - 1024) // STRUCTURAL_WORKER_MEMORY_MB
    return max(MIN_WORKERS, min(STRUCTURAL_RUNNER_MAX_WORKERS, host["cpus"], int(by_memory)))


def _lane_workers(lane: Lane) -> int | None:
    """The ``--max-workers N`` a lane's command declares, or None."""
    try:
        return int(lane.command[lane.command.index("--max-workers") + 1])
    except (ValueError, IndexError):
        return None


def fit_exclusive_lane(lane: Lane, available_mb: int) -> Lane | None:
    """The exclusive structural lane at the width ``available_mb`` backs at the
    per-worker floor, never wider than planned.

    The plan sizes that lane to the whole budget measured when ``plan`` ran;
    MemAvailable drifts by about 1 GB before its phase starts (page cache held
    by tsc/eslint, Postgres, other agents on the box), and a lane reserved to
    the last MB was refused at admission without running a single gate
    (PR1634 coordinator, 2026-10-29). Narrowing it keeps every gate running at
    the width the box can actually back; None when not even MIN_WORKERS fit,
    which stays a refusal.
    """
    planned = _lane_workers(lane)
    if not lane.exclusive or planned is None:
        return None
    workers = min(planned, int((available_mb - 1024) // STRUCTURAL_WORKER_MEMORY_MB))
    if workers < MIN_WORKERS:
        return None
    index = lane.command.index("--max-workers") + 1
    command = [*lane.command[:index], str(workers), *lane.command[index + 1:]]
    return replace(lane, command=command, memory_mb=1024 + STRUCTURAL_WORKER_MEMORY_MB * workers)


def _list_schedule(order: list[Lane], seconds: dict[str, float], after: dict[str, list[str]],
                   max_parallel: int, budget_mb: int | None) -> float:
    """Makespan of a list schedule under the driver's admission rules."""
    return _wall(_list_schedule_finish(order, seconds, after, max_parallel, budget_mb))


def _wall(finished: dict[str, float], names: set[str] | None = None) -> float:
    values = [end for name, end in finished.items() if names is None or name in names]
    return round(max(values), 1) if values else 0.0


def _list_schedule_finish(order: list[Lane], seconds: dict[str, float], after: dict[str, list[str]],
                          max_parallel: int, budget_mb: int | None) -> dict[str, float]:
    """Finish time of every lane in a list schedule under the driver's admission rules."""
    finished: dict[str, float] = {}
    running: list[tuple[float, str, int]] = []  # (end, name, memory_mb)
    pending = list(order)
    clock = 0.0
    while pending or running:
        reserved = sum(memory for _, _, memory in running)
        for lane in list(pending):
            if max_parallel and len(running) >= max_parallel:
                break
            if any(dependency not in finished for dependency in after.get(lane.name, [])):
                continue
            if budget_mb is not None and running and reserved + lane.memory_mb > budget_mb:
                continue
            pending.remove(lane)
            running.append((clock + seconds[lane.name], lane.name, lane.memory_mb))
            reserved += lane.memory_mb
        if running:
            running.sort()
            end, name, _ = running.pop(0)
            clock = max(clock, end)
            finished[name] = clock
        elif pending:  # unsatisfiable dependency: force progress rather than spin
            lane = pending.pop(0)
            running.append((clock + seconds[lane.name], lane.name, lane.memory_mb))
    return finished


def simulate(lanes: list[Lane], estimates: dict[str, dict], max_parallel: int, budget_mb: int | None) -> dict:
    """Projected union wall of the phased lanes (Group 3 plus declared-phase
    lanes such as the local smoke lane), phased versus legacy admission, from
    recorded durations only (no contention model). ``group3`` reports the same
    two walls over the Group 3 lanes alone, so the smoke lane's own length
    never hides how long the Group 3 gates took.

    Legacy uses every lane's recorded median, measured with the lanes running
    together. Phased uses ``isolated_s`` where a lane has run alone and the
    same loaded median otherwise, naming those lanes UNMEASURED: the phased
    wall is then an upper bound, not a measurement.
    """
    simulated = phased_lanes(lanes)
    group3 = {lane.name for lane in simulated if lane.group == "3"}
    loaded = {lane.name: float((estimates.get(lane.name) or {}).get("seconds") or 0.0) for lane in simulated}
    # Edges to other phased lanes, including those reached through unphased
    # lanes (whose own durations the projection does not model).
    legacy_after = phased_dependencies(lanes)
    legacy_finish = _list_schedule_finish(sorted(simulated, key=lambda l: -loaded[l.name]), loaded, legacy_after,
                                          max_parallel, budget_mb)
    phases = schedule_phases(lanes, estimates)
    implied = implied_dependencies(phases)
    phased: dict[str, float] = {}
    unmeasured: list[str] = []
    for lane in simulated:
        isolated = (estimates.get(lane.name) or {}).get("isolated_s")
        if isolated is None:
            unmeasured.append(lane.name)
        phased[lane.name] = loaded[lane.name] if isolated is None else float(isolated)
    phased_after = {lane.name: sorted(set(legacy_after[lane.name]) | set(implied.get(lane.name, [])))
                    for lane in simulated}
    phased_finish = _list_schedule_finish(sorted(simulated, key=lambda l: -phased[l.name]), phased, phased_after,
                                          max_parallel, budget_mb)
    legacy_wall, phased_wall = _wall(legacy_finish), _wall(phased_finish)
    legacy_group3, phased_group3 = _wall(legacy_finish, group3), _wall(phased_finish, group3)
    lanes_out: dict[str, dict] = {}
    for lane in simulated:
        entry = {"loaded_s": loaded[lane.name], "phased_s": phased[lane.name],
                 "source": (estimates.get(lane.name) or {}).get("source")}
        if lane.phase:
            entry["phase"] = lane.phase
        lanes_out[lane.name] = entry
    return {"legacy_union_wall_s": legacy_wall, "phased_union_wall_s": phased_wall,
            "delta_s": round(legacy_wall - phased_wall, 1), "phases": phases,
            "group3": {"legacy_union_wall_s": legacy_group3, "phased_union_wall_s": phased_group3,
                       "delta_s": round(legacy_group3 - phased_group3, 1)},
            "lanes": lanes_out,
            "unmeasured_isolated": unmeasured,
            "note": "phased uses recorded isolated durations only where a lane has run alone; UNMEASURED lanes "
                    "keep their loaded median as an upper bound, so the phased wall is a bound, not a measurement"}


def _history(state_dir: Path) -> list[dict]:
    """Every archived receipt of this state dir, oldest first."""
    receipts: list[dict] = []
    try:
        lines = (state_dir / "history.jsonl").read_text().splitlines()
    except OSError:
        return receipts
    for line in lines:
        try:
            receipt = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(receipt, dict):
            receipts.append(receipt)
    return receipts


def _archive(state_dir: Path, receipt: dict) -> None:
    with (state_dir / "history.jsonl").open("a") as handle:
        handle.write(json.dumps(receipt, sort_keys=True) + "\n")


def _lane_failure_class(receipt: dict, name: str) -> str:
    """The run-deploy-stage failure class recorded for a failed lane."""
    lane = receipt.get("lanes", {}).get(name, {})
    fallback = f"exit-{lane.get('exit')}" if lane.get("exit") is not None else "unknown"
    run_dir = receipt.get("stage_run_dir")
    started = lane.get("started_epoch")
    if not run_dir or started is None:
        return fallback
    best: dict | None = None
    for row in deploy_stage_wait._rows(Path(run_dir)):
        if row.get("stage") != name:
            continue
        try:
            row_started = float(row.get("started_epoch") or 0)
        except (TypeError, ValueError):
            continue
        if abs(row_started - float(started)) <= 5.0 and (best is None or row_started > best["_t"]):
            best = {"_t": row_started, "row": row}
    if best is None:
        return fallback
    detail = best["row"].get("detail") or {}
    outcome = detail.get("outcome") or {}
    return str(outcome.get("failure_class") or fallback)


def fix_loop_state(receipts: list[dict], cap: int) -> dict:
    """Consecutive completed failed rounds, with their failure classes.

    Superseded, stale and capped receipts never count as a round: nothing
    ran to completion on those bytes. A passed round or an ``after_rca``
    acknowledgement restarts the count.
    """
    rounds = 0
    classes: dict[str, list[str]] = {}
    rca_ref: str | None = None
    for receipt in receipts:
        loop = receipt.get("fix_loop") or {}
        if loop.get("rca_ack"):
            # Only the run started with --after-rca restarts the count; later
            # receipts carry the reference for telemetry without resetting.
            rounds = 0
            classes = {}
            rca_ref = str(loop.get("rca_ref"))
        if receipt.get("status") == "passed":
            rounds = 0
            classes = {}
            continue
        if receipt.get("status") != "failed" or receipt.get("interrupted"):
            continue  # a signalled run never completed a round
        rounds += 1
        for name in sorted(_failed_lanes(receipt)):
            classes.setdefault(name, []).append(_lane_failure_class(receipt, name))
    return {"cap": cap, "failed_rounds": rounds, "classes": classes, "rca_ref": rca_ref,
            "rca_ack": False, "capped": bool(cap) and rounds >= cap}


def _terminate_lanes(processes: dict[str, subprocess.Popen[bytes]], signum: int) -> None:
    for process in processes.values():
        if process.returncode is None:
            try:
                os.killpg(process.pid, signum)
            except ProcessLookupError:
                pass


def _probe_source() -> dict[str, str] | None:
    """Current source digest, or None while git is busy (index.lock, commit in flight)."""
    try:
        return source_digest()
    except (subprocess.CalledProcessError, OSError):
        return None


def _settled_source(frozen: dict, settle_seconds: float, poll_seconds: float) -> dict[str, str]:
    """Block until the changed source has stopped changing for settle_seconds."""
    current = _probe_source() or frozen
    since = time.monotonic()
    while True:
        time.sleep(min(poll_seconds, max(0.05, settle_seconds)))
        probe = _probe_source()
        if probe is not None and probe != current:
            current, since = probe, time.monotonic()
        elif time.monotonic() - since >= settle_seconds:
            return current


def run(
    plan: Path,
    state_dir: Path,
    max_parallel: int | None = None,
    budget_mb: int | None = None,
    *,
    follow_source: bool = False,
    settle_seconds: float = DEFAULT_SETTLE_SECONDS,
    poll_seconds: float = DEFAULT_POLL_SECONDS,
    fix_loop_cap: int = DEFAULT_FIX_LOOP_CAP,
    after_rca: str | None = None,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
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
            _archive(state_dir, previous)
    receipts = _history(state_dir)
    loop = fix_loop_state(receipts, fix_loop_cap)
    if after_rca:
        loop.update(failed_rounds=0, classes={}, rca_ref=after_rca, rca_ack=True, capped=False)
    if loop["capped"]:
        summary = "; ".join(f"{lane}={','.join(kinds)}" for lane, kinds in sorted(loop["classes"].items())) or "-"
        receipt = {
            "schema_version": RECEIPT_SCHEMA,
            "plan": str(plan),
            "supervisor_pid": os.getpid(),
            "started_at": _now(),
            "started_epoch": time.time(),
            "finished_at": _now(),
            "attempt": 1,
            "source": _probe_source(),
            "lanes": {lane.name: {"status": "not-run", "group": lane.group} for lane in lanes},
            "status": "capped",
            "fix_loop": loop,
            "stage_run_dir": _stage_run_dir(),
        }
        write_receipt(receipt_path, receipt)
        print(
            f"FIX_LOOP_CAP: {loop['failed_rounds']} full gate round(s) failed on this deploy "
            f"(cap {fix_loop_cap}); failure classes: {summary}. Route every class to /RCA "
            "(local repro + fix) instead of a blind rerun; then run again with --after-rca <ref>.",
            flush=True,
        )
        return EXIT_FIX_LOOP_CAP
    attempt = 1
    supersedes: dict | None = None
    while True:
        receipt, outcome = _run_attempt(
            lanes, plan, state_dir, receipt_path, max_parallel, previous,
            host=host, live_budget=live_budget, budget_mb=budget_mb,
            attempt=attempt, supersedes=supersedes, loop=loop,
            follow_source=follow_source, settle_seconds=settle_seconds, poll_seconds=poll_seconds,
            payload=payload,
        )
        if outcome != "superseded":
            break
        if attempt >= max_attempts:
            receipt["status"] = "stale"
            receipt["note"] = f"max attempts ({max_attempts}) reached while the source kept changing"
            write_receipt(receipt_path, receipt)
            break
        _archive(state_dir, receipt)
        previous = receipt
        supersedes = {"attempt": attempt, **receipt["source"]}
        attempt += 1
    return {"passed": 0, "failed": 1, "stale": EXIT_STALE}.get(receipt["status"], 1)


def _run_attempt(
    lanes: list[Lane],
    plan: Path,
    state_dir: Path,
    receipt_path: Path,
    max_parallel: int,
    previous: dict | None,
    *,
    host: dict,
    live_budget: int,
    budget_mb: int,
    attempt: int,
    supersedes: dict | None,
    loop: dict,
    follow_source: bool,
    settle_seconds: float,
    poll_seconds: float,
    payload: dict | None = None,
) -> tuple[dict, str]:
    """One attempt on one frozen source; returns (receipt, "done" | "superseded")."""
    # Phase-implied dependencies are recomputed per attempt from the ledger as
    # it stands now; the plan's own ``after`` edges are always kept.
    lanes = [Lane(**{**lane.__dict__, "after": list(lane.after)}) for lane in lanes]
    schedule = apply_schedule(lanes, payload or {})
    order = failed_first(lanes, previous)
    previously_failed = _failed_lanes(previous)
    frozen = source_digest()
    receipt: dict = {
        "schema_version": RECEIPT_SCHEMA,
        "plan": str(plan),
        "supervisor_pid": os.getpid(),
        "started_at": _now(),
        "started_epoch": time.time(),
        "attempt": attempt,
        "follow_source": follow_source,
        "settle_seconds": settle_seconds if follow_source else None,
        "source": frozen,
        "order": [lane.name for lane in order],
        "lanes": {
            lane.name: {"status": "pending", "group": lane.group, "memory_mb": lane.memory_mb} for lane in order
        },
        "status": "running",
        "fix_loop": loop,
        "stage_run_dir": _stage_run_dir(),
        "source_root": str(SOURCE_ROOT),
        "host": host,
        "host_peak": sample_host_peak({}, host),
        "host_samples": [{"at": _now(), **host, "headroom_mb": live_budget}],
        "max_parallel": max_parallel,
        "memory_budget_mb": budget_mb,
        "schedule": schedule,
        "after": {lane.name: list(lane.after) for lane in order},
    }
    if supersedes:
        receipt["supersedes"] = supersedes
    write_receipt(receipt_path, receipt)
    log_dir = state_dir / "logs"
    log_dir.mkdir(exist_ok=True)
    print(f"PIPELINE_ATTEMPT attempt={attempt} {_source_label(frozen)}", flush=True)

    processes: dict[str, subprocess.Popen[bytes]] = {}
    stopping = 0

    def terminate(signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = signum
        _terminate_lanes(processes, signal.SIGTERM)

    for forwarded in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(forwarded, terminate)

    by_name = {lane.name: lane for lane in lanes}
    # Phased lanes are designed to run together: admitting one charges only the
    # running lanes' unmaterialized declarations against live headroom. Unphased
    # lanes keep the declared-peak accounting (semantic-stack's startup kills a
    # running smoke stack; memory is what keeps them apart).
    credit_lanes = {lane.name for lane in phased_lanes(lanes)}
    pending = list(order)
    superseding: dict | None = None  # the settled new source once detected
    changed_source: dict | None = None
    changed_since = 0.0
    last_probe = time.monotonic()
    last_sample = time.monotonic()
    while True:
        if time.monotonic() - last_sample >= HOST_SAMPLE_SECONDS:
            sample = runtime_host_resources()
            sample_host_peak(receipt["host_peak"], sample)
            receipt["host_samples"].append({"at": _now(), **sample,
                                            "headroom_mb": memory_budget_mb(sample)})
            observed = sample_lane_tree_rss({p.pid for p in processes.values() if p.returncode is None})
            for name, process in processes.items():
                if process.returncode is None and process.pid in observed:
                    tree_state = receipt["lanes"][name]
                    tree_state["tree_rss_mb"] = observed[process.pid]
                    tree_state["tree_peak_rss_mb"] = max(float(tree_state.get("tree_peak_rss_mb") or 0.0),
                                                         observed[process.pid])
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
                if superseding is not None:
                    status = "superseded"
                else:
                    status = "passed" if process.returncode == 0 else "failed"
                lane_state.update(
                    status=status,
                    exit=process.returncode,
                    finished_epoch=time.time(),
                    wall_s=round(time.time() - lane_state["started_epoch"], 1),
                    peak_rss_mb=round(usage.ru_maxrss / (1024 * 1024 if sys.platform == "darwin" else 1024), 3),
                    rusage_source="wait4",
                )
                changed = True
        if changed:
            receipt["status"] = "superseded" if superseding is not None else overall(receipt["lanes"])
            write_receipt(receipt_path, receipt)
        if not stopping and superseding is None:
            running_states = {name: receipt["lanes"][name] for name, p in processes.items() if p.returncode is None}
            running = len(running_states)
            reserved = sum(by_name[name].memory_mb for name in running_states)
            # Live headroom already contains what the running lanes use; only
            # the part of their declarations not yet materialized is still owed.
            unmaterialized = sum(unmaterialized_mb(by_name[name].memory_mb, state.get("tree_rss_mb"))
                                 for name, state in running_states.items())
            pass_sample = None
            for lane in list(pending):
                if max_parallel and running >= max_parallel:
                    break
                if any(receipt["lanes"][d]["status"] not in TERMINAL_LANE for d in lane.after):
                    continue
                if lane.exclusive and not running:
                    # Alone in its phase: fit its width to what is free right now
                    # (the plan-time budget and live headroom both drift) instead
                    # of refusing it or waiting for memory no other lane holds.
                    if pass_sample is None:
                        pass_sample = runtime_host_resources()
                        sample_host_peak(receipt["host_peak"], pass_sample)
                    free = [value for value in (budget_mb, memory_budget_mb(pass_sample)) if value is not None]
                    fitted = fit_exclusive_lane(lane, min(free) - reserved) if free else None
                    if fitted is not None and fitted.memory_mb < lane.memory_mb:
                        note = (f"resized: {_lane_workers(lane)} -> {_lane_workers(fitted)} workers "
                                f"(planned {lane.memory_mb} MB, {min(free)} MB available)")
                        receipt["lanes"][lane.name].update(note=note, memory_mb=fitted.memory_mb)
                        print(f"PIPELINE_LANE_RESIZED lane={lane.name} {note}", flush=True)
                        pending[pending.index(lane)] = fitted
                        by_name[lane.name] = fitted
                        lane = fitted
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
                        # Admitted when running lanes release their declared share.
                        _record_waiting(receipt["lanes"][lane.name], {
                            "at": _now(), "budget_mb": budget_mb, "memory_mb": lane.memory_mb,
                            "reserved_declared_mb": reserved}, "budget")
                        continue
                if pass_sample is None:
                    pass_sample = runtime_host_resources()
                    sample_host_peak(receipt["host_peak"], pass_sample)
                sample = pass_sample
                headroom = memory_budget_mb(sample)
                accounting = "unmaterialized" if lane.name in credit_lanes else "declared"
                live_reserved = unmaterialized if accounting == "unmaterialized" else reserved
                inputs = _admission_inputs(lane, headroom, budget_mb, reserved, live_reserved, accounting,
                                           running_states, by_name)
                if headroom is None or live_reserved + lane.memory_mb > headroom:
                    if headroom is None and receipt["host_samples"][-1].get("error") != sample.get("error"):
                        receipt["host_samples"].append({"at": _now(), **sample, "headroom_mb": headroom})
                    if running:
                        _record_waiting(receipt["lanes"][lane.name], inputs, "headroom")
                        continue  # this run can still release reservations
                    receipt["host_samples"].append({"at": _now(), **sample, "headroom_mb": headroom})
                    pending.remove(lane)
                    receipt["lanes"][lane.name].update(
                        status="failed", exit=None, finished_epoch=time.time(),
                        note=f"refused: needs {lane.memory_mb} MB, live headroom {headroom} MB",
                        admission={**inputs, "decision": "refused"},
                    )
                    continue
                receipt["host_samples"].append({"at": _now(), **sample, "headroom_mb": headroom})
                pending.remove(lane)
                deferred = receipt["lanes"][lane.name].pop("waiting", None)
                receipt["lanes"][lane.name]["admission"] = {**inputs, "decision": "admitted", "deferred": deferred}
                if deferred:
                    print(f"PIPELINE_LANE_ADMITTED lane={lane.name} after {deferred['checks']} deferred check(s) "
                          f"since {deferred['since']}: headroom={headroom} reserved_live={live_reserved} "
                          f"reserved_declared={reserved} memory={lane.memory_mb} accounting={accounting}",
                          flush=True)
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
                        admission={**inputs, "decision": "spawn-failed", "deferred": deferred},
                    )
                    continue
                pass_sample = None  # a successful spawn changes live headroom
                receipt["lanes"][lane.name].update(
                    status="running", started_epoch=time.time(), log=str(log_path)
                )
                running_states[lane.name] = receipt["lanes"][lane.name]
                running += 1
                reserved += lane.memory_mb
                unmaterialized += lane.memory_mb  # nothing of a fresh lane is visible yet
            write_receipt(receipt_path, receipt)
        elif pending:
            for lane in pending:
                if superseding is not None:
                    receipt["lanes"][lane.name].update(status="superseded", note="superseded")
                else:
                    receipt["lanes"][lane.name].update(status="failed", exit=128 + stopping, note="not started")
            if stopping:
                receipt["interrupted"] = signal.Signals(stopping).name
            pending = []
        if not pending and all(state["status"] in TERMINAL_LANE for state in receipt["lanes"].values()):
            break
        now = time.monotonic()
        if follow_source and not stopping and superseding is None and now - last_probe >= poll_seconds:
            last_probe = now
            probe = _probe_source()
            if probe is None or probe == frozen:
                changed_source, changed_since = None, 0.0
            else:
                if probe != changed_source:
                    changed_source, changed_since = probe, now
                    print(
                        f"PIPELINE_SOURCE_CHANGED attempt={attempt} {_source_label(probe)} "
                        f"settling={settle_seconds:.0f}s",
                        flush=True,
                    )
                elif now - changed_since >= settle_seconds:
                    superseding = probe
                    receipt["status"] = "superseded"
                    receipt["superseded_at"] = _now()
                    receipt["superseded_by"] = probe
                    receipt["superseded_lanes"] = sorted(
                        name for name, state in receipt["lanes"].items() if state["status"] == "running"
                    )
                    write_receipt(receipt_path, receipt)
                    print(
                        f"PIPELINE_SUPERSEDED attempt={attempt} old_head={frozen.get('head')} "
                        f"new_head={probe.get('head')} terminating={','.join(receipt['superseded_lanes']) or '-'}",
                        flush=True,
                    )
                    _terminate_lanes(processes, signal.SIGTERM)
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
    if superseding is not None:
        receipt["status"] = "superseded"
        write_receipt(receipt_path, receipt)
        return receipt, "superseded"
    final_source = source_digest()
    receipt["final_source"] = final_source
    receipt["status"] = overall(receipt["lanes"])
    try:
        record_lane_durations(receipt)
    except OSError as error:
        print(f"PIPELINE_LEDGER: could not record lane durations: {error}", file=sys.stderr, flush=True)
    if final_source != frozen:
        if follow_source and not stopping:
            settled = _settled_source(frozen, settle_seconds, poll_seconds)
            receipt["status"] = "superseded"
            receipt["superseded_at"] = _now()
            receipt["superseded_by"] = settled
            receipt["superseded_lanes"] = []
            write_receipt(receipt_path, receipt)
            print(
                f"PIPELINE_SUPERSEDED attempt={attempt} old_head={frozen.get('head')} "
                f"new_head={settled.get('head')} terminating=- (source changed after the lanes finished)",
                flush=True,
            )
            return receipt, "superseded"
        receipt["status"] = "stale"
    write_receipt(receipt_path, receipt)
    return receipt, "done"


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


def _pending_source_change(receipt: dict) -> bool:
    """Whether the worktree bytes already differ from the attempt's frozen source."""
    probe = _probe_source()
    return probe is not None and probe != (receipt.get("source") or {})


def _supervisor_event(receipt: dict, attempt: int | None = None) -> tuple[int, dict] | None:
    """Events only the supervisor knows; lane events come from stage receipts.

    ``attempt`` is the attempt the waiter armed on; a receipt from another
    attempt (or one marked superseded) is the supersede event. Without it the
    receipt's own attempt is used, so a single receipt is judged on its own.
    """
    if attempt is None:
        attempt = int(receipt.get("attempt", 1))
    if receipt.get("status") == "stale":
        return EXIT_STALE, {"event": "stale"}
    if receipt.get("status") == "capped":
        return EXIT_FIX_LOOP_CAP, {"event": "fix-loop-cap", "fix_loop": receipt.get("fix_loop")}
    if receipt.get("status") == "superseded" or int(receipt.get("attempt", 1)) != attempt:
        return _SUPERSEDED_EVENT, {"event": "superseded", "attempt": attempt}
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
    if receipt.get("status") == "capped":
        loop = receipt.get("fix_loop") or {}
        print(f"PIPELINE_WAKE status=fix-loop-cap exit={EXIT_FIX_LOOP_CAP} failed_rounds={loop.get('failed_rounds')}")
        print(json.dumps({"event": "fix-loop-cap", "exit": EXIT_FIX_LOOP_CAP, "fix_loop": loop}, sort_keys=True))
        return EXIT_FIX_LOOP_CAP
    if not receipt.get("stage_run_dir"):
        print("PIPELINE_WAKE status=no-stage-run exit=2 (start one with run-deploy-stage --start)")
        return 2
    latest = {"receipt": receipt}

    def refresh() -> dict:
        latest["receipt"] = _read_receipt(receipt_path) or latest["receipt"]
        return latest["receipt"]

    while True:
        current = latest["receipt"]
        attempt = int(current.get("attempt", 1))
        lanes = list(current["lanes"])
        stage_run_dir = Path(current["stage_run_dir"])
        code, payload = deploy_stage_wait.wait_for_stages(
            stage_run_dir,
            lanes,
            since=float(current["started_epoch"]),
            timeout=max(0.0, limit - (time.monotonic() - started)),
            stall_seconds=stall_seconds,
            extra_event=lambda armed=attempt: _supervisor_event(refresh(), armed),
        )
        if code == deploy_stage_wait.EXIT_FAILED:
            # A stage failure is reported before extra_event runs: the attempt
            # may already have been superseded, in which case the failure
            # belongs to discarded bytes and the next attempt is what to follow.
            current = refresh()
            if int(current.get("attempt", 1)) != attempt or current.get("status") == "superseded":
                code, payload = _SUPERSEDED_EVENT, {"event": "superseded", "attempt": attempt}
        while code == 0:
            if time.monotonic() - started >= limit:
                code, payload = deploy_stage_wait.EXIT_TIMEOUT, {"event": "timeout"}
                break
            # Every lane passed; the supervisor still re-hashes the frozen source.
            current = refresh()
            status = current.get("status")
            if int(current.get("attempt", 1)) != attempt or status == "superseded":
                code, payload = _SUPERSEDED_EVENT, {"event": "superseded", "attempt": attempt}
                break
            if status in {"passed", "failed", "stale"}:
                code = {"passed": 0, "failed": 1, "stale": EXIT_STALE}[status]
                payload = {"event": status}
                break
            if not _supervisor_alive(current):
                code, payload = 3, {"event": "supervisor-died", "pid": current.get("supervisor_pid")}
                break
            time.sleep(0.2)
        if (
            code == deploy_stage_wait.EXIT_FAILED
            and current.get("follow_source")
            and current.get("status") in ("running", "failing")  # attempt not terminal
            and _supervisor_alive(current)
            and _pending_source_change(current)
        ):
            # The failure belongs to bytes that are no longer current: a fix is
            # landing and the supervisor will supersede this attempt once it
            # settles. Report the next attempt instead of the stale failure.
            if time.monotonic() - started >= limit:
                code, payload = deploy_stage_wait.EXIT_TIMEOUT, {"event": "timeout", "pending_supersede": attempt}
                break
            time.sleep(0.5)
            continue
        if code != _SUPERSEDED_EVENT:
            break
        # Superseded: wait for the next attempt's receipt (or a terminal state) and start over.
        print(f"PIPELINE_SUPERSEDED attempt={attempt} (results on the old bytes discarded)", flush=True)
        while True:
            current = refresh()
            if int(current.get("attempt", 1)) != attempt and current.get("status") != "superseded":
                break
            if current.get("status") == "stale":
                code, payload = EXIT_STALE, {"event": "stale"}
                break
            if not _supervisor_alive(current):
                code, payload = 3, {"event": "supervisor-died", "pid": current.get("supervisor_pid")}
                break
            if time.monotonic() - started >= limit:
                code, payload = deploy_stage_wait.EXIT_TIMEOUT, {"event": "timeout", "superseded": attempt}
                break
            time.sleep(0.2)
        if code != _SUPERSEDED_EVENT:
            break
    final = latest["receipt"]
    lanes = list(final["lanes"])
    stage_run_dir = Path(final["stage_run_dir"])
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
    source = final.get("source") or {}
    print(
        f"PIPELINE_WAKE status={payload.get('event')} exit={code} head={source.get('head')} "
        f"digest={str(source.get('digest'))[:12]} attempt={final.get('attempt', 1)} "
        f"still_running={','.join(running) or '-'}"
    )
    payload["exit"] = code
    payload["attempt"] = final.get("attempt", 1)
    payload["source"] = source
    print(json.dumps(payload, sort_keys=True, default=str))
    return code


def verify(state_dir: Path, expect_head: str | None = None) -> int:
    """Exit 0 only for a passed receipt bound to the current HEAD and bytes."""
    receipt = _read_receipt(state_dir / "receipt.json")
    if receipt is None:
        print("PIPELINE_VERIFY status=no-receipt exit=2")
        return 2
    status = receipt.get("status")
    source = receipt.get("source") or {}
    if status != "passed":
        print(f"PIPELINE_VERIFY status={status} exit=1 head={source.get('head')} (receipt is not green)")
        return 1
    current = source_digest()
    if expect_head and source.get("head") != expect_head:
        print(f"PIPELINE_VERIFY status=head-mismatch exit={EXIT_STALE} receipt={source.get('head')} expected={expect_head}")
        return EXIT_STALE
    if current != source:
        print(
            f"PIPELINE_VERIFY status=source-mismatch exit={EXIT_STALE} receipt_head={source.get('head')} "
            f"receipt_digest={str(source.get('digest'))[:12]} current_head={current['head']} "
            f"current_digest={current['digest'][:12]} (gates ran on different bytes; rerun)"
        )
        return EXIT_STALE
    print(
        f"PIPELINE_VERIFY status=bound exit=0 head={current['head']} digest={current['digest'][:12]} "
        f"attempt={receipt.get('attempt', 1)}"
    )
    return 0


AGENTCARD_TASKS = (
    "agent-payment-test-shop",
    "agent-payment-setup-resume",
    "agent-payment-idempotent-abandonment",
    "agent-payment-abandonment",
)
# Persisted per worktree (.context is per checkout): tsc re-checks only files
# whose content hash changed and re-reports the cached diagnostics for the
# rest, so the error set equals a full --noEmit run.
TSBUILDINFO = "../.context/tsbuildinfo/back-end.tsbuildinfo"
TYPESCRIPT_COMMAND = [
    "bash", "-c",
    f"mkdir -p ../.context/tsbuildinfo && npx tsc --noEmit --incremental --tsBuildInfoFile {TSBUILDINFO}",
]


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
        lane("typescript", list(TYPESCRIPT_COMMAND), "back-end", memory_mb=2048)
        lane("backend-structural", ["npm", "run", "test:structural"], "back-end", memory_mb=512)
        if args.schedule == SCHEDULE_PHASED:
            # Alone in its phase: every core the whole-box budget can back at
            # the measured per-worker floor, not the shared host_scale share.
            workers["structural"] = exclusive_structural_workers(host)
        lane("deploy-command-structural", ["python3", "scripts/run-deploy-structural-gates.py",
             "--max-workers", str(workers["structural"])],
             memory_mb=1024 + STRUCTURAL_WORKER_MEMORY_MB * workers["structural"],
             exclusive=args.schedule == SCHEDULE_PHASED)
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
            # Coverage phase: admitted first, this 4096 MB stack held the memory
            # the exclusive structural lane needed (#1638: smoke-only for 13-23
            # min). Beside backend-coverage-blackbox (2560 MB) it fits the budget.
            lane("smoke", ["bash", "scripts/run-predeploy-local"], group="4", memory_mb=4096,
                 phase=PHASE_COVERAGE)
        if args.agentcard:
            # Alongside smoke, never after it: its own isolated local stack in
            # the same declared phase (no edge between the two).
            lane("agentcard-lifecycle",
                 ["bash", "scripts/run-bench", "--local", *AGENTCARD_TASKS, "--bootstrap",
                  "--max-concurrency", "1", "--no-dashboard"], group="4", env={
                     "BENCHMARK_SKIP_WMH_BUILD": "1",
                     "BENCHMARK_ATTEMPT_SUITE": "predeploy",
                     "BENCHMARK_COUNTS_FOR_DEPLOY_ELIGIBILITY": "0",
                     "BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL": "1",
                 }, reuse_passed=False, memory_mb=4096, phase=PHASE_COVERAGE)
    for entry in lanes:
        if entry["group"] == "4":
            entry.setdefault("reuse_passed", False)
    plan_lanes = [Lane(**{k: v for k, v in entry.items() if k in Lane.__dataclass_fields__}) for entry in lanes]
    estimates = lane_estimates(plan_lanes, load_lane_durations(), stage_receipt_samples([l.name for l in plan_lanes]))
    phases = schedule_phases(plan_lanes, estimates) if args.schedule == SCHEDULE_PHASED else []
    return {
        "lanes": lanes,
        "host": host,
        "workers": workers,
        "max_parallel": default_max_parallel(host),
        "memory_budget_mb": memory_budget_mb(host),
        # ``run`` recomputes the phases from the ledger at attempt time; this
        # preview shows the order the current ledger implies.
        "schedule": {"policy": args.schedule, "phases": phases, "estimates": estimates},
    }


def simulate_plan(path: Path, max_parallel: int | None, budget_mb: int | None,
                  legacy_plan: Path | None = None) -> dict:
    """``legacy_plan`` (``plan --schedule legacy``) supplies the legacy lanes'
    own reservations/worker flags; without it the same plan is compared. With
    it, both the top-level and the ``group3`` legacy walls (and deltas)
    describe that plan, never the phased plan compared against itself."""
    lanes, payload = load_plan_payload(path)
    estimates = lane_estimates(lanes, load_lane_durations(), stage_receipt_samples([l.name for l in lanes]))
    if max_parallel is None:
        max_parallel = int(payload.get("max_parallel") or 0)
    if budget_mb is None:
        budget_mb = payload.get("memory_budget_mb")
    result = simulate(lanes, estimates, max_parallel, budget_mb)
    if legacy_plan is not None:
        legacy_lanes, _ = load_plan_payload(legacy_plan)
        legacy = simulate(legacy_lanes, lane_estimates(legacy_lanes, load_lane_durations(),
                                                       stage_receipt_samples([l.name for l in legacy_lanes])),
                          max_parallel, budget_mb)
        for block, legacy_block in ((result, legacy), (result["group3"], legacy["group3"])):
            block["legacy_union_wall_s"] = legacy_block["legacy_union_wall_s"]
            block["delta_s"] = round(block["legacy_union_wall_s"] - block["phased_union_wall_s"], 1)
        result["legacy_plan"] = str(legacy_plan)
    return result


# ── Post-merge production gate: the Fly lane (deploy.md Step 13 / 13ab) ───────
# ``production`` gates the Step 13b production semantic dispatch on the exact
# deploy-agents.yml run of the merged SHA. The #1639 chain (2026-10-30)
# dispatched the production semantic workflow as soon as Render was live while
# the Fly cooperative cutover was still running; 4/5 jobs failed (route
# timeouts, temporal_workflow_id never persisted) and only the rerun after Fly
# was live passed. Every GitHub wait is recorded in the production receipt.
PRODUCTION_RECEIPT = "production.json"
PRODUCTION_SCHEMA = 1
AGENTS_WORKFLOW = "deploy-agents.yml"
AGENTS_WORKFLOW_PATH = ".github/workflows/deploy-agents.yml"
CLASSIFY_AGENT_RUNTIME = Path("scripts") / "classify-agent-runtime-changes.sh"
SURFACE_HASH_SCRIPT = Path("scripts") / "agent_workflow_surface_hash.py"
# deploy-agents.yml logs the durable job it enqueued; the cutover monitor and
# the queue identity check (Step 13ab) are bound to that exact job.
JOB_ID_PATTERN = re.compile(r"Queued production worker deployment ([a-f0-9]{64})")
# deploy.md Step 13: 120 x 5 s for the exact run to appear, 540 x 10 s for it
# to complete (the workflow's own cutover step allows 90 minutes).
DEFAULT_FLY_START_TIMEOUT = 600.0
DEFAULT_FLY_TIMEOUT = 5400.0
DEFAULT_FLY_POLL_SECONDS = 10.0
GH_TIMEOUT_SECONDS = 120.0


class ProductionGateError(RuntimeError):
    """A blocked production gate: the message is the operator's next action."""


def merged_changes(merged_sha: str, root: Path | None = None) -> list[str]:
    """Paths changed by the merge commit itself (``merged_sha^1..merged_sha``),
    never the latest ``main``, which may already belong to a later PR."""
    root = SOURCE_ROOT if root is None else root
    output = subprocess.run(
        ["git", "diff", "--name-only", f"{merged_sha}^1", merged_sha], cwd=root, check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=300,
    ).stdout
    return [line for line in output.splitlines() if line]


def agent_cutover_required(changed: list[str], root: Path | None = None) -> dict:
    """deploy.md Step 13's rule: runtime files selected by
    ``scripts/classify-agent-runtime-changes.sh`` or the workflow file itself
    require the exact deploy-agents.yml run; tests, benchmarks, docs and
    coverage harnesses under agents/ never do."""
    root = SOURCE_ROOT if root is None else root
    classified = subprocess.run(
        ["bash", str(root / CLASSIFY_AGENT_RUNTIME)], input="".join(f"{path}\n" for path in changed),
        cwd=root, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60,
    ).stdout
    runtime = [line for line in classified.splitlines() if line]
    workflow = AGENTS_WORKFLOW_PATH in changed
    return {"required": bool(runtime or workflow), "runtime_files": runtime, "workflow_changed": workflow}


def _gh_json(arguments: list[str], root: Path) -> object:
    """``gh ... --json`` parsed; a failed call raises with gh's own message."""
    completed = subprocess.run(["gh", *arguments], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, timeout=GH_TIMEOUT_SECONDS)
    if completed.returncode != 0:
        raise ProductionGateError(f"gh {' '.join(arguments[:3])} failed: {completed.stderr.strip() or completed.stdout.strip()}")
    try:
        return json.loads(completed.stdout or "null")
    except json.JSONDecodeError as error:
        raise ProductionGateError(f"gh {' '.join(arguments[:3])} returned invalid JSON: {error}") from error


def _gh_run_log(run_id: str, root: Path) -> str:
    completed = subprocess.run(["gh", "run", "view", run_id, "--log"], cwd=root, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, timeout=GH_TIMEOUT_SECONDS * 5)
    if completed.returncode != 0:
        raise ProductionGateError(f"gh run view {run_id} --log failed: {completed.stderr.strip()}")
    return completed.stdout


def recover_job_id(log: str, run_id: str) -> str:
    """The one durable job the run enqueued (deploy.md: ``sort -u`` of the log
    line, exactly one 64-hex id)."""
    found = sorted(set(JOB_ID_PATTERN.findall(log)))
    if len(found) != 1:
        raise ProductionGateError(
            f"exact deployment job was not recovered from run {run_id}'s log "
            f"({len(found)} 'Queued production worker deployment <id>' lines); do not dispatch "
            "production semantics: inspect `gh run view " + run_id + " --log` and resume the saved job per "
            "deploy.md Step 13"
        )
    return found[0]


def fly_wait(merged_sha: str, *, root: Path, waits: list[dict], state: dict | None = None,
             timeout: float = DEFAULT_FLY_TIMEOUT, start_timeout: float = DEFAULT_FLY_START_TIMEOUT,
             poll_seconds: float = DEFAULT_FLY_POLL_SECONDS, sleep=time.sleep) -> dict:
    """Block until the exact deploy-agents.yml run whose headSha is the merged
    SHA has completed; every GitHub wait lands in ``waits`` and the run's
    identity, conclusion and durable job id land in ``state`` as they are
    learned (so a blocked gate's receipt still names the run). Returns
    ``state``."""
    result = {"required": True} if state is None else state
    result.update(required=True, run_id=None, attempt=None, url=None, status=None, conclusion=None,
                  deployment_token=None, job_id=None, job_stage=None)
    started = time.monotonic()
    run_row: dict | None = None
    polls = 0
    while run_row is None:
        polls += 1
        rows = _gh_json(["run", "list", "--workflow", AGENTS_WORKFLOW, "--branch", "main", "--limit", "30",
                         "--json", "databaseId,headSha,status,conclusion,attempt,url"], root)
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict) and row.get("headSha") == merged_sha:
                run_row = row
                break
        if run_row is None:
            if time.monotonic() - started >= start_timeout:
                waits.append({"workflow": AGENTS_WORKFLOW, "kind": "run-start", "head": merged_sha, "run_id": None,
                              "polls": polls, "waited_s": round(time.monotonic() - started, 1), "outcome": "timeout"})
                raise ProductionGateError(
                    f"exact {AGENTS_WORKFLOW} run for {merged_sha} did not start within {start_timeout:.0f}s; "
                    "do not dispatch production semantics: check GitHub Actions for the merge commit or start it with "
                    f"`gh workflow run {AGENTS_WORKFLOW} --ref main -f expected_sha={merged_sha}`"
                )
            sleep(min(5.0, poll_seconds))
    run_id = str(run_row.get("databaseId"))
    result.update(run_id=run_id, url=run_row.get("url"), status=run_row.get("status"))
    waits.append({"workflow": AGENTS_WORKFLOW, "kind": "run-start", "head": merged_sha, "run_id": run_id,
                  "polls": polls, "waited_s": round(time.monotonic() - started, 1), "outcome": "found"})
    complete_started = time.monotonic()
    polls = 0
    view: dict = {}
    while True:
        polls += 1
        payload = _gh_json(["run", "view", run_id, "--json", "status,conclusion,attempt,url,headSha"], root)
        view = payload if isinstance(payload, dict) else {}
        result.update(status=view.get("status"), url=view.get("url") or result["url"],
                      attempt=str(view.get("attempt") or "") or None)
        if view.get("status") == "completed":
            break
        if time.monotonic() - complete_started >= timeout:
            waits.append({"workflow": AGENTS_WORKFLOW, "kind": "run-complete", "run_id": run_id, "polls": polls,
                          "waited_s": round(time.monotonic() - complete_started, 1), "status": view.get("status"),
                          "outcome": "timeout"})
            raise ProductionGateError(
                f"{AGENTS_WORKFLOW} run {run_id} ({view.get('url') or 'no url'}) is still {view.get('status')} after "
                f"{timeout:.0f}s; CI is still active: retain its job, clocks and Machines and keep observing "
                "(deploy.md Step 13) instead of dispatching production semantics"
            )
        sleep(poll_seconds)
    conclusion = str(view.get("conclusion") or "none")
    attempt = str(view.get("attempt") or "")
    waits.append({"workflow": AGENTS_WORKFLOW, "kind": "run-complete", "run_id": run_id, "attempt": attempt,
                  "polls": polls, "waited_s": round(time.monotonic() - complete_started, 1),
                  "status": "completed", "conclusion": conclusion, "outcome": "completed"})
    result.update(attempt=attempt, url=view.get("url"), status="completed", conclusion=conclusion,
                  deployment_token=f"{run_id}-{attempt}" if attempt else None)
    # The GitHub conclusion is telemetry: a run that concluded failure and was
    # resumed through the queue CLI keeps that conclusion forever (deploy.md
    # Step 13), and `gh run rerun` would mint an attempt whose token the job
    # identity rejects. The durable job recovered from this run's log is the
    # authority for "live" (Step 13ab: stage SUCCEEDED + monitor --verify).
    result["job_id"] = recover_job_id(log=_gh_run_log(run_id, root), run_id=run_id)
    return result


def _dotenv_values(path: Path) -> dict[str, str]:
    """``KEY=VALUE`` lines of an env file (what ``source .env`` exports); values
    are returned, never printed."""
    values: dict[str, str] = {}
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return values
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def surface_hash(root: Path) -> str:
    completed = subprocess.run([sys.executable, str(root / SURFACE_HASH_SCRIPT)], cwd=root, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, timeout=300)
    if completed.returncode != 0 or not completed.stdout.strip():
        raise ProductionGateError(f"could not compute the agent workflow surface hash: {completed.stderr.strip()}")
    return completed.stdout.strip()


def resume_command(job_id: str) -> str:
    """deploy.md Step 13: an interrupted or failed CI cutover resumes the SAME
    durable job from back-end/; never enqueue a replacement or rerun CI."""
    return (f"node --import tsx scripts/worker-deployment-queue.ts run --job-id {job_id} -- "
            "python3 ../scripts/worker_pool_cutover.py")


def cutover_verify(fly: dict, merged_sha: str, expected_hash: str, *, root: Path) -> dict:
    """deploy.md Step 13ab for the cooperative route: the saved job must be
    ``SUCCEEDED`` (CI cut over only when its durable job is; a green build or
    the run's conclusion is insufficient) and carry this merged SHA and
    workflow attempt, then the managed monitor ``--verify`` is authoritative
    for the job, its pointer and retained bank evidence. ``fly['job_stage']``
    records the stage read, separately from the run's conclusion."""
    backend = root / "back-end"
    env = {**os.environ, **_dotenv_values(backend / ".env")}
    job_id = fly["job_id"]
    read = subprocess.run(["node", "--import", "tsx", "scripts/worker-deployment-queue.ts", "read", "--job-id", job_id],
                          cwd=backend, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=600)
    if read.returncode != 0:
        raise ProductionGateError(f"worker-deployment-queue.ts read --job-id {job_id} failed: {read.stderr.strip()}")
    try:
        job = json.loads(read.stdout)
        stage = str(job["stage"])
        identity = job["identity"]
        source_commit, attempt = identity["sourceCommit"], identity["attempt"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise ProductionGateError(
            f"worker-deployment-queue.ts read --job-id {job_id} returned no job stage/identity: {error}") from error
    fly["job_stage"] = stage
    if stage != "SUCCEEDED":
        raise ProductionGateError(
            f"durable job {job_id} is {stage}, not SUCCEEDED (run {fly.get('run_id')} concluded "
            f"{fly.get('conclusion')}); the Fly worker cutover is NOT live for {merged_sha}. Do not dispatch "
            f"production semantics: resume the saved deployment from back-end/ with `{resume_command(job_id)}` "
            "and rerun this gate once the durable job is SUCCEEDED"
        )
    if source_commit != merged_sha or attempt != fly["deployment_token"]:
        raise ProductionGateError(
            f"job {job_id} source/attempt mismatch: job sourceCommit={source_commit} attempt={attempt}, expected "
            f"{merged_sha} / {fly['deployment_token']}; a prior rollout of the same SHA cannot authorize this deploy"
        )
    monitor = subprocess.run(["node", "--import", "tsx", "scripts/monitor-cooperative-cutover.ts", "--job-id", job_id,
                              "--expected-hash", expected_hash, "--verify"], cwd=backend, env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=3600)
    tail = monitor.stdout[-2000:]
    if monitor.returncode != 0:
        raise ProductionGateError(
            f"monitor-cooperative-cutover.ts --verify failed (exit {monitor.returncode}) for job {job_id}: {tail.strip()}"
        )
    return {"job_id": job_id, "job_stage": stage, "source_commit": source_commit, "attempt": attempt,
            "expected_hash": expected_hash, "queue_read": "ok", "monitor_verify_exit": 0, "monitor_tail": tail}


def production(merged_sha: str, state_dir: Path, dispatch: list[str] | None = None, *, root: Path | None = None,
               expected_hash: str | None = None, timeout: float = DEFAULT_FLY_TIMEOUT,
               start_timeout: float = DEFAULT_FLY_START_TIMEOUT, poll_seconds: float = DEFAULT_FLY_POLL_SECONDS) -> int:
    """Gate the production semantic dispatch on every exercised surface being
    live. Render/Vercel waits stay in deploy.md Step 13/13a; this command owns
    the Fly lane: when the merge touches agent runtime files (or
    deploy-agents.yml) it waits for the exact deploy-agents.yml run on the
    merged SHA to complete, recovers its durable job id, runs the Step 13ab
    proof (job SUCCEEDED + identity + monitor --verify), and only then runs
    ``dispatch`` (when given). A still-running run, a job that is not
    SUCCEEDED, an identity mismatch or a failed monitor exits 1 with the
    operator's next action and never dispatches. The receipt
    ``production.json`` in ``state_dir`` records the decision, the run
    id/attempt/job id, the run conclusion and job stage separately, and every
    GitHub wait."""
    root = SOURCE_ROOT if root is None else root
    state_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = state_dir / PRODUCTION_RECEIPT
    waits: list[dict] = []
    receipt: dict = {"schema_version": PRODUCTION_SCHEMA, "merged_sha": merged_sha, "started_at": _now(),
                     "started_epoch": time.time(), "github_waits": waits, "status": "running",
                     "fly": {"required": None}, "cutover_verify": None, "semantic_dispatch": None}
    write_receipt(receipt_path, receipt)

    def finish(status: str, code: int, error: str | None = None) -> int:
        receipt.update(status=status, finished_at=_now(), wall_s=round(time.time() - receipt["started_epoch"], 1))
        if error:
            receipt["error"] = error
        write_receipt(receipt_path, receipt)
        return code

    try:
        changed = merged_changes(merged_sha, root)
        cutover = agent_cutover_required(changed, root)
        receipt["changed_files"] = len(changed)
        receipt["agent_cutover"] = cutover
        if cutover["required"]:
            print(f"PIPELINE_PRODUCTION fly=required head={merged_sha} runtime_files={len(cutover['runtime_files'])} "
                  f"workflow_changed={cutover['workflow_changed']}: waiting for the exact {AGENTS_WORKFLOW} run",
                  flush=True)
            try:
                fly_wait(merged_sha, root=root, waits=waits, state=receipt["fly"], timeout=timeout,
                         start_timeout=start_timeout, poll_seconds=poll_seconds)
            except ProductionGateError:
                write_receipt(receipt_path, receipt)
                raise
            fly = receipt["fly"]
            print(f"PIPELINE_PRODUCTION fly=completed run={fly['run_id']} attempt={fly['attempt']} "
                  f"conclusion={fly['conclusion']} job={fly['job_id']}", flush=True)
            write_receipt(receipt_path, receipt)
            expected = expected_hash or surface_hash(root)
            try:
                receipt["cutover_verify"] = cutover_verify(fly, merged_sha, expected, root=root)
            except ProductionGateError:
                write_receipt(receipt_path, receipt)  # keeps fly.job_stage for the operator
                raise
            print(f"PIPELINE_PRODUCTION cutover=verified job={fly['job_id']} job_stage={fly['job_stage']} "
                  f"hash={expected}", flush=True)
        else:
            receipt["fly"] = {"required": False, "reason": "no agent runtime or deploy-agents.yml change in the merge"}
            print(f"PIPELINE_PRODUCTION fly=not-required head={merged_sha} ({len(changed)} changed files, "
                  "no agent runtime change): no deploy-agents.yml wait", flush=True)
    except ProductionGateError as error:
        print(f"PIPELINE_PRODUCTION status=blocked exit=1 {error}", flush=True)
        return finish("failed", 1, str(error))
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as error:
        detail = getattr(error, "stderr", "") or ""
        message = f"{type(error).__name__}: {error} {detail.strip() if isinstance(detail, str) else ''}".strip()
        print(f"PIPELINE_PRODUCTION status=error exit=2 {message}", flush=True)
        return finish("failed", 2, message)
    if dispatch:
        receipt["semantic_dispatch"] = {"command": list(dispatch), "at": _now(), "exit": None}
        write_receipt(receipt_path, receipt)
        completed = subprocess.run(dispatch, cwd=root)
        receipt["semantic_dispatch"]["exit"] = completed.returncode
        print(f"PIPELINE_PRODUCTION dispatch exit={completed.returncode}", flush=True)
        if completed.returncode != 0:
            return finish("failed", completed.returncode, f"dispatch command exited {completed.returncode}")
    else:
        receipt["semantic_dispatch"] = {"command": None, "gate": "open"}
    print(f"PIPELINE_PRODUCTION status=open exit=0 head={merged_sha} receipt={receipt_path}", flush=True)
    return finish("passed", 0)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


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
    run_parser.add_argument("--follow-source", action="store_true",
                            help="supersede the attempt when the source changes and settles")
    run_parser.add_argument("--settle-seconds", type=float, default=DEFAULT_SETTLE_SECONDS)
    run_parser.add_argument("--poll-seconds", type=float, default=DEFAULT_POLL_SECONDS)
    run_parser.add_argument("--max-attempts", type=int, default=DEFAULT_MAX_ATTEMPTS)
    run_parser.add_argument("--fix-loop-cap", type=int, default=_env_int("DEPLOY_FIX_LOOP_CAP", DEFAULT_FIX_LOOP_CAP),
                            help="completed failed rounds before FIX_LOOP_CAP (0 disables)")
    run_parser.add_argument("--after-rca", default=None,
                            help="RCA reference that authorizes the next round and restarts the count")
    wait_parser = sub.add_parser("wait")
    wait_parser.add_argument("--state-dir", type=Path, required=True)
    wait_parser.add_argument("--timeout", type=float, default=0)
    wait_parser.add_argument("--stall-seconds", type=float, default=0.0)
    wait_parser.add_argument("--since", type=float, required=True,
                             help="epoch captured before launching `run`; older receipts never satisfy the wait")
    verify_parser = sub.add_parser("verify", help="exit 0 only when the receipt passed on the current bytes")
    verify_parser.add_argument("--state-dir", type=Path, required=True)
    verify_parser.add_argument("--expect-head", default=None)
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
    plan_parser.add_argument("--schedule", choices=(SCHEDULE_PHASED, SCHEDULE_LEGACY), default=SCHEDULE_PHASED,
                             help="Group 3 admission: phased (quick -> exclusive structural -> coverage) or legacy")
    production_parser = sub.add_parser(
        "production",
        help="post-merge Fly lane: wait for the exact deploy-agents.yml run of the merged SHA (agent runtime "
             "changes only), verify its cutover, then run the dispatch command after `--`")
    production_parser.add_argument("--merged-sha", required=True)
    production_parser.add_argument("--state-dir", type=Path, required=True)
    production_parser.add_argument("--timeout", type=float, default=DEFAULT_FLY_TIMEOUT,
                                   help="seconds to wait for the run to complete once it exists")
    production_parser.add_argument("--start-timeout", type=float, default=DEFAULT_FLY_START_TIMEOUT,
                                   help="seconds to wait for the exact run to appear")
    production_parser.add_argument("--poll-seconds", type=float, default=DEFAULT_FLY_POLL_SECONDS)
    production_parser.add_argument("--expected-hash", default=None,
                                   help="precomputed agent workflow surface hash (default: scripts/agent_workflow_surface_hash.py)")
    production_parser.add_argument("dispatch", nargs=argparse.REMAINDER,
                                   help="-- <command> run only once the gate is open (e.g. gh workflow run ...)")
    simulate_parser = sub.add_parser("simulate", help="project the Group 3 union wall: phased vs legacy")
    simulate_parser.add_argument("--plan", type=Path, required=True)
    simulate_parser.add_argument("--max-parallel", type=int, default=None)
    simulate_parser.add_argument("--memory-budget-mb", type=int, default=None)
    simulate_parser.add_argument("--legacy-plan", type=Path, default=None,
                                 help="plan --schedule legacy output: the legacy variant's own lane reservations")
    args = parser.parse_args(argv)
    if args.action == "plan":
        print(json.dumps(standard_plan(args), indent=2))
        return 0
    if args.action == "simulate":
        try:
            print(json.dumps(simulate_plan(args.plan, args.max_parallel, args.memory_budget_mb, args.legacy_plan),
                             indent=2))
        except ValueError as error:
            print(f"invalid plan {args.plan}: {error}", file=sys.stderr)
            return 2
        return 0
    if args.action == "run":
        try:
            return run(
                args.plan, args.state_dir, args.max_parallel, args.memory_budget_mb,
                follow_source=args.follow_source, settle_seconds=args.settle_seconds,
                poll_seconds=args.poll_seconds, fix_loop_cap=args.fix_loop_cap,
                after_rca=args.after_rca, max_attempts=args.max_attempts,
            )
        except ValueError as error:
            print(f"invalid plan {args.plan}: {error}", file=sys.stderr)
            return 2
    if args.action == "verify":
        return verify(args.state_dir, args.expect_head)
    if args.action == "production":
        dispatch = list(args.dispatch)
        if dispatch and dispatch[0] == "--":
            dispatch.pop(0)
        return production(args.merged_sha, args.state_dir, dispatch or None, expected_hash=args.expected_hash,
                          timeout=args.timeout, start_timeout=args.start_timeout, poll_seconds=args.poll_seconds)
    return wait(args.state_dir, args.timeout, args.stall_seconds, args.since)


if __name__ == "__main__":
    sys.exit(main())
