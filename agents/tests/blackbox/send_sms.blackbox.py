"""Blackbox tests for send-sms domain."""

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
        "/api/send-sms": {
            "status": 200,
            "json": {"success": True, "messageId": "sms-123"},
        },
    })


async def test_send_sms_happy_path():
    """send_sms_activity sends SMS via backend and returns result."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.send_sms import send_sms_activity

        result = await send_sms_activity(
            phone_number="+15551234567",
            message="Hello from Navi!",
        )

    assert result.get("success") is True or result.get("messageId") == "sms-123"


async def test_send_sms_boundary():
    """Verify exact HTTP request sent to backend SMS endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.send_sms import send_sms_activity

        await send_sms_activity(
            phone_number="+15559876543",
            message="Test message content",
        )

    call = assert_captured_call(
        url_contains="/api/send-sms",
        method="POST",
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    assert body["phone_number"] == "+15559876543"
    assert body["message"] == "Test message content"


# -------------------- service.py tests --------------------


def test_format_phone_number_e164():
    from domains.send_sms.service import format_phone_number
    assert format_phone_number("+15551234567") == "+1 (555) 123-4567"


def test_format_phone_number_ten_digits():
    from domains.send_sms.service import format_phone_number
    assert format_phone_number("5551234567") == "+1 (555) 123-4567"


def test_format_phone_number_with_formatting():
    from domains.send_sms.service import format_phone_number
    assert format_phone_number("(555) 123-4567") == "+1 (555) 123-4567"


def test_format_phone_number_unparseable():
    from domains.send_sms.service import format_phone_number
    assert format_phone_number("not-a-number") == "not-a-number"


def test_truncate_message_short():
    from domains.send_sms.service import truncate_message
    assert truncate_message("hi") == "hi"


def test_truncate_message_long():
    from domains.send_sms.service import truncate_message
    from domains.send_sms.config import MESSAGE_DISPLAY_MAX_LENGTH, MESSAGE_DISPLAY_SUFFIX
    long_msg = "x" * (MESSAGE_DISPLAY_MAX_LENGTH + 100)
    out = truncate_message(long_msg)
    assert out.endswith(MESSAGE_DISPLAY_SUFFIX)
    assert len(out) == MESSAGE_DISPLAY_MAX_LENGTH


def test_compute_service_usage():
    from domains.send_sms.service import compute_service_usage
    from domains.send_sms.config import SMS_COST_CENTS, SMS_PROVIDER
    usage = compute_service_usage()
    assert usage == [{"cost_cents": SMS_COST_CENTS, "provider": SMS_PROVIDER}]


async def test_manager_happy_path():
    from domains.send_sms.handler import SendSmsManager

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "send_sms_activity":
            return {"success": True, "messageId": "sms-1"}
        return None

    manager = SendSmsManager()
    out = await manager.execute_tool(
        execute_activity=mock_execute_activity,
        tool_call={"phone_number": "+15551234567", "message": "hi"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out["result"]["success"] is True
    assert len(out["usage"]["service"]) == 1


async def test_manager_error_path():
    from domains.send_sms.handler import SendSmsManager

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "send_sms_activity":
            raise RuntimeError("provider down")
        return None

    manager = SendSmsManager()
    out = await manager.execute_tool(
        execute_activity=mock_execute_activity,
        tool_call={"phone_number": "+15551234567", "message": "hi"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert "error" in out["result"]
    assert out["result"]["phone_number"] == "+15551234567"
    assert out["usage"]["service"] == []


async def test_send_sms_entry_point():
    from domains.send_sms.handler import send_sms

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "send_sms_activity":
            return {"success": True}
        return None

    out = await send_sms(
        execute_activity=mock_execute_activity,
        tool_call={"phone_number": "+15551234567", "message": "Hi"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id=None,
    )
    assert out["result"]["success"] is True


async def run_all_tests():
    print("send-sms blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_send_sms_happy_path)
    await r.record_async("boundary", test_send_sms_boundary)
    r.record("format_phone_number_e164", test_format_phone_number_e164)
    r.record("format_phone_number_ten_digits", test_format_phone_number_ten_digits)
    r.record("format_phone_number_with_formatting", test_format_phone_number_with_formatting)
    r.record("format_phone_number_unparseable", test_format_phone_number_unparseable)
    r.record("truncate_message_short", test_truncate_message_short)
    r.record("truncate_message_long", test_truncate_message_long)
    r.record("compute_service_usage", test_compute_service_usage)
    await r.record_async("manager_happy_path", test_manager_happy_path)
    await r.record_async("manager_error_path", test_manager_error_path)
    await r.record_async("send_sms_entry_point", test_send_sms_entry_point)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
