"""Blackbox tests for read-message-history domain."""

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


def _make_mock_execute_activity(calls: list):
    async def mock(activity_fn, *, args, start_to_close_timeout, retry_policy):
        calls.append({"activity": activity_fn.__name__, "args": args})
        # simulate activity fn return - but only care about execute_tool flow
        return None
    return mock


def _setup():
    setup_mock({
        "/api/people/messages": {
            "status": 200,
            "json": {
                "person": {
                    "id": "person-1",
                    "firstName": "Alice",
                    "lastName": "Smith",
                    "phoneNumber": "+15551234567",
                    "email": "alice@example.com",
                },
                "messages": [
                    {"text": "Hey!", "direction": "inbound", "timestamp": "2026-04-01T10:00:00Z"},
                    {"text": "Hi there!", "direction": "outbound", "timestamp": "2026-04-01T10:01:00Z"},
                ],
                "count": 2,
            },
        },
    })


async def test_read_message_history_happy_path():
    """read_message_history_activity returns person info and messages."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.read_message_history import read_message_history_activity

        result = await read_message_history_activity(
            user_id="user-42",
            phone="+15551234567",
        )

    assert result["person"]["firstName"] == "Alice"
    assert result["count"] == 2
    assert len(result["messages"]) == 2


async def test_read_message_history_boundary():
    """Verify exact HTTP request sent to backend messages endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.read_message_history import read_message_history_activity

        await read_message_history_activity(
            user_id="user-99",
            email="bob@example.com",
            first_name="Bob",
            last_name="Jones",
            message_limit=25,
        )

    call = assert_captured_call(
        url_contains="/api/people/messages",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["user_id"] == "user-99"
    assert body["email"] == "bob@example.com"
    assert body["firstName"] == "Bob"
    assert body["lastName"] == "Jones"
    assert body["message_limit"] == 25


async def test_read_message_history_phone_only():
    """Activity works with phone number as only identifier."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.read_message_history import read_message_history_activity

        result = await read_message_history_activity(
            user_id="user-42",
            phone="+15559876543",
        )

    assert result["person"] is not None
    call = assert_captured_call(
        url_contains="/api/people/messages",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["phone"] == "+15559876543"
    assert "email" not in body or body.get("email") is None


# -------------------- service.py pure function tests --------------------


async def test_build_person_identifier_full_name():
    from domains.read_message_history.service import build_person_identifier
    assert build_person_identifier(
        phone=None, email=None, first_name="Alice", last_name="Smith"
    ) == "Alice Smith"


async def test_build_person_identifier_email_fallback():
    from domains.read_message_history.service import build_person_identifier
    assert build_person_identifier(
        phone=None, email="alice@example.com", first_name=None, last_name=None
    ) == "alice@example.com"


async def test_build_person_identifier_phone_fallback():
    from domains.read_message_history.service import build_person_identifier
    assert build_person_identifier(
        phone="+15551234567", email=None, first_name=None, last_name=None
    ) == "+15551234567"


async def test_build_person_identifier_unknown():
    from domains.read_message_history.service import build_person_identifier
    assert build_person_identifier(
        phone=None, email=None, first_name=None, last_name=None
    ) == "Unknown"
    assert build_person_identifier(
        phone="", email="", first_name="", last_name=""
    ) == "Unknown"


async def test_build_person_identifier_partial_name_falls_through():
    """Only first_name without last_name should not match full-name branch."""
    from domains.read_message_history.service import build_person_identifier
    assert build_person_identifier(
        phone=None, email="e@e.com", first_name="Alice", last_name=None
    ) == "e@e.com"


async def test_validate_identifiers_truthy():
    from domains.read_message_history.service import validate_identifiers
    assert validate_identifiers(phone="+1555", email=None, first_name=None, last_name=None)
    assert validate_identifiers(phone=None, email="a@b", first_name=None, last_name=None)
    assert validate_identifiers(
        phone=None, email=None, first_name="A", last_name="B"
    )


async def test_validate_identifiers_falsy():
    from domains.read_message_history.service import validate_identifiers
    assert not validate_identifiers(phone=None, email=None, first_name=None, last_name=None)
    assert not validate_identifiers(phone="", email="", first_name="A", last_name=None)


async def test_build_read_metadata_with_person():
    from domains.read_message_history.service import build_read_metadata
    md = build_read_metadata(
        phone="+1555",
        email=None,
        first_name=None,
        last_name=None,
        person={"id": "p-1", "phoneNumber": "+1555", "email": "a@b.com"},
    )
    assert md["read_message_history_person"]["person_id"] == "p-1"
    assert md["read_message_history_person"]["phone"] == "+1555"
    assert md["read_message_history_person"]["person_phone"] == "+1555"
    assert md["read_message_history_person"]["person_email"] == "a@b.com"


async def test_build_read_metadata_no_person():
    from domains.read_message_history.service import build_read_metadata
    md = build_read_metadata(
        phone=None,
        email="a@b.com",
        first_name=None,
        last_name=None,
        person=None,
    )
    inner = md["read_message_history_person"]
    assert inner["person_id"] is None
    assert inner["person_phone"] is None
    assert inner["person_email"] is None
    assert inner["email"] == "a@b.com"


async def test_format_messages_for_display_empty():
    from domains.read_message_history.service import format_messages_for_display
    assert format_messages_for_display([]) == ""


async def test_format_messages_for_display_multi():
    from domains.read_message_history.service import format_messages_for_display
    out = format_messages_for_display([
        {"channel": "SMS", "from": "+1", "to": "+2", "timestamp": "t1", "message": "hi"},
        {"channel": "EMAIL", "from": "a@b", "to": "c@d", "timestamp": "t2", "message": "yo"},
    ])
    assert "[SMS]" in out
    assert "[EMAIL]" in out
    assert "1." in out and "2." in out
    assert "`+1`" in out and "`+2`" in out
    assert "hi" in out and "yo" in out


# -------------------- post_* event tests (exercise service.py event paths) --------------------


async def test_post_validation_error_calls_execute_activity():
    from domains.read_message_history.service import post_validation_error

    calls = []
    await post_validation_error(
        agent_id="a-1",
        tool_call_id="tc-1",
        execute_activity=_make_mock_execute_activity(calls),
        user_id="u-1",
    )
    assert len(calls) == 1
    assert calls[0]["activity"] == "post_agent_message"
    metadata = calls[0]["args"][3]
    assert metadata["toolStatus"] == "ERROR"


async def test_post_in_progress_event():
    from domains.read_message_history.service import post_in_progress

    calls = []
    await post_in_progress(
        person_identifier="Alice",
        agent_id="a-1",
        tool_call_id="tc-1",
        execute_activity=_make_mock_execute_activity(calls),
        user_id=None,
    )
    assert len(calls) == 1
    assert "Alice" in calls[0]["args"][1]
    assert calls[0]["args"][3]["toolStatus"] == "IN_PROGRESS"


async def test_post_result_event_no_person():
    from domains.read_message_history.service import post_result_event

    calls = []
    await post_result_event(
        result={"messages": [], "person": None, "message": "no match"},
        tool_call={"phone": "+1"},
        elapsed_time=1.0,
        read_metadata={"x": {"foo": "bar"}},
        person_identifier="someone",
        agent_id="a-1",
        tool_call_id="tc-1",
        execute_activity=_make_mock_execute_activity(calls),
        user_id="u-1",
    )
    assert len(calls) == 1
    assert calls[0]["args"][3]["toolStatus"] == "FINISHED"


async def test_post_result_event_zero_messages():
    from domains.read_message_history.service import post_result_event

    calls = []
    await post_result_event(
        result={"messages": [], "person": {"firstName": "Alice", "lastName": "S"}},
        tool_call={"phone": "+1"},
        elapsed_time=0.5,
        read_metadata={"x": {}},
        person_identifier="Alice S",
        agent_id="a-1",
        tool_call_id="tc-1",
        execute_activity=_make_mock_execute_activity(calls),
        user_id=None,
    )
    assert len(calls) == 1
    assert "Alice S" in calls[0]["args"][1] or "No messages" in calls[0]["args"][1]


async def test_post_result_event_with_messages():
    from domains.read_message_history.service import post_result_event

    calls = []
    await post_result_event(
        result={
            "messages": [
                {"channel": "SMS", "from": "+1", "to": "+2", "timestamp": "t", "message": "m"},
            ],
            "person": {"firstName": "Alice", "lastName": "Smith"},
        },
        tool_call={"phone": "+1"},
        elapsed_time=2.5,
        read_metadata={"x": {}},
        person_identifier="Alice Smith",
        agent_id="a-1",
        tool_call_id="tc-1",
        execute_activity=_make_mock_execute_activity(calls),
        user_id=None,
    )
    assert len(calls) == 1
    # message body should contain "Alice Smith" in title
    assert calls[0]["args"][3]["toolStatus"] == "FINISHED"


async def test_post_error_event():
    from domains.read_message_history.service import post_error_event

    calls = []
    await post_error_event(
        error=RuntimeError("boom"),
        tool_call={"phone": "+1"},
        elapsed_time=0.1,
        agent_id="a-1",
        tool_call_id="tc-1",
        execute_activity=_make_mock_execute_activity(calls),
        user_id=None,
    )
    assert len(calls) == 1
    assert calls[0]["args"][3]["toolStatus"] == "ERROR"


# -------------------- handler.execute_tool tests --------------------


async def test_manager_execute_tool_missing_identifier():
    from domains.read_message_history.handler import ReadMessageHistoryManager

    calls = []
    manager = ReadMessageHistoryManager()
    result = await manager.execute_tool(
        execute_activity=_make_mock_execute_activity(calls),
        tool_call={},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert result["error"] == "Missing identifier"
    assert result["messages"] == []
    assert result["person"] is None
    # One call for the validation-error event
    assert len(calls) == 1
    assert calls[0]["args"][3]["toolStatus"] == "ERROR"


async def test_manager_execute_tool_happy_path():
    from domains.read_message_history.handler import ReadMessageHistoryManager

    activity_result = {
        "person": {"id": "p-1", "firstName": "Alice", "lastName": "Smith"},
        "messages": [],
    }

    calls = []

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        calls.append({"activity": activity_fn.__name__, "args": args})
        if activity_fn.__name__ == "read_message_history_activity":
            return activity_result
        return None

    manager = ReadMessageHistoryManager()
    result = await manager.execute_tool(
        execute_activity=mock_execute_activity,
        tool_call={"phone": "+15551234567"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert result is activity_result
    # in_progress + activity + result event = 3 calls
    activities = [c["activity"] for c in calls]
    assert "read_message_history_activity" in activities
    assert "post_agent_message" in activities


async def test_manager_execute_tool_activity_fails():
    from domains.read_message_history.handler import ReadMessageHistoryManager

    calls = []

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        calls.append({"activity": activity_fn.__name__})
        if activity_fn.__name__ == "read_message_history_activity":
            raise RuntimeError("backend boom")
        return None

    manager = ReadMessageHistoryManager()
    result = await manager.execute_tool(
        execute_activity=mock_execute_activity,
        tool_call={"email": "alice@example.com"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert "error" in result
    assert result["messages"] == []
    assert result["person"] is None
    # in_progress + activity + error event
    assert any(c["activity"] == "read_message_history_activity" for c in calls)


async def run_all_tests():
    print("read-message-history blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_read_message_history_happy_path)
    await r.record_async("boundary", test_read_message_history_boundary)
    await r.record_async("phone_only", test_read_message_history_phone_only)
    await r.record_async("build_person_identifier_full_name", test_build_person_identifier_full_name)
    await r.record_async("build_person_identifier_email_fallback", test_build_person_identifier_email_fallback)
    await r.record_async("build_person_identifier_phone_fallback", test_build_person_identifier_phone_fallback)
    await r.record_async("build_person_identifier_unknown", test_build_person_identifier_unknown)
    await r.record_async("build_person_identifier_partial_name", test_build_person_identifier_partial_name_falls_through)
    await r.record_async("validate_identifiers_truthy", test_validate_identifiers_truthy)
    await r.record_async("validate_identifiers_falsy", test_validate_identifiers_falsy)
    await r.record_async("build_read_metadata_with_person", test_build_read_metadata_with_person)
    await r.record_async("build_read_metadata_no_person", test_build_read_metadata_no_person)
    await r.record_async("format_messages_for_display_empty", test_format_messages_for_display_empty)
    await r.record_async("format_messages_for_display_multi", test_format_messages_for_display_multi)
    await r.record_async("post_validation_error", test_post_validation_error_calls_execute_activity)
    await r.record_async("post_in_progress_event", test_post_in_progress_event)
    await r.record_async("post_result_event_no_person", test_post_result_event_no_person)
    await r.record_async("post_result_event_zero_messages", test_post_result_event_zero_messages)
    await r.record_async("post_result_event_with_messages", test_post_result_event_with_messages)
    await r.record_async("post_error_event", test_post_error_event)
    await r.record_async("manager_execute_tool_missing_identifier", test_manager_execute_tool_missing_identifier)
    await r.record_async("manager_execute_tool_happy_path", test_manager_execute_tool_happy_path)
    await r.record_async("manager_execute_tool_activity_fails", test_manager_execute_tool_activity_fails)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
