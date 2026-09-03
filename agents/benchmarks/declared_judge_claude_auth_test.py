"""Harness-side declared judges must pass Claude OAuth into check_progress.

Regression: mass-agent smoke completed the agent tree on Claude OAuth, then the
post-run declared evaluator called check_progress with claude_auth_present=False
and fell through OpenAI/Anthropic-key/OpenRouter to 402.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import benchmarks.run_benchmark as rb


def test_benchmark_judge_claude_auth_kwargs_maps_token_fields():
    fake = {"accessToken": "oauth-token", "source": "user", "poolTokenId": "pool-1"}

    async def run():
        with patch("helpers.llm.fetch_claude_max_token", new=AsyncMock(return_value=fake)):
            return await rb._benchmark_judge_claude_auth_kwargs("user-abc")

    kwargs = asyncio.run(run())
    assert kwargs == {
        "claude_token": "oauth-token",
        "claude_token_source": "user",
        "claude_token_pool_id": "pool-1",
        "claude_token_user_id": "user-abc",
    }


def test_declared_llm_judge_forwards_claude_token_to_check_progress():
    captured: dict = {}

    async def fake_check_progress(**kwargs):
        captured.update(kwargs)
        return {"score": 1.0, "reasoning": "pass"}

    task = MagicMock()
    task.prompt = "Buy milk"
    evaluator = {"criteria": ["milk purchased"], "judge_prompt": "be strict"}
    data = {"agent": {"id": "agent-1", "userId": "user-abc"}}

    async def run():
        with (
            patch.object(
                rb,
                "_benchmark_judge_claude_auth_kwargs",
                new=AsyncMock(
                    return_value={
                        "claude_token": "oauth-token",
                        "claude_token_source": "user",
                        "claude_token_pool_id": None,
                        "claude_token_user_id": "user-abc",
                    }
                ),
            ),
            patch("helpers.llm.check_progress", new=fake_check_progress),
        ):
            return await rb._call_declared_llm_judge(
                task, evaluator, data, evidence=[{"ok": True}]
            )

    result = asyncio.run(run())
    assert result["score"] == 1.0
    assert captured["claude_token"] == "oauth-token"
    assert captured["claude_token_user_id"] == "user-abc"
    assert captured["call_site"] == "benchmark_declared_evaluator"
