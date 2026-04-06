"""Blackbox tests for knowledge-base-helper domain (helpers/knowledge_base.py)."""

import asyncio
import json
from unittest.mock import patch

import httpx

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock_fn,
    teardown_mock,
)


def _mock_handler(request: httpx.Request) -> httpx.Response:
    """Route blueprint API endpoints and LLM completions."""
    url = str(request.url)

    # POST /api/blueprints/search
    if "/api/blueprints/search" in url:
        return httpx.Response(200, json=[
            {"id": "bp-1", "title": "Book a flight", "blueprint": [{"role": "USER", "text": "Book flight"}]},
            {"id": "bp-2", "title": "Send email", "blueprint": [{"role": "USER", "text": "Send email"}]},
        ])

    # POST /api/blueprints (save)
    if "/api/blueprints" in url:
        return httpx.Response(200, json={
            "id": "bp-saved-1",
            "title": "Test goal",
            "created": True,
        })

    # Rose completions endpoint (used by save_blueprint_deprecated for LLM compression)
    if "/completions" in url or "openrouter" in url or "rose" in url:
        return httpx.Response(200, json={
            "choices": [{"message": {"content": json.dumps([
                {"role": "USER", "text": "Test goal", "timestamp": "2026-04-05T12:00:00Z"},
            ])}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
        })

    return httpx.Response(404, json={"error": f"No mock for {url}"})


def _setup():
    setup_mock_fn(_mock_handler)


async def test_extract_goal_from_context():
    """extract_goal_from_context extracts goal from first USER message."""
    from helpers.knowledge_base import extract_goal_from_context

    context = [
        {"role": "SYSTEM", "text": "You are an agent"},
        {"role": "USER", "text": "Find cheap flights to Tokyo"},
        {"role": "ASSISTANT", "text": "I'll search for flights"},
    ]

    goal = extract_goal_from_context(context)
    assert goal == "Find cheap flights to Tokyo"


async def test_extract_goal_empty_context():
    """extract_goal_from_context returns default for empty context."""
    from helpers.knowledge_base import extract_goal_from_context

    assert extract_goal_from_context([]) == "No goal specified"


async def test_extract_goal_no_user_message():
    """extract_goal_from_context returns default when no USER message exists."""
    from helpers.knowledge_base import extract_goal_from_context

    context = [
        {"role": "SYSTEM", "text": "System message"},
        {"role": "ASSISTANT", "text": "Hello"},
    ]
    assert extract_goal_from_context(context) == "No goal specified"


async def test_query_blueprints_happy_path():
    """query_blueprints_deprecated returns matching blueprints from backend."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.knowledge_base import query_blueprints_deprecated

        result = await query_blueprints_deprecated(
            context=[{"role": "USER", "text": "Book a flight to Paris"}],
            user_id="user-42",
            limit=3,
        )

    assert len(result) == 2
    assert result[0]["id"] == "bp-1"


async def test_query_blueprints_boundary():
    """Verify POST to /api/blueprints/search with correct body."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.knowledge_base import query_blueprints_deprecated

        await query_blueprints_deprecated(
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


async def test_save_blueprint_boundary():
    """Verify save_blueprint_deprecated POSTs to /api/blueprints."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.knowledge_base import save_blueprint_deprecated

        messages = [
            {"role": "USER", "text": "Send a welcome email"},
            {"role": "TOOL", "text": "Email sent", "metadata": {"toolName": "message_person", "toolStatus": "FINISHED"}},
        ]
        result = await save_blueprint_deprecated(
            user_id="user-77",
            blueprint=messages,
        )

    assert result["saved_blueprint"]["id"] == "bp-saved-1"
    assert "usage" in result

    # Find the POST to /api/blueprints (not /search)
    captures = get_captured_requests()
    save_calls = [c for c in captures if "/api/blueprints" in c["url"] and "/search" not in c["url"] and c["method"] == "POST"]
    assert len(save_calls) >= 1, f"Expected POST to /api/blueprints, got {[c['url'] for c in captures]}"

    body = json.loads(save_calls[0]["requestBody"])
    assert body["user_id"] == "user-77"
    assert body["title"] == "Send a welcome email"
    assert "blueprint" in body


async def run_all_tests():
    print("knowledge-base-helper blackbox tests:")
    r = BlackboxResult()
    await r.record_async("extract_goal", test_extract_goal_from_context)
    await r.record_async("extract_goal_empty", test_extract_goal_empty_context)
    await r.record_async("extract_goal_no_user", test_extract_goal_no_user_message)
    await r.record_async("query_blueprints_happy_path", test_query_blueprints_happy_path)
    await r.record_async("query_blueprints_boundary", test_query_blueprints_boundary)
    await r.record_async("save_blueprint_boundary", test_save_blueprint_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
