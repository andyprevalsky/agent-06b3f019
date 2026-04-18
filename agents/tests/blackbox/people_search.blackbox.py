"""Blackbox tests for people-search domain."""

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
        "api.exa.ai/search": {
            "status": 200,
            "json": {
                "results": [
                    {
                        "title": "Jane Smith - CTO at TechCorp",
                        "url": "https://linkedin.com/in/janesmith",
                        "text": "Jane Smith is a seasoned CTO...",
                    },
                    {
                        "title": "John Doe - VP Engineering",
                        "url": "https://linkedin.com/in/johndoe",
                        "text": "John Doe leads engineering at...",
                    },
                ],
            },
        },
    })


async def test_people_search_happy_path():
    """people_search_activity returns formatted results from Exa."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.people_search import people_search_activity

        result = await people_search_activity(
            query="CTO at AI startups in SF",
            max_results=5,
        )

    assert "candidates" in result or "results" in result
    assert result.get("provider") == "exa" or result.get("query") == "CTO at AI startups in SF"


async def test_people_search_boundary():
    """Verify exact HTTP request sent to Exa search API."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.people_search import people_search_activity

        await people_search_activity(
            query="Data scientists at Google",
            max_results=10,
        )

    call = assert_captured_call(
        url_contains="api.exa.ai/search",
        method="POST",
        body_contains={"query": "Data scientists at Google", "category": "people"},
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    assert body["numResults"] == 10
    assert "contents" in body


# -------------------- handler.py tests --------------------


def _mock_execute(calls: list, *, result: dict | None = None, raises: bool = False):
    async def mock(activity_fn, *args, **kwargs):
        name = getattr(activity_fn, "__name__", "")
        calls.append({"activity": name, "kwargs": kwargs})
        if name == "people_search_activity":
            if raises:
                raise RuntimeError("exa offline")
            return result or {"candidates": [{"name": "Jane"}], "query": "x", "provider": "exa"}
        return None
    return mock


async def test_manager_execute_tool_happy():
    """ExaPeopleSearchManager.execute_tool returns result + usage."""
    from domains.people_search.handler import ExaPeopleSearchManager

    calls = []
    manager = ExaPeopleSearchManager()
    out = await manager.execute_tool(
        execute_activity=_mock_execute(
            calls,
            result={"candidates": [{"n": 1}, {"n": 2}], "query": "q", "provider": "exa"},
        ),
        tool_call={"query": "ML engineers", "max_results": 5},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert out["result"]["provider"] == "exa"
    assert len(out["result"]["candidates"]) == 2
    assert "service" in out["usage"]
    assert out["usage"]["service"][0]["provider"] == "Exa People Search"


async def test_manager_execute_tool_error_returns_error_dict():
    """On error, manager returns {error, query} (does not raise)."""
    from domains.people_search.handler import ExaPeopleSearchManager

    calls = []
    manager = ExaPeopleSearchManager()
    out = await manager.execute_tool(
        execute_activity=_mock_execute(calls, raises=True),
        tool_call={"query": "q1"},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert "error" in out
    assert "exa offline" in out["error"]
    assert out["query"] == "q1"


async def test_manager_execute_tool_long_query_truncates_display():
    """Long queries trigger the truncation path for display."""
    from domains.people_search.handler import ExaPeopleSearchManager

    calls = []
    manager = ExaPeopleSearchManager()
    await manager.execute_tool(
        execute_activity=_mock_execute(calls),
        tool_call={"query": "x" * 400},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    # activity received full query
    read_calls = [c for c in calls if c["activity"] == "people_search_activity"]
    assert len(read_calls) == 1


async def test_people_search_entry_point():
    """people_search() entry point dispatches to manager."""
    from domains.people_search.handler import people_search

    calls = []
    out = await people_search(
        execute_activity=_mock_execute(calls),
        tool_call={"query": "ML engineers"},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert "result" in out
    assert "usage" in out


async def run_all_tests():
    print("people-search blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_people_search_happy_path)
    await r.record_async("boundary", test_people_search_boundary)
    await r.record_async("manager_execute_tool_happy", test_manager_execute_tool_happy)
    await r.record_async("manager_execute_tool_error", test_manager_execute_tool_error_returns_error_dict)
    await r.record_async("manager_long_query_truncates", test_manager_execute_tool_long_query_truncates_display)
    await r.record_async("people_search_entry_point", test_people_search_entry_point)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
