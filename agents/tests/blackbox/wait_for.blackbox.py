"""Blackbox tests for wait-for domain."""

import asyncio
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


async def test_evaluate_condition_uses_llm_not_httpx():
    """evaluate_condition_activity calls LLM helper, not raw httpx."""
    with patch("temporalio.activity.heartbeat"):
        # call_llm is imported inside the function: from helpers.llm import call_llm
        with patch("helpers.llm.call_llm") as mock_llm:
            mock_llm.return_value = {
                "content": '{"satisfied": true, "reasoning": "Condition met"}',
                "usage": {"input_tokens": 50, "output_tokens": 30},
            }
            from tools.wait_for import evaluate_condition_activity

            result = await evaluate_condition_activity(
                condition="Has the deployment completed?",
                evidence="Deploy pipeline shows green status",
                model="rose-1-lite",
            )

    assert result["satisfied"] is True
    assert "reasoning" in result
    # No raw httpx calls should be captured
    assert len(get_captured_requests()) == 0


async def test_no_outbound_http_calls():
    """evaluate_condition_activity makes zero httpx calls."""
    with patch("temporalio.activity.heartbeat"):
        with patch("helpers.llm.call_llm") as mock_llm:
            mock_llm.return_value = {
                "content": '{"satisfied": false, "reasoning": "Not yet"}',
                "usage": {"input_tokens": 40, "output_tokens": 25},
            }
            from tools.wait_for import evaluate_condition_activity

            await evaluate_condition_activity(
                condition="Test condition",
                evidence="Test evidence",
                model="rose-1-lite",
            )

    assert len(get_captured_requests()) == 0


async def run_all_tests():
    print("wait-for blackbox tests:")
    r = BlackboxResult()
    await r.record_async("uses_llm_not_httpx", test_evaluate_condition_uses_llm_not_httpx)
    await r.record_async("no_outbound_http_calls", test_no_outbound_http_calls)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
