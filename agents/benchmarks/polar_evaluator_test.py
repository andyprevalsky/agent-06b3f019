"""Unit tests for the isolated polar (Odysseys-faithful) evaluator.

Isolation: do not import check_progress / semantic evidence builders here.
Production dispatch stays inside the method==\"polar\" branch of run_benchmark.
"""

from __future__ import annotations

import ast
import asyncio
from pathlib import Path

from benchmarks.polar_evaluator import (
    POLAR_METHOD,
    build_polar_trajectory,
    criteria_from_rubrics,
    parse_polar_judge_response,
    parse_polar_rubrics,
    run_polar_evaluator,
)


def test_parse_polar_rubrics_prefers_rubrics_over_criteria():
    evaluator = {
        "rubrics": [
            {
                "id": "R1",
                "requirement": "Clicked Search",
                "verification": "Screenshot shows results",
            }
        ],
        "criteria": ["ignored"],
    }
    assert parse_polar_rubrics(evaluator) == [
        {
            "id": "R1",
            "requirement": "Clicked Search",
            "verification": "Screenshot shows results",
        }
    ]


def test_parse_polar_rubrics_synthesizes_from_criteria():
    rubrics = parse_polar_rubrics({"criteria": ["Did the thing", "  ", "Also this"]})
    assert len(rubrics) == 2
    assert rubrics[0]["id"] == "C1"
    assert rubrics[0]["requirement"] == "Did the thing"
    assert "screenshot" in rubrics[0]["verification"].lower()


def test_criteria_from_rubrics_round_trip_shape():
    rubrics = [
        {
            "id": "R2",
            "requirement": "Filter applied",
            "verification": "URL has filter params",
        }
    ]
    assert criteria_from_rubrics(rubrics) == [
        "R2: Filter applied (verify: URL has filter params)"
    ]


def test_parse_polar_judge_response():
    cases = [
        ('Thoughts: looks good\nStatus: "success"', True),
        ("Thoughts: blocked\nStatus: failure", False),
        ("Status: success", True),
        ("no status line at all", False),
        ("", False),
    ]
    for text, expected_success in cases:
        success, reasoning = parse_polar_judge_response(text)
        assert success is expected_success, text
        assert isinstance(reasoning, str)


def test_build_polar_trajectory_collects_actions_and_screenshots():
    tiny_png = (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ"
        "AAAABJRU5ErkJggg=="
    )
    data = {
        "messages": [
            {"role": "SYSTEM", "message": "ignore"},
            {
                "role": "ASSISTANT",
                "message": "I'll browse",
                "metadata": {"toolName": "spawn_browser_agent", "toolStatus": "running"},
            },
            {
                "role": "TOOL",
                "message": "Browser state captured",
                "metadata": {
                    "toolName": "browser_snapshot",
                    "screenshot_b64": tiny_png,
                    "screenshot_media_type": "image/png",
                },
            },
        ],
        "_semantic_evaluator_tree": {
            "child-1": {
                "messages": [
                    {
                        "role": "TOOL",
                        "message": "clicked submit",
                        "metadata": {
                            "toolName": "click",
                            "screenshot": f"data:image/png;base64,{tiny_png}",
                        },
                    }
                ]
            }
        },
    }
    history, shots = build_polar_trajectory(data)
    assert "spawn_browser_agent" in history or "I'll browse" in history
    assert "clicked submit" in history
    assert len(shots) == 2
    assert all(s.get("b64") and s.get("mime") for s in shots)


def test_run_polar_evaluator_perfect_with_mock_llm():
    async def fake_llm(messages, **kwargs):
        return 'Thoughts: rubric met on screenshot 1\nStatus: "success"'

    result = asyncio.run(
        run_polar_evaluator(
            task_prompt="Find the price of X",
            evaluator={
                "rubrics": [
                    {
                        "id": "R1",
                        "requirement": "Navigated to product",
                        "verification": "Product page visible",
                    },
                    {
                        "id": "R2",
                        "requirement": "Price reported",
                        "verification": "Final answer has a dollar amount",
                    },
                ]
            },
            data={
                "messages": [
                    {
                        "role": "TOOL",
                        "message": "opened product",
                        "metadata": {"toolName": "navigate"},
                    }
                ],
                "agent": {"id": "agent-test"},
            },
            judge_llm=fake_llm,
        )
    )
    assert result["perfect"] is True
    assert result["score"] == 1.0
    assert len(result["rubric_results"]) == 2
    assert all(item["success"] for item in result["rubric_results"])


def test_run_polar_evaluator_fails_closed_on_one_rubric():
    calls = {"n": 0}

    async def fake_llm(messages, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return 'Thoughts: ok\nStatus: "success"'
        return 'Thoughts: missing evidence\nStatus: "failure"'

    result = asyncio.run(
        run_polar_evaluator(
            task_prompt="Do the thing",
            evaluator={"criteria": ["A", "B"]},
            data={"messages": []},
            judge_llm=fake_llm,
        )
    )
    assert result["perfect"] is False
    assert result["score"] == 0.5
    assert result["rubric_results"][0]["success"] is True
    assert result["rubric_results"][1]["success"] is False
    assert "fail" in result["reasoning"].lower()


def test_polar_method_constant():
    assert POLAR_METHOD == "polar"


def test_isolation_polar_evaluator_does_not_import_other_judges():
    """Source-level isolation: polar_evaluator must not pull other judge paths."""
    src = Path(__file__).resolve().parent / "polar_evaluator.py"
    tree = ast.parse(src.read_text())
    banned_substrings = (
        "check_progress",
        "semantic_evaluator_evidence",
        "call_declared_llm_judge",
        "ecommerce",
    )
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            module = getattr(node, "module", None) or ""
            names = " ".join(
                alias.name for alias in node.names if getattr(alias, "name", None)
            )
            blob = f"{module} {names}".lower()
            for banned in banned_substrings:
                assert banned not in blob, f"polar_evaluator imports banned {banned!r}"


def test_run_benchmark_dispatches_polar_in_isolation_branch():
    """Production call site is the method==polar branch only (lazy import)."""
    src = (Path(__file__).resolve().parent / "run_benchmark.py").read_text()
    assert 'method == "polar"' in src
    assert "from benchmarks.polar_evaluator import run_polar_evaluator" in src
    tree = ast.parse(src)
    top_level_polar_imports = [
        node
        for node in tree.body
        if isinstance(node, (ast.Import, ast.ImportFrom))
        and "polar_evaluator" in ast.dump(node)
    ]
    assert top_level_polar_imports == [], "polar_evaluator must not be imported at module top"


def _original_completion_message():
    import json
    return json.loads((Path(__file__).parent / "fixtures/polar_completion_card_original.json").read_text())


def test_polar_browser_completion_original_visible_card_reaches_actual_judge_input():
    """Recorded metadata is visible UI content, not a new generated answer."""
    import json
    message = _original_completion_message()
    completion = message["metadata"]["completionSummary"]
    calls = []

    async def capture_only(messages, **kwargs):
        calls.append(messages)
        return 'Thoughts: fixture does not assert a task verdict\nStatus: "failure"'

    result = asyncio.run(run_polar_evaluator(
        task_prompt="Return the recorded roundup and page-view confirmation",
        evaluator={"rubrics": [{"id": "R6", "requirement": "Present the recorded results", "verification": "Read the final response"}]},
        data={"messages": [message]}, judge_llm=capture_only,
    ))
    assert len(calls) == 1
    text = calls[0][1]["content"][0]["text"]
    assert completion["summary"] in text
    for output in completion["outputs"]:
        assert output["label"] in text
        def assert_values(value):
            if isinstance(value, str):
                assert value in text
            elif isinstance(value, dict):
                for item in value.values():
                    assert_values(item)
            elif isinstance(value, list):
                for item in value:
                    assert_values(item)
        assert_values(output["value"])
    assert result["score"] == 0 and result["perfect"] is False


def test_polar_browser_completion_value_mode_never_projects_hidden_report():
    message = {"role": "TOOL", "message": "4", "metadata": {
        "toolName": "completion_summary", "toolStatus": "FINISHED", "isFinalSummary": True,
        "completionSummary": {"summary": "HIDDEN REPORT", "outputs": [{"label": "HIDDEN LABEL", "value": 4}],
                              "presentation": {"version": 1, "mode": "value"}, "answerText": "4"}}}
    history, _ = build_polar_trajectory({"messages": [message]})
    assert history == "1. Action: completion_summary | status=FINISHED | 4"
    assert "HIDDEN" not in history
    message["message"] = ""
    history, _ = build_polar_trajectory({"messages": [message]})
    assert history.endswith("Displayed final answer: 4")
    assert "HIDDEN" not in history


def test_polar_browser_completion_report_projects_only_visible_values():
    message = {"role": "TOOL", "message": "", "metadata": {
        "toolName": "completion_summary", "toolStatus": "FINISHED", "isFinalSummary": True, "private_debug": "SECRET METADATA",
        "completionSummary": {"summary": "Recorded report", "internal": "SECRET INTERNAL",
                              "outputs": [{"key": "SECRET KEY", "label": "SECRET FILE LABEL", "value": [
                                  {"id": "SECRET ID", "storage_path": "SECRET PATH", "original_filename": "report.pdf"}]},
                                  {"label": "Details", "value": {"title": "Recorded title", "count": 2, "nested": [False, None]}}]}}}
    history, _ = build_polar_trajectory({"messages": [message]})
    assert "Recorded report" in history and "report.pdf" in history and "Recorded title" in history
    assert "SECRET" not in history
    assert "Count: 2" in history and "Nested\nfalse" in history


def test_polar_browser_completion_rejects_unrelated_or_malformed_carriers():
    import copy
    original = _original_completion_message()
    for role in ("USER", "SYSTEM", "ASSISTANT", "TOOL_RESULT"):
        message = copy.deepcopy(original); message["role"] = role
        history, _ = build_polar_trajectory({"messages": [message]})
        assert "Displayed final answer" not in history
    for key, value in (("toolName", "evaluate"), ("toolStatus", "IN_PROGRESS"), ("artifactOnly", True), ("isFinalSummary", False), ("isFinalSummary", None),
                       ("environmentContext", True), ("messageType", "FINAL_ANSWER")):
        message = copy.deepcopy(original); message["metadata"][key] = value
        history, _ = build_polar_trajectory({"messages": [message]})
        assert "Displayed final answer" not in history
    for bad in (None, "untyped", {"summary": None, "outputs": []}, {"summary": "x", "outputs": [True]},
                {"summary": "x", "outputs": [{"label": "bad", "value": float("nan")}] }):
        message = copy.deepcopy(original); message["metadata"]["completionSummary"] = bad
        history, _ = build_polar_trajectory({"messages": [message]})
        assert "Displayed final answer" not in history


def test_polar_browser_completion_existing_text_and_errors_stay_visible():
    message = {"role": "TOOL", "message": "Already visible", "metadata": {
        "toolName": "completion_summary", "toolStatus": "FINISHED", "isFinalSummary": True,
        "completionSummary": {"summary": "Already visible"}}}
    history, _ = build_polar_trajectory({"messages": [message]})
    assert history.count("Already visible") == 1
    message["metadata"]["completionSummary"].update(error=True, outputs=[], answerText="HIDDEN SUCCESS",
                                                   presentation={"version": 1, "mode": "value"})
    history, _ = build_polar_trajectory({"messages": [message]})
    assert "Task Failed" in history and "HIDDEN SUCCESS" not in history


def test_polar_browser_completion_ui_visibility_edge_cases():
    import copy
    pointer = {"id": "id", "storage_path": "PRIVATE PATH", "original_filename": "shown.pdf"}
    message = {"role": "TOOL", "message": "", "metadata": {
        "toolName": "completion_summary", "toolStatus": "FINISHED", "isFinalSummary": True,
        "completionSummary": {"summary": "Visible summary", "outputs": [
            {"label": "Top null label", "value": None},
            {"label": "Report", "value": {"title": "Visible heading", "hidden_null": None,
                "hidden_empty": [], "hidden_string": "", "false_value": False, "zero": 0}},
            {"label": "PRIVATE FILE LABEL", "value": pointer}]}}}
    history, _ = build_polar_trajectory({"messages": [message]})
    assert not any(key in history for key in ("hidden_null", "Hidden Null", "hidden_empty", "Hidden Empty", "hidden_string", "Hidden String"))
    assert "PRIVATE" not in history and "Title:" not in history
    assert "Top null label" in history and "Visible heading" in history
    assert "False Value: false" in history and "Zero: 0" in history and "shown.pdf" in history
    for flag in ("hidden", "agentNotification", "artifactOnly"):
        for value in (True, {}, []):
            bad = copy.deepcopy(message); bad["metadata"][flag] = value
            projected, _ = build_polar_trajectory({"messages": [bad]})
            assert "Visible summary" not in projected
    bad = copy.deepcopy(message)
    bad["metadata"]["completionSummary"].update(error={}, presentation={"version": 1, "mode": "value"}, answerText="HIDDEN ANSWER")
    projected, _ = build_polar_trajectory({"messages": [bad]})
    assert "HIDDEN ANSWER" not in projected
    bad = copy.deepcopy(message)
    bad["metadata"]["completionSummary"]["outputs"] = [{"label": "mixed", "value": [pointer, {"secret": "HIDDEN"}]}]
    projected, _ = build_polar_trajectory({"messages": [bad]})
    assert "Displayed final answer" not in projected
