"""Blackbox tests for web-search domain."""

import asyncio
import json
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock({
        "api.parallel.ai/v1beta/search": {
            "status": 200,
            "json": {
                "results": [
                    {
                        "title": "AI Trends 2026",
                        "url": "https://example.com/ai-trends",
                        "text": "The latest trends in AI...",
                    },
                    {
                        "title": "Machine Learning Guide",
                        "url": "https://example.com/ml-guide",
                        "text": "A comprehensive guide to ML...",
                    },
                ],
                "answer": "AI trends in 2026 include...",
            },
        },
    })


async def test_web_search_happy_path():
    """web_search_activity returns search results from Parallel AI."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.web_search import web_search_activity

        result = await web_search_activity(
            query="AI trends 2026",
            max_tokens=1500,
        )

    assert "results" in result or "answer" in result


async def test_web_search_boundary():
    """Verify exact HTTP request sent to Parallel AI search endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.web_search import web_search_activity

        await web_search_activity(
            query="quantum computing breakthroughs",
            max_tokens=2000,
        )

    call = assert_captured_call(
        url_contains="api.parallel.ai/v1beta/search",
        method="POST",
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    # Activity sends "objective" and "search_queries", not "query"
    assert body["objective"] == "quantum computing breakthroughs"
    assert "quantum computing breakthroughs" in body["search_queries"]

    # Verify beta header
    headers_lower = {k.lower(): v for k, v in call["requestHeaders"].items()}
    assert "parallel-beta" in headers_lower


async def run_all_tests():
    print("web-search blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_web_search_happy_path)
    await r.record_async("boundary", test_web_search_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
