"""Blackbox tests for search-user-network domain."""

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
        "/api/people/search": {
            "status": 200,
            "json": {
                "results": [
                    {
                        "id": "person-1",
                        "firstName": "Alice",
                        "lastName": "Smith",
                        "company": "TechCorp",
                        "score": 0.95,
                    },
                    {
                        "id": "person-2",
                        "firstName": "Bob",
                        "lastName": "Jones",
                        "company": "StartupInc",
                        "score": 0.82,
                    },
                ],
                "count": 2,
            },
        },
    })


async def test_search_user_network_happy_path():
    """search_user_network_activity returns matching people."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.search_user_network import search_user_network_activity

        result = await search_user_network_activity(
            user_id="user-42",
            tool_call={"first_name": "Alice"},
        )

    assert result["count"] == 2
    assert len(result["results"]) == 2


async def test_search_user_network_boundary():
    """Verify exact HTTP request sent to backend people search endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.search_user_network import search_user_network_activity

        await search_user_network_activity(
            user_id="user-99",
            tool_call={
                "first_name": "Jane",
                "last_name": "Doe",
                "company": "Google",
                "profession": "Engineer",
            },
        )

    call = assert_captured_call(
        url_contains="/api/people/search",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body.get("first_name") == "Jane"
    assert body.get("last_name") == "Doe"
    assert body.get("company") == "Google"

    headers_lower = {k.lower(): v for k, v in call["requestHeaders"].items()}
    assert "x-user-id" in headers_lower


# -------------------- service.py pure function + flow tests --------------------


async def test_build_display_title_with_name():
    from domains.search_user_network.service import build_display_title
    assert build_display_title({"first_name": "Alice", "last_name": "Smith"}) == "Alice Smith"


async def test_build_display_title_default():
    from domains.search_user_network.service import build_display_title
    assert build_display_title({}) == "contacts"


async def test_build_display_title_truncated():
    from domains.search_user_network.service import build_display_title
    from domains.search_user_network.config import TITLE_MAX_LENGTH

    long = "X" * (TITLE_MAX_LENGTH + 20)
    out = build_display_title({"first_name": long, "last_name": ""})
    assert len(out) == TITLE_MAX_LENGTH
    assert out.endswith("...")


async def test_format_search_criteria_empty():
    from domains.search_user_network.service import format_search_criteria
    assert format_search_criteria({}) == "Searching all contacts..."


async def test_format_search_criteria_all_fields():
    from domains.search_user_network.service import format_search_criteria
    out = format_search_criteria({
        "first_name": "Alice",
        "last_name": "Smith",
        "profession": "Engineer",
        "company": "TechCorp",
        "title": "CTO",
        "industry": "AI",
        "location": "SF",
        "relation": "friend",
        "skills": ["python", "go", "rust", "ts", "sql", "java"],
    })
    assert "Name: Alice Smith" in out
    assert "Profession: Engineer" in out
    assert "Company: TechCorp" in out
    assert "Title: CTO" in out
    assert "Industry: AI" in out
    assert "Location: SF" in out
    assert "Relationship: friend" in out
    assert "Skills: python, go, rust, ts, sql" in out
    # skills truncated at 5
    assert "java" not in out


async def test_format_search_criteria_skills_not_list_skipped():
    from domains.search_user_network.service import format_search_criteria
    out = format_search_criteria({"skills": "not-a-list"})
    assert out == "Searching all contacts..."


async def test_execute_search_happy_path():
    from domains.search_user_network.service import execute_search

    calls = []
    activity_result = {"results": [{"id": "p-1"}], "count": 1}

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        calls.append({"activity": getattr(activity_fn, "__name__", "fn"), "args": args})
        return activity_result

    async def fake_activity(user_id, tool_call):
        return activity_result
    fake_activity.__name__ = "search_user_network_activity"

    result = await execute_search(
        execute_activity=mock_execute_activity,
        activity_fn=fake_activity,
        tool_call={"first_name": "Alice", "last_name": "Smith"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert result == activity_result
    activities = [c["activity"] for c in calls]
    assert "search_user_network_activity" in activities
    assert activities.count("post_agent_message") >= 2


async def test_execute_search_error_path():
    from domains.search_user_network.service import execute_search

    calls = []

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        name = getattr(activity_fn, "__name__", "fn")
        calls.append({"activity": name})
        if name == "search_user_network_activity":
            raise RuntimeError("backend 500")
        return None

    async def fake_activity(user_id, tool_call):
        return None
    fake_activity.__name__ = "search_user_network_activity"

    result = await execute_search(
        execute_activity=mock_execute_activity,
        activity_fn=fake_activity,
        tool_call={"first_name": "Bob"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert result["error"] == "backend 500"
    assert result["results"] == []
    assert result["count"] == 0
    # in_progress + error post
    activities = [c["activity"] for c in calls]
    assert activities.count("post_agent_message") >= 2


async def test_manager_execute_tool():
    """Manager.execute_tool delegates to execute_search."""
    from domains.search_user_network.handler import SearchUserNetworkManager

    activity_result = {"results": [], "count": 0}

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "search_user_network_activity":
            return activity_result
        return None

    manager = SearchUserNetworkManager()
    result = await manager.execute_tool(
        execute_activity=mock_execute_activity,
        tool_call={"first_name": "Alice"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert result == activity_result


async def run_all_tests():
    print("search-user-network blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_search_user_network_happy_path)
    await r.record_async("boundary", test_search_user_network_boundary)
    await r.record_async("build_display_title_with_name", test_build_display_title_with_name)
    await r.record_async("build_display_title_default", test_build_display_title_default)
    await r.record_async("build_display_title_truncated", test_build_display_title_truncated)
    await r.record_async("format_search_criteria_empty", test_format_search_criteria_empty)
    await r.record_async("format_search_criteria_all_fields", test_format_search_criteria_all_fields)
    await r.record_async("format_search_criteria_skills_not_list", test_format_search_criteria_skills_not_list_skipped)
    await r.record_async("execute_search_happy_path", test_execute_search_happy_path)
    await r.record_async("execute_search_error_path", test_execute_search_error_path)
    await r.record_async("manager_execute_tool", test_manager_execute_tool)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
