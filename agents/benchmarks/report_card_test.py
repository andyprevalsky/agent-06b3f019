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
    clean_source_sha,
    render_report_card,
    write_report_card,
)
from benchmarks.run_benchmark import _frontend_url_for_benchmark, _report_frontend_url_for_benchmark


def _sample_state(**overrides) -> RunState:
    base = dict(
        run_id="run-abc",
        elapsed_s=615.0,
        world_model_mode="simulate",
        total_tasks=4,
        per_task=[
            TaskCard(name="chat-mode", status="passed", duration_s=74.0, cost_usd=0.09,
                     agent_url="http://localhost:5050/?agent-id=aaa", tokens_in=1200,
                     tokens_out=300),
            TaskCard(name="web-search", status="failed", duration_s=120.0, cost_usd=0.20,
                     tokens_in=2000, tokens_out=500),
            TaskCard(name="grep", status="running"),
            TaskCard(name="deep-research", status="queued"),
        ],
    )
    base.update(overrides)
    return RunState(**base)


def test_report_frontend_url_does_not_override_prompt_frontend_url(monkeypatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://public.example")
    monkeypatch.setenv("BENCHMARK_REPORT_FRONTEND_URL", "https://roselabs.ai")
    monkeypatch.delenv("BENCHMARK_FRONTEND_URL", raising=False)
    monkeypatch.delenv("BENCHMARK_REPORT_ALLOW_EPHEMERAL", raising=False)

    assert _frontend_url_for_benchmark("http://127.0.0.1:3099") == "https://public.example"
    assert _report_frontend_url_for_benchmark("http://127.0.0.1:3099") == "https://roselabs.ai"


def test_report_frontend_url_rejects_ephemeral_hosts_by_default(monkeypatch):
    monkeypatch.setenv("BENCHMARK_REPORT_FRONTEND_URL", "http://localhost:60784")
    monkeypatch.delenv("BENCHMARK_REPORT_ALLOW_EPHEMERAL", raising=False)
    assert _report_frontend_url_for_benchmark("http://127.0.0.1:3099") == "https://roselabs.ai"

    monkeypatch.setenv("BENCHMARK_REPORT_ALLOW_EPHEMERAL", "1")
    assert _report_frontend_url_for_benchmark("http://127.0.0.1:3099") == "http://localhost:60784"


def test_report_frontend_url_defaults_to_durable_prod(monkeypatch):
    monkeypatch.delenv("BENCHMARK_REPORT_FRONTEND_URL", raising=False)
    monkeypatch.delenv("BENCHMARK_REPORT_ALLOW_EPHEMERAL", raising=False)
    monkeypatch.setenv("CONDUCTOR_PORT", "3001")
    assert _report_frontend_url_for_benchmark("http://127.0.0.1:3099") == "https://roselabs.ai"


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
    for key in ("agents_llm_usd", "wmh_grounding_usd", "infra_usd", "total_usd", "fast_cache_hit_rate"):
        assert key in cost
    assert isinstance(cost["agents_llm_usd"], float)
    assert isinstance(cost["total_usd"], float)

    assert isinstance(card["per_task"], list)
    row = card["per_task"][0]
    for key in (
        "name",
        "status",
        "duration_s",
        "cost_usd",
        "agent_url",
        "tokens_in",
        "tokens_out",
        "world_model_mode",
        "infra_usd",
    ):
        assert key in row
    assert "stop_metadata" not in row
    # Headline counts include WMH tokens (0 here); breakout keeps attribution.
    assert card["metadata"] == {
        "tokens_in": 3200,
        "tokens_out": 800,
        "agent_tokens_in": 3200,
        "agent_tokens_out": 800,
        "wmh_tokens_in": 0,
        "wmh_tokens_out": 0,
    }


def test_wmh_tokens_fold_into_headline_and_infra_folds_into_total():
    state = _sample_state(
        wmh_tokens_in=10_000,
        wmh_tokens_out=2_000,
        wmh_grounding_usd=0.05,
        infra_usd=0.02,
    )
    card = build_report_card(state)
    meta = card["metadata"]
    # per_task agent totals are 1200+2000=3200 in / 300+500=800 out (from _sample_state)
    assert meta["agent_tokens_in"] == 3200 and meta["agent_tokens_out"] == 800
    assert meta["wmh_tokens_in"] == 10_000 and meta["wmh_tokens_out"] == 2_000
    assert meta["tokens_in"] == 13_200 and meta["tokens_out"] == 2_800
    # total = agents_llm + wmh_grounding + infra
    cost = card["cost"]
    assert cost["infra_usd"] == 0.02
    assert cost["total_usd"] == round(cost["agents_llm_usd"] + 0.05 + 0.02, 4)


def test_infra_usd_derived_from_per_task_when_run_level_absent():
    state = _sample_state(
        per_task=[
            TaskCard(name="a", status="passed", cost_usd=0.10, infra_usd=0.03),
            TaskCard(name="b", status="passed", cost_usd=0.20, infra_usd=0.04),
        ],
        total_tasks=2,
    )
    card = build_report_card(state)
    assert card["cost"]["infra_usd"] == 0.07


def test_per_task_world_model_mode_inherits_run_mode_or_overrides():
    # Per-task None inherits the run-level mode; an explicit per-task mode wins
    # (per-bench isolation → each bench can differ within one aggregated card).
    state = _sample_state(
        world_model_mode="simulate",
        per_task=[
            TaskCard(name="sim-bench", status="running"),
            TaskCard(name="real-bench", status="running", world_model_mode="real"),
        ],
        total_tasks=2,
    )
    rows = {r["name"]: r for r in build_report_card(state)["per_task"]}
    assert rows["sim-bench"]["world_model_mode"] == "simulate"
    assert rows["real-bench"]["world_model_mode"] == "real"


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



def test_duplicate_task_names_keep_independent_statuses():
    """Intentional k-repeats (bench A A A) must not collapse via by-name dict."""
    state = _sample_state(
        task_names=[
            "cuda-kernel-github-top100-code-agent",
            "cuda-kernel-github-top100-code-agent",
            "cuda-kernel-github-top100-code-agent",
        ],
        per_task=[
            TaskCard(
                name="cuda-kernel-github-top100-code-agent",
                status="failed",
                duration_s=1751.0,
                cost_usd=0.63,
            ),
            TaskCard(name="cuda-kernel-github-top100-code-agent", status="running"),
            TaskCard(name="cuda-kernel-github-top100-code-agent", status="running"),
        ],
        total_tasks=3,
    )
    card = build_report_card(state)
    assert card["tasks"] == {"total": 3, "running": 2, "completed": 1, "queued": 0}
    assert card["results"]["failed"] == 1
    assert card["results"]["passed"] == 0
    statuses = [row["status"] for row in card["per_task"]]
    assert statuses == ["failed", "running", "running"]


def test_task_names_render_missing_rows_as_queued():
    state = _sample_state(
        task_names=["chat-mode", "spawn-sub-agents", "parallel-tool-calls", "user-data-prod-grep"],
        per_task=[
            TaskCard(name="chat-mode", status="passed", duration_s=10.0, cost_usd=0.01),
            TaskCard(name="parallel-tool-calls", status="running"),
        ],
        total_tasks=4,
    )
    card = build_report_card(state)
    assert card["tasks"] == {"total": 4, "running": 1, "completed": 1, "queued": 2}
    assert [row["name"] for row in card["per_task"]] == [
        "chat-mode",
        "spawn-sub-agents",
        "parallel-tool-calls",
        "user-data-prod-grep",
    ]
    queued = [row for row in card["per_task"] if row["status"] == "queued"]
    assert {row["name"] for row in queued} == {"spawn-sub-agents", "user-data-prod-grep"}


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
    assert EMIT_INTERVAL_S == 1.0


def test_cadence_emits_at_t0_force_not_at_half_second_yes_at_one_second(tmp_path):
    emitter, clock, captured = _make_emitter(tmp_path)
    state = _sample_state()

    # t=0 forced → emits.
    clock.t = 0.0
    card0 = emitter.maybe_emit(state, force=True)
    assert card0 is not None
    assert len(captured) == 1
    assert (tmp_path / "report-card.json").exists()

    # t=0.5, not forced → within interval → no emit.
    clock.t = 0.5
    card_half_second = emitter.maybe_emit(state)
    assert card_half_second is None
    assert len(captured) == 1

    # t=1.0, not forced → interval elapsed → emit.
    clock.t = 1.0
    card_one_second = emitter.maybe_emit(state)
    assert card_one_second is not None
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
    clock.t = 1.0  # exactly the interval
    card = emitter.maybe_emit(_sample_state())
    assert card is not None
    assert len(captured) == 2


def test_report_card_records_source_clock_and_agent_id():
    card = build_report_card(_sample_state(
        source_sha="a" * 40, started_at=1792629049.0, finished_at=1792630155.5,
        per_task=[TaskCard(name="chat-mode", status="passed", agent_id="aaa",
                           agent_url="http://localhost:5050/?agent-id=aaa")]))
    assert (card["source_sha"], card["started_at"], card["finished_at"]) == ("a" * 40, 1792629049.0, 1792630155.5)
    assert (card["per_task"][0]["agent_id"], card["per_task"][0]["agent_url"]) == (
        "aaa", "http://localhost:5050/?agent-id=aaa")
    unknown = build_report_card(_sample_state())
    assert (unknown["source_sha"], unknown["started_at"], unknown["finished_at"]) == (None, None, None)
    assert unknown["per_task"][2]["agent_id"] is None


def test_clean_source_sha_only_for_clean_git_head(tmp_path):
    import subprocess

    assert clean_source_sha(tmp_path) is None  # not a repository
    git = ["git", "-C", str(tmp_path), "-c", "user.name=t", "-c", "user.email=t@t"]
    subprocess.run([*git, "init", "-q"], check=True)
    (tmp_path / "f.txt").write_text("a")
    subprocess.run([*git, "add", "f.txt"], check=True)
    subprocess.run([*git, "commit", "-qm", "init"], check=True)
    head = subprocess.run([*git, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    (tmp_path / "untracked.txt").write_text("ignored")
    assert clean_source_sha(tmp_path) == head
    (tmp_path / "f.txt").write_text("b")
    assert clean_source_sha(tmp_path) is None  # dirty tracked file: HEAD is not what ran


def test_card_status_keeps_interrupted_tasks_out_of_failures():
    from benchmarks.report_card import card_status

    assert card_status("PASSED", True) == "passed"
    assert card_status("FAILED", False) == "failed"
    assert card_status("CANCELLED", False) == "cancelled"
    assert card_status("SKIPPED", False) == "skipped"
    assert card_status(None, False) == "failed"
    card = build_report_card(RunState(run_id="r", elapsed_s=1.0, total_tasks=2, per_task=[
        TaskCard(name="a", status="failed"), TaskCard(name="b", status="cancelled")]))
    assert (card["results"]["failed"], card["results"]["cancelled"], card["tasks"]["completed"]) == (1, 1, 2)
