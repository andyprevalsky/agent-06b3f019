"""Blackbox tests for send-sms-as-user domain."""

import asyncio
import json
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock({
        "/api/imessage/queue": {
            "status": 200,
            "json": {"success": True, "queued": True, "id": "imsg-456"},
        },
    })


async def test_queue_imessage_happy_path():
    """queue_imessage_activity queues an iMessage via backend."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.send_sms_as_user import queue_imessage_activity

        result = await queue_imessage_activity(
            user_id="user-42",
            agent_id="agent-1",
            phone_number="+15551234567",
            message="Hey Alice, following up on our chat.",
        )

    assert result.get("success") is True or result.get("queued") is True


async def test_queue_imessage_boundary():
    """Verify exact HTTP request sent to backend iMessage queue endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.send_sms_as_user import queue_imessage_activity

        await queue_imessage_activity(
            user_id="user-99",
            agent_id="agent-2",
            phone_number="+15559876543",
            message="Test iMessage content",
        )

    call = assert_captured_call(
        url_contains="/api/imessage/queue",
        method="POST",
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    assert body["user_id"] == "user-99"
    assert body["agent_id"] == "agent-2"
    assert body["phone_number"] == "+15559876543"
    assert body["message"] == "Test iMessage content"


# -------------------- service.py tests --------------------


def test_format_phone_number_e164():
    from domains.send_sms_as_user.service import format_phone_number
    assert format_phone_number("+19729777432") == "+1 (972) 977-7432"


def test_format_phone_number_ten_digits():
    from domains.send_sms_as_user.service import format_phone_number
    assert format_phone_number("9729777432") == "+1 (972) 977-7432"


def test_format_phone_number_unparseable():
    from domains.send_sms_as_user.service import format_phone_number
    assert format_phone_number("abc") == "abc"


def test_normalize_to_e164_ten_digits():
    from domains.send_sms_as_user.service import normalize_to_e164
    assert normalize_to_e164("9729777432") == "+19729777432"


def test_normalize_to_e164_eleven_digits():
    from domains.send_sms_as_user.service import normalize_to_e164
    assert normalize_to_e164("19729777432") == "+19729777432"


def test_normalize_to_e164_already_e164():
    from domains.send_sms_as_user.service import normalize_to_e164
    # Already has + and digits - normalize strips + then re-adds
    assert normalize_to_e164("+442079460123") == "+442079460123"


def test_build_approval_question_short():
    from domains.send_sms_as_user.service import build_approval_question
    q = build_approval_question("+19729777432", "Hello", "Rose")
    assert "Rose wants to send an **iMessage**" in q
    assert "+1 (972) 977-7432" in q
    assert "Hello" in q


def test_build_approval_question_long_message_truncated():
    from domains.send_sms_as_user.service import build_approval_question
    from domains.send_sms_as_user.config import MESSAGE_PREVIEW_MAX_LENGTH
    long_msg = "x" * (MESSAGE_PREVIEW_MAX_LENGTH + 100)
    q = build_approval_question("+19729777432", long_msg, "Rose")
    assert "..." in q


def test_build_queue_display_message_short():
    from domains.send_sms_as_user.service import build_queue_display_message
    phone, msg = build_queue_display_message("+19729777432", "hi")
    assert phone == "+1 (972) 977-7432"
    assert msg == "hi"


def test_build_queue_display_message_long():
    from domains.send_sms_as_user.service import build_queue_display_message
    from domains.send_sms_as_user.config import MESSAGE_DISPLAY_MAX_LENGTH
    long_msg = "y" * (MESSAGE_DISPLAY_MAX_LENGTH + 50)
    phone, msg = build_queue_display_message("+19729777432", long_msg)
    assert msg.endswith("...")
    assert len(msg) == MESSAGE_DISPLAY_MAX_LENGTH


# -------------------- handler.py tests --------------------


def test_manager_get_approval_question():
    from domains.send_sms_as_user.handler import SendSmsAsUserManager
    manager = SendSmsAsUserManager()
    q = manager.get_approval_question({
        "phone_number": "+19729777432",
        "message": "Hi",
        "system_name": "Navi",
    })
    assert "Navi wants to send" in q
    assert "Hi" in q


def test_manager_get_approval_question_defaults():
    from domains.send_sms_as_user.handler import SendSmsAsUserManager
    manager = SendSmsAsUserManager()
    q = manager.get_approval_question({})
    # Defaults: system_name="Rose", phone="unknown", message=""
    assert "Rose wants to send" in q


async def test_manager_execute_tool_success():
    from domains.send_sms_as_user.handler import SendSmsAsUserManager

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "queue_imessage_activity":
            return {"success": True, "queue_id": "q-1"}
        return None

    manager = SendSmsAsUserManager()
    out = await manager.execute_tool(
        execute_activity=mock_execute_activity,
        tool_call={"phone_number": "+19729777432", "message": "Hi"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out["result"]["success"] is True
    assert out["result"]["queue_id"] == "q-1"
    assert out["usage"]["service"] == []


async def test_manager_execute_tool_result_failure():
    from domains.send_sms_as_user.handler import SendSmsAsUserManager

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "queue_imessage_activity":
            return {"success": False, "error": "app offline"}
        return None

    manager = SendSmsAsUserManager()
    out = await manager.execute_tool(
        execute_activity=mock_execute_activity,
        tool_call={"phone_number": "+19729777432", "message": "Hi"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out["result"]["error"] == "app offline"
    assert out["result"]["phone_number"] == "+19729777432"


async def test_manager_execute_tool_activity_raises():
    from domains.send_sms_as_user.handler import SendSmsAsUserManager

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "queue_imessage_activity":
            raise RuntimeError("network error")
        return None

    manager = SendSmsAsUserManager()
    out = await manager.execute_tool(
        execute_activity=mock_execute_activity,
        tool_call={"phone_number": "+19729777432", "message": "Hi"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert "error" in out["result"]
    assert "network error" in out["result"]["error"]


async def test_send_sms_as_user_entry_point():
    from domains.send_sms_as_user.handler import send_sms_as_user

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "queue_imessage_activity":
            return {"success": True, "queue_id": "q-1"}
        return None

    out = await send_sms_as_user(
        execute_activity=mock_execute_activity,
        tool_call={"phone_number": "+19729777432", "message": "Hi"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out["result"]["success"] is True


async def run_all_tests():
    print("send-sms-as-user blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_queue_imessage_happy_path)
    await r.record_async("boundary", test_queue_imessage_boundary)
    r.record("format_phone_number_e164", test_format_phone_number_e164)
    r.record("format_phone_number_ten_digits", test_format_phone_number_ten_digits)
    r.record("format_phone_number_unparseable", test_format_phone_number_unparseable)
    r.record("normalize_to_e164_ten_digits", test_normalize_to_e164_ten_digits)
    r.record("normalize_to_e164_eleven_digits", test_normalize_to_e164_eleven_digits)
    r.record("normalize_to_e164_already_e164", test_normalize_to_e164_already_e164)
    r.record("build_approval_question_short", test_build_approval_question_short)
    r.record("build_approval_question_long", test_build_approval_question_long_message_truncated)
    r.record("build_queue_display_message_short", test_build_queue_display_message_short)
    r.record("build_queue_display_message_long", test_build_queue_display_message_long)
    r.record("manager_get_approval_question", test_manager_get_approval_question)
    r.record("manager_get_approval_question_defaults", test_manager_get_approval_question_defaults)
    await r.record_async("manager_execute_tool_success", test_manager_execute_tool_success)
    await r.record_async("manager_execute_tool_result_failure", test_manager_execute_tool_result_failure)
    await r.record_async("manager_execute_tool_activity_raises", test_manager_execute_tool_activity_raises)
    await r.record_async("send_sms_as_user_entry_point", test_send_sms_as_user_entry_point)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
