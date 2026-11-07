"""Regression tests for the thinking-row static check (benchmarks/thinking_rows_check.py).

Registered in the deploy path through tests/blackbox/benchmark.blackbox.py. The
code-agent records are the prod run 1a3d495c (Claude Code task 6f8f8f4d) fixture
shared with the FE blackbox (front-end/src/tests/blackbox/thinking-tool-row.blackbox.tsx).
"""

from __future__ import annotations

import json
from typing import Any

from benchmarks import thinking_rows_check

FIXTURE = thinking_rows_check.FRONT_END / "src/tests/blackbox/code-agent-thinking-prod-1a3d495c.fixture.json"
ROOT = "1a3d495c-826c-4eca-afe0-382fcbf72e82"


def _run(
    root_generation: dict[str, Any] | None, *, thinking: bool = True, root_thought: bool = True
) -> list[dict[str, Any]]:
    fixture = json.loads(FIXTURE.read_text())
    messages: list[dict[str, Any]] = [
        {
            "message_id": "goal",
            "timestamp": "2026-11-06T04:13:01.022Z",
            "text": "Whats our rose repo looking like?",
            "role": "USER",
            "metadata": None,
        },
    ]
    if root_thought:
        # A run-agent turn: the one root producer that records a generation.
        metadata: dict[str, Any] = {"tool_calls": [{"tool": "web_search", "tool_call_id": "call-1"}]}
        if root_generation:
            metadata["generation"] = root_generation
        messages.append(
            {
                "message_id": "thought-1",
                "timestamp": "2026-11-06T04:21:13.920Z",
                "text": "Spawning a Claude Code agent in the repo.",
                "role": "ASSISTANT",
                "metadata": metadata,
            }
        )
    for carrier in fixture["carriers"]:
        events = [e for e in carrier["events"] if thinking or e.get("type") != "thinking"]
        messages.append(
            {
                "message_id": carrier["message_id"],
                "timestamp": carrier["timestamp"],
                "text": "",
                "role": "TOOL",
                "metadata": {
                    "toolName": "spawn_claude_code_agent",
                    "task_id": fixture["task_id"],
                    "action_type": "code_transcript",
                    "hidden": True,
                    "code_agent_events": events,
                },
            }
        )
    return messages


ROOT_GENERATION = {
    "output_tokens": 597,
    "started_at": "2026-11-06T04:21:06.500Z",
    "ended_at": "2026-11-06T04:21:13.700Z",
}


def test_thinking_rows_measured_root_and_code_agent_pass():
    result = thinking_rows_check.check_thinking_rows_from_messages(_run(ROOT_GENERATION), ROOT)
    assert result["passed"], result["failures"]
    report = result["report"]
    assert report["root"]["thoughts"] == 1
    assert round(report["root"]["measured"][0]["tokensPerSecond"], 1) == 82.9
    [code] = report["codeAgents"]
    assert code["taskId"] == "6f8f8f4d-c670-4bc8-b5df-e2c785c4a908"
    assert code["measured"][0]["outputTokens"] == 817
    assert code["measured"][0]["durationMs"] == 6050
    assert round(code["measured"][0]["tokensPerSecond"], 1) == 135.0
    assert result["detail"] == [
        "root: 1 thinking row, 1 measured (83–83 tok/s)",
        "code agent 6f8f8f4d-c670-4bc8-b5df-e2c785c4a908: 1 thinking row, 1 measured (135–135 tok/s)",
    ]
    assert result["notes"] == []


def test_thinking_rows_without_recorded_generation_fail():
    """(a) Rows that exist are held to their recorded generation when the records prove one was recordable."""
    result = thinking_rows_check.check_thinking_rows_from_messages(_run(None), ROOT)
    assert not result["passed"]
    assert result["failures"] == ["root: 1 run-agent thinking row, none carries a recorded generation (tok/s)"]
    # C24: 597 tokens in 50 ms is a response returned in one burst (an unstreamed gateway route):
    # reported as not measurable, never failed, and the row must render without a tok/s.
    burst = {**ROOT_GENERATION, "ended_at": "2026-11-06T04:21:06.550Z"}
    result = thinking_rows_check.check_thinking_rows_from_messages(_run(burst), ROOT)
    assert result["passed"], result["failures"]
    assert "root: thought thought-1 not measurable (response arrived in one burst, not streamed)" in result["notes"]
    assert result["report"]["root"]["unmeasured"] == [
        {"messageId": "thought-1", "reason": "response arrived in one burst, not streamed", "failing": False}
    ]


def test_thinking_rows_required_only_on_evidence_of_thinking():
    """(b) An agent with evidence of thinking (recorded reasoning tokens) must show thinking rows."""
    task = "6f8f8f4d-c670-4bc8-b5df-e2c785c4a908"
    result = thinking_rows_check.check_thinking_rows_from_messages(
        _run(ROOT_GENERATION, root_thought=False, thinking=False),
        ROOT,
        evidence={ROOT: {"reasoningTokens": 120}, task: {"reasoningTokens": 50}},
    )
    assert not result["passed"]
    assert result["failures"] == [
        "root: thinking recorded (120 reasoning tokens in recorded usage) but no thinking row is shown",
        f"code agent {task}: thinking recorded (50 reasoning tokens in recorded usage) but no thinking row is shown",
    ]
    # The same evidence with the rows present holds the agents to the row checks instead.
    result = thinking_rows_check.check_thinking_rows_from_messages(
        _run(ROOT_GENERATION), ROOT, evidence={ROOT: {"reasoningTokens": 120}, task: {"reasoningTokens": 400}}
    )
    assert result["passed"], result["failures"]


def test_thinking_rows_without_evidence_or_rows_are_an_explicit_na():
    """(c) No evidence and no rows is a labeled N/A in the verdict detail, never a failure."""
    task = "6f8f8f4d-c670-4bc8-b5df-e2c785c4a908"
    result = thinking_rows_check.check_thinking_rows_from_messages(
        _run(ROOT_GENERATION, root_thought=False, thinking=False), ROOT
    )
    assert result["passed"], result["failures"]
    assert result["notes"] == [
        "no thinking recorded for root (N/A)",
        f"no thinking recorded for code agent {task} (N/A)",
    ]
    assert result["detail"] == ["root: N/A, no thinking recorded", f"code agent {task}: N/A, no thinking recorded"]
    assert result["report"]["root"]["verdict"] == "n/a" and result["report"]["codeAgents"][0]["verdict"] == "n/a"


def test_thinking_rows_cli_crash_is_a_failure_not_an_exception():
    """A node crash (no JSON, exit 1) must read as a failed check with its stderr, never a raised error."""
    original = thinking_rows_check.CLI
    thinking_rows_check.CLI = "scripts/does-not-exist.mjs"
    try:
        result = thinking_rows_check.check_thinking_rows_from_messages(_run(ROOT_GENERATION), ROOT)
    finally:
        thinking_rows_check.CLI = original
    assert result["passed"] is False and result["report"] is None
    assert len(result["failures"]) == 1 and result["failures"][0].startswith("check-thinking-rows exited 1:")
    assert "does-not-exist.mjs" in result["failures"][0]
