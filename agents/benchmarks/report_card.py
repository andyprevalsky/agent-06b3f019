"""Standardized live "report card" for benchmark runs.

Self-contained module: pure builders + a cadence-driven emitter. Emitted every
60s while a run is in flight (and once at the end) to stdout AND
`.context/benchmarks/<run-id>/report-card.json`.

Schema (from docs/plans/active/cloud-branch-benchmarks-simulate.md →
"Standardized live report card"):

    {
      "run_id": "…", "elapsed_s": 615, "world_model_mode": "simulate",
      "tasks":   { "total", "running", "completed", "queued" },
      "results": { "passed", "failed", "transient", "success_rate" },
      "cost":    { "agents_llm_usd", "wmh_grounding_usd", "total_usd",
                   "fast_cache_hit_rate" },
      "infra":   { "fleet_machines", "peak_machines", "wmh_served",
                   "queue_depth" },          # OPTIONAL (None for local runs)
      "per_task":[ { "name", "status", "duration_s", "cost_usd", "agent_url" } ]
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
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional, Union

EMIT_INTERVAL_S: float = 60.0

# Terminal statuses a benchmark task can end in. Anything not terminal is
# considered still "running" for the tasks.running count.
_TERMINAL_STATUSES = {"PASSED", "FAILED", "ERROR", "CANCELLED", "SKIPPED"}


@dataclass
class TaskCard:
    """Per-task live view fed into the report card.

    `status` is a lowercase display status: "passed" | "failed" | "transient"
    | "running" | "queued" | "skipped" | "error". `duration_s` and `cost_usd`
    may be None for tasks that haven't finished. `agent_url` is the FE deep link
    (`http://<frontend>/?agent-id=<agent_id>`), or None if no agent exists yet.
    """

    name: str
    status: str
    duration_s: Optional[float] = None
    cost_usd: Optional[float] = None
    agent_url: Optional[str] = None


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
                          None, falls back to len(per_task).
      per_task          – list[TaskCard], one per task the run knows about.
      agents_llm_usd    – summed agent LLM cost in USD. If None, derived by
                          summing per_task[*].cost_usd.
      wmh_grounding_usd – WMH grounding cost in USD (OPTIONAL; None local).
      fast_cache_hit_rate – 0..1 fast-cache hit rate (OPTIONAL; None if unknown).
      infra             – optional Infra block (None for local runs).
    """

    run_id: str
    elapsed_s: float
    world_model_mode: Optional[str] = None
    total_tasks: Optional[int] = None
    per_task: List[TaskCard] = field(default_factory=list)
    agents_llm_usd: Optional[float] = None
    wmh_grounding_usd: Optional[float] = None
    fast_cache_hit_rate: Optional[float] = None
    infra: Optional["Infra"] = None


@dataclass
class Infra:
    """Cloud-stack infra metrics. All OPTIONAL — omitted/None for local runs."""

    fleet_machines: Optional[int] = None
    peak_machines: Optional[int] = None
    wmh_served: Optional[bool] = None
    queue_depth: Optional[int] = None


def _is_running(status: str) -> bool:
    return status in {"running"}


def _is_queued(status: str) -> bool:
    return status in {"queued"}


def _is_completed(status: str) -> bool:
    return status in {"passed", "failed", "transient", "skipped", "error"}


def build_report_card(state: RunState) -> dict:
    """Build the report-card dict from a RunState. Pure — no clock, no I/O."""
    per_task = list(state.per_task)

    total = state.total_tasks if state.total_tasks is not None else len(per_task)
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
    decided = passed + failed
    success_rate = round(passed / decided, 3) if decided > 0 else 0.0

    if state.agents_llm_usd is not None:
        agents_llm_usd = round(state.agents_llm_usd, 4)
    else:
        agents_llm_usd = round(sum(t.cost_usd or 0.0 for t in per_task), 4)

    wmh_grounding_usd = (
        round(state.wmh_grounding_usd, 4) if state.wmh_grounding_usd is not None else None
    )
    total_usd = round(agents_llm_usd + (wmh_grounding_usd or 0.0), 4)

    cost = {
        "agents_llm_usd": agents_llm_usd,
        "wmh_grounding_usd": wmh_grounding_usd,
        "total_usd": total_usd,
        "fast_cache_hit_rate": state.fast_cache_hit_rate,
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
            "success_rate": success_rate,
        },
        "cost": cost,
        "infra": infra,
        "per_task": [
            {
                "name": t.name,
                "status": t.status,
                "duration_s": round(t.duration_s, 1) if t.duration_s is not None else None,
                "cost_usd": round(t.cost_usd, 4) if t.cost_usd is not None else None,
                "agent_url": t.agent_url,
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
    """Cadence-driven emitter: render to stdout + write JSON at most q60s.

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
        self._emit(render_report_card(card))
        try:
            write_report_card(card, self._context_dir)
        except OSError as e:
            # Writing the JSON must never crash a live benchmark run.
            self._emit(f"[report-card] ⚠ write failed (non-fatal): {e}")
        self._last_emit_at = self._now()
        self.last_card = card
        return card
