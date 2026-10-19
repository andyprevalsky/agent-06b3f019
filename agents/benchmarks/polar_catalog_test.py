"""Polar-bench catalog integration: Odysseys + BU Bench V1, never daily."""

from __future__ import annotations

import json
from pathlib import Path

from benchmarks.benchmark_tasks import (
    all_tasks,
    get_task_by_name,
    get_tasks_by_tag,
    suite_tasks,
)
from benchmarks.long_horizon import validate_catalog
from benchmarks.polar_catalog import (
    POLAR_GROUP,
    POLAR_TAG,
    build_polar_catalog_tasks,
    is_polar_bench_task,
    load_polar_tasks_file,
    write_polar_tasks_file,
)
import benchmarks.run_benchmark as rb


def test_polar_tasks_file_matches_sources(tmp_path):
    """Committed polar_tasks.json stays in sync with polar/*.json sources."""
    built = build_polar_catalog_tasks()
    committed = load_polar_tasks_file()
    assert len(built) == len(committed) == 300
    assert [t["name"] for t in built] == [t["name"] for t in committed]
    assert built == committed
    # Rebuilding is a semantic no-op. Write to a scratch copy: the committed
    # file's secret-substring escaping depends on the caller's environment.
    committed_path = Path(__file__).resolve().parent / "polar_tasks.json"
    rebuilt_path = tmp_path / "polar_tasks.json"
    write_polar_tasks_file(rebuilt_path)
    assert json.loads(rebuilt_path.read_text()) == json.loads(committed_path.read_text())


def test_polar_bench_group_and_tags_never_daily():
    polar = get_tasks_by_tag(POLAR_TAG)
    assert len(polar) == 300
    assert all(t.group == POLAR_GROUP for t in polar)
    assert all(POLAR_TAG in t.tags for t in polar)
    assert all("daily" not in t.tags for t in polar)
    assert all(t.group != "daily" for t in polar)
    assert all(t.bench == "rose-bench" for t in polar)
    assert all(t.status == "ready" for t in polar)
    assert all(t.requires_browser_agent for t in polar)
    assert all(t.enforce_declared_evaluators for t in polar)
    assert all(t.approval_handling is None for t in polar)
    # Polar slice uses the isolated Odysseys-faithful evaluator only.
    assert all(
        e.get("method") == "polar" for t in polar for e in (t.evaluators or [])
    )
    assert all(
        isinstance((t.evaluators or [{}])[0].get("rubrics"), list)
        and (t.evaluators or [{}])[0]["rubrics"]
        for t in polar
    )

    odysseys = [t for t in polar if "odysseys" in t.tags]
    bu = [t for t in polar if "bu-bench" in t.tags]
    assert len(odysseys) == 200
    assert len(bu) == 100
    assert get_task_by_name("polar-bu-001").name == "polar-bu-001"
    assert get_task_by_name(odysseys[0].name).group == POLAR_GROUP


def test_polar_step_budgets_disable_wall_clock():
    """Polar evals are step-budgeted (easy/medium/hard), not wall-clock timed."""
    from benchmarks.polar_catalog import (
        polar_browser_step_budget,
        polar_wall_clock_disabled,
    )

    polar = get_tasks_by_tag(POLAR_TAG)
    assert all(t.timeout_seconds == 0 for t in polar)
    assert all(polar_wall_clock_disabled(t) for t in polar)
    assert all(t.max_steps.get("browser") for t in polar)

    expected = {"easy": 100, "medium": 250, "hard": 500}
    for level, budget in expected.items():
        level_tasks = [t for t in polar if level in t.tags and "odysseys" in t.tags]
        assert level_tasks
        assert all(t.max_steps == {"browser": budget} for t in level_tasks)
        assert all(polar_browser_step_budget(t) == budget for t in level_tasks)

    bu = [t for t in polar if "bu-bench" in t.tags]
    assert all(t.max_steps == {"browser": 100} for t in bu)
    assert all(polar_browser_step_budget(t) == 100 for t in bu)


def test_polar_bench_excluded_from_default_suites_and_browser_tag():
    assert all(not is_polar_bench_task(t) for t in suite_tasks())
    browser = get_tasks_by_tag("browser")
    assert all(not is_polar_bench_task(t) for t in browser)
    assert len(browser) >= 8

    class _Args:
        suite = "all"
        anon = False
        prod = False
        exclude_task = []
        task = None

    selected = rb.resolve_tasks(_Args())
    assert selected
    assert all(not is_polar_bench_task(t) for t in selected)

    class _PolarArgs:
        suite = POLAR_TAG
        anon = False
        prod = False
        exclude_task = []
        task = None

    polar_selected = rb.resolve_tasks(_PolarArgs())
    assert len(polar_selected) == 300
    assert all(is_polar_bench_task(t) for t in polar_selected)

    class _RoseArgs:
        suite = "rose-bench"
        anon = False
        prod = False
        exclude_task = []
        task = None

    rose_selected = rb.resolve_tasks(_RoseArgs())
    assert rose_selected
    assert all(not is_polar_bench_task(t) for t in rose_selected)


def test_validate_catalog_includes_polar_slice():
    tasks = validate_catalog()
    polar = [t for t in tasks if is_polar_bench_task(t)]
    assert len(tasks) >= 300
    assert len(polar) == 300
    assert all(t.get("group") == POLAR_GROUP for t in polar)
    # Ground-truth answers stay in evaluators, never in the agent prompt.
    bu_with_answer = json.loads(
        (Path(__file__).resolve().parent / "polar" / "bu_bench_v1.json").read_text()
    )
    answered = [t for t in bu_with_answer if t.get("answer")]
    assert answered
    for src in answered[:5]:
        catalog = next(t for t in polar if src["task_id"] in " ".join(t.get("source") or []))
        assert src["answer"] not in catalog["prompt"]
        criteria_blob = " ".join(catalog["evaluators"][0]["criteria"])
        assert src["answer"] in criteria_blob


def test_all_tasks_merges_first_party_and_polar():
    names = [t.name for t in all_tasks()]
    assert len(names) == len(set(names))
    assert any(n.startswith("polar-odysseys-") for n in names)
    assert "polar-bu-001" in names
    # First-party smoke still present
    assert "chat-mode" in names or "test-mass-agent-run-0" in names


def test_polar_create_agent_defaults_write_lock_off(monkeypatch):
    """Polar public-web tasks must not stall on product write-lock pauses."""
    import benchmarks.run_benchmark as rb
    from benchmarks.benchmark_tasks import get_task_by_name

    polar = get_task_by_name("polar-bu-001")
    daily = next(t for t in all_tasks() if t.group == "daily" and t.approval_handling is None)

    monkeypatch.delenv("BENCHMARK_WRITE_LOCK_ENABLED", raising=False)
    assert rb._resolve_write_lock_enabled(polar) is False
    assert rb._resolve_write_lock_enabled(daily) is None

    monkeypatch.setenv("BENCHMARK_WRITE_LOCK_ENABLED", "true")
    assert rb._resolve_write_lock_enabled(polar) is True
    monkeypatch.setenv("BENCHMARK_WRITE_LOCK_ENABLED", "false")
    assert rb._resolve_write_lock_enabled(polar) is False
