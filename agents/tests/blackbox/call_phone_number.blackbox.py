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
        return httpx.Response(
            200,
            json={
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
            },
        )

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
    assert body["idempotency_key"] == "agent-1:tc-1"

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


async def test_poll_read_timeout_retries_and_completes():
    """A single Vapi poll ReadTimeout must not fail a live call."""
    polls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/api/vapi/call" in url and request.method == "POST" and "/call/" not in url.split("/api/vapi/call")[1]:
            return httpx.Response(200, json={"call_id": "call-test-123"})
        if "/api/vapi/call/call-test-123" in url and request.method == "GET":
            polls["n"] += 1
            if polls["n"] == 1:
                raise httpx.ReadTimeout("")
            return httpx.Response(
                200,
                json={
                    "status": "ended",
                    "analysis": {"summary": "Held then finished", "structuredData": {}},
                    "transcript": "Please continue to hold.",
                    "endedReason": "hangup",
                    "startedAt": "2026-01-01T00:00:00Z",
                    "endedAt": "2026-01-01T00:02:30Z",
                },
            )
        if "/api/agents/" in url and "/messages" in url:
            return httpx.Response(200, json={"id": "msg-1"})
        return httpx.Response(404)

    setup_mock_fn(handler)

    with (
        patch("temporalio.activity.heartbeat"),
        patch("tools.call_phone_number.save_phone_call_message", new_callable=AsyncMock),
        patch("tools.call_phone_number.asyncio.sleep", side_effect=_noop_sleep),
    ):
        from tools.call_phone_number import call_phone_number_activity

        result = await call_phone_number_activity(
            to="+15559876543",
            system_prompt="Stay on the line through the hold queue",
            output_schema={},
            agent_id="a-1",
            tool_call_id="tc-1",
        )

    assert polls["n"] == 2
    assert result["success"] is True
    assert result["call_id"] == "call-test-123"


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
        capture for capture in captures if "/api/agents/a-1/messages" in capture["url"] and capture["method"] == "POST"
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


def test_enrich_transcript_with_dtmf_marks_keypresses_inline():
    from domains.call_phone_number.service import enrich_transcript_with_dtmf

    speech = "User: Press two to track a package.\nUser: Enter your tracking number.\nAI: Thank you. Goodbye."
    messages = [
        {"role": "user", "message": "Press two to track a package."},
        {
            "role": "tool_calls",
            "toolCalls": [
                {
                    "function": {
                        "name": "dtmf",
                        "arguments": '{"keys": "2"}',
                    }
                }
            ],
        },
        {"role": "user", "message": "Enter your tracking number."},
        {
            "role": "tool_calls",
            "toolCalls": [
                {
                    "function": {
                        "name": "dtmf",
                        "arguments": {"keys": "ww245w133w8820#"},
                    }
                }
            ],
        },
        {"role": "bot", "message": "Thank you. Goodbye."},
    ]
    out = enrich_transcript_with_dtmf(speech, messages)
    assert "[DTMF] 2" in out
    assert "[DTMF] 2451338820# (sent: ww245w133w8820#)" in out
    assert out.index("[DTMF] 2") < out.index("[DTMF] 2451338820#")
    assert "Press two to track a package." in out
    assert "Enter your tracking number." in out


def test_enrich_transcript_with_dtmf_noop_without_keypresses():
    from domains.call_phone_number.service import enrich_transcript_with_dtmf

    speech = "User: Hello.\nAI: Hi."
    assert enrich_transcript_with_dtmf(speech, None) == speech
    assert enrich_transcript_with_dtmf(speech, [{"role": "user", "message": "Hello."}]) == speech


def test_calculate_duration_from_timestamps_valid():
    from domains.call_phone_number.service import calculate_duration_from_timestamps

    d = calculate_duration_from_timestamps("2026-01-01T00:00:00Z", "2026-01-01T00:01:30Z")
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
    q = manager.get_approval_question(
        {
            "to": "+19729777432",
            "system_prompt": "Be polite",
        }
    )
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


def test_poll_interval_backs_off_after_long_hold():
    from domains.call_phone_number.config import (
        ACTIVE_POLL_INTERVAL_SECONDS,
        HEARTBEAT_TIMEOUT_SECONDS,
        HTTP_TIMEOUT_POLL,
        INITIAL_POLL_INTERVAL_SECONDS,
        LONG_HOLD_POLL_AFTER_POLLS,
        LONG_HOLD_POLL_INTERVAL_SECONDS,
        MAX_RETRY_ATTEMPTS,
    )
    from domains.call_phone_number.service import max_poll_coverage_seconds, poll_interval_seconds

    assert poll_interval_seconds(0, call_started=False) == INITIAL_POLL_INTERVAL_SECONDS
    assert poll_interval_seconds(10, call_started=True) == ACTIVE_POLL_INTERVAL_SECONDS
    assert poll_interval_seconds(LONG_HOLD_POLL_AFTER_POLLS, call_started=True) == LONG_HOLD_POLL_INTERVAL_SECONDS
    assert HEARTBEAT_TIMEOUT_SECONDS >= 600
    assert HEARTBEAT_TIMEOUT_SECONDS > HTTP_TIMEOUT_POLL * 2
    assert MAX_RETRY_ATTEMPTS >= 5
    assert max_poll_coverage_seconds() >= 12600


async def test_manager_execute_tool_uses_idempotent_retry_policy():
    """Activity retry is allowed only because backend call creation is idempotent."""
    from domains.call_phone_number.handler import CallPhoneNumberManager

    seen_retry_policy = None

    seen_heartbeat = None

    async def mock_execute_activity(activity_fn, *, args, **kw):
        nonlocal seen_retry_policy, seen_heartbeat
        if getattr(activity_fn, "__name__", "") == "call_phone_number_activity":
            seen_retry_policy = kw["retry_policy"]
            seen_heartbeat = kw["heartbeat_timeout"]
            return {"success": True, "call_id": "c-1", "duration": 60}
        return None

    manager = CallPhoneNumberManager()
    await manager.execute_tool(
        execute_activity=mock_execute_activity,
        tool_call={"to": "+19729777432", "system_prompt": "Be kind"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )

    assert seen_retry_policy is not None
    assert seen_retry_policy.maximum_attempts == 5
    from datetime import timedelta

    from domains.call_phone_number.config import HEARTBEAT_TIMEOUT_SECONDS

    assert seen_heartbeat == timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)


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


def _hold_poll(state, status="in-progress", listen_url=None, hold_seconds=0, **extra):
    holds = [{"startedAt": "2026-01-01T00:01:00Z", "endedAt": None}] if state != "connected" or hold_seconds else []
    body = {
        "status": status,
        "startedAt": "2026-01-01T00:00:00Z",
        "phoneHold": {"state": state, "holds": holds, "holdSeconds": hold_seconds},
        **extra,
    }
    if listen_url:
        body["monitor"] = {"listenUrl": listen_url}
    return body


async def test_wait_for_human_hold_updates_card_and_cost():
    """A parked call shows on-hold, resumes with the new segment's audio, and bills hold time separately."""
    sequence = [
        _hold_poll("connected", listen_url="wss://listen/a"),
        _hold_poll("on_hold"),
        _hold_poll("on_hold"),
        _hold_poll("reconnecting"),
        _hold_poll("connected", listen_url="wss://listen/b", hold_seconds=9000),
        _hold_poll(
            "ended",
            status="ended",
            hold_seconds=9000,
            transcript="AI: Hi\n[On hold for 2h 30m]\nUser: Air Canada, Jordan speaking.",
            analysis={"summary": "Claimed the credit", "structuredData": {"credit_claimed": True}},
            endedReason="customer-ended-call",
            endedAt="2026-01-01T02:36:00Z",
        ),
    ]
    polls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/api/vapi/call" in url and request.method == "POST" and "/call/" not in url.split("/api/vapi/call")[1]:
            return httpx.Response(200, json={"call_id": "call-hold-1"})
        if "/api/vapi/call/call-hold-1" in url and request.method == "GET":
            body = sequence[min(polls["n"], len(sequence) - 1)]
            polls["n"] += 1
            return httpx.Response(200, json=body)
        return httpx.Response(404)

    setup_mock_fn(handler)
    with (
        patch("temporalio.activity.heartbeat"),
        patch("tools.call_phone_number.asyncio.sleep", side_effect=_noop_sleep),
    ):
        from tools.call_phone_number import call_phone_number_activity

        result = await call_phone_number_activity(
            to="+18885550100",
            system_prompt="Claim the flight credit",
            output_schema={},
            agent_id="a-1",
            tool_call_id="tc-1",
        )

    cards = [
        json.loads(capture["requestBody"])["metadata"]["phoneCall"]
        for capture in get_captured_requests()
        if "/api/agents/a-1/messages" in capture["url"] and capture["method"] == "POST"
    ]
    assert [card["status"] for card in cards] == ["in-progress", "on-hold", "in-progress", "ended"], cards
    assert cards[0]["listenUrl"] == "wss://listen/a"
    assert cards[1]["holdStartedAt"] == "2026-01-01T00:01:00Z"
    assert cards[2]["listenUrl"] == "wss://listen/b"
    assert cards[3]["holdSeconds"] == 9000
    assert result["hold_seconds"] == 9000
    assert "including 2h 30m on hold" in result["message"]

    from domains.call_phone_number.config import CALL_HOLD_PROVIDER, CALL_PROVIDER
    from domains.call_phone_number.service import compute_service_usage

    usage = compute_service_usage(result["duration"], result["hold_seconds"])
    assert [item["provider"] for item in usage] == [CALL_PROVIDER, CALL_HOLD_PROVIDER]
    # 6 assistant minutes at 5c + 150 hold minutes at 2c, vs 780c if the hold billed as Vapi time.
    assert usage[0]["cost_cents"] == 30
    assert usage[1]["cost_cents"] == 300


def test_compute_service_usage_without_hold_is_unchanged():
    from domains.call_phone_number.service import compute_service_usage

    assert compute_service_usage(120) == compute_service_usage(120, 0)
    assert len(compute_service_usage(120, 0)) == 1


async def test_simulated_phone_result_persists_terminal_event():
    """DB-polling callers receive the exact simulated tool completion once."""
    from domains.call_phone_number import handler
    from helpers.world_model_runtime import WorldModelToolExecutionAdapter
    from helpers.messages import post_agent_message

    body = "Call reached voicemail. No live response or new route. Do not redial."
    agent_id = "00000000-0000-0000-0000-000000000001"
    user_id = "00000000-0000-0000-0000-000000000002"
    call_id = "call_simulated_completion_control"
    arguments = {"to": "+12025550123", "system_prompt": "Record the actual call outcome.",
                 "output_schema": {"call_outcome": "", "next_step": ""}}
    for mode, is_error in [("real", False), ("shadow", False),
                           ("simulate", False), ("simulate", True)]:
        posted = []

        class RecordedClient:
            async def step(self, *unused):
                return {"content": body, "is_error": is_error}

        adapter = WorldModelToolExecutionAdapter(
            mode="simulate", client=RecordedClient(), world_model_name="control",
            session_id="control-session", agent_id=agent_id, timestamp_ms=1000,
        )

        async def execute_activity(fn, *, args, **unused):
            if fn.__name__ == "call_phone_number_activity":
                if mode != "simulate":
                    return {"success": True, "message": body, "duration": 120}
                return await handler.call_phone_number_activity(*args)
            if fn is post_agent_message:
                posted.append(args)
            return None

        with patch.object(handler.WorldModelToolExecutionAdapter, "from_env", return_value=adapter):
            result = await handler.CallPhoneNumberManager().execute_tool(
                execute_activity=execute_activity, tool_call=arguments, tool_call_id=call_id,
                agent_id=agent_id, user_id=user_id, world_model_mode=mode,
            )
        terminal = [row for row in posted if row[3].get("toolStatus") in {"FINISHED", "ERROR"}]
        if mode != "simulate":
            assert not terminal, "Real/shadow activity already owns completion; do not duplicate it"
            continue
        assert len(terminal) == 1, "Persist exactly one completion for the DB-polling caller"
        assert terminal[0][1] == body
        assert terminal[0][3]["toolCallId"] == call_id
        assert terminal[0][3]["toolName"] == "call_phone_number"
        assert terminal[0][3]["toolStatus"] == ("ERROR" if is_error else "FINISHED")
        assert result["message"] == body
        assert result["success"] is (not is_error)
        assert "recordingUrl" not in terminal[0][3]["phoneCall"]


async def run_all_tests():
    print("call-phone-number blackbox tests:")
    r = BlackboxResult()
    await r.record_async("initiation_boundary", test_initiation_boundary)
    await r.record_async("poll_boundary", test_poll_boundary)
    await r.record_async("poll_read_timeout_retries_and_completes", test_poll_read_timeout_retries_and_completes)
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
    r.record(
        "enrich_transcript_with_dtmf_marks_keypresses_inline",
        test_enrich_transcript_with_dtmf_marks_keypresses_inline,
    )
    r.record(
        "enrich_transcript_with_dtmf_noop_without_keypresses",
        test_enrich_transcript_with_dtmf_noop_without_keypresses,
    )
    r.record("calculate_duration_from_timestamps_valid", test_calculate_duration_from_timestamps_valid)
    r.record("calculate_duration_from_timestamps_missing", test_calculate_duration_from_timestamps_missing)
    r.record("calculate_duration_from_timestamps_invalid", test_calculate_duration_from_timestamps_invalid)
    r.record("manager_get_approval_question", test_manager_get_approval_question)
    r.record("manager_get_approval_question_defaults", test_manager_get_approval_question_defaults)
    r.record("poll_interval_backs_off_after_long_hold", test_poll_interval_backs_off_after_long_hold)
    await r.record_async("manager_execute_tool_success", test_manager_execute_tool_success)
    await r.record_async("simulated_phone_result_persists_terminal_event", test_simulated_phone_result_persists_terminal_event)
    await r.record_async(
        "manager_execute_tool_uses_idempotent_retry_policy",
        test_manager_execute_tool_uses_idempotent_retry_policy,
    )
    await r.record_async("manager_execute_tool_error", test_manager_execute_tool_error)
    await r.record_async("call_phone_number_entry_point", test_call_phone_number_entry_point)
    await r.record_async(
        "wait_for_human_hold_updates_card_and_cost",
        test_wait_for_human_hold_updates_card_and_cost,
    )
    r.record("compute_service_usage_without_hold_is_unchanged", test_compute_service_usage_without_hold_is_unchanged)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
