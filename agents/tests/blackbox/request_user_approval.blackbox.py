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
    setup_mock({
        "/api/attention-requests": {
            "status": 200,
            "json": {"id": "req-abc123", "status": "pending"},
        },
    })


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
    setup_mock({
        "/api/attention-requests/req-setup/respond": {
            "status": 200,
            "json": {"success": True, "request_id": "req-setup"},
        },
    })
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

    def __init__(self, activity_results=None, wait_condition_sets_context=None, patched=True):
        self._activity_results = activity_results or {}
        self._wait_sets_context = wait_condition_sets_context  # callable to mutate wf
        self._patched = patched
        self.logger = type("L", (), {"info": lambda *a, **kw: None, "error": lambda *a, **kw: None})()
        self.activity_calls = []

    def info(self):
        return type("I", (), {"workflow_id": "wf-123"})()

    def uuid4(self):
        return "tool-call-uuid"

    def patched(self, patch_id):
        return self._patched

    async def execute_activity(self, fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "?")
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

    fake = _FakeWFModule(
        activity_results={"create_approval_request_activity": RuntimeError("db down")}
    )
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


async def test_direct_approval_replays_legacy_message_poll_path():
    """Pre-patch workflow histories retain their original poll activity sequence."""
    from domains.request_user_approval.service import request_user_approval_direct

    wf = _WFInstance()
    wf._signal_responses["req-legacy"] = "ok"
    wf.context.append({"role": "USER", "text": "Go ahead"})
    fake = _FakeWFModule(
        activity_results={"create_approval_request_activity": "req-legacy"},
        patched=False,
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

    assert result["response"] == "Go ahead"


async def test_direct_create_failure_propagates():
    """Create-request failure posts error event and re-raises."""
    from domains.request_user_approval.service import request_user_approval_direct

    fake = _FakeWFModule(
        activity_results={"create_approval_request_activity": RuntimeError("db error")}
    )
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
    await r.record_async("direct_approval_legacy_replay", test_direct_approval_replays_legacy_message_poll_path)
    await r.record_async("direct_create_fail", test_direct_create_failure_propagates)
    await r.record_async("direct_sms_notify", test_direct_sms_source_attempts_sms_notify)
    await r.record_async("direct_attention", test_direct_attention_returns_without_waiting_and_emits_attention_metadata)
    await r.record_async("direct_attention_sms", test_direct_attention_sms_source_sends_agentcard_setup_notify)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
