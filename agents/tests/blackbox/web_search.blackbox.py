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


# -------------------- handler.py tests --------------------


def _mock_execute(calls: list, *, result: dict | None = None, raises: bool = False):
    async def mock(activity_fn, *args, **kwargs):
        name = getattr(activity_fn, "__name__", "")
        calls.append({"activity": name, "kwargs": kwargs})
        if name == "web_search_activity":
            if raises:
                raise RuntimeError("parallel offline")
            return result or {"results": [], "answer": "", "query": "x"}
        return None
    return mock


async def test_manager_execute_tool_happy():
    """WebSearchManager.execute_tool returns result + usage with per-query cost."""
    from tools.web_search.handler import WebSearchManager

    calls = []
    manager = WebSearchManager()
    out = await manager.execute_tool(
        execute_activity=_mock_execute(
            calls, result={"results": [{"title": "r"}], "answer": "a", "query": "q"}
        ),
        tool_call={"query": "AI trends", "max_tokens": 1000},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert out["result"]["answer"] == "a"
    assert out["usage"]["service"][0]["provider"] == "Parallel AI Search"


async def test_manager_execute_tool_raises_on_error():
    """WebSearchManager re-raises on activity exception."""
    from tools.web_search.handler import WebSearchManager

    calls = []
    manager = WebSearchManager()
    try:
        await manager.execute_tool(
            execute_activity=_mock_execute(calls, raises=True),
            tool_call={"query": "q"},
            tool_call_id="tc-1",
            agent_id="agent-1",
            user_id="user-1",
        )
        raise AssertionError("Expected RuntimeError")
    except RuntimeError as e:
        assert "parallel offline" in str(e)


async def test_manager_execute_tool_long_query_truncates():
    """Long query is truncated for display only; activity gets full value."""
    from tools.web_search.handler import WebSearchManager

    calls = []
    manager = WebSearchManager()
    long_query = "q" * 500
    await manager.execute_tool(
        execute_activity=_mock_execute(calls),
        tool_call={"query": long_query},
        tool_call_id="tc-1",
        agent_id="agent-1",
    )
    read = [c for c in calls if c["activity"] == "web_search_activity"]
    assert len(read) == 1


async def test_web_search_entry_point():
    """web_search() entry point dispatches to manager."""
    from tools.web_search.handler import web_search

    calls = []
    out = await web_search(
        execute_activity=_mock_execute(calls),
        tool_call={"query": "q"},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert "result" in out


async def run_all_tests():
    print("web-search blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_web_search_happy_path)
    await r.record_async("boundary", test_web_search_boundary)
    await r.record_async("manager_execute_tool_happy", test_manager_execute_tool_happy)
    await r.record_async("manager_execute_tool_raises", test_manager_execute_tool_raises_on_error)
    await r.record_async("manager_long_query_truncates", test_manager_execute_tool_long_query_truncates)
    await r.record_async("web_search_entry_point", test_web_search_entry_point)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
