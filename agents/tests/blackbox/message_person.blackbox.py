"""Blackbox tests for message-person domain."""

import asyncio
import json
from unittest.mock import AsyncMock, patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock({
        "/api/people/messages/recent": {
            "status": 200,
            "json": {
                "messages": [
                    {"text": "Hey, how's the project going?", "person": "Alice", "timestamp": "2026-04-01T10:00:00Z"},
                    {"text": "Let's sync tomorrow", "person": "Bob", "timestamp": "2026-04-01T09:00:00Z"},
                ],
                "count": 2,
            },
        },
    })


async def test_fetch_recent_messages_happy_path():
    """fetch_recent_messages_activity returns messages from backend."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.message_person import fetch_recent_messages_activity

        result = await fetch_recent_messages_activity(
            user_id="user-42",
            limit=50,
            days=30,
        )

    assert result["count"] == 2
    assert len(result["messages"]) == 2
    assert result["messages"][0]["person"] == "Alice"


async def test_fetch_recent_messages_boundary():
    """Verify exact HTTP request sent to backend messages endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.message_person import fetch_recent_messages_activity

        await fetch_recent_messages_activity(
            user_id="user-99",
            limit=100,
            days=7,
        )

    call = assert_captured_call(
        url_contains="/api/people/messages/recent",
        method="GET",
        header_present="X-API-Key",
    )
    headers_lower = {k.lower(): v for k, v in call["requestHeaders"].items()}
    assert "x-user-id" in headers_lower
    # Query params are in the URL
    assert "limit=100" in call["url"]
    assert "days=7" in call["url"]


async def test_no_httpx_from_generate_message():
    """generate_message_activity uses call_llm, not raw httpx — zero captured calls."""
    _setup()
    with (
        patch("temporalio.activity.heartbeat"),
        patch("helpers.llm.call_llm") as mock_llm,
    ):
        mock_llm.return_value = {
            "content": "Hey! Great to connect.",
            "usage": {"input_tokens": 100, "output_tokens": 20},
        }
        from tools.message_person import generate_message_activity

        result = await generate_message_activity(
            model="rose-1-lite",
            system_name="Navi",
            conversation_context="User asked to message Alice",
            person_name="Alice",
            messages_context="Recent thread with Alice",
            exa_context="",
            intent="Follow up on project",
            channel="sms",
        )

    assert "message" in result
    # call_llm doesn't use httpx, so no captured calls from it
    captures = get_captured_requests()
    assert len(captures) == 0


# ── classify_person_id ──────────────────────────────────────────────


def test_classify_person_id_phone_full():
    """E.164 phone passes through."""
    from domains.message_person.service import classify_person_id

    out = classify_person_id("+19725551234")
    assert out == {"phone": "+19725551234"}


def test_classify_person_id_phone_10_digit():
    """10-digit US phone gets '1' prefix."""
    from domains.message_person.service import classify_person_id

    out = classify_person_id("9725551234")
    assert out == {"phone": "+19725551234"}


def test_classify_person_id_phone_with_formatting():
    """Phone with dashes and parens normalized."""
    from domains.message_person.service import classify_person_id

    out = classify_person_id("(972) 555-1234")
    assert out == {"phone": "+19725551234"}


def test_classify_person_id_email():
    """Email strings return {email: ...} lowercased."""
    from domains.message_person.service import classify_person_id

    out = classify_person_id("Alice@Example.com")
    assert out == {"email": "alice@example.com"}


def test_classify_person_id_name_two_parts():
    """Two-word string treated as first+last."""
    from domains.message_person.service import classify_person_id

    out = classify_person_id("Alice Smith")
    assert out == {"first_name": "Alice", "last_name": "Smith"}


def test_classify_person_id_name_multi_word_last():
    """Three-word string joins last name from tail."""
    from domains.message_person.service import classify_person_id

    out = classify_person_id("Alice Mary Smith")
    assert out == {"first_name": "Alice", "last_name": "Mary Smith"}


def test_classify_person_id_single_word_fallback():
    """Single word treated as first name with empty last."""
    from domains.message_person.service import classify_person_id

    out = classify_person_id("Madonna")
    assert out == {"first_name": "Madonna", "last_name": ""}


# ── format_messages_for_context ────────────────────────────────────


def test_format_messages_for_context_empty():
    """Empty list returns 'No previous messages.'"""
    from domains.message_person.service import format_messages_for_context

    assert format_messages_for_context([]) == "No previous messages."


def test_format_messages_for_context_happy():
    """Messages render with channel/timestamp/arrow/content."""
    from domains.message_person.service import format_messages_for_context

    out = format_messages_for_context([
        {"channel": "imessage", "from": "+15551111111", "to": "+15552222222", "timestamp": "T1", "message": "hi"},
        {"channel": "email", "from": "a@x.com", "to": "b@x.com", "timestamp": "T2", "message": "yo"},
    ])
    assert "[imessage]" in out
    assert "[email]" in out
    assert "hi" in out and "yo" in out
    assert "→" in out


def test_format_messages_for_context_limit():
    """Limit truncates message list length."""
    from domains.message_person.service import format_messages_for_context

    msgs = [{"message": f"m{i}", "channel": "x", "from": "", "to": "", "timestamp": ""} for i in range(5)]
    out = format_messages_for_context(msgs, limit=2)
    assert "m0" in out and "m1" in out
    assert "m2" not in out


# ── format_person_display ──────────────────────────────────────────


def test_format_person_display_with_name():
    from domains.message_person.service import format_person_display

    assert format_person_display({"firstName": "Alice", "lastName": "Smith"}) == "Alice Smith"


def test_format_person_display_email_fallback():
    from domains.message_person.service import format_person_display

    assert format_person_display({"email": "alice@example.com"}) == "alice@example.com"


def test_format_person_display_phone_fallback():
    from domains.message_person.service import format_person_display

    assert format_person_display({"phoneNumber": "+15551234"}) == "+15551234"


def test_format_person_display_unknown():
    from domains.message_person.service import format_person_display

    assert format_person_display({}) == "Unknown"


# ── build_conversation_summary ─────────────────────────────────────


def test_build_conversation_summary_empty():
    from domains.message_person.service import build_conversation_summary

    assert build_conversation_summary([]) == "No conversation history."


def test_build_conversation_summary_with_messages():
    from domains.message_person.service import build_conversation_summary

    out = build_conversation_summary([
        {"role": "USER", "text": "hello"},
        {"role": "ASSISTANT", "text": "world"},
        {"role": "TOOL", "text": ""},  # skipped
    ])
    assert "[USER]: hello" in out
    assert "[ASSISTANT]: world" in out


def test_build_conversation_summary_truncates_long():
    from domains.message_person.service import build_conversation_summary

    out = build_conversation_summary([{"role": "USER", "text": "a" * 3000}])
    assert "(truncated)" in out


def test_build_conversation_summary_only_empty_text():
    """Context where every message has empty text returns default."""
    from domains.message_person.service import build_conversation_summary

    assert build_conversation_summary([{"role": "USER", "text": ""}]) == "No conversation history."


# ── extract_user_name ──────────────────────────────────────────────


def test_extract_user_name_from_context():
    from domains.message_person.service import extract_user_name

    ctx = "Something else\nName: Andy Prevalsky\nMore stuff"
    assert extract_user_name("Navi", ctx) == "Andy Prevalsky"


def test_extract_user_name_fallback():
    from domains.message_person.service import extract_user_name

    assert extract_user_name("Navi", "no name line here") == "Navi"


def test_extract_user_name_empty_name_falls_back():
    """Name: with empty value falls back to system name."""
    from domains.message_person.service import extract_user_name

    assert extract_user_name("Navi", "Name: ") == "Navi"


# ── build_cold_outreach_person ─────────────────────────────────────


def test_build_cold_outreach_person_email():
    from domains.message_person.service import build_cold_outreach_person

    out = build_cold_outreach_person("x@y.com", None)
    assert out["email"] == "x@y.com"
    assert out["phoneNumber"] is None


def test_build_cold_outreach_person_phone():
    from domains.message_person.service import build_cold_outreach_person

    out = build_cold_outreach_person(None, "+15551234567")
    assert out["phoneNumber"] == "+15551234567"


# ── handler validation helpers ────────────────────────────────────


def test_handler_validate_inputs_missing_person():
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    ev = MessagePersonManager._validate_inputs("", "imessage", "", "ping")
    assert ev is not None and ev.status == MessageStatus.ERROR
    assert "person_id" in ev.message


def test_handler_validate_inputs_bad_channel():
    from domains.message_person.handler import MessagePersonManager

    ev = MessagePersonManager._validate_inputs("Alice Smith", "sms", "", "ping")
    assert ev is not None
    assert "Channel" in ev.title or "channel" in ev.message.lower()


def test_handler_validate_inputs_email_needs_from():
    from domains.message_person.handler import MessagePersonManager

    ev = MessagePersonManager._validate_inputs("a@b.com", "email", "", "ping")
    assert ev is not None
    assert "from_email" in ev.message


def test_handler_validate_inputs_missing_intent():
    from domains.message_person.handler import MessagePersonManager

    ev = MessagePersonManager._validate_inputs("Alice Smith", "imessage", "", "")
    assert ev is not None
    assert "intent" in ev.message


def test_handler_validate_inputs_happy():
    from domains.message_person.handler import MessagePersonManager

    ev = MessagePersonManager._validate_inputs("Alice Smith", "imessage", "", "ping")
    assert ev is None


def test_handler_validate_channel_no_phone():
    from domains.message_person.handler import MessagePersonManager

    ev = MessagePersonManager._validate_channel("imessage", None, "a@b.com", "Alice")
    assert ev is not None
    assert "phone" in ev.message.lower()


def test_handler_validate_channel_no_email():
    from domains.message_person.handler import MessagePersonManager

    ev = MessagePersonManager._validate_channel("email", "+15551234", None, "Alice")
    assert ev is not None
    assert "email" in ev.message.lower()


def test_handler_validate_channel_happy():
    from domains.message_person.handler import MessagePersonManager

    assert MessagePersonManager._validate_channel("imessage", "+15551234", None, "Alice") is None
    assert MessagePersonManager._validate_channel("email", None, "a@b.com", "Alice") is None


# ── ambiguous error and finished event ────────────────────────────


def test_build_ambiguous_error():
    from domains.message_person.handler import MessagePersonManager

    history = {
        "matches": [
            {"firstName": "Alice", "lastName": "Smith", "email": "a@x.com", "messageCount": 10},
            {"firstName": "Alice", "lastName": "Jones", "phoneNumber": "+15551111", "messageCount": 3},
        ],
    }
    ev = MessagePersonManager._build_ambiguous_error(history, {"first_name": "Alice"}, "Alice")
    assert "Multiple people" in ev.message
    assert "Alice Smith" in ev.message
    assert "Alice Jones" in ev.message


def test_build_finished_event_imessage():
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    ev = MessagePersonManager._build_finished_event(
        channel="imessage",
        channel_label="iMessage",
        person_display="Alice",
        recipient="+15551234",
        from_email="",
        generated_subject=None,
        generated_message="Hey Alice, long text " * 20,
        gen_usage={"prompt_tokens": 100, "completion_tokens": 20, "actual_model": "rose-ultra"},
        model="rose-labs/rose-1-lite",
    )
    assert ev.status == MessageStatus.FINISHED
    assert "Alice" in ev.title
    # Message preview should be truncated
    assert "..." in ev.message
    # LLM usage attached
    assert ev.data and ev.data["usage"]["llm"][0]["tokens_in"] == 100


def test_build_finished_event_email_with_subject():
    from domains.message_person.handler import MessagePersonManager

    ev = MessagePersonManager._build_finished_event(
        channel="email",
        channel_label="Email",
        person_display="Alice",
        recipient="a@b.com",
        from_email="sender@mine.com",
        generated_subject="Hello",
        generated_message="Short body",
        gen_usage={},
        model="rose-labs/rose-1-lite",
    )
    assert "sender@mine.com" in ev.message
    assert "Hello" in ev.message
    # No usage → no data
    assert ev.data is None


# ── MessagePersonManager end-to-end via patched workflow module ─────


class _FakeWFModule:
    def __init__(self, activity_results=None):
        self._results = activity_results or {}
        self.logger = type("L", (), {"info": lambda *a, **kw: None, "error": lambda *a, **kw: None})()

    async def execute_activity(self, fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "?")
        if name in self._results:
            value = self._results[name]
            if isinstance(value, Exception):
                raise value
            if callable(value):
                return value()
            return value
        raise KeyError(f"No fake result for {name}")


def _patch_handler_workflow(fake):
    import domains.message_person.handler as h

    original = h.workflow
    h.workflow = fake

    def restore():
        h.workflow = original

    return restore


class _WFInstance:
    def __init__(self, *, context=None):
        self.user_id = "user-1"
        self.agent_id = "agent-1"
        self.model = "rose-labs/rose-1-lite"
        self.context = context or []
        self.system_name = "Navi"
        self.user_context_section = "Name: Alice Tester"
        self.context_gates = None
        self.handled = []

    async def _handle_tool_event(self, event, tool_call_id, tool_name):
        self.handled.append((event, tool_call_id, tool_name))


async def _collect(gen):
    events = []
    async for e in gen:
        events.append(e)
    return events


async def test_handler_missing_person_id_yields_error():
    """Validation: missing person_id yields ERROR."""
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    events = await _collect(
        MessagePersonManager().execute_tool(
            workflow_instance=_WFInstance(),
            tool_call={"channel": "imessage", "intent": "hi"},
            tool_call_id="tc-1",
        )
    )
    assert events[0].status == MessageStatus.ERROR


async def test_handler_read_history_failure_yields_error():
    """If read_message_history_activity raises, yields error event after IN_PROGRESS."""
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(
        activity_results={"read_message_history_activity": RuntimeError("boom")}
    )
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            MessagePersonManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={
                    "person_id": "Alice Smith",
                    "channel": "imessage",
                    "intent": "hello",
                },
                tool_call_id="tc-hist",
            )
        )
    finally:
        restore()

    # First event IN_PROGRESS lookup, next event is ERROR
    errs = [e for e in events if e.status == MessageStatus.ERROR]
    assert len(errs) == 1
    assert "Failed to look up" in errs[0].title


async def test_handler_multiple_matches_yields_ambiguous():
    """multiple_matches in history response results in ambiguous error."""
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(
        activity_results={
            "read_message_history_activity": {
                "multiple_matches": True,
                "matches": [
                    {"firstName": "Alice", "lastName": "Smith", "email": "a@x.com", "messageCount": 2},
                    {"firstName": "Alice", "lastName": "Jones", "phoneNumber": "+15551234", "messageCount": 1},
                ],
            }
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            MessagePersonManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={"person_id": "Alice", "channel": "imessage", "intent": "hi"},
                tool_call_id="tc-amb",
            )
        )
    finally:
        restore()

    errs = [e for e in events if e.status == MessageStatus.ERROR]
    assert len(errs) == 1
    assert "Ambiguous" in errs[0].title


async def test_handler_no_person_found_no_id_yields_error():
    """When no person found and person_id isn't email/phone -> ERROR."""
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(
        activity_results={
            "read_message_history_activity": {"person": None, "messages": []},
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            MessagePersonManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={"person_id": "Somebody Unknown", "channel": "imessage", "intent": "hi"},
                tool_call_id="tc-nf",
            )
        )
    finally:
        restore()

    errs = [e for e in events if e.status == MessageStatus.ERROR]
    assert any("No person found" in (e.title or "") for e in errs)


async def test_handler_channel_mismatch_no_phone():
    """Person found but no phone + channel=imessage -> channel error."""
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(
        activity_results={
            "read_message_history_activity": {
                "person": {"firstName": "Alice", "lastName": "Smith", "email": "a@x.com"},
                "messages": [],
            },
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            MessagePersonManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={"person_id": "Alice Smith", "channel": "imessage", "intent": "hi"},
                tool_call_id="tc-cm",
            )
        )
    finally:
        restore()

    errs = [e for e in events if e.status == MessageStatus.ERROR]
    assert any("Cannot send iMessage" in (e.title or "") for e in errs)


async def test_handler_empty_generated_message_yields_error():
    """Generate returns empty message -> ERROR event."""
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(
        activity_results={
            "read_message_history_activity": {
                "person": {"firstName": "Alice", "lastName": "Smith", "phoneNumber": "+15551234567"},
                "messages": [],
            },
            "fetch_recent_messages_activity": {"messages": []},
            "people_search_activity": {"answer": "some context"},
            "generate_message_activity": {"message": "", "usage": {}},
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            MessagePersonManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={"person_id": "Alice Smith", "channel": "imessage", "intent": "check-in"},
                tool_call_id="tc-empty",
            )
        )
    finally:
        restore()

    errs = [e for e in events if e.status == MessageStatus.ERROR]
    assert any("Empty message" in (e.title or "") for e in errs)


async def test_handler_generate_message_raises_yields_error():
    """generate_message_activity raising -> propagates as error."""
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(
        activity_results={
            "read_message_history_activity": {
                "person": {"firstName": "Alice", "lastName": "Smith", "phoneNumber": "+15551234567"},
                "messages": [],
            },
            "fetch_recent_messages_activity": {"messages": []},
            "people_search_activity": {"answer": ""},
            "generate_message_activity": RuntimeError("llm timeout"),
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            MessagePersonManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={"person_id": "Alice Smith", "channel": "imessage", "intent": "hi"},
                tool_call_id="tc-gerr",
            )
        )
    finally:
        restore()

    errs = [e for e in events if e.status == MessageStatus.ERROR]
    assert any("Message generation failed" in (e.title or "") for e in errs)


async def test_handler_cold_outreach_email_path():
    """No person found but email id is provided -> cold outreach flow."""
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    # Need _request_approval to not block. Patch the approval helper.
    approved = {"called": False}

    async def fake_approval(*args, **kwargs):
        approved["called"] = True
        return {"response": "ok", "question": "", "attention_request_id": None}

    fake = _FakeWFModule(
        activity_results={
            "read_message_history_activity": {"person": None, "messages": []},
            "fetch_recent_messages_activity": {"messages": []},
            "generate_message_activity": {
                "message": "Hi Alice!",
                "subject": "Hello",
                "usage": {"prompt_tokens": 5, "completion_tokens": 3, "actual_model": "rose-1-lite"},
            },
            "send_email_activity": None,
        }
    )
    restore = _patch_handler_workflow(fake)

    with patch("domains.message_person.handler.request_user_approval_direct", fake_approval):
        try:
            events = await _collect(
                MessagePersonManager().execute_tool(
                    workflow_instance=_WFInstance(),
                    tool_call={
                        "person_id": "alice@example.com",
                        "channel": "email",
                        "from_email": "me@roselabs.ai",
                        "intent": "say hi",
                    },
                    tool_call_id="tc-cold",
                )
            )
        finally:
            restore()

    assert approved["called"]
    finished = [e for e in events if e.status == MessageStatus.FINISHED]
    assert len(finished) == 1
    assert "Email sent" in finished[0].title


async def test_handler_user_rejects_approval():
    """UserRejectedError from approval -> ERROR event with rejection feedback."""
    from domains.message_person.handler import MessagePersonManager
    from domains.request_user_approval.types import UserRejectedError
    from tools.base import MessageStatus

    async def fake_approval(*args, **kwargs):
        raise UserRejectedError("User said no", rejection_message="too soon")

    fake = _FakeWFModule(
        activity_results={
            "read_message_history_activity": {
                "person": {"firstName": "Alice", "lastName": "Smith", "phoneNumber": "+15551234567"},
                "messages": [],
            },
            "fetch_recent_messages_activity": {"messages": []},
            "people_search_activity": {"answer": ""},
            "generate_message_activity": {"message": "Hey!", "usage": {}},
        }
    )
    restore = _patch_handler_workflow(fake)
    with patch("domains.message_person.handler.request_user_approval_direct", fake_approval):
        try:
            events = await _collect(
                MessagePersonManager().execute_tool(
                    workflow_instance=_WFInstance(),
                    tool_call={"person_id": "Alice Smith", "channel": "imessage", "intent": "hi"},
                    tool_call_id="tc-rej",
                )
            )
        finally:
            restore()

    errs = [e for e in events if e.status == MessageStatus.ERROR]
    assert any("cancelled" in (e.title or "").lower() for e in errs)
    assert any("too soon" in (e.message or "") for e in errs)


async def test_handler_imessage_send_failure():
    """imessage send returns success=False -> ERROR event."""
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    async def fake_approval(*args, **kwargs):
        return {"response": "ok", "question": "", "attention_request_id": None}

    fake = _FakeWFModule(
        activity_results={
            "read_message_history_activity": {
                "person": {"firstName": "Alice", "lastName": "Smith", "phoneNumber": "+15551234567"},
                "messages": [],
            },
            "fetch_recent_messages_activity": {"messages": []},
            "people_search_activity": {"answer": ""},
            "generate_message_activity": {"message": "Hey!", "usage": {}},
            "queue_imessage_activity": {"success": False, "error": "Mac not connected"},
        }
    )
    restore = _patch_handler_workflow(fake)
    with patch("domains.message_person.handler.request_user_approval_direct", fake_approval):
        try:
            events = await _collect(
                MessagePersonManager().execute_tool(
                    workflow_instance=_WFInstance(),
                    tool_call={"person_id": "Alice Smith", "channel": "imessage", "intent": "hi"},
                    tool_call_id="tc-sf",
                )
            )
        finally:
            restore()

    errs = [e for e in events if e.status == MessageStatus.ERROR]
    assert any("Failed to send iMessage" in (e.title or "") for e in errs)


async def test_handler_send_activity_exception_email():
    """Exception in send_email_activity produces error event with normalized message."""
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    async def fake_approval(*args, **kwargs):
        return {"response": "ok", "question": "", "attention_request_id": None}

    fake = _FakeWFModule(
        activity_results={
            "read_message_history_activity": {
                "person": {"firstName": "Alice", "lastName": "Smith", "email": "a@x.com"},
                "messages": [],
            },
            "fetch_recent_messages_activity": {"messages": []},
            "people_search_activity": {"answer": ""},
            "generate_message_activity": {
                "message": "Hey",
                "subject": "Sub",
                "usage": {},
            },
            "send_email_activity": RuntimeError("Gmail not connected"),
        }
    )
    restore = _patch_handler_workflow(fake)
    with patch("domains.message_person.handler.request_user_approval_direct", fake_approval):
        try:
            events = await _collect(
                MessagePersonManager().execute_tool(
                    workflow_instance=_WFInstance(),
                    tool_call={
                        "person_id": "Alice Smith",
                        "channel": "email",
                        "from_email": "me@roselabs.ai",
                        "intent": "hello",
                    },
                    tool_call_id="tc-email-err",
                )
            )
        finally:
            restore()

    errs = [e for e in events if e.status == MessageStatus.ERROR]
    assert any("Failed to send Email" in (e.title or "") for e in errs)


async def test_handler_successful_imessage_send_finished_event():
    """End-to-end success for iMessage yields FINISHED event with usage."""
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    async def fake_approval(*args, **kwargs):
        return {"response": "ok", "question": "", "attention_request_id": None}

    fake = _FakeWFModule(
        activity_results={
            "read_message_history_activity": {
                "person": {"firstName": "Alice", "lastName": "Smith", "phoneNumber": "+15551234567"},
                "messages": [],
            },
            "fetch_recent_messages_activity": {"messages": []},
            "people_search_activity": {"answer": ""},
            "generate_message_activity": {
                "message": "Hello Alice!",
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "actual_model": "rose-1-lite"},
            },
            "queue_imessage_activity": {"success": True},
        }
    )
    restore = _patch_handler_workflow(fake)
    with patch("domains.message_person.handler.request_user_approval_direct", fake_approval):
        try:
            events = await _collect(
                MessagePersonManager().execute_tool(
                    workflow_instance=_WFInstance(),
                    tool_call={"person_id": "Alice Smith", "channel": "imessage", "intent": "ping"},
                    tool_call_id="tc-ok",
                )
            )
        finally:
            restore()

    finished = [e for e in events if e.status == MessageStatus.FINISHED]
    assert len(finished) == 1
    assert finished[0].data is not None
    assert finished[0].data["usage"]["llm"][0]["tokens_in"] == 10


async def run_all_tests():
    print("message-person blackbox tests:")
    r = BlackboxResult()
    await r.record_async("fetch_recent_messages_happy_path", test_fetch_recent_messages_happy_path)
    await r.record_async("fetch_recent_messages_boundary", test_fetch_recent_messages_boundary)
    await r.record_async("no_httpx_from_generate_message", test_no_httpx_from_generate_message)
    # classify_person_id
    r.record("classify_phone_full", test_classify_person_id_phone_full)
    r.record("classify_phone_10digit", test_classify_person_id_phone_10_digit)
    r.record("classify_phone_formatted", test_classify_person_id_phone_with_formatting)
    r.record("classify_email", test_classify_person_id_email)
    r.record("classify_name_two", test_classify_person_id_name_two_parts)
    r.record("classify_name_multi", test_classify_person_id_name_multi_word_last)
    r.record("classify_single_word", test_classify_person_id_single_word_fallback)
    # format_messages
    r.record("format_messages_empty", test_format_messages_for_context_empty)
    r.record("format_messages_happy", test_format_messages_for_context_happy)
    r.record("format_messages_limit", test_format_messages_for_context_limit)
    # format_person_display
    r.record("format_person_name", test_format_person_display_with_name)
    r.record("format_person_email", test_format_person_display_email_fallback)
    r.record("format_person_phone", test_format_person_display_phone_fallback)
    r.record("format_person_unknown", test_format_person_display_unknown)
    # build_conversation_summary
    r.record("conv_summary_empty", test_build_conversation_summary_empty)
    r.record("conv_summary_msgs", test_build_conversation_summary_with_messages)
    r.record("conv_summary_truncates", test_build_conversation_summary_truncates_long)
    r.record("conv_summary_only_empty", test_build_conversation_summary_only_empty_text)
    # extract_user_name
    r.record("user_name_from_ctx", test_extract_user_name_from_context)
    r.record("user_name_fallback", test_extract_user_name_fallback)
    r.record("user_name_empty_value", test_extract_user_name_empty_name_falls_back)
    # cold_outreach
    r.record("cold_outreach_email", test_build_cold_outreach_person_email)
    r.record("cold_outreach_phone", test_build_cold_outreach_person_phone)
    # handler validation
    r.record("handler_validate_missing_person", test_handler_validate_inputs_missing_person)
    r.record("handler_validate_bad_channel", test_handler_validate_inputs_bad_channel)
    r.record("handler_validate_email_needs_from", test_handler_validate_inputs_email_needs_from)
    r.record("handler_validate_missing_intent", test_handler_validate_inputs_missing_intent)
    r.record("handler_validate_happy", test_handler_validate_inputs_happy)
    r.record("handler_channel_no_phone", test_handler_validate_channel_no_phone)
    r.record("handler_channel_no_email", test_handler_validate_channel_no_email)
    r.record("handler_channel_happy", test_handler_validate_channel_happy)
    # ambiguous/finished events
    r.record("ambiguous_error", test_build_ambiguous_error)
    r.record("finished_event_imessage", test_build_finished_event_imessage)
    r.record("finished_event_email", test_build_finished_event_email_with_subject)
    # handler end-to-end paths
    await r.record_async("handler_missing_person_id", test_handler_missing_person_id_yields_error)
    await r.record_async("handler_read_history_failure", test_handler_read_history_failure_yields_error)
    await r.record_async("handler_multiple_matches", test_handler_multiple_matches_yields_ambiguous)
    await r.record_async("handler_no_person_no_id", test_handler_no_person_found_no_id_yields_error)
    await r.record_async("handler_channel_mismatch", test_handler_channel_mismatch_no_phone)
    await r.record_async("handler_empty_message", test_handler_empty_generated_message_yields_error)
    await r.record_async("handler_gen_raises", test_handler_generate_message_raises_yields_error)
    await r.record_async("handler_cold_outreach_email", test_handler_cold_outreach_email_path)
    await r.record_async("handler_user_rejects", test_handler_user_rejects_approval)
    await r.record_async("handler_imessage_fail", test_handler_imessage_send_failure)
    await r.record_async("handler_email_exception", test_handler_send_activity_exception_email)
    await r.record_async("handler_imessage_success", test_handler_successful_imessage_send_finished_event)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
