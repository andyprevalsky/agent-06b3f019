"""Unit tests for Codex harness runner helpers."""

from __future__ import annotations

import sys
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parents[1]
if str(AGENTS_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENTS_ROOT))

from benchmarks.codex_runner import parse_work_agent_id, build_codex_goal
from benchmarks.benchmark_tasks import BenchmarkTask, get_task_by_name
from benchmarks.long_horizon import validate_catalog


def test_parse_work_agent_id_extracts_uuid():
    output = "done\nROSE_WORK_AGENT_ID=ac267c32-470f-41da-8343-091b8965c410\n"
    assert parse_work_agent_id(output) == "ac267c32-470f-41da-8343-091b8965c410"


def test_parse_work_agent_id_missing_returns_none():
    assert parse_work_agent_id("no marker here") is None


def test_build_codex_goal_includes_task_name_and_benchmark_prompt():
    task = get_task_by_name("claude-code-agent")
    goal = build_codex_goal(task, "List files in /tmp")
    assert task.name in goal
    assert "List files in /tmp" in goal
    assert "ROSE_WORK_AGENT_ID" in goal


def test_food_plan_grocery_task_is_in_daily_ecommerce_catalog():
    tasks = validate_catalog()
    names = {task["name"] for task in tasks if "ecommerce" in task.get("tags", [])}
    assert "browser-doordash-food-plan-grocery-order" in names


def test_effective_harness_resolution(monkeypatch):
    from benchmarks import run_benchmark as rb

    task = BenchmarkTask(
        name="harness-probe",
        title="Harness Probe",
        prompt="probe",
        timeout_seconds=60,
        is_chat_mode=True,
        expected_tools=[],
        tags=[],
        price_limit_cents=10,
        requires_browser_agent=False,
        requires_claude_code=False,
        attachment=None,
        approval_handling=None,
        start_phase=None,
        harness="rose",
    )
    monkeypatch.delenv("BENCHMARK_HARNESS", raising=False)
    assert rb._effective_harness(task) == "rose"
    task.harness = "codex"
    assert rb._effective_harness(task) == "codex"
    monkeypatch.setenv("BENCHMARK_HARNESS", "codex")
    task.harness = "rose"
    assert rb._effective_harness(task) == "codex"


if __name__ == "__main__":
    test_parse_work_agent_id_extracts_uuid()
    test_parse_work_agent_id_missing_returns_none()
    test_build_codex_goal_includes_task_name_and_benchmark_prompt()
    test_food_plan_grocery_task_is_in_daily_ecommerce_catalog()
    print("codex_runner_test: all passed")
