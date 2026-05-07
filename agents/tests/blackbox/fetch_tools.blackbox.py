"""Blackbox tests for fetch_tools domain."""

import asyncio
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
        "/api/agents/": {
            "status": 200,
            "json": {
                "agent": {
                    "id": "agent-1",
                    "tools": [
                        {"id": "web_search", "name": "Web Search", "description": "Search the web"},
                        {"id": "grep", "name": "Grep", "description": "Search text patterns"},
                    ],
                },
                "messages": [],
            },
        },
    })


async def test_fetch_agent_tools_happy_path():
    """fetch_agent_tools returns list of tool dicts with id, name, description."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.fetch_tools import fetch_agent_tools

        result = await fetch_agent_tools("agent-1")

    assert len(result) == 2
    assert result[0]["id"] == "web_search"
    assert result[0]["name"] == "Web Search"
    assert result[0]["description"] == "Search the web"
    assert result[1]["id"] == "grep"


async def test_fetch_agent_tools_boundary():
    """Verify GET to correct URL with X-API-Key header."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.fetch_tools import fetch_agent_tools

        await fetch_agent_tools("agent-1")

    assert_captured_call(
        url_contains="/api/agents/agent-1",
        method="GET",
        header_present="X-API-Key",
    )


async def test_legacy_tool_fetch_agent_tools_happy_path():
    """Legacy tools.fetch_tools path returns name/description pairs."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.fetch_tools import fetch_agent_tools

        result = await fetch_agent_tools("agent-1")

    assert result == [
        {"name": "Web Search", "description": "Search the web"},
        {"name": "Grep", "description": "Search text patterns"},
    ]


async def test_legacy_tool_fetch_agent_tools_default_description():
    """Missing descriptions get a stable default in the legacy path."""
    setup_mock(
        {
            "/api/agents/": {
                "status": 200,
                "json": {"agent": {"tools": [{"name": "Only Name"}]}},
            },
        }
    )
    with patch("temporalio.activity.heartbeat"):
        from tools.fetch_tools import fetch_agent_tools

        result = await fetch_agent_tools("agent-2")

    assert result == [{"name": "Only Name", "description": "No description available"}]


async def test_legacy_tool_fetch_agent_tools_error_returns_empty():
    """The legacy tool fetcher fails closed to an empty tool list."""
    setup_mock({"/api/agents/": {"status": 500, "json": {}}})
    with patch("temporalio.activity.heartbeat"):
        from tools.fetch_tools import fetch_agent_tools

        result = await fetch_agent_tools("agent-3")

    assert result == []


async def run_all_tests():
    print("fetch-tools blackbox tests:")
    r = BlackboxResult()
    await r.record_async("fetch_agent_tools_happy_path", test_fetch_agent_tools_happy_path)
    await r.record_async("fetch_agent_tools_boundary", test_fetch_agent_tools_boundary)
    await r.record_async(
        "legacy_tool_fetch_agent_tools_happy_path",
        test_legacy_tool_fetch_agent_tools_happy_path,
    )
    await r.record_async(
        "legacy_tool_fetch_agent_tools_default_description",
        test_legacy_tool_fetch_agent_tools_default_description,
    )
    await r.record_async(
        "legacy_tool_fetch_agent_tools_error_returns_empty",
        test_legacy_tool_fetch_agent_tools_error_returns_empty,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
