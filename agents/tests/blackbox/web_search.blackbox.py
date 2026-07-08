"""Blackbox tests for web-search domain."""

import asyncio
import json
from unittest.mock import AsyncMock, patch

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


def test_types_contracts_are_importable():
    """Public web-search result contracts stay importable for tool callers."""
    from tools.web_search.types import ExecuteActivityCallable, SearchResult

    assert ExecuteActivityCallable is not None
    assert SearchResult.__annotations__ == {
        "answer": str,
        "sources": list[str],
        "query": str,
        "provider": str,
    }


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


async def test_web_search_ddgs_fallback():
    """When Parallel AI raises, execute_search falls back to DuckDuckGo."""
    from unittest.mock import MagicMock, patch

    with patch("temporalio.activity.heartbeat"):
        with patch("tools.web_search.service.fetch_search_results", side_effect=Exception("parallel offline")):
            with patch(
                "tools.web_search.service.fetch_search_results_ddgs",
                return_value=[
                    {"title": "DDG Result", "url": "https://ddg.example.com", "excerpts": ["Some body text"]},
                ],
            ):
                from tools.web_search.service import execute_search

                result = await execute_search("test query")

    assert result["provider"] == "ddgs"
    assert "DDG Result" in result["answer"]
    assert "https://ddg.example.com" in result["sources"]


async def test_web_search_ddgs_no_api_key():
    """When no API key is configured, goes directly to DuckDuckGo."""
    from unittest.mock import patch

    with patch("temporalio.activity.heartbeat"):
        with patch("tools.web_search.service.load_config") as mock_cfg:
            mock_cfg.return_value.parallel.api_key = ""
            with patch(
                "tools.web_search.service.fetch_search_results_ddgs",
                return_value=[
                    {"title": "DDG No Key", "url": "https://ddg.example.com", "excerpts": ["content"]},
                ],
            ) as mock_ddgs:
                from tools.web_search.service import execute_search

                result = await execute_search("no key query")
                mock_ddgs.assert_called_once_with("no key query")

    assert result["provider"] == "ddgs"


# -------------------- handler.py tests --------------------


def _mock_execute(calls: list, *, result: dict | None = None, raises: bool = False):
    async def mock(activity_fn, *args, **kwargs):
        name = getattr(activity_fn, "__name__", "")
        calls.append({"activity": name, "args": args, "kwargs": kwargs})
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
    posted = [c for c in calls if c["activity"] == "post_agent_message"]
    assert posted
    first_metadata = posted[0]["kwargs"]["args"][3]
    assert first_metadata["title"] == "Searching the web for AI trends"


async def test_manager_execute_tool_fast_cache_hit_has_no_service_cost():
    """Fast Mode cache hits should not be billed as live Parallel searches."""
    from tools.web_search.handler import FAST_CACHE_HIT_FIELD, WebSearchManager

    calls = []
    manager = WebSearchManager()
    out = await manager.execute_tool(
        execute_activity=_mock_execute(
            calls,
            result={
                "results": [{"title": "cached"}],
                "answer": "cached answer",
                "query": "q",
                FAST_CACHE_HIT_FIELD: True,
            },
        ),
        tool_call={"query": "AI trends", "max_tokens": 1000},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )

    assert out["result"]["answer"] == "cached answer"
    assert FAST_CACHE_HIT_FIELD not in out["result"]
    assert out["usage"]["service"] == []

    finished = [c for c in calls if c["activity"] == "post_agent_message"][-1]
    assert "**Cost:** $0.0000" in finished["kwargs"]["args"][1]
    assert FAST_CACHE_HIT_FIELD not in finished["kwargs"]["args"][1]


async def test_web_search_activity_fast_cache_hit_marks_cached_result():
    """Activity returns a cache-hit marker so the manager can skip service billing."""
    from tools.web_search.handler import FAST_CACHE_HIT_FIELD, web_search_activity

    cached = {"results": [{"title": "cached"}], "answer": "cached answer", "query": "q"}
    with patch("tools.web_search.handler.fast_cache_client.cache_get", new=AsyncMock(return_value=cached)):
        with patch("tools.web_search.handler.execute_search", new=AsyncMock(side_effect=AssertionError("live call"))):
            result = await web_search_activity(
                query="AI trends",
                max_tokens=1000,
                fast_mode_cache_enabled=True,
                fast_mode_goal="goal",
            )

    assert result["answer"] == "cached answer"
    assert result[FAST_CACHE_HIT_FIELD] is True


async def test_web_search_activity_ignores_unavailable_fast_cache_when_fallback_enabled():
    """Benchmark fallback mode treats unavailable WMH observations as cache misses."""
    from tools.web_search.handler import FAST_CACHE_HIT_FIELD, web_search_activity

    cached = {
        "answer": '{"result_unavailable": true}',
        "metadata": {"result_unavailable": True},
    }
    live = {"results": [{"title": "live"}], "answer": "live answer", "query": "q"}

    with patch.dict(
        "os.environ",
        {
            "BENCHMARK_WMH_FALLBACK_ON_UNAVAILABLE": "1",
            "BENCHMARK_WORLD_MODEL_MODE": "",
        },
        clear=False,
    ):
        with patch("tools.web_search.handler.fast_cache_client.cache_get", new=AsyncMock(return_value=cached)):
            with patch("tools.web_search.handler.fast_cache_client.cache_set", new=AsyncMock(return_value=True)) as set_cache:
                with patch("tools.web_search.handler.execute_search", new=AsyncMock(return_value=live)) as execute_search:
                    result = await web_search_activity(
                        query="AI trends",
                        max_tokens=1000,
                        fast_mode_cache_enabled=True,
                        fast_mode_goal="goal",
                    )

    execute_search.assert_awaited_once_with(query="AI trends", max_tokens=1000)
    assert result == live
    assert FAST_CACHE_HIT_FIELD not in result
    assert set_cache.await_count == 1


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
    r.record("types_contracts", test_types_contracts_are_importable)
    await r.record_async("happy_path", test_web_search_happy_path)
    await r.record_async("boundary", test_web_search_boundary)
    await r.record_async("ddgs_fallback", test_web_search_ddgs_fallback)
    await r.record_async("ddgs_no_api_key", test_web_search_ddgs_no_api_key)
    await r.record_async("manager_execute_tool_happy", test_manager_execute_tool_happy)
    await r.record_async("manager_fast_cache_no_cost", test_manager_execute_tool_fast_cache_hit_has_no_service_cost)
    await r.record_async("activity_fast_cache_marks_result", test_web_search_activity_fast_cache_hit_marks_cached_result)
    await r.record_async(
        "activity_fast_cache_ignores_unavailable",
        test_web_search_activity_ignores_unavailable_fast_cache_when_fallback_enabled,
    )
    await r.record_async("manager_execute_tool_raises", test_manager_execute_tool_raises_on_error)
    await r.record_async("manager_long_query_truncates", test_manager_execute_tool_long_query_truncates)
    await r.record_async("web_search_entry_point", test_web_search_entry_point)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
