"""run_all_evaluators: every declared evaluator reports a verdict, also for a failed or timed-out run.

Registered in the permanent gate by agents/tests/blackbox/benchmark.blackbox.py
(test_code_agent_checks_are_in_permanent_gate). Without the task option the loop stops at the first
failing evaluator exactly as before, so every other benchmark is unchanged.
"""

from __future__ import annotations

import asyncio
import copy
import dataclasses

import pytest

from benchmarks import code_agent_checks
from benchmarks import run_benchmark as rb
from benchmarks.benchmark_tasks import get_task_by_name
from benchmarks.long_horizon import validate_task_contract

TASK = "code-agent-rose-repo"
SPAWN_ID = "11111111-1111-4111-8111-111111111111"


def _static(evaluator_id: str, check: dict) -> dict:
    return {"id": evaluator_id, "method": "static_check", "criteria": [evaluator_id], "checks": [check]}


def _status(evaluator_id: str, value: str) -> dict:
    return _static(evaluator_id, {"type": "agent_status", "value": value})


def _task(evaluators: list[dict], *, run_all: bool = True):
    return dataclasses.replace(
        get_task_by_name(TASK), enforce_declared_evaluators=True, run_all_evaluators=run_all, evaluators=evaluators
    )


def _run(task, status: str = "COMPLETED", *, static_only: bool = False):
    data = {"agent": {"status": status}, "_benchmark": {}}
    return asyncio.run(rb._run_declared_evaluators(task, data, base_url="http://localhost:1", static_only=static_only))


def _verdicts(results: list[dict]) -> list[tuple[str, bool]]:
    return [(r["id"], r["passed"]) for r in results]


def test_all_evaluators_pass():
    ok, reason, results = _run(_task([_status("a", "COMPLETED"), _status("b", "COMPLETED"), _status("c", "COMPLETED")]))
    assert ok and reason is None
    assert _verdicts(results) == [("a", True), ("b", True), ("c", True)]


def test_mixed_run_reports_every_verdict_and_names_the_first_failure_and_the_rest():
    task = _task([_status("a", "COMPLETED"), _status("b", "PAUSED"), _status("c", "UNKNOWN"), _status("d", "COMPLETED")])
    ok, reason, results = _run(task)
    assert not ok
    assert _verdicts(results) == [("a", True), ("b", False), ("c", False), ("d", True)]
    assert reason.startswith("Declared evaluator b failed: Agent status was COMPLETED; expected PAUSED")
    assert "(+1 more failing: c)" in reason


def test_all_failing_evaluators_each_report_a_verdict():
    ok, reason, results = _run(_task([_status("a", "PAUSED"), _status("b", "PAUSED"), _status("c", "PAUSED")]))
    assert not ok
    assert _verdicts(results) == [("a", False), ("b", False), ("c", False)]
    assert "(+2 more failing: b, c)" in reason


def test_a_task_namespace_without_the_option_keeps_the_stop_at_first_failure_loop():
    """benchmark.blackbox builds fake tasks as plain namespaces (declared_judge_low_score_verdict_is_not_rejudged)."""
    from types import SimpleNamespace

    task = SimpleNamespace(
        name="plain",
        enforce_declared_evaluators=True,
        evaluators=[_status("a", "PAUSED"), _status("b", "PAUSED")],
        process_spec=None,
        tags=[],
    )
    ok, reason, results = _run(task)
    assert not ok and _verdicts(results) == [("a", False)] and "more failing" not in reason


def test_without_the_option_the_loop_still_stops_at_the_first_failure():
    task = _task([_status("a", "COMPLETED"), _status("b", "PAUSED"), _status("c", "PAUSED")], run_all=False)
    ok, reason, results = _run(task)
    assert not ok and _verdicts(results) == [("a", True), ("b", False)]
    assert reason.startswith("Declared evaluator b failed") and "more failing" not in reason


def _fake_evidence(rows: int) -> dict:
    return {
        "agent_ids": ["root"],
        "spawns": [],
        "spawn_calls_by_agent": {"root": ["call-1"]},
        "sessions_by_agent": {"root": [{"id": f"row-{i}"} for i in range(rows)]},
        "backend_creates": [],
        "sources": {},
        "context": {},
    }


def test_a_timed_out_run_still_runs_static_and_lane_evaluators_on_the_collected_evidence(monkeypatch):
    evaluators = [
        _status("completed", "COMPLETED"),
        _static("one-session", {"type": "code_agent_one_session_per_spawn"}),
        {"id": "judge", "method": "single_turn_llm_judge", "criteria": ["judged"], "judge_prompt": "x"},
        _static("lane-thinking", {"type": "code_agent_thinking_rows"}),
    ]

    async def hydrate(data, *, benchmark, base_url, evaluators):
        data.setdefault("_benchmark", {})[code_agent_checks.EVIDENCE_KEY] = _fake_evidence(rows=3)

    monkeypatch.setattr(rb.code_agent_checks, "hydrate", hydrate)
    monkeypatch.setattr(
        rb.code_agent_checks.external,
        "run",
        lambda check, evidence: (False, f"{check['type']}: lane evidence says the root had no thinking rows"),
    )
    ok, reason, results = _run(_task(evaluators), status="PAUSED", static_only=True)
    assert not ok
    # The LLM judge is skipped for a failed run; every static evaluator reports, including the lane's.
    assert _verdicts(results) == [("completed", False), ("one-session", False), ("lane-thinking", False)]
    assert "3 ClaudeCodeSession row(s) for 1 spawn call(s)" in results[1]["reasoning"]
    assert "no thinking rows" in results[2]["reasoning"]
    assert "(+2 more failing: one-session, lane-thinking)" in reason


def test_a_passing_run_with_one_failing_lane_evaluator_still_lists_the_others(monkeypatch):
    async def hydrate(data, *, benchmark, base_url, evaluators):
        data.setdefault("_benchmark", {})[code_agent_checks.EVIDENCE_KEY] = _fake_evidence(rows=1)

    monkeypatch.setattr(rb.code_agent_checks, "hydrate", hydrate)
    monkeypatch.setattr(rb.code_agent_checks.external, "run", lambda check, evidence: (True, "ok"))
    evaluators = [
        _status("completed", "COMPLETED"),
        _static("one-session", {"type": "code_agent_one_session_per_spawn"}),
        _static("lane-render", {"type": "code_agent_render"}),
    ]
    ok, reason, results = _run(_task(evaluators))
    assert ok and _verdicts(results) == [("completed", True), ("one-session", True), ("lane-render", True)]


def test_gating_helpers_run_a_failed_run_only_for_run_all_tasks():
    run_all = _task([_status("a", "COMPLETED")])
    plain = _task([_status("a", "COMPLETED")], run_all=False)
    assert rb._runs_declared_evaluators(run_all, passed=False)
    assert not rb._runs_declared_evaluators(plain, passed=False)
    assert rb._runs_declared_evaluators(plain, passed=True)
    assert not rb._runs_declared_evaluators(dataclasses.replace(run_all, enforce_declared_evaluators=False), passed=True)
    transcript = _task([_static("t", {"type": "claude_code_session_output"})], run_all=False)
    assert rb._runs_declared_evaluators(transcript, passed=False)


def test_a_run_all_task_keeps_the_runs_own_failure_beside_the_verdicts():
    run_all = _task([_status("a", "COMPLETED")])
    plain = _task([_status("a", "COMPLETED")], run_all=False)
    verdicts = "Declared evaluator a failed: x"
    assert rb._declared_failure_reason(run_all, "Timeout after 1504s", verdicts) == f"Timeout after 1504s | {verdicts}"
    assert rb._declared_failure_reason(run_all, None, verdicts) == verdicts
    assert rb._declared_failure_reason(plain, "Timeout after 1504s", verdicts) == verdicts


def test_catalog_accepts_the_option_only_as_a_boolean_on_an_enforced_task():
    raw = copy.deepcopy(next(t for t in __import__("benchmarks.long_horizon", fromlist=["x"]).validate_catalog() if t["name"] == TASK))
    assert raw["run_all_evaluators"] is True
    validate_task_contract(raw)
    for bad in ("yes", 1):
        with pytest.raises(ValueError, match="run_all_evaluators"):
            validate_task_contract({**raw, "run_all_evaluators": bad})
    with pytest.raises(ValueError, match="run_all_evaluators"):
        validate_task_contract({**raw, "enforce_declared_evaluators": False})
