"""Blackbox tests for format_tool_display domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


def test_format_spawn_agent():
    """format_tool_display for spawn_agent includes type label and goal."""
    from helpers.format_tool_display import format_tool_display

    result = format_tool_display("spawn_agent", {
        "type": "explore",
        "goal": "Find pricing for Acme Corp",
    })

    assert "Researching" in result
    assert "Find pricing for Acme Corp" in result


def test_format_web_search():
    """format_tool_display for web_search includes query."""
    from helpers.format_tool_display import format_tool_display

    result = format_tool_display("web_search", {
        "query": "best hotels in Lisbon",
    })

    assert "Searching the web" in result
    assert "best hotels in Lisbon" in result


def test_format_unknown_tool():
    """format_tool_display for unknown tool returns raw tool name."""
    from helpers.format_tool_display import format_tool_display

    result = format_tool_display("some_unknown_tool", {"x": 1})

    assert result == "some_unknown_tool"


def test_truncate_short():
    """_truncate leaves short strings unchanged."""
    from helpers.format_tool_display import _truncate

    result = _truncate("hello", 50)

    assert result == "hello"


def test_truncate_long():
    """_truncate shortens long strings and adds ellipsis."""
    from helpers.format_tool_display import _truncate

    long_text = "a" * 100
    result = _truncate(long_text, 20)

    assert len(result) == 20
    assert result.endswith("...")


def test_truncate_empty():
    """_truncate returns '...' for empty/falsy input."""
    from helpers.format_tool_display import _truncate

    assert _truncate("", 50) == "..."
    assert _truncate(None, 50) == "..."


def test_format_spawn_agent_browser():
    """format_tool_display for spawn_agent with type=browser includes browsing label."""
    from helpers.format_tool_display import format_tool_display

    result = format_tool_display("spawn_agent", {
        "type": "browser",
        "goal": "Login and buy item",
    })

    assert "Browsing" in result
    assert "Login and buy item" in result


async def run_all_tests():
    print("format-tool-display blackbox tests:")
    r = BlackboxResult()
    r.record("format_spawn_agent", test_format_spawn_agent)
    r.record("format_web_search", test_format_web_search)
    r.record("format_unknown_tool", test_format_unknown_tool)
    r.record("truncate_short", test_truncate_short)
    r.record("truncate_long", test_truncate_long)
    r.record("truncate_empty", test_truncate_empty)
    r.record("format_spawn_agent_browser", test_format_spawn_agent_browser)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
