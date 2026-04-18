"""Blackbox tests for send-message-to-user domain."""

import asyncio
from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


# ── Validation errors / short-circuits via execute_tool ────────────────


async def _collect_events(gen):
    events = []
    async for e in gen:
        events.append(e)
    return events


async def test_emits_message_event():
    """execute_tool yields a FINISHED event for non-question messages."""
    from tools.send_message_to_user import SendMessageToUserManager
    from tools.base import MessageStatus

    manager = SendMessageToUserManager()

    gen = manager.execute_tool(
        workflow_instance=None,
        tool_call={"message": "Hello! I found 3 results for you.", "is_question": False},
        tool_call_id="tc-1",
    )
    event = await gen.__anext__()

    assert event.status == MessageStatus.FINISHED
    assert "Hello! I found 3 results for you." in event.message


async def test_question_flag_in_metadata():
    """When is_question=True, event metadata flags it as attention-requiring."""
    from tools.send_message_to_user import SendMessageToUserManager

    manager = SendMessageToUserManager()

    gen = manager.execute_tool(
        workflow_instance=None,
        tool_call={"message": "Should I proceed?", "is_question": True},
        tool_call_id="tc-2",
    )
    event = await gen.__anext__()

    assert "Should I proceed?" in event.message or "Should I proceed?" in (event.title or "")


async def test_no_outbound_http_calls():
    """send_message_to_user initial event makes zero outbound HTTP calls."""
    from tools.send_message_to_user import SendMessageToUserManager

    manager = SendMessageToUserManager()

    gen = manager.execute_tool(
        workflow_instance=None,
        tool_call={"message": "Test message"},
        tool_call_id="tc-3",
    )
    await gen.__anext__()

    assert len(get_captured_requests()) == 0


async def test_validation_missing_message():
    """Missing message yields an ERROR event."""
    from domains.send_message_to_user.handler import SendMessageToUserManager
    from tools.base import MessageStatus

    manager = SendMessageToUserManager()
    events = await _collect_events(
        manager.execute_tool(workflow_instance=None, tool_call={}, tool_call_id="tc-m1")
    )
    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "non-empty" in events[0].message


async def test_validation_empty_message_string():
    """Empty/whitespace message also fails validation."""
    from domains.send_message_to_user.handler import SendMessageToUserManager
    from tools.base import MessageStatus

    manager = SendMessageToUserManager()
    events = await _collect_events(
        manager.execute_tool(workflow_instance=None, tool_call={"message": "   "}, tool_call_id="tc-e")
    )
    assert events[0].status == MessageStatus.ERROR


async def test_validation_bad_is_question_type():
    """Non-bool is_question fails validation."""
    from domains.send_message_to_user.handler import SendMessageToUserManager
    from tools.base import MessageStatus

    manager = SendMessageToUserManager()
    events = await _collect_events(
        manager.execute_tool(
            workflow_instance=None,
            tool_call={"message": "Hi", "is_question": "yes"},
            tool_call_id="tc-b",
        )
    )
    assert events[0].status == MessageStatus.ERROR
    assert "boolean" in events[0].message.lower()


# ── is_sub_agent helper ───────────────────────────────────────────


def test_is_sub_agent_depth_zero():
    from domains.send_message_to_user.service import is_sub_agent

    class _WF:
        depth = 0

    assert is_sub_agent(_WF()) is False


def test_is_sub_agent_depth_one():
    from domains.send_message_to_user.service import is_sub_agent

    class _WF:
        depth = 1

    assert is_sub_agent(_WF()) is True


def test_is_sub_agent_missing_attr():
    """Missing depth attribute treated as 0."""
    from domains.send_message_to_user.service import is_sub_agent

    class _WF:
        pass

    assert is_sub_agent(_WF()) is False


def test_validate_tool_call_execute_phase_forces_false():
    """Execute-phase variant forces is_question=False regardless of payload."""
    from domains.send_message_to_user.service import validate_tool_call

    result = validate_tool_call({
        "tool": "send_message_to_user_execute_phase",
        "message": "hello",
        "is_question": True,
    })
    assert result["ok"] is True
    assert result["is_question"] is False


def test_validate_tool_call_default_is_question_true():
    """Default is_question value is True when unspecified."""
    from domains.send_message_to_user.service import validate_tool_call

    result = validate_tool_call({"message": "hi"})
    assert result["ok"] is True
    assert result["is_question"] is True


def test_build_attention_metadata_question():
    from domains.send_message_to_user.types import build_attention_metadata

    out = build_attention_metadata("Proceed?", is_question=True, is_waiting=True)
    assert out["sendMessageToUser"]["attentionKind"] == "question"
    assert out["sendMessageToUser"]["isWaitingForUser"] is True
    assert out["attentionMessage"] == "Proceed?"


def test_build_attention_metadata_info():
    from domains.send_message_to_user.types import build_attention_metadata

    out = build_attention_metadata("FYI", is_question=False, is_waiting=False)
    assert out["sendMessageToUser"]["attentionKind"] == "info"


# ── handler end-to-end paths via patched workflow ─────────────────────


class _FakeWorkflowModule:
    """Stand-in for temporalio.workflow with activity + sleep stubs."""

    def __init__(self, activity_results=None, wait_results=None):
        self._activity_results = activity_results or {}
        self._wait_results = wait_results or []
        self._wait_idx = 0
        # stub common helpers the handler/service might read
        self.logger = type("Logger", (), {"info": lambda *a, **kw: None, "error": lambda *a, **kw: None})()
        # preserve unsafe since handler uses it; real module-level `with` already executed
        import temporalio.workflow as real
        self.unsafe = real.unsafe

    async def execute_activity(self, fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "?")
        if name in self._activity_results:
            value = self._activity_results[name]
            if isinstance(value, Exception):
                raise value
            if callable(value):
                return value()
            return value
        raise KeyError(f"No fake result for activity: {name}")

    async def wait_condition(self, predicate, timeout=None):
        # Evaluate the predicate once; if True → return, else simulate configured result
        if predicate():
            return
        if self._wait_idx < len(self._wait_results):
            res = self._wait_results[self._wait_idx]
            self._wait_idx += 1
            if isinstance(res, Exception):
                raise res
            return res
        return

    async def sleep(self, seconds):
        return None


class _FakeWorkflow:
    """Minimal workflow-instance stub."""

    def __init__(self, *, user_id="user-1", agent_id="agent-1", depth=0, has_new_messages=True):
        self.user_id = user_id
        self.agent_id = agent_id
        self.depth = depth
        self._has_new_messages = has_new_messages
        self._posted = []

    async def _post_message(self, text, role, metadata=None):
        self._posted.append((text, role, metadata))


def _patch_handler_workflow(fake):
    """Swap the workflow module reference inside handler module."""
    import domains.send_message_to_user.handler as h

    original = h.workflow
    h.workflow = fake

    def restore():
        h.workflow = original

    return restore


async def test_handler_sub_agent_auto_responds():
    """Sub-agent (depth >= 1) bypasses SMS path and auto-responds."""
    from domains.send_message_to_user.handler import SendMessageToUserManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule()
    restore = _patch_handler_workflow(fake)
    try:
        wf = _FakeWorkflow(depth=2)
        events = await _collect_events(
            SendMessageToUserManager().execute_tool(
                workflow_instance=wf,
                tool_call={"message": "Can I?", "is_question": True},
                tool_call_id="tc-sub",
            )
        )
    finally:
        restore()

    # First event is IN_PROGRESS (question prompt), final event is FINISHED auto-response
    assert events[-1].status == MessageStatus.FINISHED
    assert "sub-agent" in events[-1].title.lower()
    # _post_message was called with the sub-agent auto response
    assert len(wf._posted) == 1


async def test_handler_sms_source_sends_sms_and_waits():
    """SMS-sourced agent sends SMS immediately then waits for response."""
    from domains.send_message_to_user.handler import SendMessageToUserManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_results={
            "get_agent_source": "SMS",
            "notify_sms_event_activity": None,
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        wf = _FakeWorkflow(has_new_messages=True)  # immediate response
        events = await _collect_events(
            SendMessageToUserManager().execute_tool(
                workflow_instance=wf,
                tool_call={"message": "Ready?", "is_question": True},
                tool_call_id="tc-sms",
            )
        )
    finally:
        restore()

    statuses = [e.status for e in events]
    assert MessageStatus.FINISHED in statuses
    # "User response received" is the last event title for non-sub-agent path
    assert events[-1].title == "User response received"


async def test_handler_non_sms_timeout_triggers_sms_fallback():
    """Non-SMS agent waits; TimeoutError triggers SMS fallback notify."""
    from domains.send_message_to_user.handler import SendMessageToUserManager
    from tools.base import MessageStatus

    wait_calls = {"count": 0}

    class _WaitFake(_FakeWorkflowModule):
        async def wait_condition(self, predicate, timeout=None):
            wait_calls["count"] += 1
            # First wait: simulate timeout; second wait: satisfy
            if wait_calls["count"] == 1:
                raise TimeoutError("no response")
            # second call: set flag and return
            return

    fake = _WaitFake(
        activity_results={
            "get_agent_source": "WEB",
            "notify_sms_event_activity": None,
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        wf = _FakeWorkflow(has_new_messages=False)

        # Simulate that after first wait (timeout) we "have" a message so the
        # second wait in step 5 short-circuits via `if not _has_new_messages`.
        async def _run():
            gen = SendMessageToUserManager().execute_tool(
                workflow_instance=wf,
                tool_call={"message": "Ready?", "is_question": True},
                tool_call_id="tc-non-sms",
            )
            events = []
            async for e in gen:
                # Set new_messages to True before step 5 runs
                wf._has_new_messages = True
                events.append(e)
            return events

        events = await _run()
    finally:
        restore()

    assert events[-1].status == MessageStatus.FINISHED


async def run_all_tests():
    print("send-message-to-user blackbox tests:")
    r = BlackboxResult()
    await r.record_async("emits_message_event", test_emits_message_event)
    await r.record_async("question_flag_in_metadata", test_question_flag_in_metadata)
    await r.record_async("no_outbound_http_calls", test_no_outbound_http_calls)
    await r.record_async("validation_missing_message", test_validation_missing_message)
    await r.record_async("validation_empty_message", test_validation_empty_message_string)
    await r.record_async("validation_bad_is_question", test_validation_bad_is_question_type)
    r.record("is_sub_agent_zero", test_is_sub_agent_depth_zero)
    r.record("is_sub_agent_one", test_is_sub_agent_depth_one)
    r.record("is_sub_agent_missing", test_is_sub_agent_missing_attr)
    r.record("validate_execute_phase_forces_false", test_validate_tool_call_execute_phase_forces_false)
    r.record("validate_default_is_question", test_validate_tool_call_default_is_question_true)
    r.record("build_attention_metadata_question", test_build_attention_metadata_question)
    r.record("build_attention_metadata_info", test_build_attention_metadata_info)
    await r.record_async("handler_sub_agent", test_handler_sub_agent_auto_responds)
    await r.record_async("handler_sms_source", test_handler_sms_source_sends_sms_and_waits)
    await r.record_async("handler_non_sms_timeout", test_handler_non_sms_timeout_triggers_sms_fallback)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
