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
