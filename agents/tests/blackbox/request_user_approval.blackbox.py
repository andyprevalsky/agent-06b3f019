"""Blackbox tests for request-user-approval domain."""

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
    setup_mock(
        {
            "/api/attention-requests": {
                "status": 200,
                "json": {"id": "req-abc123", "status": "pending"},
            },
        }
    )


async def test_create_approval_happy_path():
    """create_approval_request_activity returns the request ID."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.request_user_approval import create_approval_request_activity

        result = await create_approval_request_activity(
            user_id="user-42",
            agent_id="agent-1",
            workflow_id="wf-123",
            question="Do you approve sending this email?",
        )

    assert result == "req-abc123"


async def test_create_approval_boundary():
    """Verify exact HTTP request sent to backend attention-requests endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.request_user_approval import create_approval_request_activity

        await create_approval_request_activity(
            user_id="user-99",
            agent_id="agent-2",
            workflow_id="wf-456",
            question="Approve this action?",
            image_url="https://example.com/screenshot.png",
            metadata={"writePermission": True},
        )

    call = assert_captured_call(
        url_contains="/api/attention-requests",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["userId"] == "user-99"
    assert body["agentId"] == "agent-2"
    assert body["workflowId"] == "wf-456"
    assert body["question"] == "Approve this action?"
    assert body["imageUrl"] == "https://example.com/screenshot.png"
    assert body["metadata"]["writePermission"] is True
    headers = {key.lower(): value for key, value in call["requestHeaders"].items()}
    assert headers.get("x-api-key")
    assert headers.get("x-user-id") == body["userId"]


async def test_create_approval_minimal_params():
    """Activity works with only required params (no image_url or metadata)."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.request_user_approval import create_approval_request_activity

        result = await create_approval_request_activity(
            user_id="user-1",
            agent_id="agent-1",
            workflow_id="wf-1",
            question="Proceed?",
        )

    assert result == "req-abc123"
    call = assert_captured_call(url_contains="/api/attention-requests", method="POST")
    body = json.loads(call["requestBody"])
    assert "imageUrl" not in body
    assert "metadata" not in body


async def test_resolve_attention_request_boundary():
    """resolve_attention_request_activity marks an existing attention request answered."""
    setup_mock(
        {
            "/api/attention-requests/req-setup/respond": {
                "status": 200,
                "json": {"success": True, "request_id": "req-setup"},
            },
        }
    )
    with patch("temporalio.activity.heartbeat"):
        from tools.request_user_approval import resolve_attention_request_activity

        result = await resolve_attention_request_activity(
            "user-123",
            "req-setup",
            "AgentCard setup completed.",
        )

    assert result["success"] is True
    assert result["request_id"] == "req-setup"
    call = assert_captured_call(
        url_contains="/api/attention-requests/req-setup/respond",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    headers = {k.lower(): v for k, v in call["requestHeaders"].items()}
    assert body["response"] == "AgentCard setup completed."
    assert headers["x-user-id"] == "user-123"


async def test_user_rejected_error_defaults():
    """UserRejectedError has default rejection message of empty string."""
    from domains.request_user_approval.types import UserRejectedError

    e = UserRejectedError()
    assert e.rejection_message == ""
    assert "rejected" in str(e).lower()


async def test_user_rejected_error_custom():
    """UserRejectedError carries rejection_message."""
    from domains.request_user_approval.types import UserRejectedError

    e = UserRejectedError("no way", rejection_message="too expensive")
    assert e.rejection_message == "too expensive"


async def test_manager_singleton():
    """get_manager returns same instance each call."""
    from domains.request_user_approval.service import get_manager

    a = get_manager()
    b = get_manager()
    assert a is b


# ── RequestUserApprovalManager.execute_tool paths ──────────────────


class _FakeWFModule:
    """Stand-in for temporalio.workflow used by service."""

    def __init__(self, activity_results=None, wait_condition_sets_context=None):
        self._activity_results = activity_results or {}
        self._wait_sets_context = wait_condition_sets_context  # callable to mutate wf
        self.logger = type("L", (), {"info": lambda *a, **kw: None, "error": lambda *a, **kw: None})()
        self.activity_calls = []

    def info(self):
        return type("I", (), {"workflow_id": "wf-123"})()

    def now(self):
        from datetime import datetime, timezone

        return getattr(self, "_now", None) or datetime(2026, 10, 3, tzinfo=timezone.utc)

    def uuid4(self):
        return "tool-call-uuid"

    async def execute_activity(self, fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "?")
        if name == "notify_sms_event_activity":
            from datetime import timedelta

            assert kwargs["start_to_close_timeout"] >= timedelta(seconds=300)
        self.activity_calls.append({"name": name, "args": args or [], "kwargs": kwargs})
        if name in self._activity_results:
            value = self._activity_results[name]
            if isinstance(value, Exception):
                raise value
            if callable(value):
                return value()
            return value
        raise KeyError(f"No fake result for activity: {name}")

    async def wait_condition(self, predicate, timeout=None):
        if self._wait_sets_context is not None:
            self._wait_sets_context()
        return


def _patch_service_workflow(fake):
    import domains.request_user_approval.service as s

    original = s.workflow
    s.workflow = fake

    def restore():
        s.workflow = original

    return restore


class _WFInstance:
    def __init__(self, user_id="user-1", agent_id="agent-1", *, context=None):
        self.user_id = user_id
        self.agent_id = agent_id
        self.context = context if context is not None else []
        self._signal_responses = {}
        self.parent_workflow_id = None
        self.agent_source = "WEB"
        self.handled_events = []

    async def _handle_tool_event(self, event, tool_call_id, tool_name):
        self.handled_events.append((event, tool_call_id, tool_name))

    async def _poll_messages(self, since):
        return None


async def _collect(gen):
    out = []
    async for e in gen:
        out.append(e)
    return out


async def test_manager_missing_question_yields_error():
    """Empty question yields ERROR event."""
    from domains.request_user_approval.service import RequestUserApprovalManager
    from tools.base import MessageStatus

    manager = RequestUserApprovalManager()
    events = await _collect(
        manager.execute_tool(
            workflow_instance=_WFInstance(),
            tool_call={"question": ""},
            tool_call_id="tc-e",
        )
    )
    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR


async def test_manager_happy_path_yields_pre_and_post_events():
    """execute_tool yields IN_PROGRESS then FINISHED when user responds."""
    from domains.request_user_approval.service import RequestUserApprovalManager
    from tools.base import MessageStatus

    wf = _WFInstance()

    def append_user_message():
        wf.context.append({"role": "USER", "text": "Approved!"})

    fake = _FakeWFModule(
        activity_results={"create_approval_request_activity": "req-abc"},
        wait_condition_sets_context=append_user_message,
    )
    restore = _patch_service_workflow(fake)
    try:
        events = await _collect(
            RequestUserApprovalManager().execute_tool(
                workflow_instance=wf,
                tool_call={"question": "Approve?", "image_url": "http://x/y.png", "metadata": {"k": "v"}},
                tool_call_id="tc-ok",
            )
        )
    finally:
        restore()

    statuses = [e.status for e in events]
    assert MessageStatus.IN_PROGRESS in statuses
    assert MessageStatus.FINISHED in statuses
    # Metadata from the attention request should be propagated to the pre-event
    pre = next(e for e in events if e.status == MessageStatus.IN_PROGRESS)
    assert pre.metadata is not None
    assert "requestUserApproval" in pre.metadata
    assert pre.metadata["requestUserApproval"]["attentionRequestId"] == "req-abc"
    post = next(e for e in events if e.status == MessageStatus.FINISHED)
    assert "Approval request:" in post.message
    assert "Approve?" in post.message
    assert "User response:" in post.message
    assert "Approved!" in post.message


async def test_manager_create_request_failure_yields_error():
    """If create_approval_request_activity raises, ERROR is yielded."""
    from domains.request_user_approval.service import RequestUserApprovalManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(activity_results={"create_approval_request_activity": RuntimeError("db down")})
    restore = _patch_service_workflow(fake)
    try:
        events = await _collect(
            RequestUserApprovalManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={"question": "Approve?", "metadata": {"k": "v"}},
                tool_call_id="tc-fail",
            )
        )
    finally:
        restore()

    assert any(e.status == MessageStatus.ERROR for e in events)
    # Metadata is preserved on error
    err = next(e for e in events if e.status == MessageStatus.ERROR)
    assert err.metadata is not None


async def test_manager_multiple_user_messages_collected():
    """Manager reads back all consecutive USER messages as response."""
    from domains.request_user_approval.service import RequestUserApprovalManager

    wf = _WFInstance()

    def append_user_messages():
        wf.context.append({"role": "USER", "text": "part 1"})
        wf.context.append({"role": "USER", "text": "part 2"})

    fake = _FakeWFModule(
        activity_results={"create_approval_request_activity": "req-xy"},
        wait_condition_sets_context=append_user_messages,
    )
    restore = _patch_service_workflow(fake)
    try:
        events = await _collect(
            RequestUserApprovalManager().execute_tool(
                workflow_instance=wf,
                tool_call={"question": "OK?"},
                tool_call_id="tc-multi",
            )
        )
    finally:
        restore()

    assert len(events) == 2  # IN_PROGRESS + FINISHED


# ── request_user_approval_direct helper tests ──────────────────────


async def test_direct_rejection_raises_user_rejected():
    """If _signal_responses holds REJECTION_SENTINEL, raises UserRejectedError."""
    from domains.request_user_approval.config import REJECTION_SENTINEL
    from domains.request_user_approval.service import request_user_approval_direct
    from domains.request_user_approval.types import UserRejectedError

    wf = _WFInstance()

    def populate():
        # Signal arrives (rejection) and user rejection text appended to context
        wf._signal_responses["req-z"] = REJECTION_SENTINEL
        wf.context.append({"role": "USER", "text": "way too expensive"})

    fake = _FakeWFModule(
        activity_results={"create_approval_request_activity": "req-z"},
        wait_condition_sets_context=populate,
    )
    restore = _patch_service_workflow(fake)
    try:
        raised = False
        try:
            await request_user_approval_direct(
                workflow_instance=wf,
                question="OK?",
                image_url=None,
                metadata=None,
            )
        except UserRejectedError as e:
            raised = True
            assert "way too expensive" in e.rejection_message
        assert raised
    finally:
        restore()


async def test_direct_approval_returns_response_text():
    """Approval text comes from the request-scoped signal, as it does in production."""
    from domains.request_user_approval.service import request_user_approval_direct

    wf = _WFInstance()
    wf._signal_responses["req-q"] = "its 1:45pm local time"

    fake = _FakeWFModule(
        activity_results={"create_approval_request_activity": "req-q"},
    )
    restore = _patch_service_workflow(fake)
    try:
        result = await request_user_approval_direct(
            workflow_instance=wf,
            question="Send?",
            metadata={"foo": "bar"},
        )
    finally:
        restore()

    assert result["response"] == "its 1:45pm local time"
    assert result["question"] == "Send?"
    assert result["attention_request_id"] == "req-q"
    post = next(ev for ev, _, _ in wf.handled_events if ev.status.name == "FINISHED")
    assert "Approval request:" in post.message
    assert "Send?" in post.message
    assert "User response:" in post.message
    assert "its 1:45pm local time" in post.message


async def test_direct_approval_ignores_unscoped_trailing_messages():
    """Approval always consumes the exact request-scoped signal response."""
    from domains.request_user_approval.service import request_user_approval_direct

    wf = _WFInstance()
    wf._signal_responses["req-legacy"] = "ok"
    wf.context.append({"role": "USER", "text": "Go ahead"})
    fake = _FakeWFModule(activity_results={"create_approval_request_activity": "req-legacy"})
    restore = _patch_service_workflow(fake)
    try:
        result = await request_user_approval_direct(
            workflow_instance=wf,
            question="Send?",
            metadata={"foo": "bar"},
        )
    finally:
        restore()

    assert result["response"] == "ok"


async def test_direct_generation_handoff_stashes_request_without_resolving():
    """Cooperative cutover must keep the original attn_id, not fence the row.

    DEPLOY_INTERRUPTED on the row is the dead-generation fence. A live
    continue_as_new has to re-wait that same id so SMS approve still works.
    """
    from helpers.generation_handoff import DEPLOY_INTERRUPTED_TOOL_MESSAGE, GenerationHandoffRequested
    from domains.request_user_approval.service import request_user_approval_direct
    from tools.base import MessageStatus

    wf = _WFInstance()

    async def _handoff_queue():
        return "navi-agent-tasks-live"

    wf._check_generation_handoff = _handoff_queue

    fake = _FakeWFModule(
        activity_results={
            "create_approval_request_activity": "req-stale-prod",
            "notify_sms_event_activity": None,
        },
    )
    restore = _patch_service_workflow(fake)
    raised = False
    try:
        try:
            await request_user_approval_direct(
                workflow_instance=wf,
                question="Make a phone call to +1 (415) 800-8345?",
                metadata={"toolApproval": True},
            )
        except GenerationHandoffRequested as exc:
            raised = True
            assert exc.task_queue == "navi-agent-tasks-live"
    finally:
        restore()

    assert raised is True
    resolve_calls = [c for c in fake.activity_calls if c["name"] == "resolve_attention_request_activity"]
    assert not resolve_calls, "live continue_as_new must not fence the approval row"
    assert wf._pending_approval_resume == {
        "request_id": "req-stale-prod",
        "question": "Make a phone call to +1 (415) 800-8345?",
    }
    finished = [ev for ev, _, _ in wf.handled_events if ev.status == MessageStatus.FINISHED]
    assert finished
    assert finished[-1].message == DEPLOY_INTERRUPTED_TOOL_MESSAGE


async def test_direct_retry_after_handoff_reuses_request_and_consumes_late_signal():
    """After continue_as_new, retry the tool against the original attn_id.

    Prod agent 262669d8 created cmuq98lzx after cutover; SMS approved
    cmuq8f9bo and the live wait ignored it. A late signal on the original
    id must complete the resumed wait without creating a second row.
    """
    from helpers.generation_handoff import GenerationHandoffRequested
    from domains.request_user_approval.service import request_user_approval_direct

    wf = _WFInstance()

    async def _handoff_queue():
        return "navi-agent-tasks-live"

    wf._check_generation_handoff = _handoff_queue
    create_ids = ["req-stale-prod", "req-new-must-not-be-created"]
    fake = _FakeWFModule(
        activity_results={
            "create_approval_request_activity": lambda: create_ids.pop(0),
            "notify_sms_event_activity": None,
        },
    )
    restore = _patch_service_workflow(fake)
    try:
        try:
            await request_user_approval_direct(
                workflow_instance=wf,
                question="Make a phone call to +1 (415) 800-8345?",
                metadata={"toolApproval": True},
            )
        except GenerationHandoffRequested:
            pass

        # Late SMS approve of the original id, then the replacement run retries.
        wf._check_generation_handoff = None
        wf._signal_responses["req-stale-prod"] = "Approved. Go ahead and make the call."
        result = await request_user_approval_direct(
            workflow_instance=wf,
            question="Make a phone call to +1 (415) 800-8345?",
            metadata={"toolApproval": True},
        )
    finally:
        restore()

    create_calls = [c for c in fake.activity_calls if c["name"] == "create_approval_request_activity"]
    assert len(create_calls) == 1
    assert result["attention_request_id"] == "req-stale-prod"
    assert result["response"] == "Approved. Go ahead and make the call."
    assert wf._pending_approval_resume is None


async def test_pending_approval_request_to_resume_reads_interrupted_chip():
    from domains.request_user_approval.service import pending_approval_request_to_resume
    from helpers.generation_handoff import DEPLOY_INTERRUPTED_TOOL_MESSAGE

    assert (
        pending_approval_request_to_resume(
            [
                {
                    "role": "TOOL",
                    "text": DEPLOY_INTERRUPTED_TOOL_MESSAGE,
                    "metadata": {
                        "toolStatus": "FINISHED",
                        "requestUserApproval": {"attentionRequestId": "cmuq8f9bo"},
                    },
                }
            ]
        )
        == "cmuq8f9bo"
    )
    assert (
        pending_approval_request_to_resume(
            [
                {
                    "role": "TOOL",
                    "text": DEPLOY_INTERRUPTED_TOOL_MESSAGE,
                    "metadata": {
                        "toolStatus": "FINISHED",
                        "requestUserApproval": {"attentionRequestId": "cmuq8f9bo"},
                    },
                },
                {
                    "role": "TOOL",
                    "text": "Approval request:\ncall\n\nUser response:\nApproved",
                    "metadata": {
                        "toolStatus": "FINISHED",
                        "requestUserApproval": {"attentionRequestId": "cmuq8f9bo"},
                    },
                },
            ]
        )
        is None
    )


async def test_sibling_approvals_match_question_and_do_not_steal_id():
    """Two parked waits reuse only the matching question; a third action is new."""
    from domains.request_user_approval.service import (
        request_user_approval_direct,
        stash_pending_approvals_from_context,
    )

    wf = _WFInstance()
    wf.context = [
        {
            "role": "TOOL",
            "text": "Call the restaurant?",
            "metadata": {
                "toolStatus": "IN_PROGRESS",
                "attentionMessage": "Call the restaurant?",
                "requestUserApproval": {"attentionRequestId": "attn-call"},
            },
        },
        {
            "role": "TOOL",
            "text": "Send the email?",
            "metadata": {
                "toolStatus": "IN_PROGRESS",
                "attentionMessage": "Send the email?",
                "requestUserApproval": {"attentionRequestId": "attn-email"},
            },
        },
    ]
    stash_pending_approvals_from_context(wf)
    assert wf._pending_approval_resume == {
        "requests": [
            {"request_id": "attn-call", "question": "Call the restaurant?"},
            {"request_id": "attn-email", "question": "Send the email?"},
        ]
    }

    create_ids = ["attn-new-must-not", "attn-stolen-must-not"]
    fake = _FakeWFModule(
        activity_results={
            "create_approval_request_activity": lambda: create_ids.pop(0),
            "notify_sms_event_activity": None,
        },
    )
    restore = _patch_service_workflow(fake)
    try:
        wf._signal_responses["attn-email"] = "Approved. Send it."
        email = await request_user_approval_direct(
            workflow_instance=wf,
            question="Send the email?",
        )
        wf._signal_responses["attn-new-must-not"] = "Approved. Book a hotel."
        hotel = await request_user_approval_direct(
            workflow_instance=wf,
            question="Book a hotel?",
        )
    finally:
        restore()

    create_calls = [c for c in fake.activity_calls if c["name"] == "create_approval_request_activity"]
    assert email["attention_request_id"] == "attn-email"
    assert hotel["attention_request_id"] == "attn-new-must-not"
    assert len(create_calls) == 1
    assert wf._pending_approval_resume == {
        "request_id": "attn-call",
        "question": "Call the restaurant?",
    }


async def test_manager_generation_handoff_stashes_request_without_resolving():
    """LLM-facing execute_tool handoff must stash the same attn_id for reuse."""
    from helpers.generation_handoff import DEPLOY_INTERRUPTED_TOOL_MESSAGE, GenerationHandoffRequested
    from domains.request_user_approval.service import RequestUserApprovalManager
    from tools.base import MessageStatus

    wf = _WFInstance()

    async def _handoff_queue():
        return "navi-agent-tasks-live"

    wf._check_generation_handoff = _handoff_queue

    fake = _FakeWFModule(
        activity_results={
            "create_approval_request_activity": "req-mgr-stale",
        },
    )
    restore = _patch_service_workflow(fake)
    manager = RequestUserApprovalManager()
    events = []
    raised = False
    try:
        try:
            async for event in manager.execute_tool(
                workflow_instance=wf,
                tool_call={"question": "Approve sending this email?"},
                tool_call_id="tc-handoff",
            ):
                events.append(event)
        except GenerationHandoffRequested:
            raised = True
    finally:
        restore()

    assert raised is True
    resolve_calls = [c for c in fake.activity_calls if c["name"] == "resolve_attention_request_activity"]
    assert not resolve_calls
    assert wf._pending_approval_resume == {
        "request_id": "req-mgr-stale",
        "question": "Approve sending this email?",
    }
    finished = [e for e in events if e.status == MessageStatus.FINISHED]
    assert finished
    assert finished[-1].message == DEPLOY_INTERRUPTED_TOOL_MESSAGE


async def test_direct_create_failure_propagates():
    """Create-request failure posts error event and re-raises."""
    from domains.request_user_approval.service import request_user_approval_direct

    fake = _FakeWFModule(activity_results={"create_approval_request_activity": RuntimeError("db error")})
    restore = _patch_service_workflow(fake)

    wf = _WFInstance()
    raised = False
    try:
        try:
            await request_user_approval_direct(
                workflow_instance=wf,
                question="q",
                metadata={"k": "v"},
            )
        except RuntimeError:
            raised = True
    finally:
        restore()

    assert raised is True
    # The error event should have been posted
    assert any("Failed to create approval" in (ev.title or "") for ev, _, _ in wf.handled_events)


async def test_direct_sms_source_attempts_sms_notify():
    """SMS-source root agent also fires notify_sms_event_activity."""
    from domains.request_user_approval.service import request_user_approval_direct

    wf = _WFInstance()
    wf.agent_source = "SMS"
    wf.parent_workflow_id = None
    wf._signal_responses["req-s"] = "ok"
    wf.context.append({"role": "USER", "text": "Yes"})

    activity_calls = []

    async def fake_notify():
        activity_calls.append("notify")

    fake = _FakeWFModule(
        activity_results={
            "create_approval_request_activity": "req-s",
            "notify_sms_event_activity": lambda: activity_calls.append("notify") or None,
        },
    )
    restore = _patch_service_workflow(fake)
    try:
        await request_user_approval_direct(
            workflow_instance=wf,
            question="q",
            metadata={"writeLockNotification": {"action": "Buy item"}},
        )
    finally:
        restore()

    assert "notify" in activity_calls
    notify_call = next(c for c in fake.activity_calls if c["name"] == "notify_sms_event_activity")
    payload = notify_call["args"][3]
    assert payload["metadata"]["writeLockNotification"]["action"] == "Buy item"


async def test_direct_web_source_also_fires_sms_notify():
    """Root agents of ANY source (here WEB) fire the write_lock SMS so FE-created
    purchase agents also reach the user. Previously gated to SMS-source only."""
    from domains.request_user_approval.service import request_user_approval_direct

    wf = _WFInstance()
    wf.agent_source = "WEB"
    wf.parent_workflow_id = None
    wf._signal_responses["req-web"] = "ok"
    wf.context.append({"role": "USER", "text": "Yes"})

    activity_calls = []

    fake = _FakeWFModule(
        activity_results={
            "create_approval_request_activity": "req-web",
            "notify_sms_event_activity": lambda: activity_calls.append("notify") or None,
        },
    )
    restore = _patch_service_workflow(fake)
    try:
        await request_user_approval_direct(
            workflow_instance=wf,
            question="Approve a $56.24 purchase?",
            metadata={"requestPaymentCard": {"merchant": "Nopa Fish"}},
        )
    finally:
        restore()

    assert "notify" in activity_calls
    notify_call = next(c for c in fake.activity_calls if c["name"] == "notify_sms_event_activity")
    assert notify_call["args"][1] == "write_lock"


async def test_direct_subagent_fires_sms_notify():
    """Sub-agents that block on approval must fire write_lock SMS.

    agent_started stays root-only (per-spawn firehose at 10k agents), but a
    payment/write-lock approval is O(approvals) and the user otherwise never
    learns a child agent is waiting. Regression: Nopa Fish sub-agent
    cd03d03a… requested $28.51 approval with no SMS (root ef7e8089…).
    """
    from domains.request_user_approval.service import request_user_approval_direct

    wf = _WFInstance()
    wf.agent_source = "SMS"
    wf.parent_workflow_id = "parent-wf-1"
    wf._signal_responses["req-sub"] = "ok"
    wf.context.append({"role": "USER", "text": "Yes"})

    activity_calls = []

    fake = _FakeWFModule(
        activity_results={
            "create_approval_request_activity": "req-sub",
            "notify_sms_event_activity": lambda: activity_calls.append("notify") or None,
        },
    )
    restore = _patch_service_workflow(fake)
    try:
        await request_user_approval_direct(
            workflow_instance=wf,
            question="Approve a $28.51 purchase from Nopa Fish?",
            metadata={"requestPaymentCard": {"merchant": "Nopa Fish"}},
        )
    finally:
        restore()

    assert "notify" in activity_calls
    notify_call = next(c for c in fake.activity_calls if c["name"] == "notify_sms_event_activity")
    assert notify_call["args"][1] == "write_lock"
    assert notify_call["args"][2] == wf.agent_id


async def test_direct_attention_returns_without_waiting_and_emits_attention_metadata():
    """Non-blocking attention handoffs create a request and post an in-progress user attention event."""
    from domains.request_user_approval.service import request_user_attention_direct

    wf = _WFInstance()
    fake = _FakeWFModule(activity_results={"create_approval_request_activity": "req-setup"})
    restore = _patch_service_workflow(fake)
    try:
        result = await request_user_attention_direct(
            workflow_instance=wf,
            question="One Time Agent Payment Setup is required.\n\nOpen this setup link:\nhttps://rose.test/setup",
            title="One Time Agent Payment Setup",
            metadata={
                "attentionKind": "agentcard_user_connect_required",
                "agentCardSetup": {
                    "status": "connect_required",
                    "setupUrl": "https://rose.test/setup",
                },
            },
        )
    finally:
        restore()

    assert result["attention_request_id"] == "req-setup"
    assert len(wf.handled_events) == 1
    event, _tool_call_id, _tool_name = wf.handled_events[0]
    assert event.title == "One Time Agent Payment Setup"
    assert event.status.name == "IN_PROGRESS"
    assert event.metadata["isUserAttentionMessage"] is True
    assert event.metadata["attentionKind"] == "agentcard_user_connect_required"
    assert event.metadata["attentionRequestId"] == "req-setup"
    assert event.metadata["agentCardSetup"]["status"] == "connect_required"


async def test_direct_attention_sms_source_sends_agentcard_setup_notify():
    """AgentCard setup handoffs propagate through SMS for SMS-source root agents."""
    from domains.request_user_approval.service import request_user_attention_direct

    wf = _WFInstance()
    wf.agent_source = "SMS"
    wf.parent_workflow_id = None
    activity_calls = []

    fake = _FakeWFModule(
        activity_results={
            "create_approval_request_activity": "req-setup-sms",
            "notify_sms_event_activity": lambda: activity_calls.append("notify") or None,
        },
    )
    restore = _patch_service_workflow(fake)
    try:
        await request_user_attention_direct(
            workflow_instance=wf,
            question="One Time Agent Payment Setup is required.",
            title="One Time Agent Payment Setup",
            metadata={"attentionKind": "agentcard_user_connect_required"},
            sms_event_type="agentcard_setup",
            sms_payload={"setup_url": "https://rose.test/setup"},
        )
    finally:
        restore()

    assert "notify" in activity_calls
    notify_call = next(c for c in fake.activity_calls if c["name"] == "notify_sms_event_activity")
    assert notify_call["args"][1] == "agentcard_setup"
    payload = notify_call["args"][3]
    assert payload["attention_request_id"] == "req-setup-sms"
    assert payload["setup_url"] == "https://rose.test/setup"


async def test_direct_approval_does_not_send_reminder():
    """After the initial write_lock SMS, later waits must not send another SMS."""
    from datetime import datetime, timedelta, timezone

    from domains.request_user_approval.service import request_user_approval_direct

    wf = _WFInstance()
    notify_payloads = []

    class _WaitFake(_FakeWFModule):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._now = datetime(2026, 10, 3, tzinfo=timezone.utc)
            self._waits = 0

        def now(self):
            return self._now

        async def wait_condition(self, predicate, timeout=None):
            self._waits += 1
            if self._waits == 1:
                self._now = self._now + timedelta(minutes=16)
                raise TimeoutError("slice elapsed")
            wf._signal_responses["req-remind"] = "Approved"
            return

    fake = _WaitFake(
        activity_results={
            "create_approval_request_activity": "req-remind",
            "notify_sms_event_activity": lambda: notify_payloads.append("sent") or None,
        }
    )
    restore = _patch_service_workflow(fake)
    try:
        result = await request_user_approval_direct(
            workflow_instance=wf,
            question="Approve the purchase?",
        )
    finally:
        restore()

    notify_calls = [c for c in fake.activity_calls if c["name"] == "notify_sms_event_activity"]
    assert len(notify_calls) == 1
    assert notify_calls[0]["args"][3].get("reminder") is not True
    assert result["response"] == "Approved"
    assert fake._waits == 2


async def test_direct_approval_resume_does_not_notify_again():
    """A cutover that already notified must not SMS again."""
    from helpers.generation_handoff import GenerationHandoffRequested
    from domains.request_user_approval.service import request_user_approval_direct

    wf = _WFInstance()
    wf._pending_approval_resume = {
        "request_id": "req-reminded",
        "question": "Approve the purchase?",
    }
    wf._signal_responses["req-reminded"] = "Approved later"

    fake = _FakeWFModule(
        activity_results={
            "create_approval_request_activity": "req-must-not-create",
            "notify_sms_event_activity": None,
        }
    )
    restore = _patch_service_workflow(fake)
    try:
        result = await request_user_approval_direct(
            workflow_instance=wf,
            question="Approve the purchase?",
        )
    finally:
        restore()

    create_calls = [c for c in fake.activity_calls if c["name"] == "create_approval_request_activity"]
    notify_calls = [c for c in fake.activity_calls if c["name"] == "notify_sms_event_activity"]
    assert create_calls == []
    assert notify_calls == []
    assert result["attention_request_id"] == "req-reminded"
    assert result["response"] == "Approved later"
    assert not isinstance(result, GenerationHandoffRequested)


async def test_direct_approval_resume_request_does_not_notify_again():
    """Parked resume_request that already notified must not SMS again."""
    from domains.request_user_approval.service import request_user_approval_direct

    wf = _WFInstance()
    wf._signal_responses["req-parked"] = "Approved"

    fake = _FakeWFModule(
        activity_results={
            "create_approval_request_activity": "req-must-not-create",
            "notify_sms_event_activity": None,
        }
    )
    restore = _patch_service_workflow(fake)
    try:
        result = await request_user_approval_direct(
            workflow_instance=wf,
            question="Approve the purchase?",
            resume_request={
                "attention_request_id": "req-parked",
                "tool_call_id": "tool-parked",
            },
        )
    finally:
        restore()

    create_calls = [c for c in fake.activity_calls if c["name"] == "create_approval_request_activity"]
    notify_calls = [c for c in fake.activity_calls if c["name"] == "notify_sms_event_activity"]
    assert create_calls == []
    assert notify_calls == []
    assert result["attention_request_id"] == "req-parked"
    assert result["response"] == "Approved"


async def test_direct_subagent_attention_sms_sends_notify():
    """Sub-agent setup handoffs (login/card) must also SMS — same class as approval."""
    from domains.request_user_approval.service import request_user_attention_direct

    wf = _WFInstance()
    wf.agent_source = "SMS"
    wf.parent_workflow_id = "parent-wf-1"
    activity_calls = []

    fake = _FakeWFModule(
        activity_results={
            "create_approval_request_activity": "req-setup-sub",
            "notify_sms_event_activity": lambda: activity_calls.append("notify") or None,
        },
    )
    restore = _patch_service_workflow(fake)
    try:
        await request_user_attention_direct(
            workflow_instance=wf,
            question="One Time Agent Payment Setup is required.",
            title="One Time Agent Payment Setup",
            metadata={"attentionKind": "agentcard_user_connect_required"},
            sms_event_type="agentcard_setup",
            sms_payload={"setup_url": "https://rose.test/setup"},
        )
    finally:
        restore()

    assert "notify" in activity_calls
    notify_call = next(c for c in fake.activity_calls if c["name"] == "notify_sms_event_activity")
    assert notify_call["args"][1] == "agentcard_setup"


async def test_direct_cancel_preserves_unanswered_resume_only():
    """Canceled unanswered chips retain their row; consumed decisions never rearm."""
    from copy import deepcopy

    from domains.request_user_approval.config import REJECTION_SENTINEL
    from domains.request_user_approval.service import (
        request_user_approval_direct,
        stash_pending_approvals_from_context,
    )
    from tools.base import MessageStatus

    class PersistedWF(_WFInstance):
        def __init__(self, blocked_status):
            super().__init__()
            self.blocked_status = blocked_status
            self.persisted = asyncio.Event()
            self.blocked_once = False

        async def _handle_tool_event(self, event, tool_call_id, tool_name):
            await super()._handle_tool_event(deepcopy(event), tool_call_id, tool_name)
            self.context.append(
                {
                    "role": "TOOL",
                    "text": event.message,
                    "metadata": {
                        **(event.metadata or {}),
                        "toolStatus": event.status.name,
                    },
                }
            )
            if event.status == self.blocked_status and not self.blocked_once:
                self.blocked_once = True
                self.persisted.set()
                await asyncio.Event().wait()

    for decision in (None, "Approved", REJECTION_SENTINEL):
        request_id = "req-cancel-resume"
        question = "Approve the existing request?"
        wf = PersistedWF(MessageStatus.IN_PROGRESS if decision is None else MessageStatus.FINISHED)
        if decision is not None:
            wf._pending_approval_resume = {
                "request_id": request_id,
                "question": question,
            }
            wf._signal_responses[request_id] = decision
        fake = _FakeWFModule(
            activity_results={
                "create_approval_request_activity": request_id,
                "notify_sms_event_activity": None,
            }
        )
        restore = _patch_service_workflow(fake)
        task = asyncio.create_task(request_user_approval_direct(wf, question, close_on_cancel=True))
        try:
            await asyncio.wait_for(wf.persisted.wait(), timeout=10)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError("The original caller must remain canceled")
            stash_pending_approvals_from_context(wf)
            assert request_id not in wf._signal_responses
            assert not any(c["name"] == "resolve_attention_request_activity" for c in fake.activity_calls)
            if decision is None:
                assert getattr(wf, "_pending_approval_resume", None) == {
                    "request_id": request_id,
                    "question": question,
                }, "Canceled unanswered approval lost its original attention request"
                closed = wf.handled_events[-1][0]
                assert closed.title == "Approval interrupted"
                assert closed.metadata["excludeFromModel"] is True
                wf._signal_responses[request_id] = "Approved"
                resumed = await request_user_approval_direct(wf, question, close_on_cancel=True)
                assert resumed["attention_request_id"] == request_id
                assert resumed["response"] == "Approved"
                assert wf._pending_approval_resume is None
                assert sum(c["name"] == "create_approval_request_activity" for c in fake.activity_calls) == 1
                assert sum(c["name"] == "notify_sms_event_activity" for c in fake.activity_calls) == 1
            else:
                assert wf._pending_approval_resume is None, "Consumed decisions must never be re-stashed"
                terminal_events = [e for e, _, _ in wf.handled_events if e.status == MessageStatus.FINISHED]
                assert len(terminal_events) == 2
                assert terminal_events[0] == terminal_events[1]
                expected_title = (
                    "✗ User rejected action" if decision == REJECTION_SENTINEL else "✓ User approval received"
                )
                assert terminal_events[-1].title == expected_title
                assert not any(c["name"] == "create_approval_request_activity" for c in fake.activity_calls)
                assert not any(c["name"] == "notify_sms_event_activity" for c in fake.activity_calls)
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            restore()


async def run_all_tests():
    print("request-user-approval blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_create_approval_happy_path)
    await r.record_async("boundary", test_create_approval_boundary)
    await r.record_async("minimal_params", test_create_approval_minimal_params)
    await r.record_async("resolve_attention_boundary", test_resolve_attention_request_boundary)
    await r.record_async("user_rejected_defaults", test_user_rejected_error_defaults)
    await r.record_async("user_rejected_custom", test_user_rejected_error_custom)
    await r.record_async("manager_singleton", test_manager_singleton)
    await r.record_async("manager_missing_question", test_manager_missing_question_yields_error)
    await r.record_async("manager_happy", test_manager_happy_path_yields_pre_and_post_events)
    await r.record_async("manager_create_fail", test_manager_create_request_failure_yields_error)
    await r.record_async("manager_multi_user_msgs", test_manager_multiple_user_messages_collected)
    await r.record_async("direct_rejection", test_direct_rejection_raises_user_rejected)
    await r.record_async("direct_approval", test_direct_approval_returns_response_text)
    await r.record_async(
        "direct_approval_scoped_signal",
        test_direct_approval_ignores_unscoped_trailing_messages,
    )
    await r.record_async(
        "direct_handoff_stashes_request",
        test_direct_generation_handoff_stashes_request_without_resolving,
    )
    await r.record_async(
        "direct_retry_reuses_request",
        test_direct_retry_after_handoff_reuses_request_and_consumes_late_signal,
    )
    await r.record_async(
        "pending_approval_resume_scan",
        test_pending_approval_request_to_resume_reads_interrupted_chip,
    )
    await r.record_async(
        "manager_handoff_stashes_request",
        test_manager_generation_handoff_stashes_request_without_resolving,
    )
    await r.record_async(
        "sibling_approvals_match_question",
        test_sibling_approvals_match_question_and_do_not_steal_id,
    )
    await r.record_async("direct_create_fail", test_direct_create_failure_propagates)
    await r.record_async("direct_sms_notify", test_direct_sms_source_attempts_sms_notify)
    await r.record_async("direct_web_notify", test_direct_web_source_also_fires_sms_notify)
    await r.record_async("direct_subagent_notify", test_direct_subagent_fires_sms_notify)
    await r.record_async("direct_attention", test_direct_attention_returns_without_waiting_and_emits_attention_metadata)
    await r.record_async("direct_attention_sms", test_direct_attention_sms_source_sends_agentcard_setup_notify)
    await r.record_async(
        "direct_subagent_attention_sms",
        test_direct_subagent_attention_sms_sends_notify,
    )
    await r.record_async(
        "direct_cancel_preserves_unanswered_resume_only",
        test_direct_cancel_preserves_unanswered_resume_only,
    )
    await r.record_async(
        "direct_no_reminder",
        test_direct_approval_does_not_send_reminder,
    )
    await r.record_async(
        "direct_resume_no_notify",
        test_direct_approval_resume_does_not_notify_again,
    )
    await r.record_async(
        "direct_resume_request_no_notify",
        test_direct_approval_resume_request_does_not_notify_again,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
