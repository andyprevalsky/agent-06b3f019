"""Standardized live "report card" for benchmark runs.

Self-contained module: pure builders + a cadence-driven emitter. Emitted every
1s while a run is in flight (and once at the end) to stdout AND
`.context/benchmarks/<run-id>/report-card.json`.

Schema (from docs/plans/active/cloud-branch-benchmarks-simulate.md →
"Standardized live report card"):

    {
      "run_id": "…", "elapsed_s": 615, "world_model_mode": "simulate",
      "tasks":   { "total", "running", "completed", "queued" },
      "results": { "passed", "failed", "transient", "success_rate" },
      "cost":    { "agents_llm_usd", "wmh_grounding_usd", "total_usd",
                   "fast_cache_hit_rate" },
      "infra":   { "peak_machines", "wmh_served" },   # OPTIONAL (None for local runs)
      "metadata": { "tokens_in", "tokens_out" },
      "per_task":[ { "name", "status", "duration_s", "cost_usd", "agent_url",
                     "tokens_in", "tokens_out", "world_model_mode" } ]
    }

Design contract:
- Builders (`build_report_card`, `render_report_card`) are PURE — no wall-clock,
  no I/O. All time comes from `RunState.elapsed_s`.
- `ReportCardEmitter` owns cadence; its clock is injected so it is testable.
- `infra`, `wmh_grounding_usd`, `fast_cache_hit_rate`, and any field a local run
  can't know are OPTIONAL and serialize as `None`.

Integration (wired by the integrator into run_benchmark.py's parallel poll loop,
around the `asyncio.wait(...)` result-drain at lines ~5474-5495): construct a
`RunState` from the loop's live variables and call
`emitter.maybe_emit(state)` after each drain, then `maybe_emit(state, force=True)`
once the loop finishes. See module-level docstring in report_card_test.py for the
exact construction recipe.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional, Union

EMIT_INTERVAL_S: float = 1.0

# Terminal statuses a benchmark task can end in. Anything not terminal is
# considered still "running" for the tasks.running count.
_TERMINAL_STATUSES = {"PASSED", "FAILED", "ERROR", "CANCELLED", "SKIPPED"}


@dataclass
class TaskCard:
    """Per-task live view fed into the report card.

    `status` is a lowercase display status: "passed" | "failed" | "transient"
    | "running" | "queued" | "skipped" | "error". `duration_s`, `cost_usd`,
    `tokens_in`, and `tokens_out` may be None for tasks that haven't finished.
    `agent_url` is the FE deep link (`http://<frontend>/?agent-id=<id>`),
    or None if no agent exists yet.
    """

    name: str
    status: str
    duration_s: Optional[float] = None
    cost_usd: Optional[float] = None
    agent_url: Optional[str] = None
    agent_id: Optional[str] = None
    outcome_sha256: Optional[str] = None
    llm_call_count: Optional[int] = None
    tree_agent_count: Optional[int] = None
    tokens_in: Optional[int] = None
    tokens_out: Optional[int] = None
    # Per-bench world-model mode ("real" | "simulate" | "shadow"). None → inherit
    # the run-level mode. With per-bench isolation each machine sets its own.
    world_model_mode: Optional[str] = None
    # Whether fast-mode prompt caching was enabled for this bench's agent (drives
    # the ⚡ dashboard icon). None/False → not fast-mode.
    fast_mode: Optional[bool] = None
    # vCPU / machine cost for this bench's isolated Fly machine over its runtime
    # (rate × duration). None off-cloud / before the machine cost is known.
    infra_usd: Optional[float] = None


@dataclass
class RunState:
    """Explicit integration contract: everything the emitter needs, nothing more.

    The integrator constructs this from run_benchmark.py's parallel-loop
    variables. Counts are derived from `per_task` when not supplied, so the
    minimal construction is just `run_id`, `elapsed_s`, and `per_task`.

    Fields:
      run_id            – the BenchmarkRun.run_id.
      elapsed_s         – wall seconds since run start (caller-provided; keeps
                          builders pure/clock-free).
      world_model_mode  – "simulate" | "shadow" | "real" | None.
      total_tasks       – total tasks in the run (incl. not-yet-started). If
                          None, falls back to len(task_names) or len(per_task).
      task_names        – ordered benchmark task names for the invocation. When
                          supplied, missing rows are rendered as queued so the
                          dashboard always shows the whole run shape.
      per_task          – list[TaskCard], one per task the run knows about.
      agents_llm_usd    – summed agent LLM cost in USD. If None, derived by
                          summing per_task[*].cost_usd.
      tokens_in         – tree/run input token count. If None, derived by
                          summing per_task[*].tokens_in.
      tokens_out        – tree/run output token count. If None, derived by
                          summing per_task[*].tokens_out.
      wmh_grounding_usd – WMH grounding cost in USD (OPTIONAL; None local).
      fast_cache_hit_rate – 0..1 demo-cache hit rate (OPTIONAL; None if unknown).
      infra             – optional Infra block (None for local runs).
      source_sha        – git HEAD the run executed from (None if unknown or the
                          tracked tree was dirty, so a card never claims it).
      started_at        – wall-clock epoch when the run started.
      finished_at       – wall-clock epoch when every task reached a verdict
                          (None while any task is still queued/running).
    """

    run_id: str
    elapsed_s: float
    world_model_mode: Optional[str] = None
    total_tasks: Optional[int] = None
    task_names: List[str] = field(default_factory=list)
    per_task: List[TaskCard] = field(default_factory=list)
    agents_llm_usd: Optional[float] = None
    llm_call_count: Optional[int] = None
    tree_agent_count: Optional[int] = None
    tokens_in: Optional[int] = None
    tokens_out: Optional[int] = None
    wmh_grounding_usd: Optional[float] = None
    # WMH inference tokens (the simulator's own Rose calls). Folded into the
    # headline token counts so the dash reflects total tokens burned, not just
    # the agent tree's. None when no WMH is served (real runs).
    wmh_tokens_in: Optional[int] = None
    wmh_tokens_out: Optional[int] = None
    # vCPU / machine cost for the run's isolated Fly machine(s) over the run's
    # wallclock (rate × elapsed). Folded into total_usd. None off-cloud.
    infra_usd: Optional[float] = None
    fast_cache_hit_rate: Optional[float] = None
    infra: Optional["Infra"] = None
    source_sha: Optional[str] = None
    started_at: Optional[float] = None
    finished_at: Optional[float] = None


@dataclass
class Infra:
    """Cloud-stack infra metrics. All OPTIONAL — omitted/None for local runs."""

    fleet_machines: Optional[int] = None
    peak_machines: Optional[int] = None
    wmh_served: Optional[bool] = None
    queue_depth: Optional[int] = None


def clean_source_sha(repo: Union[str, Path]) -> Optional[str]:
    """HEAD when tracked source is clean (native output history excluded); None on errors.

    A dirty checkout did not run HEAD's bytes, so the card records no source
    rather than a misleading one.
    """
    try:
        git = ["git", "-C", str(repo)]
        sha = subprocess.run([*git, "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
        dirty = subprocess.run([*git, "diff", "--no-renames", "--name-only", "-z", "HEAD"],
                               capture_output=True, timeout=30, check=True).stdout.split(b"\0")
        unmerged = subprocess.run([*git, "ls-files", "--unmerged", "-z"],
                                  capture_output=True, timeout=30, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return sha if (re.fullmatch(r"[0-9a-f]{40}", sha) and not unmerged
                   and all(not path or path.startswith(b"agents/benchmarks/history/") for path in dirty)) else None


def _is_running(status: str) -> bool:
    return status in {"running"}


def _is_queued(status: str) -> bool:
    return status in {"queued"}


def _is_completed(status: str) -> bool:
    return status in {"passed", "failed", "transient", "skipped", "error", "cancelled"}


def card_status(benchmark_status: Optional[str], passed: bool) -> str:
    """Per-task card status from the harness verdict.

    A task the run interrupted (benchmark_status CANCELLED: never started, or stopped
    mid-flight by a run stop) has no task verdict; it is ``cancelled``, never an agent
    ``failed``.
    """
    verdict = str(benchmark_status or "").upper()
    if verdict == "SKIPPED":
        return "skipped"
    if verdict == "CANCELLED" and not passed:
        return "cancelled"
    return "passed" if passed else "failed"


def build_report_card(state: RunState) -> dict:
    """Build the report-card dict from a RunState. Pure — no clock, no I/O."""
    if state.task_names:
        # Consume per_task cards in order so intentional k-repeats of the same
        # task name (e.g. `bench A A A`) keep independent statuses. A dict keyed
        # by name would collapse three parallel runs into one card and paint all
        # three slots with whichever result finished last.
        from collections import defaultdict, deque

        pools: dict[str, deque[TaskCard]] = defaultdict(deque)
        for card in state.per_task:
            pools[card.name].append(card)
        per_task = []
        for name in state.task_names:
            if pools[name]:
                per_task.append(pools[name].popleft())
            else:
                per_task.append(TaskCard(name=name, status="queued", tokens_in=0, tokens_out=0))
        for leftover in pools.values():
            per_task.extend(leftover)
    else:
        per_task = list(state.per_task)

    total = state.total_tasks if state.total_tasks is not None else max(len(state.task_names), len(per_task))
    running = sum(1 for t in per_task if _is_running(t.status))
    completed = sum(1 for t in per_task if _is_completed(t.status))
    # Queued = explicit queued cards, plus any total-vs-known shortfall (tasks
    # the run knows exist but hasn't created a card for yet).
    explicit_queued = sum(1 for t in per_task if _is_queued(t.status))
    implicit_queued = max(0, total - len(per_task))
    queued = explicit_queued + implicit_queued

    passed = sum(1 for t in per_task if t.status == "passed")
    failed = sum(1 for t in per_task if t.status == "failed" or t.status == "error")
    transient = sum(1 for t in per_task if t.status == "transient")
    cancelled = sum(1 for t in per_task if t.status == "cancelled")
    decided = passed + failed
    success_rate = round(passed / decided, 3) if decided > 0 else 0.0

    if state.agents_llm_usd is not None:
        agents_llm_usd = round(state.agents_llm_usd, 4)
    else:
        agents_llm_usd = round(sum(t.cost_usd or 0.0 for t in per_task), 4)

    wmh_grounding_usd = round(state.wmh_grounding_usd, 4) if state.wmh_grounding_usd is not None else None
    # Infra (vCPU/machine) cost: prefer the run-level value; else sum per-bench.
    infra_usd = (
        round(state.infra_usd, 4)
        if state.infra_usd is not None
        else (
            round(sum(float(t.infra_usd) for t in per_task if t.infra_usd is not None), 4)
            if any(t.infra_usd is not None for t in per_task)
            else None
        )
    )
    total_usd = round(agents_llm_usd + (wmh_grounding_usd or 0.0) + (infra_usd or 0.0), 4)

    cost = {
        "agents_llm_usd": agents_llm_usd,
        "wmh_grounding_usd": wmh_grounding_usd,
        "infra_usd": infra_usd,
        "total_usd": total_usd,
        "fast_cache_hit_rate": state.fast_cache_hit_rate,
    }
    agent_tokens_in = (
        int(state.tokens_in) if state.tokens_in is not None else sum(int(t.tokens_in or 0) for t in per_task)
    )
    agent_tokens_out = (
        int(state.tokens_out) if state.tokens_out is not None else sum(int(t.tokens_out or 0) for t in per_task)
    )
    wmh_tokens_in = int(state.wmh_tokens_in or 0)
    wmh_tokens_out = int(state.wmh_tokens_out or 0)
    # Headline counts INCLUDE WMH inference tokens (per the cost spec); the
    # breakout keeps agent-vs-WMH attribution available to the dashboard.
    metadata = {
        "tokens_in": agent_tokens_in + wmh_tokens_in,
        "tokens_out": agent_tokens_out + wmh_tokens_out,
        "agent_tokens_in": agent_tokens_in,
        "agent_tokens_out": agent_tokens_out,
        "wmh_tokens_in": wmh_tokens_in,
        "wmh_tokens_out": wmh_tokens_out,
    }

    infra: Optional[dict] = None
    if state.infra is not None:
        infra = {
            "fleet_machines": state.infra.fleet_machines,
            "peak_machines": state.infra.peak_machines,
            "wmh_served": state.infra.wmh_served,
            "queue_depth": state.infra.queue_depth,
        }

    return {
        "run_id": state.run_id,
        "source_sha": state.source_sha,
        "started_at": state.started_at,
        "finished_at": state.finished_at,
        "elapsed_s": round(state.elapsed_s, 1),
        "world_model_mode": state.world_model_mode,
        "tasks": {
            "total": total,
            "running": running,
            "completed": completed,
            "queued": queued,
        },
        "results": {
            "passed": passed,
            "failed": failed,
            "transient": transient,
            "cancelled": cancelled,
            "success_rate": success_rate,
        },
        "cost": cost,
        "infra": infra,
        "metadata": metadata,
        "per_task": [
            {
                "name": t.name,
                "status": t.status,
                "duration_s": round(t.duration_s, 1) if t.duration_s is not None else None,
                "cost_usd": round(t.cost_usd, 4) if t.cost_usd is not None else None,
                "agent_url": t.agent_url,
                "agent_id": t.agent_id,
                "outcome_sha256": t.outcome_sha256,
                "tokens_in": int(t.tokens_in or 0),
                "tokens_out": int(t.tokens_out or 0),
                "world_model_mode": t.world_model_mode or state.world_model_mode,
                "fast_mode": bool(t.fast_mode) if t.fast_mode is not None else None,
                "infra_usd": round(t.infra_usd, 4) if t.infra_usd is not None else None,
            }
            for t in per_task
        ],
    }


def _fmt_usd(value: Optional[float]) -> str:
    return f"${value:.4f}" if value is not None else "—"


def _fmt_pct(value: Optional[float]) -> str:
    return f"{value:.0%}" if value is not None else "—"


def _fmt_dur(value: Optional[float]) -> str:
    return f"{value:.0f}s" if value is not None else "—"


def render_report_card(card: dict) -> str:
    """Compact terminal-friendly table. Pure — takes a built card dict."""
    tasks = card.get("tasks", {})
    results = card.get("results", {})
    cost = card.get("cost", {})
    infra = card.get("infra")

    lines: List[str] = []
    header = (
        f"[report-card] run={card.get('run_id')} "
        f"elapsed={card.get('elapsed_s')}s "
        f"mode={card.get('world_model_mode') or '—'}"
    )
    lines.append(header)
    lines.append(
        "  tasks: "
        f"total={tasks.get('total', 0)} "
        f"running={tasks.get('running', 0)} "
        f"completed={tasks.get('completed', 0)} "
        f"queued={tasks.get('queued', 0)}"
    )
    lines.append(
        "  results: "
        f"passed={results.get('passed', 0)} "
        f"failed={results.get('failed', 0)} "
        f"transient={results.get('transient', 0)} "
        f"success_rate={_fmt_pct(results.get('success_rate'))}"
    )
    lines.append(
        "  cost: "
        f"agents_llm={_fmt_usd(cost.get('agents_llm_usd'))} "
        f"wmh={_fmt_usd(cost.get('wmh_grounding_usd'))} "
        f"total={_fmt_usd(cost.get('total_usd'))} "
        f"cache_hit={_fmt_pct(cost.get('fast_cache_hit_rate'))}"
    )
    if infra:
        lines.append(
            "  infra: "
            f"fleet={infra.get('fleet_machines') if infra.get('fleet_machines') is not None else '—'} "
            f"peak={infra.get('peak_machines') if infra.get('peak_machines') is not None else '—'} "
            f"wmh_served={infra.get('wmh_served') if infra.get('wmh_served') is not None else '—'} "
            f"queue_depth={infra.get('queue_depth') if infra.get('queue_depth') is not None else '—'}"
        )

    per_task = card.get("per_task", [])
    if per_task:
        lines.append(f"  {'task':<28} {'status':<10} {'dur':>7} {'cost':>10}")
        lines.append(f"  {'-' * 28} {'-' * 10} {'-' * 7} {'-' * 10}")
        for t in per_task:
            lines.append(
                f"  {str(t.get('name', ''))[:28]:<28} "
                f"{str(t.get('status', ''))[:10]:<10} "
                f"{_fmt_dur(t.get('duration_s')):>7} "
                f"{_fmt_usd(t.get('cost_usd')):>10}"
            )
    return "\n".join(lines)


def write_report_card(card: dict, context_dir: Union[str, Path]) -> Path:
    """Atomically write `report-card.json` under the run's context dir."""
    directory = Path(context_dir)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "report-card.json"

    payload = json.dumps(card, indent=2, sort_keys=False)
    # Atomic write: temp file in the same dir, then os.replace.
    fd, tmp_path = tempfile.mkstemp(dir=str(directory), prefix=".report-card.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, target)
    except BaseException:
        # Best-effort cleanup of the temp file on failure.
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    return target


class ReportCardEmitter:
    """Cadence-driven emitter: render to stdout + write JSON at most once per second.

    The clock is injected (`now`) so cadence is deterministically testable.
    `maybe_emit` emits when >= EMIT_INTERVAL_S has elapsed since the last emit,
    or when `force=True` (final emit). The first `maybe_emit` at t=0 must be
    called with `force=True` to guarantee an initial card.
    """

    def __init__(
        self,
        context_dir: Union[str, Path],
        *,
        now: Callable[[], float] = time.monotonic,
        interval_s: float = EMIT_INTERVAL_S,
        stream: Optional[Callable[[str], None]] = None,
    ) -> None:
        self._context_dir = Path(context_dir)
        self._now = now
        self._interval_s = interval_s
        self._emit = stream if stream is not None else print
        self._last_emit_at: Optional[float] = None
        self.last_card: Optional[dict] = None

    def _should_emit(self, force: bool) -> bool:
        if force:
            return True
        if self._last_emit_at is None:
            return True
        return (self._now() - self._last_emit_at) >= self._interval_s

    def maybe_emit(self, state: RunState, *, force: bool = False) -> Optional[dict]:
        """Emit the report card if due (or forced). Returns the card or None."""
        if not self._should_emit(force):
            return None
        card = build_report_card(state)
        messages = [render_report_card(card)]
        try:
            write_report_card(card, self._context_dir)
        except OSError as e:
            # Writing the JSON must never crash a live benchmark run.
            messages.append(f"[report-card] ⚠ write failed (non-fatal): {e}")
        self._last_emit_at = self._now()
        self.last_card = card
        # Persist the native projection before optional console output.
        for message in messages:
            try:
                self._emit(message)
            except (OSError, ValueError):
                pass  # A closed output sink cannot replace the canonical outcome.
        return card
