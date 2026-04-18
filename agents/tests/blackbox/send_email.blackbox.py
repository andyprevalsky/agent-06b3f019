"""Blackbox tests for send-email domain."""

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
        "/api/integrations/email/send": {
            "status": 200,
            "json": {
                "messageId": "msg-email-123",
                "threadId": "thread-456",
            },
        },
    })


async def test_send_email_happy_path():
    """send_email_activity returns messageId and threadId."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.send_email import send_email_activity

        result = await send_email_activity(
            user_id="user-42",
            to="alice@example.com",
            subject="Project Update",
            body="Hi Alice, here's the latest update...",
        )

    assert result["messageId"] == "msg-email-123"
    assert result["threadId"] == "thread-456"


async def test_send_email_boundary():
    """Verify exact HTTP request sent to backend email endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.send_email import send_email_activity

        await send_email_activity(
            user_id="user-99",
            to="bob@example.com",
            subject="Meeting Tomorrow",
            body="Let's sync at 2pm.",
            cc="charlie@example.com",
            from_email="user@custom.com",
        )

    call = assert_captured_call(
        url_contains="/api/integrations/email/send",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["user_id"] == "user-99"
    assert body["to"] == "bob@example.com"
    assert body["subject"] == "Meeting Tomorrow"
    assert body["body"] == "Let's sync at 2pm."
    assert body["cc"] == "charlie@example.com"
    assert body["from_email"] == "user@custom.com"


async def test_send_email_minimal_params():
    """Activity works with only required params (no cc or from_email)."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.send_email import send_email_activity

        result = await send_email_activity(
            user_id="user-1",
            to="test@example.com",
            subject="Test",
            body="Test body",
        )

    assert result["messageId"] == "msg-email-123"
    call = assert_captured_call(url_contains="/api/integrations/email/send", method="POST")
    body = json.loads(call["requestBody"])
    assert body["to"] == "test@example.com"


# -------------------- service.py tests --------------------


def test_build_pre_message_without_cc():
    from domains.send_email.service import _build_pre_message
    out = _build_pre_message("a@b.com", "Hello", None)
    assert "**To:** a@b.com" in out
    assert "**Subject:** Hello" in out
    assert "Cc" not in out


def test_build_pre_message_with_cc():
    from domains.send_email.service import _build_pre_message
    out = _build_pre_message("a@b.com", "Hello", "c@d.com")
    assert "**Cc:** c@d.com" in out


def test_build_pre_message_truncates_long_subject():
    from domains.send_email.service import _build_pre_message
    from domains.send_email.config import DISPLAY_SUBJECT_MAX_LEN
    subject = "s" * (DISPLAY_SUBJECT_MAX_LEN + 50)
    out = _build_pre_message("a@b.com", subject, None)
    assert "..." in out


async def test_execute_send_email_happy():
    from domains.send_email.service import execute_send_email

    activity_result = {"messageId": "m-1", "threadId": "t-1"}

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "send_email_activity":
            return activity_result
        return None

    out = await execute_send_email(
        execute_activity=mock_execute_activity,
        tool_call={"to": "a@b", "subject": "S", "body": "B", "cc": "c@d"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out == activity_result


async def test_execute_send_email_error():
    from domains.send_email.service import execute_send_email

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "send_email_activity":
            raise RuntimeError("SMTP failed")
        return None

    out = await execute_send_email(
        execute_activity=mock_execute_activity,
        tool_call={"to": "a@b", "subject": "S", "body": "B"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert "error" in out
    assert "SMTP failed" in out["error"]
    assert out["to"] == "a@b"
    assert out["subject"] == "S"


async def test_send_email_entry_point():
    from domains.send_email.handler import send_email

    activity_result = {"messageId": "m-1"}

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "send_email_activity":
            return activity_result
        return None

    out = await send_email(
        execute_activity=mock_execute_activity,
        tool_call={"to": "a@b", "subject": "S", "body": "B"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out == activity_result


async def run_all_tests():
    print("send-email blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_send_email_happy_path)
    await r.record_async("boundary", test_send_email_boundary)
    await r.record_async("minimal_params", test_send_email_minimal_params)
    r.record("build_pre_message_without_cc", test_build_pre_message_without_cc)
    r.record("build_pre_message_with_cc", test_build_pre_message_with_cc)
    r.record("build_pre_message_truncates", test_build_pre_message_truncates_long_subject)
    await r.record_async("execute_send_email_happy", test_execute_send_email_happy)
    await r.record_async("execute_send_email_error", test_execute_send_email_error)
    await r.record_async("send_email_entry_point", test_send_email_entry_point)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
