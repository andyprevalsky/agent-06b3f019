"""Blackbox tests for knowledge-base domain."""

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
        "/api/blueprints/search": {
            "status": 200,
            "json": [
                {"id": "bp-1", "title": "Book a flight", "blueprint": "STATUS: SUCCESS\nTRAJECTORY:\n  t:0  web_search"},
                {"id": "bp-2", "title": "Send an email", "blueprint": "STATUS: SUCCESS\nTRAJECTORY:\n  t:0  message_person"},
            ],
        },
        "/api/blueprints": {
            "status": 200,
            "json": {"id": "bp-new-1", "title": "Test goal", "created": True},
        },
    })


async def test_query_blueprints_happy_path():
    """query_blueprints_activity returns matching blueprints."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.knowledge_base import query_blueprints_activity

        result = await query_blueprints_activity(
            context=[{"role": "USER", "text": "Book a flight to Paris"}],
            user_id="user-42",
            limit=3,
        )

    assert len(result) == 2
    assert result[0]["id"] == "bp-1"
    assert result[0]["title"] == "Book a flight"


async def test_query_blueprints_boundary():
    """Verify exact HTTP request sent to blueprints search endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.knowledge_base import query_blueprints_activity

        await query_blueprints_activity(
            context=[{"role": "USER", "text": "Research competitor pricing"}],
            user_id="user-99",
            limit=5,
        )

    call = assert_captured_call(
        url_contains="/api/blueprints/search",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["goal"] == "Research competitor pricing"
    assert body["user_id"] == "user-99"
    assert body["limit"] == 5


async def test_save_blueprint_happy_path():
    """save_blueprint_activity saves compressed blueprint via backend."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.knowledge_base import save_blueprint_activity

        messages = [
            {"role": "USER", "text": "Test goal for saving"},
            {"role": "TOOL", "text": "Search done", "metadata": {"toolName": "web_search", "toolStatus": "FINISHED", "toolCallId": "tc-1"}},
        ]
        result = await save_blueprint_activity(
            user_id="user-42",
            blueprint=messages,
        )

    assert result["saved_blueprint"]["id"] == "bp-new-1"
    assert result["saved_blueprint"]["created"] is True


async def test_save_blueprint_boundary():
    """Verify exact HTTP request sent to blueprints save endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.knowledge_base import save_blueprint_activity

        messages = [
            {"role": "USER", "text": "Send a welcome email"},
            {"role": "TOOL", "text": "Email sent", "metadata": {"toolName": "message_person", "toolStatus": "FINISHED", "toolCallId": "tc-2"}},
        ]
        await save_blueprint_activity(user_id="user-77", blueprint=messages)

    call = assert_captured_call(
        url_contains="/api/blueprints",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["user_id"] == "user-77"
    assert body["title"] == "Send a welcome email"
    assert "blueprint" in body
    # Blueprint should be a compressed text string, not JSON
    assert isinstance(body["blueprint"], str)
    assert "TRAJECTORY:" in body["blueprint"]


async def test_trajectory_compression():
    """_build_trajectory_blueprint produces compact deterministic output."""
    from tools.knowledge_base import _build_trajectory_blueprint

    context = [
        {"role": "USER", "text": "Find AI companies"},
        {"role": "TOOL", "text": "3 results", "metadata": {
            "toolName": "web_search", "toolStatus": "FINISHED", "toolCallId": "tc-1",
            "data": {"query": "AI companies"},
        }},
        {"role": "TOOL", "text": "fetched", "metadata": {
            "toolName": "web_fetch", "toolStatus": "FINISHED", "toolCallId": "tc-2",
            "data": {"url": "https://example.com/ai"},
        }},
        {"role": "TOOL", "text": "done", "metadata": {
            "toolName": "attempt_completion", "toolStatus": "FINISHED", "toolCallId": "tc-3",
        }},
    ]
    result = _build_trajectory_blueprint(context, "Find AI companies")

    assert "STATUS: SUCCESS" in result
    assert "TRAJECTORY:" in result
    assert "web_search" in result
    assert "web_fetch" in result
    assert "attempt_completion" in result
    assert "USER MESSAGES:" in result
    assert "Find AI companies" in result


async def test_query_blueprints_empty_context():
    """query_blueprints_activity handles empty context gracefully."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.knowledge_base import query_blueprints_activity

        # Empty context should still make the request (extract_goal_from_context handles it)
        result = await query_blueprints_activity(
            context=[],
            user_id="user-1",
            limit=1,
        )

    # Should return results (mock always returns 2 results)
    assert isinstance(result, list)


async def run_all_tests():
    print("knowledge-base blackbox tests:")
    r = BlackboxResult()
    await r.record_async("query_happy_path", test_query_blueprints_happy_path)
    await r.record_async("query_boundary", test_query_blueprints_boundary)
    await r.record_async("save_happy_path", test_save_blueprint_happy_path)
    await r.record_async("save_boundary", test_save_blueprint_boundary)
    await r.record_async("trajectory_compression", test_trajectory_compression)
    await r.record_async("query_empty_context", test_query_blueprints_empty_context)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
