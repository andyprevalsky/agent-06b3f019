"""Blackbox tests for message-person domain."""

import asyncio
import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import httpx

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    setup_mock_fn,
    teardown_mock,
)


def _setup():
    setup_mock(
        {
            "/api/imessage/queue/queue-1/status": {
                "status": 200,
                "json": {
                    "success": True,
                    "status": "sent",
                    "sent_at": "2026-07-11T22:00:00.000Z",
                },
            },
            "/api/imessage/queue": {
                "status": 200,
                "json": {
                    "success": True,
                    "queue_id": "queue-1",
                    "relay_connected": True,
                    "relay_last_seen_at": "2026-07-11T21:59:59.000Z",
                },
            },
            "/api/people/messages/recent": {
                "status": 200,
                "json": {
                    "messages": [
                        {
                            "text": "Hey, how's the project going?",
                            "person": "Alice",
                            "timestamp": "2026-04-01T10:00:00Z",
                        },
                        {"text": "Let's sync tomorrow", "person": "Bob", "timestamp": "2026-04-01T09:00:00Z"},
                    ],
                    "count": 2,
                },
            },
        }
    )


async def test_queue_imessage_activity_waits_for_delivery_confirmation():
    """The agent-to-backend boundary returns only confirmed send."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from domains.message_person.repo import queue_imessage_activity

        result = await queue_imessage_activity(
            user_id="user-42",
            agent_id="agent-42",
            tool_call_id="call-42",
            phone_number="+19729777432",
            message="Hello from Rose",
        )

    assert result == {
        "success": True,
        "queue_id": "queue-1",
        "status": "sent",
        "sent_at": "2026-07-11T22:00:00.000Z",
    }
    call = assert_captured_call(
        url_contains="/api/imessage/queue",
        method="POST",
        header_present="X-API-Key",
    )
    payload = json.loads(call["requestBody"])
    assert payload == {
        "user_id": "user-42",
        "agent_id": "agent-42",
        "idempotency_key": "call-42",
        "phone_number": "+19729777432",
        "message": "Hello from Rose",
    }
    status_call = assert_captured_call(
        index=1,
        url_contains="/api/imessage/queue/queue-1/status",
        method="GET",
        header_present="X-User-Id",
    )
    status_headers = {k.lower(): v for k, v in status_call["requestHeaders"].items()}
    assert status_headers["x-user-id"] == "user-42"


async def test_simulated_imessage_send_carries_approved_write_to_wmh():
    """A send after approval must not look unapproved to the replacement environment."""
    from domains.message_person.repo import queue_imessage_activity

    observed_actions = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/world_models/rose-golden/sessions/session-approved/step"):
            observed_actions.append(json.loads(request.content.decode("utf-8"))["action"])
            return httpx.Response(
                200,
                json={
                    "observation": {
                        "content": '{"success":true,"queue_id":"queue-sim","status":"queued","relay_connected":false}',
                        "tool_result": {
                            "success": True,
                            "queue_id": "queue-sim",
                            "status": "queued",
                            "relay_connected": False,
                        },
                    }
                },
            )
        return httpx.Response(404, json={"error": "unexpected route"})

    setup_mock_fn(handler)
    with patch.dict(
        "os.environ",
        {
            "WMH_BASE_URL": "https://wmh.example.test",
            "WMH_MODEL_NAME": "rose-golden",
            "WMH_SESSION_ID": "session-approved",
        },
    ):
        result = await queue_imessage_activity(
            "user-42",
            "agent-42",
            "call-approved",
            "+19729777432",
            "Approved message",
            "simulate",
            "root-42",
            True,
        )
    assert result["success"] is True
    assert len(observed_actions) == 1
    assert observed_actions[0]["arguments"]["arguments"]["approval_granted"] is True
    teardown_mock()


async def test_post_approval_message_dispatch_passes_approval_to_wmh_activity():
    from domains.message_person.handler import MessagePersonManager

    receipt = {"success": True, "queue_id": "queue-sim", "status": "queued", "relay_connected": False}
    with patch(
        "domains.message_person.handler.workflow.execute_activity",
        new_callable=AsyncMock,
        return_value=receipt,
    ) as execute_activity:
        result = await MessagePersonManager._deliver_message(
            channel="imessage",
            user_id="user-42",
            agent_id="agent-42",
            tool_call_id="call-approved",
            context=[],
            person_phone="+19729777432",
            generated_message="Approved message",
            person_display="Andy",
            world_model_mode="simulate",
            world_model_session_scope_id="root-42",
        )
    assert result["status"] == "queued"
    assert execute_activity.call_args.kwargs["args"][-1] is True


async def test_queue_imessage_activity_waits_through_pending_status():
    """A pending queue state is polled until the Mac reports success."""
    status_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal status_calls
        if request.method == "POST" and request.url.path == "/api/imessage/queue":
            return httpx.Response(
                200,
                json={"success": True, "queue_id": "queue-delayed", "relay_connected": True},
            )
        if request.method == "GET" and request.url.path == "/api/imessage/queue/queue-delayed/status":
            status_calls += 1
            if status_calls == 1:
                return httpx.Response(200, json={"success": True, "status": "queued", "sent_at": None})
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "status": "sent",
                    "sent_at": "2026-07-11T22:01:00.000Z",
                },
            )
        return httpx.Response(404, json={"error": f"No mock for {request.url}"})

    setup_mock_fn(handler)
    with (
        patch("temporalio.activity.heartbeat"),
        patch("domains.message_person.repo.asyncio.sleep", new_callable=AsyncMock) as sleep,
    ):
        from domains.message_person.repo import queue_imessage_activity

        result = await queue_imessage_activity(
            user_id="user-42",
            agent_id="agent-42",
            tool_call_id="call-delayed",
            phone_number="+19729777432",
            message="Delayed confirmation",
        )

    assert result["status"] == "sent"
    assert result["sent_at"] == "2026-07-11T22:01:00.000Z"
    assert status_calls == 2
    sleep.assert_awaited_once_with(2)


async def test_queue_imessage_activity_checks_final_buffered_status():
    """A send ACK near the lease/expiry boundary is observed before timeout."""
    status_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal status_calls
        if request.method == "POST" and request.url.path == "/api/imessage/queue":
            return httpx.Response(
                200,
                json={"success": True, "queue_id": "queue-boundary", "relay_connected": True},
            )
        if request.method == "GET" and request.url.path == "/api/imessage/queue/queue-boundary/status":
            status_calls += 1
            if status_calls < 4:
                return httpx.Response(200, json={"success": True, "status": "sending", "sent_at": None})
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "status": "sent",
                    "sent_at": "2026-07-11T22:02:00.000Z",
                },
            )
        return httpx.Response(404, json={"error": f"No mock for {request.url}"})

    setup_mock_fn(handler)
    with (
        patch("temporalio.activity.heartbeat"),
        patch("domains.message_person.repo.asyncio.sleep", new_callable=AsyncMock) as sleep,
    ):
        from domains.message_person.repo import queue_imessage_activity

        result = await queue_imessage_activity(
            user_id="user-42",
            agent_id="agent-42",
            tool_call_id="call-boundary",
            phone_number="+19729777432",
            message="Boundary confirmation",
        )

    assert result["status"] == "sent"
    assert status_calls == 4
    assert sleep.await_count == 3


async def test_queue_imessage_activity_offline_returns_durable_queued_receipt_without_polling():
    """An offline relay leaves the approved send queued and tells the agent immediately."""
    setup_mock(
        {
            "/api/imessage/queue": {
                "status": 200,
                "json": {
                    "success": True,
                    "queue_id": "queue-offline",
                    "relay_connected": False,
                    "relay_last_seen_at": None,
                },
            },
        }
    )
    with patch("temporalio.activity.heartbeat"):
        from domains.message_person.repo import queue_imessage_activity

        result = await queue_imessage_activity(
            user_id="user-42",
            agent_id="agent-42",
            tool_call_id="call-offline",
            phone_number="+19729777432",
            message="Send when the Mac returns",
        )

    assert result == {
        "success": True,
        "queue_id": "queue-offline",
        "status": "queued",
        "relay_connected": False,
        "relay_last_seen_at": None,
    }
    assert len(get_captured_requests()) == 1


async def test_queue_imessage_activity_online_timeout_stays_queued_for_later():
    """A fresh heartbeat is not a send guarantee; missing ACK remains queued, never failed/sent."""
    status_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal status_calls
        if request.method == "POST" and request.url.path == "/api/imessage/queue":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "queue_id": "queue-relay-dropped",
                    "relay_connected": True,
                    "relay_last_seen_at": "2026-07-11T22:00:00.000Z",
                },
            )
        if request.method == "GET" and request.url.path == "/api/imessage/queue/queue-relay-dropped/status":
            status_calls += 1
            return httpx.Response(200, json={"success": True, "status": "queued", "sent_at": None})
        return httpx.Response(404, json={"error": f"No mock for {request.url}"})

    setup_mock_fn(handler)
    with (
        patch("temporalio.activity.heartbeat"),
        patch("domains.message_person.repo.IMESSAGE_ACK_POLL_ATTEMPTS", 2),
        patch("domains.message_person.repo.asyncio.sleep", new_callable=AsyncMock) as sleep,
    ):
        from domains.message_person.repo import queue_imessage_activity

        result = await queue_imessage_activity(
            user_id="user-42",
            agent_id="agent-42",
            tool_call_id="call-relay-dropped",
            phone_number="+19729777432",
            message="Still durable",
        )

    assert result["success"] is True
    assert result["status"] == "queued"
    assert result["relay_connected"] is True
    assert result["queue_id"] == "queue-relay-dropped"
    assert status_calls == 2
    sleep.assert_awaited_once_with(2)


async def test_send_email_activity_posts_to_integrations_send():
    """email channel posts once to /api/integrations/email/send with idempotency."""
    setup_mock(
        {
            "/api/integrations/email/send": {
                "status": 200,
                "json": {
                    "success": True,
                    "messageId": "gmail-msg-1",
                    "threadId": "gmail-thread-1",
                },
            },
        }
    )
    with patch("temporalio.activity.heartbeat"):
        from domains.message_person.repo import send_email_activity

        result = await send_email_activity(
            user_id="user-42",
            agent_id="agent-42",
            tool_call_id="call-email-1",
            to_email="office@example.com",
            from_email="me@roselabs.ai",
            subject="Hello",
            body="Hi there",
        )

    assert result == {
        "success": True,
        "status": "sent",
        "channel": "email",
        "message_id": "gmail-msg-1",
        "thread_id": "gmail-thread-1",
        "to": "office@example.com",
        "from_email": "me@roselabs.ai",
        "subject": "Hello",
    }
    calls = get_captured_requests()
    assert len(calls) == 1
    assert "/api/integrations/email/send" in calls[0]["url"]
    assert json.loads(calls[0]["requestBody"]) == {
        "user_id": "user-42",
        "agent_id": "agent-42",
        "idempotency_key": "call-email-1",
        "to": "office@example.com",
        "from_email": "me@roselabs.ai",
        "subject": "Hello",
        "body": "Hi there",
    }


async def test_send_email_activity_surfaces_gmail_rejection():
    """A Gmail/config rejection is terminal and returns success=False."""
    setup_mock(
        {
            "/api/integrations/email/send": {
                "status": 400,
                "json": {
                    "error": "Gmail not connected",
                    "message": "No Gmail accounts connected",
                },
            },
        }
    )
    with patch("temporalio.activity.heartbeat"):
        from domains.message_person.repo import send_email_activity

        result = await send_email_activity(
            user_id="user-42",
            agent_id="agent-42",
            tool_call_id="call-email-fail",
            to_email="office@example.com",
            from_email="me@roselabs.ai",
            subject="Hello",
            body="Hi there",
        )

    assert result["success"] is False
    assert "No Gmail accounts connected" in result["error"]


async def test_send_agent_sms_activity_is_immediate_and_never_touches_imessage_queue():
    """agent_sms uses the AgentPhone boundary exactly once and has no queue lifecycle."""
    setup_mock(
        {
            "/api/agentphone/messages/send": {
                "status": 200,
                "json": {
                    "success": True,
                    "status": "sent",
                    "message_id": "msg-agent-1",
                    "provider": "agentphone",
                    "provider_channel": "sms",
                    "from_number": "+19125550100",
                    "to_number": "+19729777432",
                    "conversation_id": "conv-1",
                },
            },
        }
    )
    with patch("temporalio.activity.heartbeat"):
        from domains.message_person.repo import send_agent_sms_activity

        result = await send_agent_sms_activity(
            user_id="user-42",
            agent_id="agent-42",
            tool_call_id="call-agent-sms",
            phone_number="+19729777432",
            message="Immediate from Rose",
        )

    assert result["status"] == "sent"
    assert result["message_id"] == "msg-agent-1"
    calls = get_captured_requests()
    assert len(calls) == 1
    assert "/api/agentphone/messages/send" in calls[0]["url"]
    assert "/api/imessage/queue" not in calls[0]["url"]
    assert json.loads(calls[0]["requestBody"]) == {
        "user_id": "user-42",
        "agent_id": "agent-42",
        "idempotency_key": "call-agent-sms",
        "phone_number": "+19729777432",
        "message": "Immediate from Rose",
    }


async def test_send_agent_sms_activity_surfaces_provider_rejection_without_queue_fallback():
    """A carrier/config rejection is terminal and cannot silently fall back to user iMessage."""
    setup_mock(
        {
            "/api/agentphone/messages/send": {
                "status": 502,
                "json": {"error": "AgentPhone HTTP 403: outbound SMS is not enabled"},
            },
        }
    )
    with patch("temporalio.activity.heartbeat"):
        from domains.message_person.repo import send_agent_sms_activity

        result = await send_agent_sms_activity(
            user_id="user-42",
            agent_id="agent-42",
            tool_call_id="call-agent-sms-rejected",
            phone_number="+19729777432",
            message="Must not reroute",
        )

    assert result == {"success": False, "error": "AgentPhone HTTP 403: outbound SMS is not enabled"}
    calls = get_captured_requests()
    assert len(calls) == 1
    assert "/api/agentphone/messages/send" in calls[0]["url"]
    assert all("/api/imessage/queue" not in call["url"] for call in calls)


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


async def test_fetch_voice_context_has_no_calendar_cutoff_and_keeps_timestamps():
    """Live voice history uses the latest messages regardless of calendar age."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.message_person import fetch_recent_messages_activity

        result = await fetch_recent_messages_activity(user_id="user-99", limit=100)

    call = assert_captured_call(url_contains="/api/people/messages/recent", method="GET")
    assert "limit=100" in call["url"]
    assert "days=" not in call["url"]
    assert result["messages"][0]["timestamp"] == "2026-04-01T10:00:00Z"


async def test_fetch_voice_context_includes_messages_from_current_minute():
    """Fresh messages are not hidden by a prompt-cache time bucket."""
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    setup_mock(
        {
            "/api/people/messages/recent": {
                "status": 200,
                "json": {"messages": [{"timestamp": timestamp, "message": "just sent"}], "count": 1},
            },
        }
    )
    with patch("temporalio.activity.heartbeat"):
        from tools.message_person import fetch_recent_messages_activity

        result = await fetch_recent_messages_activity(user_id="user-99")

    assert result["messages"] == [{"timestamp": timestamp, "message": "just sent"}]


async def test_agent_sms_generation_uses_text_prompt_without_subject_or_httpx():
    """agent_sms drafts a text, not an email, and generation makes no transport call."""
    _setup()
    with (
        patch("temporalio.activity.heartbeat"),
        patch("helpers.llm.call_llm") as mock_llm,
    ):
        mock_llm.return_value = {
            "content": "Hey! Great to connect.",
            "usage": {"input_tokens": 100, "output_tokens": 20},
            "finish_reason": "stop",
        }
        from tools.message_person import generate_message_activity

        result = await generate_message_activity(
            model="rose-1-flash",
            system_name="Navi",
            conversation_context="User asked to message Alice",
            person_name="Alice",
            messages_context="Recent thread with Alice",
            exa_context="",
            intent="Follow up on project",
            channel="agent_sms",
        )

    assert "message" in result
    assert result["subject"] is None
    _, kwargs = mock_llm.call_args
    prompt = kwargs["messages"][-1]["content"]
    assert "# Channel\nAgent SMS" in prompt
    assert "message from the agent phone" in prompt
    assert "Do NOT include a subject line" in prompt
    # call_llm doesn't use httpx, so no captured calls from it
    captures = get_captured_requests()
    assert len(captures) == 0


async def test_generate_message_activity_forwards_compute_tokens_to_llm():
    """Nested message generation uses the workflow-selected direct compute token."""
    _setup()
    with (
        patch("temporalio.activity.heartbeat"),
        patch("helpers.llm.call_llm") as mock_llm,
    ):
        mock_llm.return_value = {
            "content": "Subject: Hello\nHi Alice!",
            "usage": {"input_tokens": 100, "output_tokens": 20},
            "finish_reason": "stop",
        }
        from tools.message_person import generate_message_activity

        result = await generate_message_activity(
            model="rose-labs/rose-1-flash",
            system_name="Navi",
            conversation_context="User asked to message Alice",
            person_name="Alice",
            messages_context="Recent thread with Alice",
            exa_context="",
            intent="Follow up on project",
            channel="email",
            person_email="alice@example.com",
            general_messages_context="Recent user style",
            agent_id="agent-1",
            gpt_token="gpt-token-1",
            gpt_account_id="acct-1",
            gpt_token_source="pool",
            gpt_token_pool_id="pool-token-1",
            gpt_token_user_id="user-1",
        )

    assert result["subject"] == "Hello"
    _, kwargs = mock_llm.call_args
    assert kwargs["gpt_token"] == "gpt-token-1"
    assert kwargs["gpt_account_id"] == "acct-1"
    assert kwargs["gpt_token_source"] == "pool"
    assert kwargs["gpt_token_pool_id"] == "pool-token-1"
    assert kwargs["gpt_token_user_id"] == "user-1"
    assert kwargs["max_tokens"] >= 4096


def test_build_message_approval_question_is_plain_text_and_keeps_full_draft():
    """Approval SMS must not emit Markdown asterisks and must keep the full draft.

    Reproduces agent eab955b6: iMessage showed `**Email**` / `**To:**` literally,
    and the Message section was truncated mid-sentence.
    """
    from domains.message_person.service import build_message_approval_question

    full_draft = (
        "Hi Speedrun Team,\n\n"
        "I am looking into credit allocations provided through the Speedrun marketplace "
        "for our infrastructure planning.\n\n"
        "Please share the exact credit amounts by provider for OpenAI, Anthropic, AWS, "
        "Google Cloud, Azure, and Runpod.\n\n"
        "Thanks,\nAndy"
    )
    question = build_message_approval_question(
        system_name="Rose",
        channel="email",
        channel_label="Email",
        person_display="sr-team@a16z.com",
        recipient="sr-team@a16z.com",
        from_email="andy@roselabs.ai",
        generated_subject="LLM and Cloud Credit Amounts for Speedrun Marketplace",
        intent=(
            "Ask a16z Speedrun team (sr-team@a16z.com) for the exact breakdown and "
            "dollar amounts of LLM and cloud credits provided per provider"
        ),
        generated_message=full_draft,
    )

    assert "**" not in question, f"Approval question leaked markdown asterisks:\n{question}"
    assert "Rose wants to send an Email" in question
    assert "To: sr-team@a16z.com (sr-team@a16z.com)" in question
    assert "From: andy@roselabs.ai" in question
    assert "Subject: LLM and Cloud Credit Amounts for Speedrun Marketplace" in question
    assert full_draft in question
    assert question.endswith('Reply to approve, or say "no" to cancel.')


async def test_generate_message_activity_rejects_truncated_finish_reason():
    """Truncated drafts must not reach approval/SMS (finish_reason=length)."""
    _setup()
    with (
        patch("temporalio.activity.heartbeat"),
        patch("helpers.llm.call_llm") as mock_llm,
    ):
        mock_llm.return_value = {
            "content": (
                "Subject: LLM and Cloud Credit Amounts for Speedrun Marketplace\nHi Speedrun Team,\n\nPlease share the"
            ),
            "finish_reason": "length",
            "usage": {"prompt_tokens": 100, "completion_tokens": 1024, "finish_reason": "length"},
        }
        from tools.message_person import generate_message_activity

        try:
            await generate_message_activity(
                model="rose-labs/rose-1-flash",
                system_name="Rose",
                conversation_context="User asked about speedrun credits",
                person_name="sr-team@a16z.com",
                messages_context="No previous messages.",
                exa_context="",
                intent="Ask for exact LLM credit amounts",
                channel="email",
                person_email="sr-team@a16z.com",
            )
            raise AssertionError("expected truncated generation to raise")
        except ValueError as exc:
            assert "truncated" in str(exc).lower()


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


def test_agent_sms_idempotency_key_is_stable_for_logical_send():
    from domains.message_person.service import build_agent_sms_idempotency_key

    first_turn = [{"role": "USER", "message_id": "turn-1", "text": "send it"}]
    first = build_agent_sms_idempotency_key("agent-1", "+15551234567", first_turn)
    retry = build_agent_sms_idempotency_key("agent-1", "+15551234567", first_turn)
    assert first == retry
    assert first.startswith("message_person_agent_sms_")
    assert first != build_agent_sms_idempotency_key("agent-2", "+15551234567", first_turn)
    assert first != build_agent_sms_idempotency_key("agent-1", "+15557654321", first_turn)
    second_turn = [*first_turn, {"role": "USER", "message_id": "turn-2", "text": "send it again"}]
    assert first != build_agent_sms_idempotency_key("agent-1", "+15551234567", second_turn)


# ── format_messages_for_context ────────────────────────────────────


def test_format_messages_for_context_empty():
    """Empty list returns 'No previous messages.'"""
    from domains.message_person.service import format_messages_for_context

    assert format_messages_for_context([]) == "No previous messages."


def test_format_messages_for_context_happy():
    """Messages render with channel/timestamp/arrow/content."""
    from domains.message_person.service import format_messages_for_context

    out = format_messages_for_context(
        [
            {"channel": "imessage", "from": "+15551111111", "to": "+15552222222", "timestamp": "T1", "message": "hi"},
            {"channel": "email", "from": "a@x.com", "to": "b@x.com", "timestamp": "T2", "message": "yo"},
        ]
    )
    assert "[imessage]" in out
    assert "[email]" in out
    assert "hi" in out and "yo" in out
    assert "T1" in out and "T2" in out
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

    out = build_conversation_summary(
        [
            {"role": "USER", "text": "hello"},
            {"role": "ASSISTANT", "text": "world"},
            {"role": "TOOL", "text": ""},  # skipped
        ]
    )
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

    ctx = "Something else\nFull Name: Andy Prevalsky\nMore stuff"
    assert extract_user_name("Navi", ctx) == "Andy Prevalsky"


def test_extract_user_name_fallback():
    from domains.message_person.service import extract_user_name

    assert extract_user_name("Navi", "no name line here") == "Navi"


def test_extract_user_name_empty_name_falls_back():
    """Full Name: with empty value falls back to system name."""
    from domains.message_person.service import extract_user_name

    assert extract_user_name("Navi", "Full Name: ") == "Navi"


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


def test_handler_validate_inputs_agent_sms_happy():
    from domains.message_person.handler import MessagePersonManager

    assert MessagePersonManager._validate_inputs("Alice Smith", "agent_sms", "", "ping") is None


def test_message_person_schema_exposes_distinct_phone_transports():
    from utils.tool_schemas import MessagePersonTool

    channel_schema = MessagePersonTool.model_json_schema()["properties"]["channel"]
    assert channel_schema["enum"] == ["imessage", "agent_sms", "email"]


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


def test_handler_validate_channel_agent_sms_needs_phone():
    from domains.message_person.handler import MessagePersonManager

    missing = MessagePersonManager._validate_channel("agent_sms", None, "alice@example.com", "Alice")
    assert missing is not None
    assert "phone number" in missing.message.lower()
    assert MessagePersonManager._validate_channel("agent_sms", "+15551234", None, "Alice") is None
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

    generated_message = "Hey Alice, long text " * 20
    ev = MessagePersonManager._build_finished_event(
        channel="imessage",
        channel_label="iMessage",
        person_display="Alice",
        recipient="+15551234",
        from_email="",
        generated_subject=None,
        generated_message=generated_message,
        delivery_receipt={
            "channel": "imessage",
            "queue_id": "queue-1",
            "status": "sent",
            "sent_at": "2026-07-11T22:00:00.000Z",
        },
        gen_usage={"prompt_tokens": 100, "completion_tokens": 20, "actual_model": "rose-ultra"},
        model="rose-labs/rose-1-flash",
    )
    assert ev.status == MessageStatus.FINISHED
    assert "Alice" in ev.title
    assert generated_message in ev.message
    assert ev.message.endswith(generated_message)
    # LLM usage attached
    assert ev.data and ev.data["usage"]["llm"][0]["tokens_in"] == 100
    assert ev.data["delivery"]["status"] == "sent"
    assert ev.data["delivery"]["sent_at"] == "2026-07-11T22:00:00.000Z"


def test_build_finished_event_email_with_subject():
    from domains.message_person.handler import MessagePersonManager

    generated_message = "Detailed email body. " * 20
    ev = MessagePersonManager._build_finished_event(
        channel="email",
        channel_label="Email",
        person_display="Alice",
        recipient="a@b.com",
        from_email="sender@mine.com",
        generated_subject="Hello",
        generated_message=generated_message,
        delivery_receipt={"channel": "email", "message_id": "gmail-1"},
        gen_usage={},
        model="rose-labs/rose-1-flash",
    )
    assert "sender@mine.com" in ev.message
    assert "Hello" in ev.message
    assert ev.message.endswith(generated_message)
    assert ev.data == {"delivery": {"channel": "email", "message_id": "gmail-1"}}


def test_build_finished_event_imessage_queued_is_truthful_about_uncertain_timing():
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    ev = MessagePersonManager._build_finished_event(
        channel="imessage",
        channel_label="iMessage",
        person_display="Alice",
        recipient="+15551234",
        from_email="",
        generated_subject=None,
        generated_message="Hey Alice",
        delivery_receipt={
            "channel": "imessage",
            "queue_id": "queue-offline",
            "status": "queued",
            "relay_connected": False,
        },
        gen_usage={},
        model="rose-labs/rose-1-flash",
    )

    assert ev.status == MessageStatus.FINISHED
    assert "queued" in ev.title.lower()
    assert "mac" in ev.message.lower()
    assert "no guarantee" in ev.message.lower()
    assert "sent" not in ev.title.lower()
    assert ev.data and ev.data["delivery"]["status"] == "queued"


# ── MessagePersonManager end-to-end via patched workflow module ─────


class _FakeWFModule:
    def __init__(self, activity_results=None):
        self._results = activity_results or {}
        self.calls = []
        self.logger = type("L", (), {"info": lambda *a, **kw: None, "error": lambda *a, **kw: None})()

    async def execute_activity(self, fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "?")
        self.calls.append({"name": name, "args": args or [], "kwargs": kwargs})
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


async def test_live_message_person_uses_dated_voice_history_without_days_filter():
    from domains.message_person.handler import MessagePersonManager

    fake = _FakeWFModule(
        activity_results={
            "fetch_recent_messages_activity": {
                "messages": [
                    {
                        "channel": "imessage",
                        "from": "me",
                        "to": "+15551111111",
                        "timestamp": "2025-01-01T10:00:00.000Z",
                        "message": "older style sample",
                    }
                ]
            }
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        context = await MessagePersonManager._fetch_voice_context({}, "user-1")
    finally:
        restore()

    assert fake.calls[0]["args"] == ["user-1", 100]
    assert "2025-01-01T10:00:00.000Z" in context
    assert "older style sample" in context


class _WFInstance:
    def __init__(self, *, context=None):
        self.user_id = "user-1"
        self.agent_id = "agent-1"
        self.model = "rose-labs/rose-1-flash"
        self.context = context or []
        self.system_name = "Navi"
        self.user_context_section = "Full Name: Alice Tester"
        self.context_gates = None
        self.handled = []

    async def _handle_tool_event(self, event, tool_call_id, tool_name):
        self.handled.append((event, tool_call_id, tool_name))

    async def _refresh_compute_token(self, user_id):
        self.refreshed_user_id = user_id

    def _active_claude_token(self):
        return None

    def _active_claude_source(self):
        return None

    def _active_claude_pool_id(self):
        return None

    def _active_gpt_token(self):
        return "gpt-token-1"

    def _active_gpt_account_id(self):
        return "acct-1"

    def _active_gpt_source(self):
        return "pool"

    def _active_gpt_pool_id(self):
        return "pool-token-1"


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

    fake = _FakeWFModule(activity_results={"read_message_history_activity": RuntimeError("boom")})
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


async def test_handler_passes_workflow_compute_token_to_generate_activity():
    """message_person generation activity inherits the agent workflow compute token."""
    from domains.message_person.handler import MessagePersonManager

    fake = _FakeWFModule(
        activity_results={
            "generate_message_activity": {"message": "Hi Alice!", "usage": {}},
        }
    )
    wf = _WFInstance()
    restore = _patch_handler_workflow(fake)
    try:
        result = await MessagePersonManager()._generate_message(
            wf,
            "rose-labs/rose-1-flash",
            "Navi",
            "conversation",
            "Alice Smith",
            "messages",
            "",
            "say hi",
            "imessage",
            "alice@example.com",
            "voice",
            "agent-1",
        )
    finally:
        restore()

    assert result["message"] == "Hi Alice!"
    call = fake.calls[-1]
    assert call["name"] == "generate_message_activity"
    assert call["args"][-5:] == [
        "gpt-token-1",
        "acct-1",
        "pool",
        "pool-token-1",
        "user-1",
    ]
    assert wf.refreshed_user_id == "user-1"


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
    """Approved email cold outreach delivers via send_email_activity and finishes."""
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
                "usage": {"prompt_tokens": 5, "completion_tokens": 3, "actual_model": "rose-1-flash"},
            },
            "send_email_activity": {
                "success": True,
                "status": "sent",
                "message_id": "gmail-1",
                "thread_id": "thread-1",
                "to": "alice@example.com",
                "from_email": "me@roselabs.ai",
                "subject": "Hello",
            },
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
    errors = [e for e in events if e.status == MessageStatus.ERROR]
    assert errors == []
    assert len(finished) == 1
    assert "Email sent" in (finished[0].title or "")
    assert finished[0].data and finished[0].data["delivery"]["message_id"] == "gmail-1"
    sends = [call for call in fake.calls if call["name"] == "send_email_activity"]
    assert len(sends) == 1
    assert sends[0]["args"] == [
        "user-1",
        "agent-1",
        "tc-cold",
        "alice@example.com",
        "me@roselabs.ai",
        "Hello",
        "Hi Alice!",
    ]
    assert sends[0]["kwargs"]["retry_policy"].maximum_attempts == 1


async def test_handler_email_delivery_failure_surfaces_provider_error():
    """Provider rejection after approval yields ERROR and does not claim sent."""
    from domains.message_person.handler import MessagePersonManager
    from tools.base import MessageStatus

    async def fake_approval(*args, **kwargs):
        return {"response": "ok", "question": "", "attention_request_id": None}

    fake = _FakeWFModule(
        activity_results={
            "read_message_history_activity": {"person": None, "messages": []},
            "fetch_recent_messages_activity": {"messages": []},
            "generate_message_activity": {
                "message": "Hi Alice!",
                "subject": "Hello",
                "usage": {},
            },
            "send_email_activity": {
                "success": False,
                "error": "Gmail token expired",
            },
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
                    tool_call_id="tc-email-fail",
                )
            )
        finally:
            restore()

    assert [e for e in events if e.status == MessageStatus.FINISHED] == []
    errors = [e for e in events if e.status == MessageStatus.ERROR]
    assert len(errors) == 1
    assert "Failed to send Email" in (errors[0].title or "")
    assert "Gmail token expired" in (errors[0].message or "")


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


async def test_handler_successful_imessage_requires_delivery_confirmation():
    """iMessage reaches FINISHED only after the Mac confirms delivery."""
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
            "generate_message_activity": {
                "message": "Hello Alice!",
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "actual_model": "rose-1-flash"},
            },
            "queue_imessage_activity": {
                "success": True,
                "queue_id": "queue-42",
                "status": "sent",
                "sent_at": "2026-07-11T22:00:00.000Z",
            },
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
    assert finished[0].data["delivery"] == {
        "channel": "imessage",
        "queue_id": "queue-42",
        "status": "sent",
        "sent_at": "2026-07-11T22:00:00.000Z",
    }
    queue_calls = [call for call in fake.calls if call["name"] == "queue_imessage_activity"]
    assert len(queue_calls) == 1
    assert queue_calls[0]["args"] == ["user-1", "agent-1", "tc-ok", "+15551234567", "Hello Alice!"]
    assert queue_calls[0]["kwargs"]["start_to_close_timeout"].total_seconds() == 150


async def test_handler_offline_imessage_finishes_as_queued_not_sent():
    """An accepted durable queue write is success, with truthful offline relay status."""
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
            "generate_message_activity": {"message": "Hello Alice!", "usage": {}},
            "queue_imessage_activity": {
                "success": True,
                "queue_id": "queue-offline",
                "status": "queued",
                "relay_connected": False,
                "relay_last_seen_at": None,
            },
        }
    )
    restore = _patch_handler_workflow(fake)
    with patch("domains.message_person.handler.request_user_approval_direct", fake_approval):
        try:
            events = await _collect(
                MessagePersonManager().execute_tool(
                    workflow_instance=_WFInstance(),
                    tool_call={"person_id": "Alice Smith", "channel": "imessage", "intent": "ping"},
                    tool_call_id="tc-offline",
                )
            )
        finally:
            restore()

    finished = [event for event in events if event.status == MessageStatus.FINISHED]
    assert len(finished) == 1
    assert finished[0].data and finished[0].data["delivery"]["status"] == "queued"
    assert "queued" in finished[0].title.lower()
    assert "sent" not in finished[0].title.lower()


async def test_handler_agent_sms_is_immediate_single_attempt_and_never_queues():
    """agent_sms has a distinct, non-queued, non-retrying transport path."""
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
            "generate_message_activity": {"message": "Hello from Rose", "usage": {}},
            "send_agent_sms_activity": {
                "success": True,
                "status": "sent",
                "message_id": "msg-42",
                "provider": "agentphone",
                "provider_channel": "sms",
                "from_number": "+19125550100",
                "to_number": "+15551234567",
                "conversation_id": "conv-42",
            },
        }
    )
    restore = _patch_handler_workflow(fake)
    with patch("domains.message_person.handler.request_user_approval_direct", fake_approval):
        try:
            events = await _collect(
                MessagePersonManager().execute_tool(
                    workflow_instance=_WFInstance(),
                    tool_call={"person_id": "Alice Smith", "channel": "agent_sms", "intent": "ping"},
                    tool_call_id="tc-agent-sms",
                )
            )
        finally:
            restore()

    finished = [event for event in events if event.status == MessageStatus.FINISHED]
    assert len(finished) == 1
    assert finished[0].data and finished[0].data["delivery"]["channel"] == "agent_sms"
    assert [call for call in fake.calls if call["name"] == "queue_imessage_activity"] == []
    sends = [call for call in fake.calls if call["name"] == "send_agent_sms_activity"]
    assert len(sends) == 1
    from domains.message_person.service import build_agent_sms_idempotency_key

    expected_key = build_agent_sms_idempotency_key("agent-1", "+15551234567", [])
    assert sends[0]["args"] == ["user-1", "agent-1", expected_key, "+15551234567", "Hello from Rose"]
    assert sends[0]["kwargs"]["retry_policy"].maximum_attempts == 1


async def test_handler_agent_sms_provider_failure_is_terminal_and_never_queues():
    """Provider rejection produces one error event without retrying through user iMessage."""
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
            "generate_message_activity": {"message": "Hello from Rose", "usage": {}},
            "send_agent_sms_activity": {
                "success": False,
                "error": "AgentPhone HTTP 403: outbound SMS is not enabled",
            },
        }
    )
    restore = _patch_handler_workflow(fake)
    with patch("domains.message_person.handler.request_user_approval_direct", fake_approval):
        try:
            events = await _collect(
                MessagePersonManager().execute_tool(
                    workflow_instance=_WFInstance(),
                    tool_call={"person_id": "Alice Smith", "channel": "agent_sms", "intent": "ping"},
                    tool_call_id="tc-agent-sms-rejected",
                )
            )
        finally:
            restore()

    assert [event for event in events if event.status == MessageStatus.FINISHED] == []
    errors = [event for event in events if event.status == MessageStatus.ERROR]
    assert len(errors) == 1
    assert "outbound SMS is not enabled" in errors[0].message
    assert "Do not call message_person again" in errors[0].message
    assert "unless the user explicitly requests a new attempt" in errors[0].message
    assert len([call for call in fake.calls if call["name"] == "send_agent_sms_activity"]) == 1
    assert [call for call in fake.calls if call["name"] == "queue_imessage_activity"] == []


async def test_handler_imessage_queue_failure_is_terminal_error():
    """A rejected queue write cannot be transformed into a sent event."""
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
            "generate_message_activity": {"message": "Hello Alice!", "usage": {}},
            "queue_imessage_activity": {"success": False, "error": "backend unavailable"},
        }
    )
    restore = _patch_handler_workflow(fake)
    with patch("domains.message_person.handler.request_user_approval_direct", fake_approval):
        try:
            events = await _collect(
                MessagePersonManager().execute_tool(
                    workflow_instance=_WFInstance(),
                    tool_call={"person_id": "Alice Smith", "channel": "imessage", "intent": "ping"},
                    tool_call_id="tc-failed-queue",
                )
            )
        finally:
            restore()

    assert [event for event in events if event.status == MessageStatus.FINISHED] == []
    errors = [event for event in events if event.status == MessageStatus.ERROR]
    assert len(errors) == 1
    assert "backend unavailable" in errors[0].message


def test_message_person_prompt_forbids_automatic_agent_sms_retry():
    """A lost provider receipt must not become an accidental duplicate SMS."""
    from tools.prompts.message_person import PROMPT

    normalized = " ".join(PROMPT.lower().split())
    assert "never automatically retry a failed or unconfirmed agent_sms send" in normalized
    assert "only if the user explicitly asks for a new attempt" in normalized


async def test_queue_phone_transport_preserved_without_mac_polling():
    from domains.message_person.repo import queue_imessage_activity
    calls = []
    def backend(request):
        calls.append(request.url.path)
        assert request.method == "POST" and request.url.path == "/api/imessage/queue"
        return httpx.Response(200, json={"success": True, "queue_id": "cloud-queue", "provider": "phone_harness", "status": "approved", "browser_task_id": None, "sent_at": None})
    setup_mock_fn(backend)
    try:
        with patch("temporalio.activity.heartbeat"):
            result = await queue_imessage_activity("user", "agent", "tool", "+15550000000", "Exact approved body")
        assert result["provider"] == "phone_harness" and result["status"] == "approved"
        assert calls == ["/api/imessage/queue"]
    finally:
        teardown_mock()


async def test_cloud_message_adapter_requires_backend_sent_receipt_and_stable_binding():
    from domains.message_person import cloud_phone
    from tools.base import ToolEvent, EventType, MessageStatus
    from domains.spawn_browser_agent_v3.handler import _stable_browser_task_id
    class Browser:
        def __init__(self):
            self.calls = []
        async def execute_tool(self, instance, args, call_id):
            self.calls.append((args, call_id))
            yield ToolEvent(type=EventType.POST_MESSAGE, message="Synthetic model claims sent", status=MessageStatus.FINISHED, metadata={"toolName": "spawn_browser_agent", "action_type": "task_complete", "success": True})
    browser = Browser()
    backend = {"success": True, "provider": "phone_harness", "queue_id": "queue", "status": "unknown", "sent_at": None, "browser_task_id": _stable_browser_task_id("agent-1", "original:cloud-message")}
    fake = _FakeWFModule(activity_results={"bind_phone_message_activity": {"success": True, "provider": "phone_harness", "queue_id": "queue", "status": "approved", "browser_task_id": _stable_browser_task_id("agent-1", "original:cloud-message")}, "read_phone_message_activity": lambda: dict(backend)})
    with patch.object(cloud_phone, "workflow", fake), patch.object(cloud_phone, "get_browser_manager", lambda: browser):
        for status in ("unknown", "sent"):
            backend["status"] = status
            backend["sent_at"] = "2026-10-19T00:00:00Z" if status == "sent" else None
            events = await _collect(cloud_phone.deliver_cloud_message(_WFInstance(), queue_id="queue", tool_call_id="original", recipient="+15550000000", body="Exact approved body"))
            receipt = [e.data["cloud_delivery"] for e in events if e.data and "cloud_delivery" in e.data]
            assert (len(receipt) == 1) == (status == "sent"), "Model summary fabricated a confirmed send"
            if status == "unknown":
                assert any(e.status == MessageStatus.ERROR for e in events)
                assert not any(e.status == MessageStatus.FINISHED for e in events), "Child summary appeared confirmed before receipt"
                assert not any("Synthetic model claims sent" in (e.message or "") for e in events)
        assert all(call_id == "original:cloud-message" for _, call_id in browser.calls)
        assert len({json.dumps(args, sort_keys=True) for args, _ in browser.calls}) == 1
        assert "Exact approved body" in browser.calls[0][0]["goal"] and "+15550000000" in browser.calls[0][0]["goal"]
        assert all(args["approvedMessageIntent"] == "queue" for args, _ in browser.calls)
        assert not any(c["name"] == "bind_phone_message_activity" for c in fake.calls), "Bind ran before browser task creation"
        assert all(c["kwargs"]["retry_policy"].maximum_attempts == 1 for c in fake.calls)


async def test_handler_cloud_route_after_exact_approval_without_mac_fallback():
    from domains.message_person.handler import MessagePersonManager
    from domains.message_person import cloud_phone
    from tools.base import ToolEvent, EventType, MessageStatus
    approvals, delegated = [], []
    async def approval(*args, **kwargs):
        approvals.append(kwargs.get("question"))
    async def cloud(instance, **kwargs):
        assert len(approvals) == 1
        delegated.append(kwargs)
        yield ToolEvent(type=EventType.POST_MESSAGE, message="", status=MessageStatus.FINISHED, data={"cloud_delivery": {"channel": "imessage", "provider": "phone_harness", "queue_id": "queue", "status": "sent", "sent_at": "2026-10-19T00:00:00Z"}})
    fake = _FakeWFModule(activity_results={"read_message_history_activity": {"person": {"firstName": "Alice", "phoneNumber": "+15550000000"}, "messages": []}, "fetch_recent_messages_activity": {"messages": []}, "generate_message_activity": {"message": "Exact approved body", "usage": {}}, "queue_imessage_activity": {"success": True, "provider": "phone_harness", "queue_id": "queue", "status": "approved", "sent_at": None}})
    restore = _patch_handler_workflow(fake)
    try:
        with patch("domains.message_person.handler.request_user_approval_direct", approval), patch("domains.message_person.handler.deliver_cloud_message", cloud):
            events = await _collect(MessagePersonManager().execute_tool(_WFInstance(), {"person_id": "Alice", "channel": "imessage", "intent": "ping"}, "original"))
    finally:
        restore()
    assert len(approvals) == len(delegated) == 1
    assert delegated[0] == {"queue_id": "queue", "tool_call_id": "original", "recipient": "+15550000000", "body": "Exact approved body"}
    final = [e for e in events if e.data and e.data.get("delivery")]
    assert len(final) == 1 and final[0].data["delivery"]["provider"] == "phone_harness"
    assert len([c for c in fake.calls if c["name"] == "queue_imessage_activity"]) == 1
    fake._results["queue_imessage_activity"] = {"success": True, "provider": "phone_harness", "queue_id": "queue", "status": "sent", "sent_at": "2026-10-19T00:00:00Z"}
    restore = _patch_handler_workflow(fake)
    try:
        with patch("domains.message_person.handler.request_user_approval_direct", approval), patch("domains.message_person.handler.deliver_cloud_message", cloud):
            replay_events = await _collect(MessagePersonManager().execute_tool(_WFInstance(), {"person_id": "Alice", "channel": "imessage", "intent": "ping"}, "original"))
    finally:
        restore()
    assert len(delegated) == 1, "Already sent backend receipt restarted a browser send"
    assert any(e.data and e.data.get("delivery", {}).get("sent_at") for e in replay_events)



async def test_cloud_bind_http_fails_closed_and_after_browser_init():
    import ast
    from pathlib import Path
    from types import SimpleNamespace
    from domains.spawn_browser_agent_v3.phone import bind_approved_message
    from domains.spawn_browser_agent_v3 import handler
    config = SimpleNamespace(backend=SimpleNamespace(api_url="https://backend.test", api_key="synthetic"))
    calls = []
    status = 200
    matched = True
    def backend(request):
        calls.append(request)
        assert request.url.raw_path == b"/api/imessage/queue/queue%2Fopaque/phone-bind"
        assert json.loads(request.content) == {"user_id": "user", "browser_task_id": "owned-task"}
        assert request.headers["X-User-Id"] == "user"
        return httpx.Response(status, json={"success": True, "provider": "phone_harness", "queue_id": "queue/opaque", "browser_task_id": "owned-task" if matched else "foreign"})
    async with httpx.AsyncClient(transport=httpx.MockTransport(backend)) as client:
        await bind_approved_message(config, "user", "owned-task", "queue/opaque", client=client)
        await bind_approved_message(config, "user", "owned-task", "queue/opaque", client=client)
        for status, matched in ((403, True), (200, False)):
            try:
                await bind_approved_message(config, "user", "owned-task", "queue/opaque", client=client)
                raise AssertionError("Foreign/denied cloud binding accepted")
            except RuntimeError as error:
                assert "synthetic" not in str(error)
    tree = ast.parse(Path(handler.__file__).read_text())
    boundary = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "_spawn_browser_agent_activity_v3_real")
    bind = next(n for n in ast.walk(boundary) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "bind_approved_message")
    init = next(n for n in ast.walk(boundary) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "_init_browser_session_preserving_owner")
    model = [n for n in ast.walk(boundary) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "_call_browser_use_with_rotation"]
    assert init.lineno < bind.lineno < min(n.lineno for n in model)


async def test_phone_message_commit_rejects_forged_payload_fields():
    from types import SimpleNamespace
    from domains.spawn_browser_agent_v3.phone import execute_phone
    physical = []
    def backend(request):
        if request.url.path.endswith("/capability"):
            return httpx.Response(200, json={"enabled": True})
        if "/interactions/" in request.url.path:
            return httpx.Response(200, json={"lease": {"id": "lease", "status": "ACTIVE"}})
        physical.append(request.url.path)
        return httpx.Response(200, json={"operation": {"status": "SUCCEEDED"}})
    async with httpx.AsyncClient(transport=httpx.MockTransport(backend)) as client:
        for operation in ("messages.send_approved", "messages.verify_sent"):
            for args in ({}, {"queueId": "queue", "to": "+15550000000"}, {"queueId": "queue", "body": "Changed"}, {"queueId": "queue", "approved": True}):
                result = await execute_phone({"mode": "operation", "operation": operation, "args": args}, config=SimpleNamespace(backend=SimpleNamespace(api_url="https://backend.test", api_key="synthetic")), user_id="user", agent_id="agent", task_id="task", decision_id="decision", snapshot={"enabled": True, "interaction": {"cursor": 0}}, client=client)
                assert not result["success"], "Model forged approved-message payload reached submission"
        assert physical == []


async def test_cloud_receipt_requires_explicit_success_and_exact_bound_task():
    from domains.message_person.repo import read_phone_message_activity
    from domains.message_person import cloud_phone
    from tools.base import EventType, MessageStatus, ToolEvent
    from domains.spawn_browser_agent_v3.handler import _stable_browser_task_id
    setup_mock_fn(lambda request: httpx.Response(200, json={"provider": "phone_harness", "status": "sent", "sent_at": "2026-10-19T00:00:00Z"}))
    try:
        result = await read_phone_message_activity("user", "agent", "queue")
        assert result["success"] is False, "Malformed status was promoted to success"
    finally:
        teardown_mock()
    class Browser:
        async def execute_tool(self, *args):
            yield ToolEvent(type=EventType.POST_MESSAGE, status=MessageStatus.FINISHED, message="Claimed sent", metadata={"action_type": "task_complete"})
    fake = _FakeWFModule(activity_results={"read_phone_message_activity": {"success": True, "provider": "phone_harness", "queue_id": "queue", "status": "sent", "sent_at": "2026-10-19T00:00:00Z", "browser_task_id": "foreign-task"}})
    with patch.object(cloud_phone, "workflow", fake), patch.object(cloud_phone, "get_browser_manager", lambda: Browser()):
        events = await _collect(cloud_phone.deliver_cloud_message(_WFInstance(), queue_id="queue", tool_call_id="original", recipient="+15550000000", body="Exact"))
    assert not any(event.data and event.data.get("cloud_delivery") for event in events)
    assert any(event.status == MessageStatus.ERROR for event in events)


async def run_all_tests():
    print("message-person blackbox tests:")
    r = BlackboxResult()
    await r.record_async("cloud_receipt_explicit_success_binding", test_cloud_receipt_requires_explicit_success_and_exact_bound_task)
    await r.record_async("phone_message_commit_args", test_phone_message_commit_rejects_forged_payload_fields)
    await r.record_async("handler_cloud_exact_approval", test_handler_cloud_route_after_exact_approval_without_mac_fallback)
    await r.record_async("cloud_bind_http_and_init_order", test_cloud_bind_http_fails_closed_and_after_browser_init)
    await r.record_async("queue_phone_transport_preserved", test_queue_phone_transport_preserved_without_mac_polling)
    await r.record_async("cloud_message_authoritative_receipt", test_cloud_message_adapter_requires_backend_sent_receipt_and_stable_binding)
    await r.record_async(
        "queue_imessage_activity_confirmed_send",
        test_queue_imessage_activity_waits_for_delivery_confirmation,
    )
    await r.record_async(
        "queue_imessage_activity_pending_then_sent",
        test_queue_imessage_activity_waits_through_pending_status,
    )
    await r.record_async(
        "queue_imessage_activity_final_buffered_status",
        test_queue_imessage_activity_checks_final_buffered_status,
    )
    await r.record_async(
        "queue_imessage_activity_offline_queued_without_polling",
        test_queue_imessage_activity_offline_returns_durable_queued_receipt_without_polling,
    )
    await r.record_async(
        "simulated_imessage_send_carries_approved_write_to_wmh",
        test_simulated_imessage_send_carries_approved_write_to_wmh,
    )
    await r.record_async(
        "post_approval_message_dispatch_passes_approval_to_wmh_activity",
        test_post_approval_message_dispatch_passes_approval_to_wmh_activity,
    )
    await r.record_async(
        "queue_imessage_activity_online_timeout_stays_queued",
        test_queue_imessage_activity_online_timeout_stays_queued_for_later,
    )
    await r.record_async(
        "send_agent_sms_activity_immediate_no_imessage_queue",
        test_send_agent_sms_activity_is_immediate_and_never_touches_imessage_queue,
    )
    await r.record_async(
        "send_agent_sms_activity_provider_rejection_no_queue",
        test_send_agent_sms_activity_surfaces_provider_rejection_without_queue_fallback,
    )
    await r.record_async(
        "send_email_activity_posts_to_integrations_send",
        test_send_email_activity_posts_to_integrations_send,
    )
    await r.record_async(
        "send_email_activity_surfaces_gmail_rejection",
        test_send_email_activity_surfaces_gmail_rejection,
    )
    await r.record_async("fetch_recent_messages_happy_path", test_fetch_recent_messages_happy_path)
    await r.record_async("fetch_recent_messages_boundary", test_fetch_recent_messages_boundary)
    await r.record_async(
        "fetch_voice_context_no_calendar_cutoff",
        test_fetch_voice_context_has_no_calendar_cutoff_and_keeps_timestamps,
    )
    await r.record_async(
        "fetch_voice_context_includes_current_minute",
        test_fetch_voice_context_includes_messages_from_current_minute,
    )
    await r.record_async(
        "agent_sms_generation_text_prompt_no_httpx",
        test_agent_sms_generation_uses_text_prompt_without_subject_or_httpx,
    )
    await r.record_async(
        "generate_message_forwards_compute_token",
        test_generate_message_activity_forwards_compute_tokens_to_llm,
    )
    r.record(
        "approval_question_plain_text_full_draft",
        test_build_message_approval_question_is_plain_text_and_keeps_full_draft,
    )
    await r.record_async(
        "generate_message_rejects_truncated_finish_reason",
        test_generate_message_activity_rejects_truncated_finish_reason,
    )
    await r.record_async(
        "live_message_person_dated_voice_history",
        test_live_message_person_uses_dated_voice_history_without_days_filter,
    )
    # classify_person_id
    r.record("classify_phone_full", test_classify_person_id_phone_full)
    r.record("classify_phone_10digit", test_classify_person_id_phone_10_digit)
    r.record("classify_phone_formatted", test_classify_person_id_phone_with_formatting)
    r.record("classify_email", test_classify_person_id_email)
    r.record("classify_name_two", test_classify_person_id_name_two_parts)
    r.record("classify_name_multi", test_classify_person_id_name_multi_word_last)
    r.record("classify_single_word", test_classify_person_id_single_word_fallback)
    r.record("agent_sms_stable_idempotency_key", test_agent_sms_idempotency_key_is_stable_for_logical_send)
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
    r.record("handler_validate_agent_sms_happy", test_handler_validate_inputs_agent_sms_happy)
    r.record(
        "message_person_schema_distinct_phone_transports",
        test_message_person_schema_exposes_distinct_phone_transports,
    )
    r.record(
        "message_person_prompt_no_automatic_agent_sms_retry",
        test_message_person_prompt_forbids_automatic_agent_sms_retry,
    )
    r.record("handler_channel_no_phone", test_handler_validate_channel_no_phone)
    r.record("handler_channel_no_email", test_handler_validate_channel_no_email)
    r.record("handler_channel_happy", test_handler_validate_channel_happy)
    r.record("handler_channel_agent_sms_needs_phone", test_handler_validate_channel_agent_sms_needs_phone)
    # ambiguous/finished events
    r.record("ambiguous_error", test_build_ambiguous_error)
    r.record("finished_event_imessage", test_build_finished_event_imessage)
    r.record("finished_event_email", test_build_finished_event_email_with_subject)
    r.record(
        "finished_event_imessage_queued_truthful",
        test_build_finished_event_imessage_queued_is_truthful_about_uncertain_timing,
    )
    # handler end-to-end paths
    await r.record_async("handler_missing_person_id", test_handler_missing_person_id_yields_error)
    await r.record_async("handler_read_history_failure", test_handler_read_history_failure_yields_error)
    await r.record_async("handler_multiple_matches", test_handler_multiple_matches_yields_ambiguous)
    await r.record_async("handler_no_person_no_id", test_handler_no_person_found_no_id_yields_error)
    await r.record_async("handler_channel_mismatch", test_handler_channel_mismatch_no_phone)
    await r.record_async("handler_empty_message", test_handler_empty_generated_message_yields_error)
    await r.record_async(
        "handler_compute_token_to_generate",
        test_handler_passes_workflow_compute_token_to_generate_activity,
    )
    await r.record_async("handler_gen_raises", test_handler_generate_message_raises_yields_error)
    await r.record_async("handler_cold_outreach_email", test_handler_cold_outreach_email_path)
    await r.record_async(
        "handler_email_delivery_failure_surfaces_provider_error",
        test_handler_email_delivery_failure_surfaces_provider_error,
    )
    await r.record_async("handler_user_rejects", test_handler_user_rejects_approval)
    await r.record_async(
        "handler_imessage_success_requires_confirmed_send",
        test_handler_successful_imessage_requires_delivery_confirmation,
    )
    await r.record_async(
        "handler_imessage_offline_finishes_queued",
        test_handler_offline_imessage_finishes_as_queued_not_sent,
    )
    await r.record_async(
        "handler_agent_sms_immediate_single_attempt_no_queue",
        test_handler_agent_sms_is_immediate_single_attempt_and_never_queues,
    )
    await r.record_async(
        "handler_agent_sms_provider_failure_no_queue",
        test_handler_agent_sms_provider_failure_is_terminal_and_never_queues,
    )
    await r.record_async(
        "handler_imessage_queue_failure",
        test_handler_imessage_queue_failure_is_terminal_error,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
