"""Blackbox tests for call-phone-number domain."""

import asyncio
import json
from unittest.mock import patch, AsyncMock

import httpx

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock_fn,
    teardown_mock,
)


def _mock_handler(request: httpx.Request) -> httpx.Response:
    url = str(request.url)

    if "/api/vapi/call" in url and request.method == "POST" and "/call/" not in url.split("/api/vapi/call")[1]:
        return httpx.Response(200, json={"call_id": "call-test-123"})

    if "/api/vapi/call/call-test-123" in url and request.method == "GET":
        return httpx.Response(200, json={
            "status": "ended",
            "analysis": {
                "summary": "Called and discussed project details",
                "structuredData": {"sentiment": "positive"},
            },
            "transcript": "Hello, this is a test call.",
            "endedReason": "hangup",
            "recordingUrl": "https://recordings.test/abc.mp3",
            "startedAt": "2026-01-01T00:00:00Z",
            "endedAt": "2026-01-01T00:02:30Z",
        })

    # Catch-all for messages endpoint and other calls
    if "/api/agents/" in url and "/messages" in url:
        return httpx.Response(200, json={"id": "msg-1"})

    return httpx.Response(404)


async def _noop_sleep(_seconds):
    """Instant replacement for asyncio.sleep in tests."""
    pass


async def test_initiation_boundary():
    """Verify the call initiation POST sends correct params to backend."""
    setup_mock_fn(_mock_handler)

    with (
        patch("temporalio.activity.heartbeat"),
        patch("tools.call_phone_number.asyncio.sleep", side_effect=_noop_sleep),
    ):
        from tools.call_phone_number import call_phone_number_activity

        result = await call_phone_number_activity(
            to="+15551234567",
            system_prompt="You are a helpful assistant",
            output_schema={"type": "object", "properties": {"sentiment": {"type": "string"}}},
            agent_id="agent-1",
            tool_call_id="tc-1",
            user_id="user-1",
        )

    captures = get_captured_requests()
    # First capture is the POST to initiate the call
    initiation = captures[0]
    assert "/api/vapi/call" in initiation["url"]
    assert initiation["method"] == "POST"
    body = json.loads(initiation["requestBody"])
    assert body["to"] == "+15551234567"
    assert body["system_prompt"] == "You are a helpful assistant"
    assert "properties" in body["output_schema"]

    assert result["success"] is True
    assert result["call_id"] == "call-test-123"


async def test_poll_boundary():
    """Verify the status polling GET hits the correct URL."""
    setup_mock_fn(_mock_handler)

    with (
        patch("temporalio.activity.heartbeat"),
        patch("tools.call_phone_number.save_phone_call_message", new_callable=AsyncMock),
        patch("tools.call_phone_number.asyncio.sleep", side_effect=_noop_sleep),
    ):
        from tools.call_phone_number import call_phone_number_activity

        await call_phone_number_activity(
            to="+15559876543",
            system_prompt="Test",
            output_schema={},
            agent_id="a-1",
            tool_call_id="tc-1",
        )

    captures = get_captured_requests()
    # Should have at least 2 captures: POST init + GET poll
    assert len(captures) >= 2
    poll = captures[1]
    assert "/api/vapi/call/call-test-123" in poll["url"]
    assert poll["method"] == "GET"


async def test_finished_message_contains_call_evidence_for_verifier():
    """Verify the persisted FINISHED message includes evidence the verifier can read."""
    setup_mock_fn(_mock_handler)

    with (
        patch("temporalio.activity.heartbeat"),
        patch("tools.call_phone_number.save_phone_call_message", new_callable=AsyncMock),
        patch("tools.call_phone_number.asyncio.sleep", side_effect=_noop_sleep),
    ):
        from tools.call_phone_number import call_phone_number_activity

        result = await call_phone_number_activity(
            to="+15559876543",
            system_prompt="Tell them they are amazing.",
            output_schema={"compliment_delivered": "Whether the compliment was delivered"},
            agent_id="a-1",
            tool_call_id="tc-1",
        )

    assert result["summary"] == "Called and discussed project details"
    captures = get_captured_requests()
    message_posts = [
        capture
        for capture in captures
        if "/api/agents/a-1/messages" in capture["url"] and capture["method"] == "POST"
    ]
    assert message_posts, "Expected call completion to persist a TOOL message"

    body = json.loads(message_posts[-1]["requestBody"])
    message = body["message"]
    assert "Summary: Called and discussed project details" in message
    assert '"sentiment": "positive"' in message
    assert "Transcript:" in message
    assert "Hello, this is a test call." in message


# -------------------- service.py tests --------------------


def test_format_phone_number_e164():
    from domains.call_phone_number.service import format_phone_number
    assert format_phone_number("+19729777432") == "+1 (972) 977-7432"


def test_format_phone_number_ten_digits():
    from domains.call_phone_number.service import format_phone_number
    assert format_phone_number("9729777432") == "+1 (972) 977-7432"


def test_format_phone_number_with_formatting():
    from domains.call_phone_number.service import format_phone_number
    assert format_phone_number("(972) 977-7432") == "+1 (972) 977-7432"


def test_format_phone_number_unparseable():
    from domains.call_phone_number.service import format_phone_number
    assert format_phone_number("not-a-number") == "not-a-number"


def test_compute_call_cost_cents_min_billing():
    from domains.call_phone_number.service import compute_call_cost_cents
    from domains.call_phone_number.config import COST_CENTS_PER_MINUTE, MINIMUM_BILLED_MINUTES
    # 30s call is bumped to MINIMUM_BILLED_MINUTES
    cost = compute_call_cost_cents(30)
    assert cost == int(MINIMUM_BILLED_MINUTES * COST_CENTS_PER_MINUTE)


def test_compute_call_cost_cents_actual_duration():
    from domains.call_phone_number.service import compute_call_cost_cents
    from domains.call_phone_number.config import COST_CENTS_PER_MINUTE, MINIMUM_BILLED_MINUTES
    # Long call
    seconds = 600  # 10 minutes
    minutes_billed = max(MINIMUM_BILLED_MINUTES, seconds / 60)
    cost = compute_call_cost_cents(seconds)
    assert cost == int(minutes_billed * COST_CENTS_PER_MINUTE)


def test_compute_service_usage():
    from domains.call_phone_number.service import compute_service_usage
    from domains.call_phone_number.config import CALL_PROVIDER
    usage = compute_service_usage(120)
    assert len(usage) == 1
    assert usage[0]["provider"] == CALL_PROVIDER
    assert usage[0]["cost_cents"] > 0


def test_build_completion_message_full():
    from domains.call_phone_number.service import build_completion_message
    out = build_completion_message(
        formatted_phone="+1 (555) 123-4567",
        duration=120,
        summary="Discussed project",
        structured_data={"sentiment": "positive"},
        transcript="Hello world",
    )
    assert "+1 (555) 123-4567" in out
    assert "120s" in out
    assert "Summary: Discussed project" in out
    assert '"sentiment": "positive"' in out
    assert "Transcript:" in out
    assert "Hello world" in out


def test_build_completion_message_minimal():
    from domains.call_phone_number.service import build_completion_message
    out = build_completion_message(
        formatted_phone="+1 (555) 123-4567",
        duration=5,
        summary="",
        structured_data={},
        transcript="",
    )
    assert "+1 (555) 123-4567" in out
    assert "Summary" not in out
    assert "Transcript" not in out


def test_calculate_duration_from_timestamps_valid():
    from domains.call_phone_number.service import calculate_duration_from_timestamps
    d = calculate_duration_from_timestamps(
        "2026-01-01T00:00:00Z", "2026-01-01T00:01:30Z"
    )
    assert d == 90


def test_calculate_duration_from_timestamps_missing():
    from domains.call_phone_number.service import calculate_duration_from_timestamps
    assert calculate_duration_from_timestamps(None, None) == 0
    assert calculate_duration_from_timestamps("2026-01-01T00:00:00Z", None) == 0


def test_calculate_duration_from_timestamps_invalid():
    from domains.call_phone_number.service import calculate_duration_from_timestamps
    assert calculate_duration_from_timestamps("not-a-time", "also-not") == 0


# -------------------- handler.py manager tests --------------------


def test_manager_get_approval_question():
    from domains.call_phone_number.handler import CallPhoneNumberManager
    manager = CallPhoneNumberManager()
    q = manager.get_approval_question({
        "to": "+19729777432",
        "system_prompt": "Be polite",
    })
    assert "+1 (972) 977-7432" in q
    assert "Be polite" in q


def test_manager_get_approval_question_defaults():
    from domains.call_phone_number.handler import CallPhoneNumberManager
    manager = CallPhoneNumberManager()
    q = manager.get_approval_question({})
    # Defaults: to="unknown", system_prompt=""
    assert "unknown" in q


async def test_manager_execute_tool_success():
    from domains.call_phone_number.handler import CallPhoneNumberManager

    activity_result = {
        "success": True,
        "call_id": "c-1",
        "duration": 120,
    }

    async def mock_execute_activity(activity_fn, *, args, **kw):
        if getattr(activity_fn, "__name__", "") == "call_phone_number_activity":
            return activity_result
        return None

    manager = CallPhoneNumberManager()
    out = await manager.execute_tool(
        execute_activity=mock_execute_activity,
        tool_call={"to": "+19729777432", "system_prompt": "Be kind"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out == activity_result


async def test_manager_execute_tool_error():
    from domains.call_phone_number.handler import CallPhoneNumberManager

    async def mock_execute_activity(activity_fn, *, args, **kw):
        if getattr(activity_fn, "__name__", "") == "call_phone_number_activity":
            raise RuntimeError("vapi offline")
        return None

    manager = CallPhoneNumberManager()
    out = await manager.execute_tool(
        execute_activity=mock_execute_activity,
        tool_call={"to": "+19729777432", "system_prompt": "Be kind"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert "error" in out
    assert "vapi offline" in out["error"]
    assert out["to"] == "+19729777432"


async def test_call_phone_number_entry_point():
    from domains.call_phone_number.handler import call_phone_number

    async def mock_execute_activity(activity_fn, *, args, **kw):
        if getattr(activity_fn, "__name__", "") == "call_phone_number_activity":
            return {"success": True, "call_id": "c-1", "duration": 60}
        return None

    out = await call_phone_number(
        execute_activity=mock_execute_activity,
        tool_call={"to": "+19729777432", "system_prompt": "p"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out["success"] is True


async def run_all_tests():
    print("call-phone-number blackbox tests:")
    r = BlackboxResult()
    await r.record_async("initiation_boundary", test_initiation_boundary)
    await r.record_async("poll_boundary", test_poll_boundary)
    await r.record_async(
        "finished_message_contains_call_evidence_for_verifier",
        test_finished_message_contains_call_evidence_for_verifier,
    )
    r.record("format_phone_number_e164", test_format_phone_number_e164)
    r.record("format_phone_number_ten_digits", test_format_phone_number_ten_digits)
    r.record("format_phone_number_with_formatting", test_format_phone_number_with_formatting)
    r.record("format_phone_number_unparseable", test_format_phone_number_unparseable)
    r.record("compute_call_cost_cents_min_billing", test_compute_call_cost_cents_min_billing)
    r.record("compute_call_cost_cents_actual_duration", test_compute_call_cost_cents_actual_duration)
    r.record("compute_service_usage", test_compute_service_usage)
    r.record("build_completion_message_full", test_build_completion_message_full)
    r.record("build_completion_message_minimal", test_build_completion_message_minimal)
    r.record("calculate_duration_from_timestamps_valid", test_calculate_duration_from_timestamps_valid)
    r.record("calculate_duration_from_timestamps_missing", test_calculate_duration_from_timestamps_missing)
    r.record("calculate_duration_from_timestamps_invalid", test_calculate_duration_from_timestamps_invalid)
    r.record("manager_get_approval_question", test_manager_get_approval_question)
    r.record("manager_get_approval_question_defaults", test_manager_get_approval_question_defaults)
    await r.record_async("manager_execute_tool_success", test_manager_execute_tool_success)
    await r.record_async("manager_execute_tool_error", test_manager_execute_tool_error)
    await r.record_async("call_phone_number_entry_point", test_call_phone_number_entry_point)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
