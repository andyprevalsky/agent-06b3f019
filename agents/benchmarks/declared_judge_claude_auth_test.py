"""Harness-side declared judges must pass Claude + GPT OAuth into check_progress.

Regression: mass-agent smoke completed the agent tree on Claude/GPT OAuth, then the
post-run declared evaluator called check_progress with auth omitted and fell through
OpenAI API key / OpenRouter — 402s or reasoning-only empty JSON at the declared
evaluator max_tokens ceiling.
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


def test_benchmark_judge_gpt_auth_kwargs_maps_token_fields():
    fake = {
        "accessToken": "gpt-oauth",
        "accountId": "acct-1",
        "source": "user",
        "poolTokenId": "pool-gpt",
    }

    async def run():
        with patch(
            "helpers.llm.fetch_gpt_code_token_activity",
            new=AsyncMock(return_value=fake),
        ):
            return await rb._benchmark_judge_gpt_auth_kwargs("user-abc")

    kwargs = asyncio.run(run())
    assert kwargs == {
        "gpt_token": "gpt-oauth",
        "gpt_account_id": "acct-1",
        "gpt_token_source": "user",
        "gpt_token_pool_id": "pool-gpt",
        "gpt_token_user_id": "user-abc",
    }


def test_declared_llm_judge_forwards_claude_and_gpt_tokens_to_check_progress():
    captured: dict = {}

    async def fake_check_progress(**kwargs):
        captured.update(kwargs)
        return {"score": 1.0, "reasoning": "pass"}

    task = MagicMock()
    task.prompt = "Buy milk"
    task.name = "buy-milk"
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
            patch.object(
                rb,
                "_benchmark_judge_gpt_auth_kwargs",
                new=AsyncMock(
                    return_value={
                        "gpt_token": "gpt-oauth",
                        "gpt_account_id": "acct-1",
                        "gpt_token_source": "user",
                        "gpt_token_pool_id": None,
                        "gpt_token_user_id": "user-abc",
                    }
                ),
            ),
            patch("helpers.llm.check_progress", new=fake_check_progress),
            patch.object(rb, "_declared_evaluator_evidence", return_value=[{"ok": True}]),
        ):
            return await rb._call_declared_llm_judge(task, evaluator, data)

    result = asyncio.run(run())
    assert result["score"] == 1.0
    assert captured["claude_token"] == "oauth-token"
    assert captured["claude_token_user_id"] == "user-abc"
    assert captured["gpt_token"] == "gpt-oauth"
    assert captured["gpt_token_user_id"] == "user-abc"
    assert captured["call_site"] == "benchmark_declared_evaluator"


def test_declared_llm_judge_treats_payment_approval_receipt_fields_as_grounding():
    """browser-event-ticket: approval date/seat/price must count (not only tool DOM).

    Regression: single-turn judge prompt said attention requests never prove date/
    price, so a correct Fri Oct 9 Metreon payment_approval was scored 0.0 while
    agentic judges already accepted receipt fields on the pending approval.
    """
    captured: dict = {}

    async def fake_check_progress(**kwargs):
        captured.update(kwargs)
        return {"score": 1.0, "reasoning": "pass"}

    task = MagicMock()
    task.prompt = "Buy one adult movie ticket at AMC Metreon 16 for next week's Friday."
    task.name = "browser-event-ticket"
    evaluator = {
        "criteria": [
            "The pending payment approval is for one adult AMC ticket on next week's Friday"
        ],
        "judge_prompt": "Accept unresolved payment approval grounded to amctheatres.com.",
    }
    data = {"agent": {"id": "agent-1", "userId": "user-abc"}}

    async def run():
        with (
            patch.object(rb, "_benchmark_judge_claude_auth_kwargs", new=AsyncMock(return_value={})),
            patch.object(rb, "_benchmark_judge_gpt_auth_kwargs", new=AsyncMock(return_value={})),
            patch("helpers.llm.check_progress", new=fake_check_progress),
            patch.object(rb, "_declared_evaluator_evidence", return_value=[{"ok": True}]),
        ):
            return await rb._call_declared_llm_judge(task, evaluator, data)

    asyncio.run(run())
    prompt = str(captured.get("verifier_system_prompt") or "")
    assert "request_payment_card attention request" in prompt
    assert "date/time, seat" in prompt
    assert "does not prove item, price, date" not in prompt
    assert "Generic non-payment attention requests" in prompt
