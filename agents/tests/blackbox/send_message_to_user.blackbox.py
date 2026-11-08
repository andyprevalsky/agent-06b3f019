"""Blackbox tests for send-message-to-user domain."""

import asyncio
from unittest.mock import patch
from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)

# Inline views are a Rose Desktop surface (utils.rose_desktop).
ROSE_DESKTOP_USER = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
STOCK_USER = "user-stock-3333"


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
    events = await _collect_events(manager.execute_tool(workflow_instance=None, tool_call={}, tool_call_id="tc-m1"))
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

    result = validate_tool_call(
        {
            "tool": "send_message_to_user_execute_phase",
            "message": "hello",
            "is_question": True,
        }
    )
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

    def now(self):
        from datetime import datetime, timezone

        return datetime.now(timezone.utc)

    async def execute_activity(self, fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "?")
        if name == "notify_sms_event_activity":
            from datetime import timedelta

            assert kwargs["start_to_close_timeout"] >= timedelta(seconds=300)
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
    # _post_message was called with the sub-agent auto response, which tells
    # the sub-agent how to ask its parent (the user never sees this question).
    assert len(wf._posted) == 1
    posted = str(wf._posted[0])
    assert 'send_message_to_agent(to="parent"' in posted and 'wait_for(agents=["parent"])' in posted, posted
    assert "Please do not ask me anymore questions" not in posted, posted


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
    from datetime import datetime, timedelta, timezone

    from domains.send_message_to_user.handler import SendMessageToUserManager
    from tools.base import MessageStatus

    wf = _FakeWorkflow(has_new_messages=False)
    activity_names: list[str] = []

    class _WaitFake(_FakeWorkflowModule):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._now = datetime(2026, 9, 29, tzinfo=timezone.utc)
            self._waits = 0

        def now(self):
            return self._now

        async def execute_activity(self, fn, args=None, **kwargs):
            activity_names.append(getattr(fn, "__name__", "?"))
            return await super().execute_activity(fn, args=args, **kwargs)

        async def wait_condition(self, predicate, timeout=None):
            self._waits += 1
            if self._waits == 1:
                # Advance past the 15m SMS fallback so the helper re-raises.
                self._now = self._now + timedelta(minutes=16)
                raise TimeoutError("no response")
            wf._has_new_messages = True
            return

    fake = _WaitFake(
        activity_results={
            "get_agent_source": "WEB",
            "notify_sms_event_activity": None,
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect_events(
            SendMessageToUserManager().execute_tool(
                workflow_instance=wf,
                tool_call={"message": "Ready?", "is_question": True},
                tool_call_id="tc-non-sms",
            )
        )
    finally:
        restore()

    assert events[-1].status == MessageStatus.FINISHED
    assert "notify_sms_event_activity" in activity_names


async def test_handler_non_sms_temporal_timeout_triggers_sms_fallback():
    """Temporal TimeoutError from wait_condition must still trigger SMS fallback."""
    from datetime import datetime, timedelta, timezone

    from domains.send_message_to_user.handler import SendMessageToUserManager
    from temporalio.exceptions import TimeoutError as TemporalTimeoutError
    from temporalio.exceptions import TimeoutType
    from tools.base import MessageStatus

    wf = _FakeWorkflow(has_new_messages=False)
    activity_names: list[str] = []

    class _WaitFake(_FakeWorkflowModule):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._now = datetime(2026, 9, 29, tzinfo=timezone.utc)
            self._waits = 0

        def now(self):
            return self._now

        async def execute_activity(self, fn, args=None, **kwargs):
            activity_names.append(getattr(fn, "__name__", "?"))
            return await super().execute_activity(fn, args=args, **kwargs)

        async def wait_condition(self, predicate, timeout=None):
            self._waits += 1
            if self._waits == 1:
                self._now = self._now + timedelta(minutes=16)
                raise TemporalTimeoutError(
                    "timed out",
                    type=TimeoutType.START_TO_CLOSE,
                    last_heartbeat_details=(),
                )
            wf._has_new_messages = True
            return

    fake = _WaitFake(
        activity_results={
            "get_agent_source": "WEB",
            "notify_sms_event_activity": None,
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect_events(
            SendMessageToUserManager().execute_tool(
                workflow_instance=wf,
                tool_call={"message": "Ready?", "is_question": True},
                tool_call_id="tc-temporal-timeout",
            )
        )
    finally:
        restore()

    assert events[-1].status == MessageStatus.FINISHED
    assert "notify_sms_event_activity" in activity_names


async def test_handler_non_sms_fallback_handoff_closes_finished_and_reraises():
    """Cutover during the 15m SMS-fallback park must FINISH, not leave the chip open."""
    from domains.send_message_to_user.handler import SendMessageToUserManager
    from helpers.generation_handoff import DEPLOY_INTERRUPTED_TOOL_MESSAGE, GenerationHandoffRequested
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_results={
            "get_agent_source": "WEB",
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        wf = _FakeWorkflow(has_new_messages=False)

        async def _check_generation_handoff():
            return "navi-agent-tasks@new"

        wf._check_generation_handoff = _check_generation_handoff
        events = []
        raised = None
        try:
            async for event in SendMessageToUserManager().execute_tool(
                workflow_instance=wf,
                tool_call={"message": "Ready?", "is_question": True},
                tool_call_id="tc-handoff-fallback",
            ):
                events.append(event)
        except GenerationHandoffRequested as exc:
            raised = exc
    finally:
        restore()

    assert raised is not None
    assert raised.task_queue == "navi-agent-tasks@new"
    assert all(e.status != MessageStatus.ERROR for e in events)
    finished = [e for e in events if e.status == MessageStatus.FINISHED]
    assert finished
    assert finished[-1].message == DEPLOY_INTERRUPTED_TOOL_MESSAGE


# ── inline_view (rose_user_ui) ─────────────────────────────────────


class _RecordingWorkflowModule(_FakeWorkflowModule):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.calls = []

    async def execute_activity(self, fn, args=None, **kwargs):
        self.calls.append((getattr(fn, "__name__", "?"), list(args or [])))
        return await super().execute_activity(fn, args=args, **kwargs)


async def test_inline_view_pinned_to_active_version_in_metadata():
    """inline_view resolves against the ACTIVE version and persists as metadata.inlineView."""
    from domains.send_message_to_user.handler import SendMessageToUserManager
    from tools.base import MessageStatus

    fake = _RecordingWorkflowModule(
        activity_results={"resolve_user_ui_inline_view_activity": {"ok": True, "version_id": "ver-123"}}
    )
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect_events(
            SendMessageToUserManager().execute_tool(
                workflow_instance=_FakeWorkflow(user_id=ROSE_DESKTOP_USER),
                tool_call={
                    "message": "Here is your chart.",
                    "is_question": False,
                    "inline_view": {"view": "sales-chart", "props": {"points": [1, 2, 3]}},
                },
                tool_call_id="tc-inline",
            )
        )
    finally:
        restore()

    assert fake.calls == [("resolve_user_ui_inline_view_activity", [ROSE_DESKTOP_USER, "sales-chart"])]
    assert len(events) == 1 and events[0].status == MessageStatus.FINISHED
    assert events[0].message == "Here is your chart."
    assert events[0].metadata["inlineView"] == {
        "view": "sales-chart",
        "versionId": "ver-123",
        "props": {"points": [1, 2, 3]},
    }


async def test_inline_view_question_keeps_pin_on_every_event():
    """Blocking questions keep the same pinned inlineView through the reply cycle."""
    from domains.send_message_to_user.handler import SendMessageToUserManager

    fake = _RecordingWorkflowModule(
        activity_results={
            "resolve_user_ui_inline_view_activity": {"ok": True, "version_id": "ver-9"},
            "get_agent_source": "WEB",
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect_events(
            SendMessageToUserManager().execute_tool(
                workflow_instance=_FakeWorkflow(user_id=ROSE_DESKTOP_USER, has_new_messages=True),
                tool_call={"message": "Pick one?", "is_question": True, "inline_view": {"view": "picker"}},
                tool_call_id="tc-inline-q",
            )
        )
    finally:
        restore()

    assert len(events) >= 2
    for event in events:
        assert event.metadata["inlineView"] == {"view": "picker", "versionId": "ver-9", "props": {}}


async def test_inline_view_unknown_view_is_tool_error():
    """A view missing from the active manifest is rejected as tool error text, not an exception."""
    from domains.send_message_to_user.handler import SendMessageToUserManager
    from tools.base import MessageStatus

    fake = _RecordingWorkflowModule(
        activity_results={
            "resolve_user_ui_inline_view_activity": {
                "ok": False,
                "error": "Inline view 'nope' is not in the user's published Rose UI (available: hello).",
            }
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect_events(
            SendMessageToUserManager().execute_tool(
                workflow_instance=_FakeWorkflow(user_id=ROSE_DESKTOP_USER),
                tool_call={"message": "Look", "is_question": False, "inline_view": {"view": "nope"}},
                tool_call_id="tc-inline-bad",
            )
        )
    finally:
        restore()

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "not in the user's published Rose UI" in events[0].message
    assert "inlineView" not in (events[0].metadata or {})


async def test_inline_view_activity_failure_is_tool_error():
    """Exhausted activity retries surface as a tool error instead of crashing the workflow."""
    from domains.send_message_to_user.handler import SendMessageToUserManager
    from tools.base import MessageStatus

    fake = _RecordingWorkflowModule(
        activity_results={"resolve_user_ui_inline_view_activity": RuntimeError("backend down")}
    )
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect_events(
            SendMessageToUserManager().execute_tool(
                workflow_instance=_FakeWorkflow(user_id=ROSE_DESKTOP_USER),
                tool_call={"message": "Look", "is_question": False, "inline_view": {"view": "hello"}},
                tool_call_id="tc-inline-down",
            )
        )
    finally:
        restore()

    assert len(events) == 1 and events[0].status == MessageStatus.ERROR
    assert "backend down" in events[0].message


async def test_inline_view_invalid_shape_rejected_without_lookup():
    """Malformed inline_view arguments never reach the backend."""
    from domains.send_message_to_user.handler import SendMessageToUserManager
    from tools.base import MessageStatus

    for bad in ("hello", {"view": "Bad View"}, {"view": "ok", "props": [1]}, {"view": "ok", "props": {"x": "y" * 70000}}):
        fake = _RecordingWorkflowModule()
        restore = _patch_handler_workflow(fake)
        try:
            events = await _collect_events(
                SendMessageToUserManager().execute_tool(
                    workflow_instance=_FakeWorkflow(user_id=ROSE_DESKTOP_USER),
                    tool_call={"message": "Look", "is_question": False, "inline_view": bad},
                    tool_call_id="tc-inline-shape",
                )
            )
        finally:
            restore()
        assert fake.calls == [], bad
        assert len(events) == 1 and events[0].status == MessageStatus.ERROR, bad


async def test_resolve_inline_view_activity_against_backend():
    """The activity reads the ACTIVE manifest as the user and rejects unknown views / no UI."""
    from _test_utils import setup_mock

    from helpers.user_ui_activities import resolve_user_ui_inline_view_activity

    manifest = {"version": 1, "inline": {"hello": {"entry": "inline/hello/index.html"}}}
    setup_mock({"/api/user-ui/active": {"status": 200, "json": {"versionId": "ver-1", "manifest": manifest}}})
    try:
        ok = await resolve_user_ui_inline_view_activity("user-77", "hello")
        assert ok == {"ok": True, "version_id": "ver-1"}
        call = get_captured_requests()[-1]
        headers = {k.lower(): v for k, v in call["requestHeaders"].items()}
        assert headers.get("x-user-id") == "user-77"
        assert "x-api-key" in headers
        missing = await resolve_user_ui_inline_view_activity("user-77", "nope")
        assert missing["ok"] is False and "available: hello" in missing["error"]
    finally:
        teardown_mock()

    setup_mock({"/api/user-ui/active": {"status": 200, "json": {"versionId": None}}})
    try:
        none = await resolve_user_ui_inline_view_activity("user-77", "hello")
        assert none["ok"] is False and "no published Rose UI" in none["error"]
    finally:
        teardown_mock()


def test_tool_schemas_expose_inline_view():
    """Rose Desktop send_message_to_user variants declare the optional inline_view; stock ones do not."""
    from utils.tool_schemas import (
        SendMessageToUserExecutePhaseRoseDesktopTool,
        SendMessageToUserExecutePhaseTool,
        SendMessageToUserRoseDesktopTool,
        SendMessageToUserTool,
        get_tool_models,
    )

    for model in (SendMessageToUserRoseDesktopTool, SendMessageToUserExecutePhaseRoseDesktopTool):
        schema = model.model_json_schema()
        assert "inline_view" in schema["properties"]
        assert "inline_view" not in schema.get("required", [])
    parsed = SendMessageToUserRoseDesktopTool.model_validate(
        {"tool": "send_message_to_user", "message": "hi", "inline_view": {"view": "hello", "props": {"a": 1}}}
    )
    assert parsed.inline_view is not None and parsed.inline_view.view == "hello"

    flagged = get_tool_models(rose_desktop=True)
    assert flagged["send_message_to_user"] is SendMessageToUserRoseDesktopTool
    assert flagged["send_message_to_user_execute_phase"] is SendMessageToUserExecutePhaseRoseDesktopTool
    for model in (SendMessageToUserTool, SendMessageToUserExecutePhaseTool):
        assert "inline_view" not in model.model_json_schema()["properties"]
    # A stock parse drops an unadvertised inline_view, so the handler never sees it.
    stock = SendMessageToUserTool.model_validate(
        {"tool": "send_message_to_user", "message": "hi", "inline_view": {"view": "hello"}}
    )
    assert "inline_view" not in stock.model_dump()


@patch("utils.rose_desktop.ROSE_DESKTOP_ENABLED_BY_DEFAULT", False)
async def test_inline_view_ignored_for_stock_account():
    """A stock account's message posts exactly as before: no lookup, no inlineView, no error."""
    from domains.send_message_to_user.handler import SendMessageToUserManager
    from tools.base import MessageStatus

    fake = _RecordingWorkflowModule(
        activity_results={"resolve_user_ui_inline_view_activity": {"ok": True, "version_id": "ver-123"}}
    )
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect_events(
            SendMessageToUserManager().execute_tool(
                workflow_instance=_FakeWorkflow(user_id=STOCK_USER),
                tool_call={"message": "Here is your chart.", "is_question": False, "inline_view": {"view": "chart"}},
                tool_call_id="tc-inline-stock",
            )
        )
    finally:
        restore()

    assert fake.calls == [], "no rose_user_ui lookup for a stock account"
    assert len(events) == 1 and events[0].status == MessageStatus.FINISHED
    assert "inlineView" not in (events[0].metadata or {})


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
    await r.record_async(
        "handler_non_sms_temporal_timeout",
        test_handler_non_sms_temporal_timeout_triggers_sms_fallback,
    )
    await r.record_async(
        "handler_non_sms_fallback_handoff",
        test_handler_non_sms_fallback_handoff_closes_finished_and_reraises,
    )
    await r.record_async("inline_view_pinned_metadata", test_inline_view_pinned_to_active_version_in_metadata)
    await r.record_async("inline_view_question_pin", test_inline_view_question_keeps_pin_on_every_event)
    await r.record_async("inline_view_unknown_view", test_inline_view_unknown_view_is_tool_error)
    await r.record_async("inline_view_activity_failure", test_inline_view_activity_failure_is_tool_error)
    await r.record_async("inline_view_invalid_shape", test_inline_view_invalid_shape_rejected_without_lookup)
    await r.record_async("inline_view_activity_backend", test_resolve_inline_view_activity_against_backend)
    r.record("inline_view_tool_schema", test_tool_schemas_expose_inline_view)
    await r.record_async("inline_view_ignored_for_stock_account", test_inline_view_ignored_for_stock_account)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
