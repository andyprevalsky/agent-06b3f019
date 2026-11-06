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


def _run(root_generation: dict[str, Any] | None, *, thinking: bool = True) -> list[dict[str, Any]]:
    fixture = json.loads(FIXTURE.read_text())
    messages: list[dict[str, Any]] = [
        {
            "message_id": "goal",
            "timestamp": "2026-11-06T04:13:01.022Z",
            "text": "Whats our rose repo looking like?",
            "role": "USER",
            "metadata": None,
        },
        {
            "message_id": "thought-1",
            "timestamp": "2026-11-06T04:21:13.920Z",
            "text": "Spawning a Claude Code agent in the repo.",
            "role": "ASSISTANT",
            "metadata": {"generation": root_generation} if root_generation else {},
        },
    ]
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


def test_thinking_rows_without_recorded_generation_fail():
    result = thinking_rows_check.check_thinking_rows_from_messages(_run(None), ROOT)
    assert not result["passed"]
    assert result["failures"] == ["root: no thinking row carries a recorded generation (tok/s)"]
    implausible = {**ROOT_GENERATION, "ended_at": "2026-11-06T04:21:06.550Z"}  # 597 tokens in 50 ms
    result = thinking_rows_check.check_thinking_rows_from_messages(_run(implausible), ROOT)
    assert not result["passed"] and "11940.0 tok/s" in result["failures"][0]
    result = thinking_rows_check.check_thinking_rows_from_messages(_run(ROOT_GENERATION, thinking=False), ROOT)
    assert result["failures"] == ["code agent 6f8f8f4d-c670-4bc8-b5df-e2c785c4a908: no thinking rows"]


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

