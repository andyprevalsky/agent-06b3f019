"""Tests for the standardized live benchmark report card.

Integration recipe (for the integrator wiring run_benchmark.py's parallel loop):

    from benchmarks.report_card import ReportCardEmitter, RunState, TaskCard

    emitter = ReportCardEmitter(os.environ.get("BENCHMARK_CONTEXT_DIR", ".context"))
    start = time.monotonic()

    def _snapshot() -> RunState:
        per_task = []
        for r in run.task_results:            # finished tasks
            per_task.append(TaskCard(
                name=r.name,
                status=("skipped" if r.status == "SKIPPED"
                        else "passed" if r.passed else "failed"),
                duration_s=r.duration_seconds,
                cost_usd=r.cost_cents / 100.0,
                agent_url=(f"{_frontend_url_for_benchmark(base_url)}/?agent-id={r.agent_id}"
                           if r.agent_id else None),
            ))
        finished = {r.name for r in run.task_results}
        for t in parallel_batch:              # still-running tasks
            if t.name not in finished:
                per_task.append(TaskCard(name=t.name, status="running"))
        return RunState(
            run_id=run.run_id,
            elapsed_s=time.monotonic() - start,
            world_model_mode=os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real"),
            total_tasks=len(tasks),
            per_task=per_task,
        )

    # inside the `while pending:` drain, after appending results:
    emitter.maybe_emit(_snapshot())
    # after the loop finishes:
    emitter.maybe_emit(_snapshot(), force=True)
"""

import json

from benchmarks.report_card import (
    EMIT_INTERVAL_S,
    Infra,
    ReportCardEmitter,
    RunState,
    TaskCard,
    build_report_card,
    render_report_card,
    write_report_card,
)


def _sample_state(**overrides) -> RunState:
    base = dict(
        run_id="run-abc",
        elapsed_s=615.0,
        world_model_mode="simulate",
        total_tasks=4,
        per_task=[
            TaskCard(name="chat-mode", status="passed", duration_s=74.0, cost_usd=0.09,
                     agent_url="http://localhost:5050/?agent-id=aaa"),
            TaskCard(name="web-search", status="failed", duration_s=120.0, cost_usd=0.20),
            TaskCard(name="grep", status="running"),
            TaskCard(name="deep-research", status="queued"),
        ],
    )
    base.update(overrides)
    return RunState(**base)


# --- schema + types ---------------------------------------------------------


def test_report_card_schema_fields_and_types():
    card = build_report_card(_sample_state())

    assert card["run_id"] == "run-abc"
    assert isinstance(card["elapsed_s"], float)
    assert card["world_model_mode"] == "simulate"

    tasks = card["tasks"]
    for key in ("total", "running", "completed", "queued"):
        assert key in tasks and isinstance(tasks[key], int)
    assert tasks["total"] == 4
    assert tasks["running"] == 1
    assert tasks["completed"] == 2  # passed + failed
    assert tasks["queued"] == 1

    results = card["results"]
    for key in ("passed", "failed", "transient", "success_rate"):
        assert key in results
    assert isinstance(results["passed"], int)
    assert isinstance(results["failed"], int)
    assert isinstance(results["transient"], int)
    assert isinstance(results["success_rate"], float)

    cost = card["cost"]
    for key in ("agents_llm_usd", "wmh_grounding_usd", "total_usd", "fast_cache_hit_rate"):
        assert key in cost
    assert isinstance(cost["agents_llm_usd"], float)
    assert isinstance(cost["total_usd"], float)

    assert isinstance(card["per_task"], list)
    row = card["per_task"][0]
    for key in ("name", "status", "duration_s", "cost_usd", "agent_url"):
        assert key in row


def test_cost_derived_from_per_task_when_not_supplied():
    card = build_report_card(_sample_state())
    # 0.09 + 0.20 (queued/running contribute 0)
    assert card["cost"]["agents_llm_usd"] == 0.29
    # No WMH grounding for local run → total equals agents cost.
    assert card["cost"]["wmh_grounding_usd"] is None
    assert card["cost"]["total_usd"] == 0.29


def test_cost_with_wmh_grounding():
    card = build_report_card(_sample_state(wmh_grounding_usd=1.5, agents_llm_usd=4.0))
    assert card["cost"]["agents_llm_usd"] == 4.0
    assert card["cost"]["wmh_grounding_usd"] == 1.5
    assert card["cost"]["total_usd"] == 5.5


# --- success_rate math ------------------------------------------------------


def test_success_rate_math():
    state = _sample_state(
        per_task=[
            TaskCard(name="a", status="passed"),
            TaskCard(name="b", status="passed"),
            TaskCard(name="c", status="passed"),
            TaskCard(name="d", status="failed"),
        ],
        total_tasks=4,
    )
    card = build_report_card(state)
    assert card["results"]["passed"] == 3
    assert card["results"]["failed"] == 1
    assert card["results"]["success_rate"] == 0.75


def test_success_rate_divide_by_zero_is_zero():
    state = _sample_state(
        per_task=[
            TaskCard(name="a", status="running"),
            TaskCard(name="b", status="queued"),
        ],
        total_tasks=2,
    )
    card = build_report_card(state)
    assert card["results"]["passed"] == 0
    assert card["results"]["failed"] == 0
    assert card["results"]["success_rate"] == 0.0


def test_transient_counted_separately_and_excluded_from_success_rate():
    state = _sample_state(
        per_task=[
            TaskCard(name="a", status="passed"),
            TaskCard(name="b", status="failed"),
            TaskCard(name="c", status="transient"),
        ],
        total_tasks=3,
    )
    card = build_report_card(state)
    assert card["results"]["transient"] == 1
    # transient is NOT in the passed/failed denominator.
    assert card["results"]["success_rate"] == 0.5
    # but it IS a completed task.
    assert card["tasks"]["completed"] == 3


def test_error_status_counts_as_failed():
    state = _sample_state(
        per_task=[
            TaskCard(name="a", status="passed"),
            TaskCard(name="b", status="error"),
        ],
        total_tasks=2,
    )
    card = build_report_card(state)
    assert card["results"]["failed"] == 1
    assert card["results"]["success_rate"] == 0.5


def test_implicit_queued_from_total_shortfall():
    # Run knows 5 tasks exist but only 2 cards created so far.
    state = _sample_state(
        per_task=[
            TaskCard(name="a", status="running"),
            TaskCard(name="b", status="passed"),
        ],
        total_tasks=5,
    )
    card = build_report_card(state)
    assert card["tasks"]["total"] == 5
    assert card["tasks"]["queued"] == 3  # 5 total - 2 known cards


def test_total_defaults_to_per_task_length():
    state = _sample_state(total_tasks=None)
    card = build_report_card(state)
    assert card["tasks"]["total"] == 4


# --- optional fields --------------------------------------------------------


def test_infra_optional_none_for_local():
    card = build_report_card(_sample_state(infra=None))
    assert card["infra"] is None


def test_infra_present_when_provided():
    card = build_report_card(
        _sample_state(
            infra=Infra(fleet_machines=12, peak_machines=18, wmh_served=True, queue_depth=2)
        )
    )
    assert card["infra"] == {
        "fleet_machines": 12,
        "peak_machines": 18,
        "wmh_served": True,
        "queue_depth": 2,
    }


def test_fast_cache_hit_rate_optional():
    card = build_report_card(_sample_state(fast_cache_hit_rate=None))
    assert card["cost"]["fast_cache_hit_rate"] is None
    card2 = build_report_card(_sample_state(fast_cache_hit_rate=0.71))
    assert card2["cost"]["fast_cache_hit_rate"] == 0.71


def test_per_task_optional_fields_none():
    card = build_report_card(_sample_state())
    running_row = next(r for r in card["per_task"] if r["name"] == "grep")
    assert running_row["duration_s"] is None
    assert running_row["cost_usd"] is None
    assert running_row["agent_url"] is None


# --- render -----------------------------------------------------------------


def test_render_is_non_empty_and_has_key_aggregates():
    card = build_report_card(_sample_state())
    out = render_report_card(card)
    assert isinstance(out, str)
    assert out.strip()
    assert "run-abc" in out
    assert "tasks:" in out
    assert "results:" in out
    assert "cost:" in out
    # per-task rows present
    assert "chat-mode" in out
    assert "web-search" in out


def test_render_with_infra_includes_infra_line():
    card = build_report_card(
        _sample_state(infra=Infra(fleet_machines=12, peak_machines=18, wmh_served=True, queue_depth=2))
    )
    out = render_report_card(card)
    assert "infra:" in out
    assert "fleet=12" in out


def test_render_without_per_task():
    card = build_report_card(
        _sample_state(per_task=[], total_tasks=0)
    )
    out = render_report_card(card)
    assert out.strip()
    assert "run-abc" in out


# --- write ------------------------------------------------------------------


def test_write_report_card_atomic(tmp_path):
    card = build_report_card(_sample_state())
    ctx = tmp_path / "benchmarks" / "run-abc"
    path = write_report_card(card, ctx)
    assert path.exists()
    assert path.name == "report-card.json"
    loaded = json.loads(path.read_text())
    assert loaded["run_id"] == "run-abc"
    # no leftover temp files
    leftovers = [p for p in ctx.iterdir() if p.name.startswith(".report-card.")]
    assert leftovers == []


def test_write_report_card_creates_missing_dirs(tmp_path):
    card = build_report_card(_sample_state())
    ctx = tmp_path / "a" / "b" / "c"
    path = write_report_card(card, ctx)
    assert path.exists()


def test_write_report_card_cleans_temp_on_replace_failure(tmp_path, monkeypatch):
    import os as _os

    card = build_report_card(_sample_state())
    ctx = tmp_path / "run-x"

    def _boom(src, dst):
        raise OSError("simulated replace failure")

    monkeypatch.setattr(_os, "replace", _boom)
    try:
        write_report_card(card, ctx)
        assert False, "expected OSError to propagate"
    except OSError:
        pass
    # temp file cleaned up despite the failure
    leftovers = [p for p in ctx.iterdir() if p.name.startswith(".report-card.")]
    assert leftovers == []


def test_emitter_write_failure_is_non_fatal(tmp_path, monkeypatch):
    import benchmarks.report_card as rc

    clock = _FakeClock()
    captured: list[str] = []
    emitter = ReportCardEmitter(tmp_path, now=clock, stream=captured.append)

    def _boom(card, context_dir):
        raise OSError("disk full")

    monkeypatch.setattr(rc, "write_report_card", _boom)
    clock.t = 0.0
    # Must not raise; must still return the card and log a non-fatal warning.
    card = emitter.maybe_emit(_sample_state(), force=True)
    assert card is not None
    assert any("write failed" in line for line in captured)


# --- emitter cadence --------------------------------------------------------


class _FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def _make_emitter(tmp_path):
    clock = _FakeClock()
    captured: list[str] = []
    emitter = ReportCardEmitter(
        tmp_path,
        now=clock,
        stream=captured.append,
    )
    return emitter, clock, captured


def test_emit_interval_constant():
    assert EMIT_INTERVAL_S == 60.0


def test_cadence_emits_at_t0_force_not_at_t30_yes_at_t61(tmp_path):
    emitter, clock, captured = _make_emitter(tmp_path)
    state = _sample_state()

    # t=0 forced → emits.
    clock.t = 0.0
    card0 = emitter.maybe_emit(state, force=True)
    assert card0 is not None
    assert len(captured) == 1
    assert (tmp_path / "report-card.json").exists()

    # t=30, not forced → within interval → no emit.
    clock.t = 30.0
    card30 = emitter.maybe_emit(state)
    assert card30 is None
    assert len(captured) == 1

    # t=61, not forced → interval elapsed → emit.
    clock.t = 61.0
    card61 = emitter.maybe_emit(state)
    assert card61 is not None
    assert len(captured) == 2


def test_first_maybe_emit_without_force_still_emits(tmp_path):
    # If the very first call is not forced, it should still emit (last_emit None).
    emitter, clock, captured = _make_emitter(tmp_path)
    clock.t = 5.0
    card = emitter.maybe_emit(_sample_state())
    assert card is not None
    assert len(captured) == 1


def test_force_always_emits_even_within_interval(tmp_path):
    emitter, clock, captured = _make_emitter(tmp_path)
    clock.t = 0.0
    emitter.maybe_emit(_sample_state(), force=True)
    clock.t = 10.0
    # forced final emit despite only 10s elapsed
    card = emitter.maybe_emit(_sample_state(), force=True)
    assert card is not None
    assert len(captured) == 2


def test_emitter_tracks_last_card(tmp_path):
    emitter, clock, _ = _make_emitter(tmp_path)
    clock.t = 0.0
    emitter.maybe_emit(_sample_state(), force=True)
    assert emitter.last_card is not None
    assert emitter.last_card["run_id"] == "run-abc"


def test_exactly_at_interval_emits(tmp_path):
    emitter, clock, captured = _make_emitter(tmp_path)
    clock.t = 0.0
    emitter.maybe_emit(_sample_state(), force=True)
    clock.t = 60.0  # exactly the interval
    card = emitter.maybe_emit(_sample_state())
    assert card is not None
    assert len(captured) == 2
