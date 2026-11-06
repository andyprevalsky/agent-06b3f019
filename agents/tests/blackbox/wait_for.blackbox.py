"""Blackbox tests for wait-for domain."""

import asyncio
import contextlib
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


async def test_evaluate_condition_uses_llm_not_httpx():
    """evaluate_condition_activity calls LLM helper, not raw httpx."""
    with patch("temporalio.activity.heartbeat"):
        # call_llm is imported inside the function: from helpers.llm import call_llm
        with patch("helpers.llm.call_llm") as mock_llm:
            mock_llm.return_value = {
                "content": '{"satisfied": true, "reasoning": "Condition met"}',
                "usage": {"input_tokens": 50, "output_tokens": 30},
            }
            from tools.wait_for import evaluate_condition_activity

            result = await evaluate_condition_activity(
                condition="Has the deployment completed?",
                evidence="Deploy pipeline shows green status",
                model="rose-1-flash",
            )

    assert result["satisfied"] is True
    assert "reasoning" in result
    assert "response_model" not in mock_llm.call_args.kwargs
    # No raw httpx calls should be captured
    assert len(get_captured_requests()) == 0


async def test_no_outbound_http_calls():
    """evaluate_condition_activity makes zero httpx calls."""
    with patch("temporalio.activity.heartbeat"):
        with patch("helpers.llm.call_llm") as mock_llm:
            mock_llm.return_value = {
                "content": '{"satisfied": false, "reasoning": "Not yet"}',
                "usage": {"input_tokens": 40, "output_tokens": 25},
            }
            from tools.wait_for import evaluate_condition_activity

            await evaluate_condition_activity(
                condition="Test condition",
                evidence="Test evidence",
                model="rose-1-flash",
            )

    assert len(get_captured_requests()) == 0


async def test_evaluate_condition_negative():
    """Returns satisfied=False when LLM says so."""
    with (
        patch("temporalio.activity.heartbeat"),
        patch("helpers.llm.call_llm") as mock_llm,
    ):
        mock_llm.return_value = {
            "content": '{"satisfied": false, "reasoning": "Still loading"}',
            "usage": {"input_tokens": 10, "output_tokens": 5},
        }
        from tools.wait_for import evaluate_condition_activity

        result = await evaluate_condition_activity(
            condition="Is it done?",
            evidence="Spinner visible",
            model="rose-1-flash",
        )

    assert result["satisfied"] is False
    assert "Still loading" in result["reasoning"]


async def test_evaluate_condition_loose_json_fallback():
    """Invalid pydantic JSON falls back to loose json.loads parse."""
    with (
        patch("temporalio.activity.heartbeat"),
        patch("helpers.llm.call_llm") as mock_llm,
    ):
        # Missing required pydantic field, but raw JSON has satisfied+reasoning
        mock_llm.return_value = {
            "content": '{"satisfied": 1, "reasoning": "coerced truthy"}',
            "usage": {},
        }
        from tools.wait_for import evaluate_condition_activity

        result = await evaluate_condition_activity(
            condition="C",
            evidence="E",
            model="rose-1-flash",
        )
    assert result["satisfied"] is True
    assert "coerced" in result["reasoning"]


async def test_evaluate_condition_non_json_fallback():
    """Non-JSON content yields satisfied=False and preserves message."""
    with (
        patch("temporalio.activity.heartbeat"),
        patch("helpers.llm.call_llm") as mock_llm,
    ):
        mock_llm.return_value = {"content": "maybe later", "usage": {}}
        from tools.wait_for import evaluate_condition_activity

        result = await evaluate_condition_activity(
            condition="C",
            evidence="E",
            model="rose-1-flash",
        )
    assert result["satisfied"] is False
    assert "maybe later" in result["reasoning"]


async def test_evaluate_condition_accepts_prefixed_and_fenced_json():
    """Fallback providers may wrap otherwise valid JSON in harmless prose."""
    from tools.wait_for import evaluate_condition_activity

    responses = [
        'Here is the JSON requested: {"satisfied": true, "reasoning": "done"}',
        '```json\n{"satisfied": true, "reasoning": "also done"}\n```',
    ]
    for content in responses:
        with (
            patch("temporalio.activity.heartbeat"),
            patch("helpers.llm.call_llm") as mock_llm,
        ):
            mock_llm.return_value = {"content": content, "usage": {}}
            result = await evaluate_condition_activity(
                condition="C",
                evidence="E",
                model="rose-1-flash",
            )
        assert result["satisfied"] is True


# ── Pure helper coverage ──────────────────────────────────────────


def test_format_duration_seconds():
    """Seconds pluralization."""
    from tools.wait_for import format_duration

    assert format_duration(1) == "1 second"
    assert format_duration(45) == "45 seconds"


def test_format_duration_minutes_integer():
    """Exact minute boundary drops decimals."""
    from tools.wait_for import format_duration

    assert format_duration(60) == "1 minute"
    assert format_duration(120) == "2 minutes"


def test_format_duration_minutes_fractional():
    """Non-integer minutes keep one decimal."""
    from tools.wait_for import format_duration

    assert format_duration(90) == "1.5 minutes"


def test_format_duration_hours_integer():
    """Exact hour boundary drops decimals."""
    from tools.wait_for import format_duration

    assert format_duration(3600) == "1 hour"
    assert format_duration(7200) == "2 hours"


def test_format_duration_hours_fractional():
    """Fractional hours show decimal."""
    from tools.wait_for import format_duration

    assert format_duration(5400) == "1.5 hours"


def test_format_duration_days_integer():
    """Exact day boundary drops decimals."""
    from tools.wait_for import format_duration

    assert format_duration(86400) == "1 day"
    assert format_duration(172800) == "2 days"


def test_format_duration_days_fractional():
    """Fractional days show decimal."""
    from tools.wait_for import format_duration

    assert format_duration(86400 + 43200) == "1.5 days"


def test_cap_evidence_short():
    """Short evidence is returned unchanged."""
    from domains.wait_for.service import cap_evidence

    assert cap_evidence("hello") == "hello"


def test_cap_evidence_truncated():
    """Long evidence is truncated with a marker."""
    from domains.wait_for.config import EVIDENCE_CHAR_BUDGET
    from domains.wait_for.service import cap_evidence

    big = "x" * (EVIDENCE_CHAR_BUDGET + 10)
    result = cap_evidence(big)
    assert len(result) == EVIDENCE_CHAR_BUDGET + len("\n\n[...evidence truncated to fit context window]")
    assert result.endswith("context window]")


# ── WaitForManager handler tests ─────────────────────────────────


class _FakeWFModule:
    def __init__(self, activity_results=None, *, current_time=None):
        self._activity_results = activity_results or {}
        self.logger = type("L", (), {"info": lambda *a, **kw: None, "error": lambda *a, **kw: None})()
        self._current_time = current_time or datetime(2026, 4, 18, 12, 0, 0, tzinfo=timezone.utc)
        self.sleep_records = []
        self._uuid_index = 0

    def now(self):
        return self._current_time

    def uuid4(self):
        self._uuid_index += 1
        return uuid.UUID(int=self._uuid_index)

    async def execute_activity(self, fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "?")
        if name in self._activity_results:
            val = self._activity_results[name]
            if isinstance(val, Exception):
                raise val
            if callable(val):
                return val()
            return val
        raise KeyError(f"No fake result for {name}")

    async def sleep(self, seconds):
        self.sleep_records.append(seconds)

    async def wait_condition(self, predicate, timeout=None):
        """Deterministic stand-in: a slice either sees the predicate or times out (clock advances)."""
        if predicate():
            return
        seconds = timeout.total_seconds() if timeout is not None else 0
        on_slice = getattr(self, "on_slice", None)
        if on_slice is not None:
            on_slice(len(self.sleep_records))
            if predicate():
                return
        self.sleep_records.append(seconds)
        self._current_time = self._current_time + timedelta(seconds=seconds)
        raise asyncio.TimeoutError()


def _patch_handler_workflow(fake):
    import domains.wait_for.handler as h

    import importlib

    shared = importlib.import_module(h._wait_on_world_clock.__module__)
    original = h.workflow
    original_shared = shared.workflow
    h.workflow = fake
    shared.workflow = fake

    def restore():
        h.workflow = original
        shared.workflow = original_shared

    return restore


class _WFInstance:
    def __init__(
        self,
        *,
        paused=False,
        cost_limit_reached=False,
        fast_mode_cache_enabled=False,
        goal="",
        root_goal=None,
        context=None,
    ):
        self.user_id = "user-1"
        self.agent_id = "agent-1"
        self.model = "rose-1-flash"
        self.context_gates = {}
        self.is_paused = paused
        self._cost_limit_reached = cost_limit_reached
        self.fast_mode_cache_enabled = fast_mode_cache_enabled
        self.goal = goal
        self.demo_cache_goal = None
        self.root_goal = root_goal
        self.context = list(context or [])
        self.handled = []

    async def _handle_tool_event(self, event, tcid, tname):
        self.handled.append((event, tcid, tname))

    async def _check_parent_state(self):
        return None


async def _collect(gen):
    out = []
    async for e in gen:
        out.append(e)
    return out


async def test_handler_neither_timestamp_nor_condition_yields_error():
    """Missing both inputs -> ERROR."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    events = await _collect(
        WaitForManager().execute_tool(workflow_instance=_WFInstance(), tool_call={}, tool_call_id="tc")
    )
    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR


async def test_handler_condition_without_description_yields_error():
    """Condition mode rejects calls that cannot render concise display copy."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    events = await _collect(
        WaitForManager().execute_tool(
            workflow_instance=_WFInstance(),
            tool_call={"condition": "the deploy is ready"},
            tool_call_id="tc",
        )
    )
    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "description" in events[0].message


async def test_handler_condition_rejects_description_outside_schema_bounds():
    """Raw handler calls enforce the schema's 3-80 character display-copy bounds."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    for description in ("ab", "x" * 81):
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={"condition": "the deploy is ready", "description": description},
                tool_call_id="tc",
            )
        )
        assert len(events) == 1
        assert events[0].status == MessageStatus.ERROR
        assert "description" in events[0].message


async def test_handler_timestamp_invalid_format():
    """Invalid timestamp format -> ERROR."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule()
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={"until_timestamp": "not-a-ts"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()
    assert events[0].status == MessageStatus.ERROR


async def test_handler_timestamp_in_past():
    """Timestamp in past -> ERROR."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(current_time=datetime(2026, 12, 1, tzinfo=timezone.utc))
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={"until_timestamp": "2026-01-01T00:00:00Z"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()
    assert events[0].status == MessageStatus.ERROR
    assert "past" in events[0].message.lower()


async def test_handler_timestamp_too_far_future():
    """Over 31 days in future -> ERROR."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(current_time=datetime(2026, 1, 1, tzinfo=timezone.utc))
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={"until_timestamp": "2026-12-01T00:00:00Z"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()
    assert events[0].status == MessageStatus.ERROR
    assert "31 days" in events[0].message


async def test_handler_timestamp_happy_path():
    """Valid timestamp: yields IN_PROGRESS then FINISHED after sleep."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(current_time=datetime(2026, 4, 18, 12, 0, 0, tzinfo=timezone.utc))
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={"until_timestamp": "2026-04-18T12:05:00Z"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    statuses = [e.status for e in events]
    assert MessageStatus.IN_PROGRESS in statuses
    assert MessageStatus.FINISHED in statuses
    # Slept ~5 minutes (300 seconds), possibly sliced into 30s handoff polls
    assert sum(fake.sleep_records) == 300


async def test_handler_condition_paused_yields_error():
    """Condition mode with paused agent -> ERROR on first iteration."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(
        activity_results={
            "fetch_full_network_metadata": "",
            "fetch_local_data_summary": "",
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        wf = _WFInstance(paused=True)
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=wf,
                tool_call={
                    "description": "the task to finish",
                    "condition": "is it done?",
                    "check_interval_seconds": 30,
                    "max_checks": 3,
                },
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    errs = [e for e in events if e.status == MessageStatus.ERROR]
    assert any("paused" in (e.title or "").lower() for e in errs)


async def test_handler_condition_network_fetch_failure_tolerated():
    """When fetch_full_network_metadata raises, network_metadata is empty but flow continues."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(
        activity_results={
            "fetch_full_network_metadata": RuntimeError("nope"),
            "fetch_local_data_summary": RuntimeError("nope"),
        }
    )
    restore = _patch_handler_workflow(fake)
    try:
        wf = _WFInstance(paused=True)  # then short-circuit at pause check
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=wf,
                tool_call={
                    "description": "the condition to hold",
                    "condition": "c",
                    "check_interval_seconds": 30,
                    "max_checks": 1,
                },
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    assert any(e.status == MessageStatus.IN_PROGRESS for e in events)
    assert any(e.status == MessageStatus.ERROR for e in events)


async def test_handler_condition_gates_off_skip_fetch():
    """Workflow-level context_gates disable network + recent_communications fetches."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    # No fake results for network/local -- should NOT be called since gates disable them.
    fake = _FakeWFModule()
    restore = _patch_handler_workflow(fake)
    try:
        wf = _WFInstance(paused=True)  # abort early
        wf.context_gates = {"network": False, "recent_communications": False}
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=wf,
                tool_call={
                    "description": "the condition to hold",
                    "condition": "cond",
                    "check_interval_seconds": 30,
                    "max_checks": 1,
                },
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    assert any(e.status == MessageStatus.ERROR for e in events)


async def test_handler_condition_check_messages_carry_explore_task_id():
    """Every per-check wait_for message — including the re-establish IN_PROGRESS
    emitted between checks — must carry ``exploreTaskId``.

    The FE groups explore agents into their wait_for check by matching
    ``exploreTaskId`` on the *latest* message for each ``checkNum``
    (``buildWaitForChecks`` in deduplicateToolMessages.ts). The re-establish
    "Waiting for ..." message is emitted last for an unmet check, so if it lacks
    ``exploreTaskId`` the explore agent loses its association, never gets hidden,
    and renders as a separate top-level message. Regression guard for that bug.
    """
    from domains.wait_for.handler import WaitForManager
    from tools.base import EventType, MessageStatus, ToolEvent
    from tools.spawn_agent import SpawnAgentManager

    async def fake_spawn_explore(
        self,
        wf,
        tool_call,
        explore_tool_call_id,
        *,
        task_id=None,
        display_goal=None,
        capture_tool_results=None,
    ):
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Explore done",
            message="evidence",
            status=MessageStatus.FINISHED,
            metadata={"agentType": "explore", "taskId": task_id},
            data={"usage": {"llm": [], "service": []}},
        )

    # Not satisfied on check 1 (forces a re-establish), satisfied on check 2.
    calls = {"n": 0}

    def eval_result():
        calls["n"] += 1
        return (
            {"satisfied": False, "reasoning": "not yet"} if calls["n"] == 1 else {"satisfied": True, "reasoning": "met"}
        )

    fake = _FakeWFModule(activity_results={"evaluate_condition_activity": eval_result})
    restore = _patch_handler_workflow(fake)
    orig_spawn = SpawnAgentManager._spawn_explore
    SpawnAgentManager._spawn_explore = fake_spawn_explore
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={
                    "description": "the deploy to be ready",
                    "condition": "deploy ready",
                    "check_interval_seconds": 30,
                    "max_checks": 3,
                },
                tool_call_id="tc",
            )
        )
    finally:
        SpawnAgentManager._spawn_explore = orig_spawn
        restore()

    check_msgs = [e for e in events if e.metadata.get("checkNum") is not None]
    assert check_msgs, "expected per-check messages"
    assert all(e.metadata.get("description") == "the deploy to be ready" for e in check_msgs)
    missing = [e.title for e in check_msgs if not e.metadata.get("exploreTaskId")]
    assert not missing, f"per-check messages missing exploreTaskId: {missing}"

    # The specific message that regressed: the re-establish IN_PROGRESS after an
    # unmet check.
    reestablish = [
        e
        for e in events
        if e.status == MessageStatus.IN_PROGRESS
        and (e.title or "").startswith("Waiting for")
        and e.metadata.get("checkNum") is not None
    ]
    assert reestablish, "expected a re-establish IN_PROGRESS message after an unmet check"
    assert all(e.metadata.get("exploreTaskId") for e in reestablish)


async def test_handler_condition_raises_source_connect_gates_from_explore_error():
    """ERROR explore events with unavailable_sources still raise source_connect gates."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import EventType, MessageStatus, ToolEvent
    from tools.spawn_agent import SpawnAgentManager

    unavailable = [
        {
            "source": "email",
            "connector": "gmail",
            "connected": False,
            "connectUrl": "https://roselabs.ai/connect/gmail",
        }
    ]
    gate_calls = []

    async def fake_spawn_explore(
        self,
        wf,
        tool_call,
        explore_tool_call_id,
        *,
        task_id=None,
        display_goal=None,
        capture_tool_results=None,
    ):
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Explore failed",
            message="partial + failure",
            status=MessageStatus.ERROR,
            metadata={"agentType": "explore", "taskId": task_id},
            data={"unavailable_sources": unavailable},
        )

    async def fake_raise_gates(workflow_instance, sources):
        gate_calls.append(list(sources))

    fake = _FakeWFModule(
        activity_results={
            "evaluate_condition_activity": {"satisfied": True, "reasoning": "ok"},
        }
    )
    restore = _patch_handler_workflow(fake)
    orig_spawn = SpawnAgentManager._spawn_explore
    SpawnAgentManager._spawn_explore = fake_spawn_explore
    try:
        with patch(
            "domains.wait_for.handler.raise_source_connect_gates",
            new=fake_raise_gates,
        ):
            await _collect(
                WaitForManager().execute_tool(
                    workflow_instance=_WFInstance(),
                    tool_call={
                        "description": "the deploy to be ready",
                        "condition": "deploy ready",
                        "check_interval_seconds": 30,
                        "max_checks": 1,
                    },
                    tool_call_id="tc",
                )
            )
    finally:
        SpawnAgentManager._spawn_explore = orig_spawn
        restore()

    assert gate_calls == [unavailable]


async def test_handler_condition_skips_source_connect_gates_when_paused():
    """Paused workflows must not park on source_connect gates after explore."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import EventType, MessageStatus, ToolEvent
    from tools.spawn_agent import SpawnAgentManager

    unavailable = [
        {
            "source": "email",
            "connector": "gmail",
            "connected": False,
            "connectUrl": "https://roselabs.ai/connect/gmail",
        }
    ]
    gate_calls = []

    async def fake_spawn_explore(
        self,
        wf,
        tool_call,
        explore_tool_call_id,
        *,
        task_id=None,
        display_goal=None,
        capture_tool_results=None,
    ):
        # Explore finishes, then the parent is paused before gate raise.
        wf.is_paused = True
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Explore done",
            message="partial",
            status=MessageStatus.FINISHED,
            metadata={"agentType": "explore", "taskId": task_id},
            data={"unavailable_sources": unavailable, "usage": {"llm": [], "service": []}},
        )

    async def fake_raise_gates(workflow_instance, sources):
        gate_calls.append(list(sources))

    fake = _FakeWFModule()
    restore = _patch_handler_workflow(fake)
    orig_spawn = SpawnAgentManager._spawn_explore
    SpawnAgentManager._spawn_explore = fake_spawn_explore
    try:
        with patch(
            "domains.wait_for.handler.raise_source_connect_gates",
            new=fake_raise_gates,
        ):
            events = await _collect(
                WaitForManager().execute_tool(
                    workflow_instance=_WFInstance(),
                    tool_call={
                        "description": "the deploy to be ready",
                        "condition": "deploy ready",
                        "check_interval_seconds": 30,
                        "max_checks": 1,
                    },
                    tool_call_id="tc",
                )
            )
    finally:
        SpawnAgentManager._spawn_explore = orig_spawn
        restore()

    assert gate_calls == []
    assert any(
        e.status == MessageStatus.ERROR
        and ("paused" in (e.title or "").lower() or "pause" in (e.message or "").lower())
        for e in events
    )


# ── pending_timestamp_wait_to_resume (deploy-migration resume) ────


def _ts_msg(status, *, until=None, error_code=None, call_id="wf-1"):
    md = {"toolName": "wait_for", "waitForMode": "timestamp", "toolCallId": call_id, "toolStatus": status}
    if until is not None:
        md["untilTimestamp"] = until
    if error_code is not None:
        md["errorCode"] = error_code
    return {"role": "TOOL", "text": "", "metadata": md}


def test_resume_interrupted_future_wait_returns_target():
    """A deploy-interrupted wait with a future target is resumed from that target."""
    from domains.wait_for.service import pending_timestamp_wait_to_resume

    msgs = [
        _ts_msg("IN_PROGRESS", until="2026-08-03T17:00:00Z"),
        _ts_msg("FINISHED", until="2026-08-03T17:00:00Z", error_code="DEPLOY_INTERRUPTED"),
    ]
    assert pending_timestamp_wait_to_resume(msgs) == "2026-08-03T17:00:00Z"


def test_resume_interrupted_past_wait_returns_target():
    """An elapsed interrupted wait still returns its target (caller completes it)."""
    from domains.wait_for.service import pending_timestamp_wait_to_resume

    msgs = [
        _ts_msg("IN_PROGRESS", until="2026-08-03T09:00:00Z"),
        _ts_msg("FINISHED", until="2026-08-03T09:00:00Z", error_code="DEPLOY_INTERRUPTED"),
    ]
    assert pending_timestamp_wait_to_resume(msgs) == "2026-08-03T09:00:00Z"


def test_resume_completed_wait_returns_none():
    """A normally completed wait (Wait complete) is never resumed."""
    from domains.wait_for.service import pending_timestamp_wait_to_resume

    msgs = [
        _ts_msg("IN_PROGRESS", until="2026-08-03T17:00:00Z"),
        _ts_msg("FINISHED"),  # "Wait complete" carries waitForMode only, no errorCode
    ]
    assert pending_timestamp_wait_to_resume(msgs) is None


def test_resume_still_in_progress_returns_target():
    """An in-flight wait not yet finalized is resumable."""
    from domains.wait_for.service import pending_timestamp_wait_to_resume

    msgs = [_ts_msg("IN_PROGRESS", until="2026-08-03T17:00:00Z")]
    assert pending_timestamp_wait_to_resume(msgs) == "2026-08-03T17:00:00Z"


def test_resume_no_wait_returns_none():
    from domains.wait_for.service import pending_timestamp_wait_to_resume

    msgs = [{"role": "TOOL", "text": "", "metadata": {"toolName": "message_person", "toolStatus": "FINISHED"}}]
    assert pending_timestamp_wait_to_resume(msgs) is None


def test_resume_unparseable_target_returns_none():
    """A malformed target is skipped rather than crashing the resume path."""
    from domains.wait_for.service import pending_timestamp_wait_to_resume

    msgs = [_ts_msg("IN_PROGRESS", until="not-a-timestamp", error_code="DEPLOY_INTERRUPTED")]
    assert pending_timestamp_wait_to_resume(msgs) is None


def test_resume_tolerates_nondict_metadata():
    """A truthy non-dict metadata row must not abort the scan of later valid waits."""
    from domains.wait_for.service import pending_timestamp_wait_to_resume

    msgs = [
        {"role": "TOOL", "text": "", "metadata": "garbage-not-a-dict"},
        _ts_msg("IN_PROGRESS", until="2026-08-03T17:00:00Z", error_code="DEPLOY_INTERRUPTED"),
    ]
    assert pending_timestamp_wait_to_resume(msgs) == "2026-08-03T17:00:00Z"


def test_resume_latest_wait_wins():
    """An older completed wait is ignored; the newer interrupted wait resumes."""
    from domains.wait_for.service import pending_timestamp_wait_to_resume

    msgs = [
        _ts_msg("IN_PROGRESS", until="2026-08-03T08:00:00Z", call_id="wf-old"),
        _ts_msg("FINISHED", call_id="wf-old"),
        _ts_msg("IN_PROGRESS", until="2026-08-03T17:00:00Z", call_id="wf-new"),
        _ts_msg("FINISHED", until="2026-08-03T17:00:00Z", error_code="DEPLOY_INTERRUPTED", call_id="wf-new"),
    ]
    assert pending_timestamp_wait_to_resume(msgs) == "2026-08-03T17:00:00Z"


async def test_handler_timestamp_resume_past_completes_not_errors():
    """resume=True: an elapsed target yields FINISHED (completed), not an error."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(current_time=datetime(2026, 8, 3, 18, 0, 0, tzinfo=timezone.utc))
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={"until_timestamp": "2026-08-03T17:00:00Z", "resume": True},
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    statuses = [e.status for e in events]
    assert MessageStatus.FINISHED in statuses
    assert MessageStatus.ERROR not in statuses
    # No sleep for an already-elapsed target.
    assert fake.sleep_records == []


async def test_handler_timestamp_resume_nonbool_still_errors_in_past():
    """A truthy non-bool resume (e.g. the string 'false') must NOT bypass the past-error."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(current_time=datetime(2026, 8, 3, 18, 0, 0, tzinfo=timezone.utc))
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(),
                tool_call={"until_timestamp": "2026-08-03T17:00:00Z", "resume": "false"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    statuses = [e.status for e in events]
    assert MessageStatus.ERROR in statuses
    assert MessageStatus.FINISHED not in statuses


_OAI_DEMO_CHILD_GOAL = (
    "You are analyzing ONE creator for Andy Prevalsky. "
    "Research the last 90 days (approximately 2026-04-04 through 2026-07-03)."  # pragma: allowlist secret
)


async def test_handler_timestamp_live_fast_mode_past_still_errors():
    """Live Fast Mode must still reject past timestamps (demo-only bypass)."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(current_time=datetime(2026, 8, 27, 2, 0, 0, tzinfo=timezone.utc))
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(
                    fast_mode_cache_enabled=True,
                    goal="call Top Rent A Car and wait for their reply",
                ),
                tool_call={"until_timestamp": "2026-07-17T07:03:00+00:00"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    statuses = [e.status for e in events]
    assert MessageStatus.ERROR in statuses
    assert MessageStatus.FINISHED not in statuses
    assert "past" in events[0].message.lower()


async def test_handler_timestamp_live_fast_mode_far_future_still_errors():
    """Live Fast Mode must still enforce the 31-day wait cap."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(current_time=datetime(2026, 8, 27, 2, 0, 0, tzinfo=timezone.utc))
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(
                    fast_mode_cache_enabled=True,
                    goal="call Top Rent A Car and wait for their reply",
                ),
                tool_call={"until_timestamp": "2026-10-01T00:00:00+00:00"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    statuses = [e.status for e in events]
    assert MessageStatus.ERROR in statuses
    assert MessageStatus.FINISHED not in statuses
    assert "31 days" in events[0].message.lower()


async def test_handler_timestamp_live_fast_mode_still_sleeps_until_target():
    """Live Fast Mode must sleep until a legal future timestamp."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(current_time=datetime(2026, 8, 27, 2, 0, 0, tzinfo=timezone.utc))
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(
                    fast_mode_cache_enabled=True,
                    goal="call Top Rent A Car and wait for their reply",
                ),
                tool_call={"until_timestamp": "2026-08-27T02:05:00+00:00"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    statuses = [e.status for e in events]
    assert MessageStatus.FINISHED in statuses
    assert sum(fake.sleep_records) == 300, (
        f"live Fast Mode skipped timestamp sleep; sleep_records={fake.sleep_records!r}"
    )


async def test_handler_timestamp_fast_mode_past_completes_not_errors():
    """Fast Mode replay of a July wait_for must FINISH, not ERROR, once the target is past.

    The OAi demo recorded wait_until 2026-07-17…; replaying in August used to
    emit ``Timestamp … is in the past`` and leave children ACTIVE.
    """
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(current_time=datetime(2026, 8, 27, 2, 0, 0, tzinfo=timezone.utc))
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(
                    fast_mode_cache_enabled=True,
                    goal=_OAI_DEMO_CHILD_GOAL,
                ),
                tool_call={"until_timestamp": "2026-07-17T07:03:00+00:00"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    statuses = [e.status for e in events]
    assert MessageStatus.FINISHED in statuses
    assert MessageStatus.ERROR not in statuses
    assert fake.sleep_records == []
    assert "past" not in events[0].message.lower()


async def test_handler_timestamp_fast_mode_far_future_completes_not_errors():
    """Fast Mode replay of a July wait that is now >31d ahead must FINISH, not ERROR.

    A target that was a legal live wait in July (e.g. 2026-09-20 from 2026-07-17)
    is more than 31 days in the future when replayed in late August.
    """
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(current_time=datetime(2026, 8, 27, 2, 0, 0, tzinfo=timezone.utc))
    restore = _patch_handler_workflow(fake)
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(
                    fast_mode_cache_enabled=True,
                    goal=_OAI_DEMO_CHILD_GOAL,
                ),
                tool_call={"until_timestamp": "2026-10-01T00:00:00+00:00"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    statuses = [e.status for e in events]
    assert MessageStatus.FINISHED in statuses
    assert MessageStatus.ERROR not in statuses
    assert fake.sleep_records == []
    assert "31 days" not in events[0].message.lower()


async def test_handler_condition_live_fast_mode_honors_check_interval_sleep():
    """Live Fast Mode must sleep between wait_for condition checks.

    Agent 515c4894 (Top Rent email wait, interval=600s, max_checks=18) had
    fast_mode_cache_enabled=True. The handler skipped every inter-check sleep,
    so 15+ explores fired ~every 6s instead of every 10 minutes — burning the
    poll budget before any inbound reply could arrive. OAi-demo replay may skip
    wall-clock waits; live FM must not.
    """
    from domains.wait_for.handler import WaitForManager
    from tools.base import EventType, MessageStatus, ToolEvent
    from tools.spawn_agent import SpawnAgentManager

    evals = {"n": 0}

    async def fake_spawn_explore(
        self,
        wf,
        tool_call,
        explore_tool_call_id,
        *,
        task_id=None,
        display_goal=None,
        capture_tool_results=None,
    ):
        if capture_tool_results is not None:
            capture_tool_results.append("[grep] outbound only; no inbound reply yet")
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Explore done",
            message="no inbound reply",
            status=MessageStatus.FINISHED,
            metadata={"agentType": "explore", "taskId": task_id},
            data={"usage": {"llm": [], "service": []}},
        )

    def _eval(*_a, **_k):
        evals["n"] += 1
        # Fail check 1, pass check 2 — forces one inter-check sleep.
        if evals["n"] == 1:
            return {"satisfied": False, "reasoning": "no inbound reply"}
        return {"satisfied": True, "reasoning": "inbound reply arrived"}

    fake = _FakeWFModule(activity_results={"evaluate_condition_activity": _eval})
    restore = _patch_handler_workflow(fake)
    orig_spawn = SpawnAgentManager._spawn_explore
    SpawnAgentManager._spawn_explore = fake_spawn_explore
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(
                    fast_mode_cache_enabled=True,
                    goal=(
                        "call and do the following\n\nCALL BRIEF — Top Rent A Car "
                        "(Bulgaria)\n\nWHO TO CALL\n  Top Rent A Car"
                    ),
                ),
                tool_call={
                    "description": "Top Rent written booking confirmation",
                    "condition": (
                        "Check the connected mailbox for a new inbound email "
                        "from office@toprentacar.bg referencing reservation 060926801"
                    ),
                    "check_interval_seconds": 600,
                    "max_checks": 3,
                },
                tool_call_id="tc-live-fm-wait",
            )
        )
    finally:
        SpawnAgentManager._spawn_explore = orig_spawn
        restore()

    assert evals["n"] == 2
    assert sum(fake.sleep_records) == 600, (
        f"live Fast Mode skipped inter-check sleep; sleep_records={fake.sleep_records!r}"
    )
    finished = [e for e in events if e.status == MessageStatus.FINISHED]
    assert finished
    assert (finished[-1].data or {}).get("condition_met") is True


async def test_handler_condition_oai_demo_fast_mode_skips_inter_check_sleep():
    """DEMO prompt cache replay may skip wait_for inter-check wall-clock sleeps.

    The Fast Mode *button* is irrelevant — only the DEMO prompt match gates this.
    """
    from domains.wait_for.handler import WaitForManager
    from tools.base import EventType, MessageStatus, ToolEvent
    from tools.spawn_agent import SpawnAgentManager

    evals = {"n": 0}

    async def fake_spawn_explore(
        self,
        wf,
        tool_call,
        explore_tool_call_id,
        *,
        task_id=None,
        display_goal=None,
        capture_tool_results=None,
    ):
        if capture_tool_results is not None:
            capture_tool_results.append("[web_search] partial then enough")
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Explore done",
            message="evidence",
            status=MessageStatus.FINISHED,
            metadata={"agentType": "explore", "taskId": task_id},
            data={"usage": {"llm": [], "service": []}},
        )

    def _eval(*_a, **_k):
        evals["n"] += 1
        if evals["n"] == 1:
            return {"satisfied": False, "reasoning": "not yet"}
        return {"satisfied": True, "reasoning": "enough"}

    fake = _FakeWFModule(activity_results={"evaluate_condition_activity": _eval})
    restore = _patch_handler_workflow(fake)
    orig_spawn = SpawnAgentManager._spawn_explore
    SpawnAgentManager._spawn_explore = fake_spawn_explore
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(
                    # Button OFF — DEMO prompt alone must still skip sleeps.
                    fast_mode_cache_enabled=False,
                    goal=_OAI_DEMO_CHILD_GOAL,
                ),
                tool_call={
                    "description": "the research to finish",
                    "condition": "enough evidence gathered",
                    "check_interval_seconds": 600,
                    "max_checks": 3,
                },
                tool_call_id="tc-oai-skip-sleep",
            )
        )
    finally:
        SpawnAgentManager._spawn_explore = orig_spawn
        restore()

    assert evals["n"] == 2
    assert fake.sleep_records == []
    finished = [e for e in events if e.status == MessageStatus.FINISHED]
    assert finished
    assert (finished[-1].data or {}).get("condition_met") is True


_LEFTOVER_MASS_AGENT_CHILD_GOAL = (
    "Produce fresh tool-grounded evidence for the remaining strategic deliverables for Andy Prevalsky's brand task."
)


async def test_handler_condition_leftover_child_without_root_goal_honors_sleep():
    """A leftover GP goal is not the catalog prefix, so live waits still sleep."""
    from domains.spawn_agent.config import is_oai_demo_goal
    from domains.wait_for.handler import WaitForManager
    from tools.base import EventType, MessageStatus, ToolEvent
    from tools.spawn_agent import SpawnAgentManager

    assert not is_oai_demo_goal(_LEFTOVER_MASS_AGENT_CHILD_GOAL)
    evals = {"n": 0}

    async def fake_spawn_explore(
        self,
        wf,
        tool_call,
        explore_tool_call_id,
        *,
        task_id=None,
        display_goal=None,
        capture_tool_results=None,
    ):
        if capture_tool_results is not None:
            capture_tool_results.append("[web_search] partial then enough")
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Explore done",
            message="evidence",
            status=MessageStatus.FINISHED,
            metadata={"agentType": "explore", "taskId": task_id},
            data={"usage": {"llm": [], "service": []}},
        )

    def _eval(*_a, **_k):
        evals["n"] += 1
        if evals["n"] == 1:
            return {"satisfied": False, "reasoning": "not yet"}
        return {"satisfied": True, "reasoning": "enough"}

    fake = _FakeWFModule(activity_results={"evaluate_condition_activity": _eval})
    restore = _patch_handler_workflow(fake)
    orig_spawn = SpawnAgentManager._spawn_explore
    SpawnAgentManager._spawn_explore = fake_spawn_explore
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(
                    fast_mode_cache_enabled=True,
                    goal=_LEFTOVER_MASS_AGENT_CHILD_GOAL,
                ),
                tool_call={
                    "description": "the research to finish",
                    "condition": "enough evidence gathered",
                    "check_interval_seconds": 600,
                    "max_checks": 3,
                },
                tool_call_id="tc-leftover-sleeps",
            )
        )
    finally:
        SpawnAgentManager._spawn_explore = orig_spawn
        restore()

    assert evals["n"] == 2
    assert sum(fake.sleep_records) == 600, (
        f"leftover child skipped inter-check sleep; sleep_records={fake.sleep_records!r}"
    )
    finished = [e for e in events if e.status == MessageStatus.FINISHED]
    assert finished
    assert (finished[-1].data or {}).get("condition_met") is True


async def test_handler_condition_leftover_child_inherits_root_goal_skip_sleep():
    """Mass-agent leftover GPs inherit DEMO wait_for skips from the tree root."""
    from utils.oai_demo import OAI_DEMO_ROOT_GOAL_PREFIX
    from domains.wait_for.handler import WaitForManager
    from tools.base import EventType, MessageStatus, ToolEvent
    from tools.spawn_agent import SpawnAgentManager

    evals = {"n": 0}

    async def fake_spawn_explore(
        self,
        wf,
        tool_call,
        explore_tool_call_id,
        *,
        task_id=None,
        display_goal=None,
        capture_tool_results=None,
    ):
        if capture_tool_results is not None:
            capture_tool_results.append("[web_search] partial then enough")
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Explore done",
            message="evidence",
            status=MessageStatus.FINISHED,
            metadata={"agentType": "explore", "taskId": task_id},
            data={"usage": {"llm": [], "service": []}},
        )

    def _eval(*_a, **_k):
        evals["n"] += 1
        if evals["n"] == 1:
            return {"satisfied": False, "reasoning": "not yet"}
        return {"satisfied": True, "reasoning": "enough"}

    fake = _FakeWFModule(activity_results={"evaluate_condition_activity": _eval})
    restore = _patch_handler_workflow(fake)
    orig_spawn = SpawnAgentManager._spawn_explore
    SpawnAgentManager._spawn_explore = fake_spawn_explore
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(
                    fast_mode_cache_enabled=False,
                    goal=_LEFTOVER_MASS_AGENT_CHILD_GOAL,
                    root_goal=OAI_DEMO_ROOT_GOAL_PREFIX,
                ),
                tool_call={
                    "description": "the research to finish",
                    "condition": "enough evidence gathered",
                    "check_interval_seconds": 600,
                    "max_checks": 3,
                },
                tool_call_id="tc-leftover-root-skip",
            )
        )
    finally:
        SpawnAgentManager._spawn_explore = orig_spawn
        restore()

    assert evals["n"] == 2
    assert fake.sleep_records == []
    finished = [e for e in events if e.status == MessageStatus.FINISHED]
    assert finished
    assert (finished[-1].data or {}).get("condition_met") is True


async def test_handler_condition_oai_demo_fast_mode_awaits_explore():
    """OAi-demo Fast Mode wait_for captures + evaluates like live."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import EventType, MessageStatus, ToolEvent
    from tools.spawn_agent import SpawnAgentManager

    captured = {"capture": "unset", "evals": 0}

    async def fake_spawn_explore(
        self,
        wf,
        tool_call,
        explore_tool_call_id,
        *,
        task_id=None,
        display_goal=None,
        capture_tool_results=None,
    ):
        captured["capture"] = capture_tool_results
        if capture_tool_results is not None:
            capture_tool_results.append("[web_search] enough evidence")
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Explore done",
            message="Huberman cadence notes.",
            status=MessageStatus.FINISHED,
            metadata={"agentType": "explore", "taskId": task_id},
            data={"usage": {"llm": [], "service": []}},
        )

    def _eval_like_live(*_a, **_k):
        captured["evals"] += 1
        return {"satisfied": True, "reasoning": "enough evidence"}

    fake = _FakeWFModule(activity_results={"evaluate_condition_activity": _eval_like_live})
    restore = _patch_handler_workflow(fake)
    orig_spawn = SpawnAgentManager._spawn_explore
    SpawnAgentManager._spawn_explore = fake_spawn_explore
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=_WFInstance(
                    fast_mode_cache_enabled=True,
                    goal=_OAI_DEMO_CHILD_GOAL,
                ),
                tool_call={
                    "description": "the research to finish",
                    "condition": "enough evidence gathered",
                    "check_interval_seconds": 30,
                    "max_checks": 5,
                },
                tool_call_id="tc-oai-wait",
            )
        )
    finally:
        SpawnAgentManager._spawn_explore = orig_spawn
        restore()

    assert captured["capture"] is not None
    assert captured["capture"] == ["[web_search] enough evidence"]
    assert captured["evals"] == 1
    finished = [e for e in events if e.status == MessageStatus.FINISHED]
    assert finished
    assert (finished[-1].metadata or {}).get("fastModeParallel") is None
    assert (finished[-1].data or {}).get("condition_met") is True


async def test_handler_timestamp_simulate_mode_skips_wall_clock_and_advances_sim_clock():
    """World-model simulate: a timestamp wait skips the sleep and advances the logical clock.

    The WMH-served world does not change with wall-clock time, so sleeping is dead
    time. The skip must be recorded on the FINISHED event and a follow-up wait must
    be measured from the ADVANCED clock (1h after the first target = 1h more skip,
    not 25h).
    """
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(current_time=datetime(2026, 9, 8, 12, 0, 0, tzinfo=timezone.utc))
    restore = _patch_handler_workflow(fake)
    wf = _WFInstance(fast_mode_cache_enabled=False, goal="Raise me 5m dollars for my company Rose Labs")
    wf.world_model_mode = "simulate"
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=wf,
                tool_call={"until_timestamp": "2026-09-09T12:00:00+00:00"},
                tool_call_id="tc-sim-1",
            )
        )
        offset_after_first = wf.simulated_clock_offset_seconds
        events_2 = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=wf,
                tool_call={"until_timestamp": "2026-09-09T13:00:00+00:00"},
                tool_call_id="tc-sim-2",
            )
        )
    finally:
        restore()

    statuses = [e.status for e in events]
    assert MessageStatus.FINISHED in statuses
    assert MessageStatus.ERROR not in statuses
    assert fake.sleep_records == []
    finished = [e for e in events if e.status == MessageStatus.FINISHED][-1]
    assert finished.metadata["waitForMode"] == "timestamp"
    assert finished.metadata["simulatedTimeSkip"] is True
    assert finished.metadata["simulatedSkipSeconds"] == 86_400
    assert finished.metadata["simulatedClockOffsetSeconds"] == 86_400
    assert "simulated clock advanced" in finished.message
    assert offset_after_first == 86_400

    # Second wait: target is 1h past the already-skipped target → 1h skip, from the sim clock.
    finished_2 = [e for e in events_2 if e.status == MessageStatus.FINISHED][-1]
    assert MessageStatus.ERROR not in [e.status for e in events_2]
    assert finished_2.metadata["simulatedSkipSeconds"] == 3_600
    assert wf.simulated_clock_offset_seconds == 90_000
    assert fake.sleep_records == []


class _ClockFakeWFModule(_FakeWFModule):
    """Records shared world-clock waits and answers them at the requested time."""

    def __init__(self, *args, world_start, **kwargs):
        super().__init__(*args, **kwargs)
        self.world_time_ms = world_start
        self.clock_calls = []

    async def execute_activity(self, fn, args=None, **kwargs):
        if getattr(fn, "__name__", "") != "world_clock_activity":
            return await super().execute_activity(fn, args=args, **kwargs)
        operation, agent_id, _parent, wait = args
        self.clock_calls.append((operation, agent_id, dict(wait)))
        self.world_time_ms = (
            wait["until_ms"] if wait.get("until_ms") is not None else self.world_time_ms + wait["duration_ms"]
        )
        return {"resumed": True, "time_ms": self.world_time_ms, "deadline_ms": self.world_time_ms}


async def test_handler_timestamp_simulate_mode_waits_on_the_shared_world_clock():
    """The world clock decides when a simulated wait ends; this agent's view follows it."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    now = datetime(2026, 9, 8, 12, 0, 0, tzinfo=timezone.utc)
    fake = _ClockFakeWFModule(current_time=now, world_start=int(now.timestamp() * 1000))
    restore = _patch_handler_workflow(fake)
    wf = _WFInstance(goal="Raise me 5m dollars for my company Rose Labs")
    wf.world_model_mode = "simulate"
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=wf,
                tool_call={"until_timestamp": "2026-09-09T12:00:00+00:00"},
                tool_call_id="tc-clock-1",
            )
        )
    finally:
        restore()

    target = int(datetime(2026, 9, 9, 12, tzinfo=timezone.utc).timestamp() * 1000)
    assert fake.clock_calls == [("wait", "agent-1", {"wait_id": "agent-1:tc-clock-1", "until_ms": target})]
    finished = [e for e in events if e.status == MessageStatus.FINISHED][-1]
    assert finished.metadata["worldClock"] is True and finished.metadata["worldTimeMs"] == target
    assert wf.simulated_clock_offset_seconds == 86_400 and fake.sleep_records == []


async def test_handler_condition_simulate_mode_checks_at_shared_world_clock_intervals():  # V9
    from domains.wait_for.handler import WaitForManager
    from tools.base import EventType, MessageStatus, ToolEvent
    from tools.spawn_agent import SpawnAgentManager

    async def fake_spawn_explore(
        self, wf, tool_call, explore_tool_call_id, *, task_id=None, display_goal=None, capture_tool_results=None
    ):
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Explore done",
            message="evidence",
            status=MessageStatus.FINISHED,
            metadata={"agentType": "explore", "taskId": task_id},
            data={"usage": {"llm": [], "service": []}},
        )

    evals = {"n": 0}

    def _eval():
        evals["n"] += 1
        return {"satisfied": evals["n"] >= 3, "reasoning": "checked"}

    now = datetime(2026, 9, 8, 12, 0, 0, tzinfo=timezone.utc)
    fake = _ClockFakeWFModule(activity_results={"evaluate_condition_activity": _eval}, current_time=now, world_start=0)
    restore = _patch_handler_workflow(fake)
    orig_spawn = SpawnAgentManager._spawn_explore
    SpawnAgentManager._spawn_explore = fake_spawn_explore
    wf = _WFInstance(goal="Raise me 5m dollars for my company Rose Labs")
    wf.world_model_mode = "simulate"
    try:
        await _collect(
            WaitForManager().execute_tool(
                workflow_instance=wf,
                tool_call={
                    "description": "reply",
                    "condition": "an investor replied",
                    "check_interval_seconds": 900,
                    "max_checks": 5,
                },
                tool_call_id="tc-clock-cond",
            )
        )
    finally:
        SpawnAgentManager._spawn_explore = orig_spawn
        restore()

    assert fake.clock_calls == [
        ("wait", "agent-1", {"wait_id": "agent-1:tc-clock-cond:check-2", "duration_ms": 900_000}),
        ("wait", "agent-1", {"wait_id": "agent-1:tc-clock-cond:check-3", "duration_ms": 900_000}),
    ]
    assert fake.sleep_records == []


async def test_handler_timestamp_simulate_mode_past_target_on_sim_clock_still_errors():
    """A target already behind the ADVANCED simulated clock is still "in the past"."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(current_time=datetime(2026, 9, 8, 12, 0, 0, tzinfo=timezone.utc))
    restore = _patch_handler_workflow(fake)
    wf = _WFInstance(goal="not the demo prompt")
    wf.world_model_mode = "simulate"
    wf.simulated_clock_offset_seconds = 2 * 86_400  # sim clock already at 2026-09-10T12:00Z
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=wf,
                tool_call={"until_timestamp": "2026-09-09T12:00:00+00:00"},
                tool_call_id="tc-sim-past",
            )
        )
    finally:
        restore()

    assert events[-1].status == MessageStatus.ERROR
    assert "in the past" in events[-1].message
    assert fake.sleep_records == []
    assert wf.simulated_clock_offset_seconds == 2 * 86_400


async def test_handler_timestamp_real_mode_ignores_simulated_clock_helpers():
    """Real mode is untouched: it sleeps the full delta and never advances a sim clock."""
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    fake = _FakeWFModule(current_time=datetime(2026, 9, 8, 12, 0, 0, tzinfo=timezone.utc))
    restore = _patch_handler_workflow(fake)
    wf = _WFInstance(goal="not the demo prompt")
    wf.world_model_mode = "real"
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=wf,
                tool_call={"until_timestamp": "2026-09-08T13:00:00+00:00"},
                tool_call_id="tc-real",
            )
        )
    finally:
        restore()

    from helpers.wait_condition_or_handoff import IDLE_HANDOFF_SAFETY_SECONDS

    assert sum(fake.sleep_records) == 3_600
    # Handoff-aware slices (an unsignalled park re-checks the pointer once per safety slice).
    assert all(0 < seconds <= IDLE_HANDOFF_SAFETY_SECONDS for seconds in fake.sleep_records)
    assert events[-1].status == MessageStatus.FINISHED
    assert "simulatedTimeSkip" not in (events[-1].metadata or {})
    assert getattr(wf, "simulated_clock_offset_seconds", 0) == 0


async def test_handler_condition_simulate_mode_skips_inter_check_sleep_and_advances_sim_clock():
    """World-model simulate: condition polling skips the inter-check wall-clock sleep.

    Neither the Fast Mode button nor a DEMO prompt is involved — the world_model_mode
    alone gates the skip, and each skipped interval advances the simulated clock.
    """
    from domains.wait_for.handler import WaitForManager
    from tools.base import EventType, MessageStatus, ToolEvent
    from tools.spawn_agent import SpawnAgentManager

    evals = {"n": 0}

    async def fake_spawn_explore(
        self,
        wf,
        tool_call,
        explore_tool_call_id,
        *,
        task_id=None,
        display_goal=None,
        capture_tool_results=None,
    ):
        if capture_tool_results is not None:
            capture_tool_results.append("[web_search] simulated investor reply thread")
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Explore done",
            message="evidence",
            status=MessageStatus.FINISHED,
            metadata={"agentType": "explore", "taskId": task_id},
            data={"usage": {"llm": [], "service": []}},
        )

    def _eval(*_a, **_k):
        evals["n"] += 1
        if evals["n"] < 3:
            return {"satisfied": False, "reasoning": "no term sheet yet"}
        return {"satisfied": True, "reasoning": "term sheet signed"}

    fake = _FakeWFModule(activity_results={"evaluate_condition_activity": _eval})
    restore = _patch_handler_workflow(fake)
    orig_spawn = SpawnAgentManager._spawn_explore
    SpawnAgentManager._spawn_explore = fake_spawn_explore
    wf = _WFInstance(fast_mode_cache_enabled=False, goal="Raise me 5m dollars for my company Rose Labs")
    wf.world_model_mode = "simulate"
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=wf,
                tool_call={
                    "description": "investor term sheet",
                    "condition": "an investor has signed a term sheet",
                    "check_interval_seconds": 3600,
                    "max_checks": 5,
                },
                tool_call_id="tc-sim-cond",
            )
        )
    finally:
        SpawnAgentManager._spawn_explore = orig_spawn
        restore()

    assert evals["n"] == 3
    assert fake.sleep_records == []
    # Two inter-check intervals were skipped (before check 2 and check 3).
    assert wf.simulated_clock_offset_seconds == 7_200
    checking = [e for e in events if (e.metadata or {}).get("waitForMode") == "condition" and "checking" in e.title]
    assert [e.metadata.get("simulatedSkipSeconds") for e in checking] == [None, 3600, 3600]
    assert checking[-1].metadata["simulatedClockOffsetSeconds"] == 7_200
    finished = [e for e in events if e.status == MessageStatus.FINISHED]
    assert (finished[-1].data or {}).get("condition_met") is True


# ── Wake-on-message waits (real AgentWorkflow; only the DB edge + clock faked) ──

_WAKE_BASE = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)


class _Rows:
    def __init__(self):
        self.rows = []

    def add(self, role, text, metadata=None):
        stamp = (_WAKE_BASE + timedelta(milliseconds=len(self.rows) + 1)).isoformat()
        self.rows.append({"role": role, "text": text, "metadata": metadata or {}, "timestamp": stamp})

    async def handle_tool_event(self, event, agent_id, tool_call_id, tool_name, **_kwargs):
        from tools.base import AssistantEvent

        if isinstance(event, AssistantEvent):
            return
        self.add(
            "TOOL",
            event.message or "",
            {
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "toolStatus": event.status.value if event.status else "IN_PROGRESS",
                **(event.metadata or {}),
            },
        )

    async def post_message(self, text, role="ASSISTANT", metadata=None, **_kwargs):
        self.add(role, text, metadata)

    def for_call(self, tool_call_id):
        return [row for row in self.rows if row["metadata"].get("toolCallId") == tool_call_id]


class _Clock:
    """Virtual workflow clock.

    ``frozen`` (default): a wait only ends when its predicate turns true, so a
    test can deliver signals at leisure. Unfrozen: a slice that stays false for
    a few loop turns times out and the clock jumps by the slice.
    """

    def __init__(self, frozen=True):
        self.t = _WAKE_BASE
        self.timeouts = []
        self.frozen = frozen

    def now(self):
        return self.t

    async def wait_condition(self, predicate, timeout=None):
        turns = 0
        while not predicate():
            if timeout is not None and not self.frozen and turns >= 40:
                self.timeouts.append(timeout.total_seconds())
                self.t = self.t + timeout
                raise asyncio.TimeoutError()
            turns += 1
            await asyncio.sleep(0 if turns < 40 else 0.001)

    async def sleep(self, seconds):
        self.t = self.t + timedelta(seconds=seconds)


@contextlib.contextmanager
def _real_wf(rows, clock, activities=None):
    import logging

    from temporalio import workflow as temporal_workflow

    from workflows.agent_workflow import AgentWorkflow

    counter = iter(range(1, 10_000))

    async def _execute_activity(fn, args=None, **_kwargs):
        name = getattr(fn, "__name__", "")
        handler = (activities or {}).get(name)
        return handler(*(args or [])) if handler else None

    with (
        patch.object(temporal_workflow, "logger", logging.getLogger("wait-for-wake-test")),
        patch.object(temporal_workflow, "uuid4", lambda: uuid.UUID(int=next(counter))),
        patch.object(temporal_workflow, "now", clock.now),
        patch.object(temporal_workflow, "wait_condition", clock.wait_condition),
        patch.object(temporal_workflow, "sleep", clock.sleep),
        patch.object(temporal_workflow, "execute_activity", _execute_activity),
        patch.object(
            temporal_workflow, "info", lambda: type("Info", (), {"workflow_id": "wf-root", "task_queue": "q"})()
        ),
        patch("workflows.agent_workflow.handle_tool_event", rows.handle_tool_event),
    ):
        wf = AgentWorkflow()
        wf.agent_id = "agent-root"
        wf.user_id = "user-1"
        wf.goal = "Run investor outreach"
        wf._post_message = rows.post_message
        wf._background_spawns_enabled = True

        async def _no_handoff():
            return None

        wf._check_generation_handoff = _no_handoff
        yield wf


def _gated_spawns(wf, gates):
    """Background spawn executor stand-in: each task_name finishes when its gate opens."""
    from tools.base import EventType, MessageStatus, ToolEvent

    async def _execute_tool(tool_name, tool_args, tool_call_id):
        name = tool_args.get("task_name")
        await gates[name].wait()
        await wf._handle_tool_event(
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Explore complete",
                message=f"{name} done",
                status=MessageStatus.FINISHED,
                data={"result": f"{name} done"},
            ),
            tool_call_id,
            "spawn_agent",
        )
        return {"success": True, "message": f"{name} done"}

    return _execute_tool


async def _spawn_bg(wf, task_name, tool_call_id):
    started = await wf._execute_tool_once(
        "spawn_agent", {"type": "explore", "task_name": task_name, "goal": f"Draft email {task_name}."}, tool_call_id
    )
    assert started.get("success"), started
    return started["address"]


async def _until(predicate, turns=400):
    for _ in range(turns):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("condition never became true")


async def test_wait_for_timestamp_woken_early_by_user_message():
    """Repro (bench run 1): a timestamp wait slept through incoming messages. A user message ends it."""
    from domains.wait_for.handler import wait_for

    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock) as wf:
        task = asyncio.create_task(
            wait_for(wf, {"description": "the 5pm call", "until_timestamp": "2026-10-19T17:00:00Z"}, "tc-ts")
        )
        await _until(lambda: rows.for_call("tc-ts"))
        await wf.receive_user_response("Skip the call, send the email now.")
        status, result = await asyncio.wait_for(task, 2)
    final = rows.for_call("tc-ts")[-1]
    assert final["metadata"]["toolStatus"] == "FINISHED" and final["metadata"]["wokenBy"] == "user_message", final
    assert "Woken early by a new user message at 2026-10-19T12:00:00Z" in final["text"], final
    assert "Deadline was 2026-10-19T17:00:00Z (5 hours remaining)" in final["text"], final
    assert result == final["text"]
    # An early wake is a completed wait: deploy resume must not re-arm it.
    from domains.wait_for.service import pending_timestamp_wait_to_resume

    assert pending_timestamp_wait_to_resume(rows.rows) is None


async def test_wait_for_timestamp_woken_early_by_agent_message():
    from domains.wait_for.handler import wait_for

    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock) as wf:
        task = asyncio.create_task(
            wait_for(wf, {"description": "replies", "until_timestamp": "2026-10-19T12:30:00Z"}, "tc-ts2")
        )
        await _until(lambda: rows.for_call("tc-ts2"))
        clock.t = clock.t + timedelta(minutes=5)
        await wf.receive_agent_message(
            {"message_id": "m-1", "from_agent_id": "agent-a", "from_agent_path": "/root/outreach/draft_a"}
        )
        await asyncio.wait_for(task, 2)
    final = rows.for_call("tc-ts2")[-1]
    assert "Woken early by a message from another agent (/root/outreach/draft_a)" in final["text"], final
    assert "after waiting 5 minutes" in final["text"] and "(25 minutes remaining)" in final["text"], final


async def test_wait_for_attention_response_does_not_wake_timestamp_wait():
    """Only real user messages wake waits: a gate's request_id answer resolves its own tool."""
    from domains.wait_for.handler import wait_for

    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock) as wf:
        task = asyncio.create_task(
            wait_for(wf, {"description": "a minute", "until_timestamp": "2026-10-19T12:01:00Z"}, "tc-ts3")
        )
        await _until(lambda: rows.for_call("tc-ts3"))
        await wf.receive_user_response('{"request_id": "req-1", "response": "approved"}')
        for _ in range(50):
            await asyncio.sleep(0)
        assert not task.done(), rows.for_call("tc-ts3")
        clock.frozen = False  # now let the minute elapse
        await asyncio.wait_for(task, 2)
    final = rows.for_call("tc-ts3")[-1]
    assert final["text"] == "Reached 2026-10-19T12:01:00Z" and sum(clock.timeouts) == 60, (final, clock.timeouts)


async def test_wait_for_condition_mode_woken_between_checks():
    """Repro (bench run 1): outreach sat in wait_for(condition) for 757s while agent messages landed."""
    from domains.wait_for.handler import WaitForManager
    from helpers.wait_wake import record_wake
    from tools.base import EventType, MessageStatus, ToolEvent
    from tools.spawn_agent import SpawnAgentManager

    async def fake_spawn_explore(
        self, wf, tool_call, explore_tool_call_id, *, task_id=None, display_goal=None, capture_tool_results=None
    ):
        if capture_tool_results is not None:
            capture_tool_results.append("[grep] no drafts yet")
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Explore done",
            message="",
            status=MessageStatus.FINISHED,
            data={"usage": {"llm": [], "service": []}},
        )

    fake = _FakeWFModule(
        activity_results={"evaluate_condition_activity": {"satisfied": False, "reasoning": "No drafts received yet."}}
    )
    instance = _WFInstance()
    # The drafter's message lands during the inter-check sleep.
    fake.on_slice = lambda n: n == 0 and record_wake(instance, "agent_message", from_agent_path="/root/outreach/a")
    restore = _patch_handler_workflow(fake)
    orig_spawn = SpawnAgentManager._spawn_explore
    SpawnAgentManager._spawn_explore = fake_spawn_explore
    try:
        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=instance,
                tool_call={"description": "drafts", "condition": "Both drafters sent drafts", "max_checks": 5},
                tool_call_id="tc-cond",
            )
        )
    finally:
        SpawnAgentManager._spawn_explore = orig_spawn
        restore()
    final = events[-1]
    assert final.status == MessageStatus.FINISHED and final.metadata["wokenBy"] == "agent_message", final
    assert fake.sleep_records == [], fake.sleep_records  # the 900s interval never elapsed
    assert "Woken early by a message from another agent (/root/outreach/a)" in final.message
    assert 'Last check (1/5): "Both drafters sent drafts" not yet met — No drafts received yet.' in final.message
    assert final.data["condition_met"] is False and final.data["checks_completed"] == 1


async def test_wait_for_agents_mode_wakes_on_listed_child_only():
    from domains.wait_for.handler import wait_for

    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock) as wf:
        gates = {"draft_a": asyncio.Event(), "draft_b": asyncio.Event()}
        wf._execute_tool = _gated_spawns(wf, gates)
        await _spawn_bg(wf, "draft_a", "toolu_a")
        await _spawn_bg(wf, "draft_b", "toolu_b")
        task = asyncio.create_task(wait_for(wf, {"description": "draft A", "agents": ["/root/draft_a"]}, "tc-agents"))
        await _until(lambda: rows.for_call("tc-agents"))
        gates["draft_b"].set()  # unlisted agent finishes: its notification must not end the wait
        await wf._background_handles["toolu_b"]
        await wf.receive_agent_message({"message_id": "m-2", "from_agent_id": "x", "from_agent_path": "/root/other"})
        for _ in range(50):
            await asyncio.sleep(0)
        assert not task.done(), rows.for_call("tc-agents")
        gates["draft_a"].set()
        await asyncio.wait_for(task, 2)
    final = rows.for_call("tc-agents")[-1]
    assert final["metadata"]["wokenBy"] == "agent_notification", final
    assert final["text"].startswith("Woken by a background agent notification (/root/draft_a)"), final
    assert "- /root/draft_a: completed" in final["text"], final


async def test_wait_for_multi_day_timestamp_wakes_when_a_background_agent_finishes():
    """Supervising a multi-day agent costs one wait, not one turn per hour.

    wait_for(agents=...) is capped at one hour (Codex wait_agent); a longer wait
    is one timestamp wait (up to 31 days) that ends as soon as a background
    agent of ours finishes. The cap's error names that path instead of
    "call wait_for again", which spent a planner iteration every hour.
    """
    from domains.wait_for.handler import wait_for
    from utils.wait_for_bounds import WAIT_FOR_AGENTS_MAX_TIMEOUT_ERROR, resolve_wait_for_agents_timeout

    try:
        resolve_wait_for_agents_timeout(3 * 24 * 3600)
    except ValueError as exc:
        assert str(exc) == WAIT_FOR_AGENTS_MAX_TIMEOUT_ERROR
    else:
        raise AssertionError("agents-mode waits stay capped at one hour")
    assert "until_timestamp" in WAIT_FOR_AGENTS_MAX_TIMEOUT_ERROR, WAIT_FOR_AGENTS_MAX_TIMEOUT_ERROR
    assert "call wait_for again" not in WAIT_FOR_AGENTS_MAX_TIMEOUT_ERROR, WAIT_FOR_AGENTS_MAX_TIMEOUT_ERROR

    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock) as wf:
        gates = {"coder": asyncio.Event()}
        wf._execute_tool = _gated_spawns(wf, gates)
        await _spawn_bg(wf, "coder", "toolu_coder")
        task = asyncio.create_task(
            wait_for(wf, {"description": "the coder", "until_timestamp": "2026-10-22T12:00:00Z"}, "tc-days")
        )
        await _until(lambda: rows.for_call("tc-days"))
        clock.t = clock.t + timedelta(hours=30)
        gates["coder"].set()
        await asyncio.wait_for(task, 2)
    final = rows.for_call("tc-days")[-1]
    assert final["metadata"]["wokenBy"] == "agent_notification", final
    assert "Woken early by a background agent notification (/root/coder)" in final["text"], final


async def test_wait_for_wake_text_names_child_by_path_not_id():
    """Repro (bench run 2): "Woken by a sub-agent finishing (65f769fc-…)" showed an agent id.

    child_completed carries only the child's id; the wake row names its task
    path from the background record, else one tree read, else the id.
    """
    from domains.wait_for.handler import wait_for

    reads = []

    def _tree(agent_id, user_id, params):
        reads.append(params)
        if params["node"] != "agent-fg":
            return {"error": "not found"}
        node = {"agent_id": "agent-fg", "path": "/root/fg_task", "status": "COMPLETED"}
        return {"node_path": [{"agent_id": "agent-root", "path": "/root"}, node], "nodes": []}

    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock, {"list_agent_tree_activity": _tree}) as wf:
        gates = {"research": asyncio.Event()}
        wf._execute_tool = _gated_spawns(wf, gates)
        wf.current_phase = "EXECUTE"
        started = await wf._execute_tool_once(
            "spawn_agent",
            {
                "type": "general_purpose",
                "task_name": "research",
                "goal": "Research the market.",
                "start_phase": "EXECUTE",
                "output_schema": {"fields": [{"name": "notes", "type": "str", "description": "d", "required": True}]},
            },
            "toolu_gp",
        )
        assert started.get("address") == "/root/research", started
        child = wf._background_tasks["toolu_gp"]["child_agent_ids"][0]

        # Listed background child: path from its record, no tree read.
        task = asyncio.create_task(wait_for(wf, {"description": "R", "agents": ["/root/research"]}, "tc-gp"))
        await _until(lambda: rows.for_call("tc-gp"))
        wf._note_wait_wake("child_completed", agent_id=child, status="failed")
        _status, result = await asyncio.wait_for(task, 2)
        assert result.startswith("Woken by a sub-agent finishing (/root/research) after"), result
        assert child not in result.split("\n")[0], result
        assert reads == []

        # A child known only by id (foreground spawn): one tree read names it.
        task = asyncio.create_task(wait_for(wf, {"description": "any", "agents": ["any"]}, "tc-fg"))
        await _until(lambda: rows.for_call("tc-fg"))
        wf._note_wait_wake("child_completed", agent_id="agent-fg", status="completed")
        _status, result = await asyncio.wait_for(task, 2)
        assert result.startswith("Woken by a sub-agent finishing (/root/fg_task) after"), result
        assert reads == [{"node": "agent-fg", "depth": "1"}], reads

        # Unknown everywhere: fall back to the id.
        task = asyncio.create_task(wait_for(wf, {"description": "any", "agents": ["any"]}, "tc-unk"))
        await _until(lambda: rows.for_call("tc-unk"))
        wf._note_wait_wake("child_completed", agent_id="agent-gone", status="completed")
        _status, result = await asyncio.wait_for(task, 2)
        assert result.startswith("Woken by a sub-agent finishing (agent-gone) after"), result

        # An agent message without a sender path (timestamp mode): the sender's path from our record.
        task = asyncio.create_task(
            wait_for(wf, {"description": "replies", "until_timestamp": "2026-10-19T12:30:00Z"}, "tc-ts-id")
        )
        await _until(lambda: rows.for_call("tc-ts-id"))
        await wf.receive_agent_message({"message_id": "m-id", "from_agent_id": child})
        await asyncio.wait_for(task, 2)
        final = rows.for_call("tc-ts-id")[-1]
        assert "Woken early by a message from another agent (/root/research) at" in final["text"], final
        gates["research"].set()
        await wf._background_handles["toolu_gp"]


async def test_wait_for_agents_mode_wakes_on_listed_agent_message():
    from domains.wait_for.handler import wait_for

    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock) as wf:
        gates = {"draft_a": asyncio.Event()}
        wf._execute_tool = _gated_spawns(wf, gates)
        await _spawn_bg(wf, "draft_a", "toolu_a")
        task = asyncio.create_task(wait_for(wf, {"description": "A", "agents": ["/root/draft_a"]}, "tc-msg"))
        await _until(lambda: rows.for_call("tc-msg"))
        await wf.receive_agent_message({"message_id": "m-3", "from_agent_path": "/root/draft_a"})
        await asyncio.wait_for(task, 2)
        gates["draft_a"].set()
        await wf._background_handles["toolu_a"]
    final = rows.for_call("tc-msg")[-1]
    assert final["text"].startswith("Woken by a message from another agent (/root/draft_a)"), final
    assert "- /root/draft_a: running" in final["text"], final


async def test_wait_for_agents_parent_wakes_on_parent_reply():
    """A sub-agent asks its parent (send_message_to_agent to "parent") then waits with wait_for(agents=["parent"])."""
    from domains.wait_for.handler import wait_for

    reads = []

    def _tree(agent_id, user_id, params):
        reads.append(params)
        node = {"agent_id": "agent-parent", "path": "/root/outreach", "status": "ACTIVE"}
        return {"node_path": [node], "nodes": [node]}

    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock, {"list_agent_tree_activity": _tree}) as wf:
        wf.agent_id, wf.parent_agent_id, wf.depth = "agent-kid", "agent-parent", 2
        task = asyncio.create_task(wait_for(wf, {"description": "parent's answer", "agents": ["parent"]}, "tc-p"))
        await _until(lambda: rows.for_call("tc-p"))
        # Another agent's message must not end it; the parent's reply does.
        await wf.receive_agent_message(
            {"message_id": "m-x", "from_agent_id": "agent-sib", "from_agent_path": "/root/x"}
        )
        for _ in range(60):
            await asyncio.sleep(0)
        assert not task.done()
        await wf.receive_agent_message(
            {"message_id": "m-p", "from_agent_id": "agent-parent", "from_agent_path": "/root/outreach"}
        )
        _status, result = await asyncio.wait_for(task, 2)
    assert result.startswith("Woken by a message from another agent (/root/outreach)"), result
    assert "- parent: active" in result, result
    assert reads == [{"node": "agent-parent", "depth": "1"}] * 2, reads


async def test_wait_for_agents_any_and_user_message():
    from domains.wait_for.handler import wait_for

    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock) as wf:
        gates = {"draft_a": asyncio.Event(), "draft_b": asyncio.Event()}
        wf._execute_tool = _gated_spawns(wf, gates)
        await _spawn_bg(wf, "draft_a", "toolu_a")
        await _spawn_bg(wf, "draft_b", "toolu_b")
        task = asyncio.create_task(wait_for(wf, {"description": "any", "agents": ["any"]}, "tc-any"))
        await _until(lambda: rows.for_call("tc-any"))
        gates["draft_b"].set()
        await asyncio.wait_for(task, 2)
        final = rows.for_call("tc-any")[-1]
        assert final["text"].startswith("Woken by a background agent notification (/root/draft_b)"), final
        assert "- /root/draft_a: running" in final["text"] and "- /root/draft_b: completed" in final["text"], final

        task = asyncio.create_task(wait_for(wf, {"description": "any", "agents": ["any"]}, "tc-any2"))
        await _until(lambda: rows.for_call("tc-any2"))
        await wf.receive_user_response("Change of plan.")
        await asyncio.wait_for(task, 2)
        assert rows.for_call("tc-any2")[-1]["text"].startswith("Woken by a new user message"), rows.rows[-1]
        gates["draft_a"].set()
        await wf._background_handles["toolu_a"]

        # Nothing running: "any" returns at once (tree-feedback-routing a1f51afd waited
        # 6 minutes after every drafter had finished and its answer was delivered).
        assert wf._pending_background_ids() == []
        status, result = await asyncio.wait_for(wait_for(wf, {"description": "any", "agents": ["any"]}, "tc-any3"), 2)
        assert result.startswith("None of your agents is running, so there is nothing to wait for."), result
        assert "- /root/draft_a: completed" in result and "- /root/draft_b: completed" in result, result
        assert rows.for_call("tc-any3")[-1]["metadata"]["wokenBy"] == "none_running"


async def test_wait_for_agents_mode_timeout_reports_status_and_reads_tree_for_others():
    from domains.wait_for.handler import wait_for

    reads = []

    def _tree(agent_id, user_id, params):
        reads.append(params)
        node = {"agent_id": "id-sib", "path": "/root/research", "status": "ACTIVE"}
        return {"node_path": [{"agent_id": "id-root", "path": "/root"}, node], "nodes": [node]}

    rows, clock = _Rows(), _Clock(frozen=False)
    with _real_wf(rows, clock, {"list_agent_tree_activity": _tree}) as wf:
        gates = {"draft_a": asyncio.Event()}
        wf._execute_tool = _gated_spawns(wf, gates)
        await _spawn_bg(wf, "draft_a", "toolu_a")
        status, result = await asyncio.wait_for(
            wait_for(
                wf,
                {"description": "A", "agents": ["/root/draft_a", "/root/research"], "timeout_seconds": 45},
                "tc-to",
            ),
            2,
        )
        gates["draft_a"].set()
        await wf._background_handles["toolu_a"]
    assert result.startswith("Timed out after 45 seconds: no listed agent finished or messaged you."), result
    assert "- /root/draft_a: running" in result and "- /root/research: active" in result, result
    assert sum(clock.timeouts) == 45, clock.timeouts
    # Own background agents come from workflow state; the other one costs one read at start + one at return.
    assert reads == [{"node": "/root/research", "depth": "1"}] * 2, reads


async def test_wait_for_agents_mode_returns_at_once_for_finished_agent():
    from domains.wait_for.handler import wait_for

    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock) as wf:
        gates = {"draft_a": asyncio.Event()}
        wf._execute_tool = _gated_spawns(wf, gates)
        await _spawn_bg(wf, "draft_a", "toolu_a")
        gates["draft_a"].set()
        await wf._background_handles["toolu_a"]
        _status, result = await asyncio.wait_for(
            wait_for(wf, {"description": "A", "agents": ["/root/draft_a"]}, "tc-done"), 2
        )
    assert result.startswith("/root/draft_a already finished."), result
    assert clock.timeouts == []


async def test_wait_for_title_never_doubles_the_waiting_prefix():
    """Andy 2026-10-28: the work row read "Waiting for Waiting for Chase balances";
    it must read "Waiting for <agent task name>".

    A listed agent is named by its own task name even when the model's description
    differs; the description (with any "Waiting for" prefix stripped) is only the
    fallback when no name resolves ("any").
    """
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    for description, agents, expected, meta_description in (
        ("Waiting for Chase balances", ["/root/pull_bank_data"], "Waiting for pull_bank_data", "pull_bank_data"),
        ("waiting for waiting for the bank", ["/root/pull_bank_data"], "Waiting for pull_bank_data", "pull_bank_data"),
        ("Waiting for Chase balances", ["any"], "Waiting for Chase balances", "Chase balances"),
        ("Chase balances", ["any"], "Waiting for Chase balances", "Chase balances"),
    ):
        rows, clock = _Rows(), _Clock()
        with _real_wf(rows, clock) as wf:
            gates = {"pull_bank_data": asyncio.Event()}
            wf._execute_tool = _gated_spawns(wf, gates)
            await _spawn_bg(wf, "pull_bank_data", "toolu_c")
            gates["pull_bank_data"].set()
            await wf._background_handles["toolu_c"]
            events = await _collect(
                WaitForManager().execute_tool(
                    workflow_instance=wf,
                    tool_call={"description": description, "agents": agents},
                    tool_call_id="tc-title",
                )
            )
        running = [e for e in events if e.status == MessageStatus.IN_PROGRESS]
        assert running and running[0].title == expected, (description, [e.title for e in events])
        assert running[0].metadata["description"] == meta_description, running[0].metadata


def test_wait_for_agents_schema_is_a_plain_string_array():
    """agents is a plain string array; "any" is ["any"], never a string branch.

    Captured descend-full69 r004-j0047 (2026-10-23): with agents typed
    anyOf[array, const "any", null], claude-opus-5-5 sent
    agents='["/root/buy_canvas_tote"]' (a string) and execute_loop re-generated
    twice. Controlled live replay of that exact request: 5/5 strings with the
    union, 5/5 real lists with a plain array. Codex wait_agent declares targets
    as a plain string array (multi_agents_spec.rs wait_agent_tool_parameters_v1).
    """
    from pydantic import ValidationError
    from providers.rose.schema import build_anthropic_tools_from_response_model
    from utils.tool_schemas import WaitForTool, create_agent_action_model

    (tool,) = build_anthropic_tools_from_response_model(
        create_agent_action_model(["wait_for"], tool_registry={"wait_for": WaitForTool})
    )
    agents = tool["input_schema"]["properties"]["agents"]
    assert agents["anyOf"] == [{"type": "array", "items": {"type": "string"}}, {"type": "null"}], agents
    assert '["any"]' in agents["description"], agents["description"]
    assert WaitForTool(tool="wait_for", description="any agent", agents=["any"]).agents == ["any"]
    for bad in ('["/root/buy_canvas_tote"]', "any", ["any", "/root/a"]):
        try:
            WaitForTool(tool="wait_for", description="drafts", agents=bad)
        except ValidationError:
            pass
        else:
            raise AssertionError(f"accepted {bad!r}")


def test_wait_for_schema_validates_agents_mode():
    from utils.tool_schemas import WaitForTool

    ok = WaitForTool(tool="wait_for", description="drafts", agents=["/root/a", "parent"])
    assert ok.timeout_seconds is None and ok.agents == ["/root/a", "parent"]
    assert WaitForTool(tool="wait_for", description="any", agents=["any"], timeout_seconds=3600).timeout_seconds == 3600
    # Codex wait floor: below the minimum is clamped up, not rejected.
    for low in (0, 1, 5, 9.5):
        assert (
            WaitForTool(tool="wait_for", description="any", agents=["any"], timeout_seconds=low).timeout_seconds == 10
        )
    for bad, needle in [
        (
            {"until_timestamp": "2026-10-19T17:00:00Z", "timeout_seconds": 60},
            "timeout_seconds is only valid with agents",
        ),
        ({"condition": "Replies arrived", "timeout_seconds": 60}, "timeout_seconds is only valid with agents"),
        ({"agents": ["/root/a"], "condition": "A replied"}, "condition and agents are mutually exclusive"),
        ({"agents": ["any"], "until_timestamp": "2026-10-19T17:00:00Z"}, "until_timestamp and agents are mutually"),
        ({"agents": ["/root/a"], "timeout_seconds": 3601}, "timeout_seconds must be at most 3600 (1 hour)"),
        ({"agents": ["/root/a"], "timeout_seconds": "soon"}, "timeout_seconds must be a number of seconds"),
        ({"agents": []}, 'agents must list at least one address, or be ["any"]'),
        ({"agents": "all"}, "agents"),
    ]:
        try:
            WaitForTool(tool="wait_for", description="x" * 5, **bad)
        except Exception as exc:  # pydantic.ValidationError
            assert needle in str(exc), (bad, str(exc))
        else:
            raise AssertionError(f"accepted {bad}")


async def test_wait_for_agents_timeout_below_minimum_is_clamped_and_noted():
    """Codex multi_agents_v2/wait.rs: timeout < 10s waits 10s and says so; > 3600s is rejected."""
    from domains.wait_for.handler import wait_for

    rows, clock = _Rows(), _Clock(frozen=False)
    with _real_wf(rows, clock) as wf:
        gates = {"draft_a": asyncio.Event()}
        wf._execute_tool = _gated_spawns(wf, gates)
        await _spawn_bg(wf, "draft_a", "toolu_a")
        _status, result = await asyncio.wait_for(
            wait_for(wf, {"description": "A", "agents": ["/root/draft_a"], "timeout_seconds": 3}, "tc-clamp"), 2
        )
        assert sum(clock.timeouts) == 10, clock.timeouts
        assert result.startswith("Timed out after 10 seconds"), result
        assert result.endswith("\n\nRequested timeout of 3s was clamped to the minimum of 10s."), result
        assert rows.for_call("tc-clamp")[-1]["metadata"]["timeoutSeconds"] == 10

        clock.timeouts.clear()
        _status, plain = await asyncio.wait_for(
            wait_for(wf, {"description": "A", "agents": ["/root/draft_a"], "timeout_seconds": 10}, "tc-floor"), 2
        )
        assert "clamped" not in plain and sum(clock.timeouts) == 10, (plain, clock.timeouts)

        from domains.wait_for.handler import WaitForManager
        from tools.base import MessageStatus

        events = await _collect(
            WaitForManager().execute_tool(
                workflow_instance=wf,
                tool_call={"description": "A", "agents": ["/root/draft_a"], "timeout_seconds": 7200},
                tool_call_id="tc-long",
            )
        )
        assert [e.status for e in events] == [MessageStatus.ERROR], events
        assert events[0].message.startswith("timeout_seconds must be at most 3600 (1 hour)."), events[0].message
        gates["draft_a"].set()
        await asyncio.gather(*wf._background_handles.values())


async def test_wait_for_handler_rejects_timeout_without_agents():
    from domains.wait_for.handler import WaitForManager
    from tools.base import MessageStatus

    events = await _collect(
        WaitForManager().execute_tool(
            workflow_instance=_WFInstance(),
            tool_call={"description": "x", "until_timestamp": "2026-04-18T12:05:00Z", "timeout_seconds": 60},
            tool_call_id="tc",
        )
    )
    assert len(events) == 1 and events[0].status == MessageStatus.ERROR
    assert "timeout_seconds is only valid with agents" in events[0].message


async def test_send_message_arms_no_idle_wait_wait_for_agents_waits_for_the_reply():
    """No implicit idle wait after send_message_to_agent: wait_for(agents=["parent"]) is how a reply is awaited."""
    from domains.wait_for.handler import wait_for

    sent = []

    def _send(*args):
        sent.append(args)
        return {"delivered": True, "message_id": f"m-{len(sent)}"}

    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock, {"send_agent_message_activity": _send}) as wf:
        wf.parent_agent_id = "agent-parent"
        await wf._execute_tool("send_message_to_agent", {"to": "parent", "message": "Which venue?"}, "toolu_s1")
        assert sent
        # The workflow has no tool-less-turn wait machinery left to arm.
        assert not hasattr(wf, "_wait_for_background_agents") and not hasattr(wf, "_awaiting_reply")
        assert "awaiting_reply" not in wf._background_state_snapshot()

        args = {"description": "parent's answer", "agents": ["parent"], "timeout_seconds": 600}
        task = asyncio.create_task(wait_for(wf, dict(args), "tc-reply"))
        await _until(lambda: rows.for_call("tc-reply"))
        for _ in range(60):
            await asyncio.sleep(0)
        assert not task.done()
        await wf.receive_agent_message({"message_id": "r-1", "from_agent_id": "agent-parent"})
        _status, result = await asyncio.wait_for(task, 2)
        assert "message" in result.lower(), result


async def test_wait_for_agents_mode_parks_and_resumes_across_handoff():
    from domains.wait_for.handler import wait_for

    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock) as wf:
        gates = {"draft_a": asyncio.Event()}
        wf._execute_tool = _gated_spawns(wf, gates)
        await _spawn_bg(wf, "draft_a", "toolu_a")
        args = {"description": "A", "agents": ["/root/draft_a"], "timeout_seconds": 600}
        wf._tool_parking_enabled = True
        wf._active_tool_calls["tc-park"] = ("wait_for", dict(args))
        handoff = {"queue": None}

        async def _check():
            return handoff["queue"]

        wf._check_generation_handoff = _check
        task = asyncio.create_task(wait_for(wf, dict(args), "tc-park"))
        await _until(lambda: rows.for_call("tc-park"))
        clock.t = clock.t + timedelta(seconds=200)
        handoff["queue"] = "queue-next"
        # The cutover owner signals generation_handoff_available (helpers/wait_condition_or_handoff.py).
        wf._generation_handoff_hint = "queue-next"
        wf._generation_handoff_hint_seq = getattr(wf, "_generation_handoff_hint_seq", 0) + 1
        from helpers.generation_handoff import GenerationHandoffRequested

        try:
            await asyncio.wait_for(task, 2)
        except GenerationHandoffRequested as exc:
            assert exc.parked is True
        else:
            raise AssertionError("expected a parked handoff")
        assert [row["metadata"]["toolStatus"] for row in rows.for_call("tc-park")] == ["IN_PROGRESS"]
        record = wf._pending_tool_resumes[-1]
        assert record["tool_call_id"] == "tc-park" and record["resume"]["mode"] == "agents"
        assert record["resume"]["deadline"] == "2026-10-19T12:10:00Z", record

        # Next generation re-enters the same call: no second IN_PROGRESS row, original deadline kept.
        handoff["queue"] = None
        wf._generation_handoff_hint = None
        wf._tool_resume_hints = {"tc-park": record["resume"]}
        clock.frozen = False
        clock.timeouts.clear()
        resumed_at = clock.t
        _status, result = await asyncio.wait_for(wait_for(wf, dict(args), "tc-park"), 2)
        # Only the remainder of the original 600s budget is waited.
        assert sum(clock.timeouts) == (_WAKE_BASE + timedelta(seconds=600) - resumed_at).total_seconds() > 0, (
            clock.timeouts
        )
        assert result.startswith("Timed out after 10 minutes"), result
        assert [row["metadata"]["toolStatus"] for row in rows.for_call("tc-park")] == ["IN_PROGRESS", "FINISHED"]
        gates["draft_a"].set()
        await wf._background_handles["toolu_a"]


async def test_dag_planned_wait_for_hands_back_promptly_on_user_message():
    """A planned wait_for is awaited on DAG hand-back; it must end on the message, not at its deadline."""
    from loop.dag_executor import TaskDAG, execute_dag

    async def _param_activity(fn, args=None, **_kwargs):
        if "reasoning" in getattr(fn, "__name__", ""):
            return {"content": "Drafted.", "usage": {}}
        call = {"tool": "wait_for", "description": "investor replies", "until_timestamp": "2026-10-19T17:00:00Z"}
        return {"response": "", "tool_calls": [call], "usage": {}, "detected_tools_ordered": []}

    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock) as wf:
        wf.current_phase = "EXECUTE"
        wf._background_spawns_enabled = False

        async def _noop(*_args, **_kwargs):
            return None

        wf._update_tree_state = _noop
        rows.add("USER", "Wait for investor replies until 5pm, then draft follow-ups.")
        dag = TaskDAG(
            {
                "tasks": [
                    {"goal": "Wait until 5pm for investor replies.", "tool_name": "wait_for"},
                    {"goal": "Draft follow-ups", "tool_name": "reasoning"},
                ],
                "dependencies": {"1": ["0"]},
            }
        )

        async def poll_messages(since):
            return [row for row in rows.rows if row["timestamp"] > since.isoformat()]

        running = asyncio.create_task(
            execute_dag(
                dag=dag,
                agent_id=wf.agent_id,
                user_id=wf.user_id,
                model="rose-labs/rose-1-flash",
                context=list(rows.rows),
                execute_activity=_param_activity,
                post_message=wf._post_message,
                execute_tool=wf._execute_tool,
                handle_tool_event_fn=wf._handle_tool_event,
                poll_messages=poll_messages,
                system_prompt_text="SYSTEM",
                tool_names=["wait_for", "attempt_completion"],
                interrupts=wf._dag_hooks(),
            )
        )
        await _until(
            lambda: any(
                row["metadata"].get("toolName") == "wait_for" and row["metadata"].get("untilTimestamp")
                for row in rows.rows
            ),
            turns=4000,
        )
        rows.add("USER", "Investors replied already, draft now.")
        await wf.receive_user_response("Investors replied already, draft now.")
        result = await asyncio.wait_for(running, 2)
    assert result["status"] == "needs_llm" and result.get("interrupted_by_message") is True, result
    assert dag.tasks[1].state.value == "PENDING"  # dependent never started
    wait_rows = [row for row in rows.rows if row["metadata"].get("toolName") == "wait_for"]
    assert wait_rows[-1]["metadata"].get("wokenBy") == "user_message", wait_rows[-1]
    assert clock.t < datetime(2026, 10, 19, 13, 0, tzinfo=timezone.utc), clock.t  # not slept to the deadline


async def test_wait_for_wakes_on_messages_that_arrived_after_the_llm_context_poll():
    """Repro (bench browser-agent-mid-run-message, root 357d8b95): a user message
    signalled after the poll that built the LLM's context but before the wait_for
    it decided on started was never seen; the wait slept until the browser
    notification. Every mode treats such a wake as already pending."""
    from domains.wait_for.handler import wait_for

    epoch = datetime.fromtimestamp(0, tz=timezone.utc)
    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock, {"poll_new_messages": lambda *_args: []}) as wf:
        gates = {"hn_top_eight": asyncio.Event()}
        wf._execute_tool = _gated_spawns(wf, gates)
        address = await _spawn_bg(wf, "hn_top_eight", "toolu_hn")
        await wf._poll_messages(epoch)  # the context snapshot of the turn that issues wait_for
        await wf.receive_user_response("Also, add how many points each story has.")  # lands mid LLM call
        args = {"description": "HN stories", "agents": [address], "timeout_seconds": 600}
        _status, result = await asyncio.wait_for(wait_for(wf, dict(args), "tc-agents-pre"), 2)
        final = rows.for_call("tc-agents-pre")[-1]
        assert final["metadata"]["wokenBy"] == "user_message", final
        assert result.startswith("Woken by a new user message received before the wait started."), result
        assert not gates["hn_top_eight"].is_set() and wf._background_tasks["toolu_hn"]["status"] == "running"

        # Timestamp mode, same window: an agent message after the poll ends it at once.
        await wf._poll_messages(epoch)
        await wf.receive_agent_message({"message_id": "m-pre", "from_agent_id": "a", "from_agent_path": "/root/x"})
        _status, result = await asyncio.wait_for(
            wait_for(wf, {"description": "5pm", "until_timestamp": "2026-10-19T17:00:00Z"}, "tc-ts-pre"), 2
        )
        assert result.startswith(
            "Woken early by a message from another agent (/root/x), received before the wait started."
        ), result

        # Control: a message already polled into context does not end the next wait.
        await wf.receive_user_response("One more thing: skip Ask HN posts.")
        await wf._poll_messages(epoch)
        task = asyncio.create_task(wait_for(wf, dict(args), "tc-agents-post"))
        await _until(lambda: rows.for_call("tc-agents-post"))
        for _ in range(60):
            await asyncio.sleep(0)
        assert not task.done(), rows.for_call("tc-agents-post")
        gates["hn_top_eight"].set()
        await wf._background_handles["toolu_hn"]
        _status, result = await asyncio.wait_for(task, 2)
    assert result.startswith("Woken by a background agent notification"), result


async def test_dag_hands_back_before_its_first_batch_for_a_message_after_the_context_poll():
    """Same window for a plan: a message signalled after the poll the plan was built
    from, before execute_dag read its wake counter, hands back before any task starts
    (it used to wait for the first task to finish)."""
    from loop.dag_executor import TaskDAG, execute_dag

    started = []

    async def _blocking_activity(fn, args=None, **_kwargs):
        started.append(getattr(fn, "__name__", ""))
        await asyncio.Event().wait()

    epoch = datetime.fromtimestamp(0, tz=timezone.utc)
    rows, clock = _Rows(), _Clock()
    with _real_wf(rows, clock, {"poll_new_messages": lambda *_args: []}) as wf:
        wf.current_phase = "EXECUTE"
        wf._background_spawns_enabled = False
        rows.add("USER", "Summarize the top HN stories.")
        await wf._poll_messages(epoch)  # the plan-building turn's snapshot
        rows.add("USER", "Also include each story's points.")
        await wf.receive_user_response("Also include each story's points.")
        dag = TaskDAG({"tasks": [{"goal": "Summarize the stories", "tool_name": "reasoning"}], "dependencies": {}})

        async def poll_messages(since):
            return [row for row in rows.rows if row["timestamp"] > since.isoformat()]

        result = await asyncio.wait_for(
            execute_dag(
                dag=dag,
                agent_id=wf.agent_id,
                user_id=wf.user_id,
                model="rose-labs/rose-1-flash",
                context=list(rows.rows[:1]),
                execute_activity=_blocking_activity,
                post_message=wf._post_message,
                execute_tool=wf._execute_tool,
                handle_tool_event_fn=wf._handle_tool_event,
                poll_messages=poll_messages,
                system_prompt_text="SYSTEM",
                tool_names=["reasoning", "attempt_completion"],
                interrupts=wf._dag_hooks(),
            ),
            2,
        )
    assert result["status"] == "needs_llm" and result.get("interrupted_by_message") is True, result
    assert started == [] and dag.tasks[0].state.value == "PENDING", (started, dag.tasks[0].state)
    assert any(m.get("text") == "Also include each story's points." for m in result["context"]), result["context"]


async def run_all_tests():
    print("wait-for blackbox tests:")
    r = BlackboxResult()
    await r.record_async("uses_llm_not_httpx", test_evaluate_condition_uses_llm_not_httpx)
    await r.record_async("no_outbound_http_calls", test_no_outbound_http_calls)
    await r.record_async("evaluate_negative", test_evaluate_condition_negative)
    await r.record_async("evaluate_loose_json", test_evaluate_condition_loose_json_fallback)
    await r.record_async("evaluate_non_json", test_evaluate_condition_non_json_fallback)
    await r.record_async(
        "evaluate_prefixed_and_fenced_json",
        test_evaluate_condition_accepts_prefixed_and_fenced_json,
    )
    r.record("format_duration_seconds", test_format_duration_seconds)
    r.record("format_duration_minutes_int", test_format_duration_minutes_integer)
    r.record("format_duration_minutes_frac", test_format_duration_minutes_fractional)
    r.record("format_duration_hours_int", test_format_duration_hours_integer)
    r.record("format_duration_hours_frac", test_format_duration_hours_fractional)
    r.record("format_duration_days_int", test_format_duration_days_integer)
    r.record("format_duration_days_frac", test_format_duration_days_fractional)
    r.record("cap_evidence_short", test_cap_evidence_short)
    r.record("cap_evidence_truncated", test_cap_evidence_truncated)
    await r.record_async("handler_neither_input", test_handler_neither_timestamp_nor_condition_yields_error)
    await r.record_async(
        "handler_condition_requires_description",
        test_handler_condition_without_description_yields_error,
    )
    await r.record_async(
        "handler_condition_description_bounds",
        test_handler_condition_rejects_description_outside_schema_bounds,
    )
    await r.record_async("handler_ts_invalid", test_handler_timestamp_invalid_format)
    await r.record_async("handler_ts_past", test_handler_timestamp_in_past)
    await r.record_async("handler_ts_too_far", test_handler_timestamp_too_far_future)
    await r.record_async("handler_ts_happy", test_handler_timestamp_happy_path)
    await r.record_async("handler_cond_paused", test_handler_condition_paused_yields_error)
    await r.record_async("handler_cond_fetch_fail", test_handler_condition_network_fetch_failure_tolerated)
    await r.record_async("handler_cond_gates_off", test_handler_condition_gates_off_skip_fetch)
    await r.record_async("handler_cond_explore_task_id", test_handler_condition_check_messages_carry_explore_task_id)
    await r.record_async(
        "handler_cond_error_unavailable_sources",
        test_handler_condition_raises_source_connect_gates_from_explore_error,
    )
    await r.record_async(
        "handler_cond_skip_gates_when_paused",
        test_handler_condition_skips_source_connect_gates_when_paused,
    )
    r.record("resume_interrupted_future", test_resume_interrupted_future_wait_returns_target)
    r.record("resume_interrupted_past", test_resume_interrupted_past_wait_returns_target)
    r.record("resume_completed_none", test_resume_completed_wait_returns_none)
    r.record("resume_in_progress", test_resume_still_in_progress_returns_target)
    r.record("resume_no_wait_none", test_resume_no_wait_returns_none)
    r.record("resume_unparseable_none", test_resume_unparseable_target_returns_none)
    r.record("resume_nondict_metadata", test_resume_tolerates_nondict_metadata)
    r.record("resume_latest_wins", test_resume_latest_wait_wins)
    await r.record_async("handler_ts_resume_past", test_handler_timestamp_resume_past_completes_not_errors)
    await r.record_async("handler_ts_resume_nonbool", test_handler_timestamp_resume_nonbool_still_errors_in_past)
    await r.record_async(
        "handler_ts_live_fm_past_errors",
        test_handler_timestamp_live_fast_mode_past_still_errors,
    )
    await r.record_async(
        "handler_ts_live_fm_far_future_errors",
        test_handler_timestamp_live_fast_mode_far_future_still_errors,
    )
    await r.record_async(
        "handler_ts_live_fm_sleeps_until_target",
        test_handler_timestamp_live_fast_mode_still_sleeps_until_target,
    )
    await r.record_async(
        "handler_ts_fast_mode_past",
        test_handler_timestamp_fast_mode_past_completes_not_errors,
    )
    await r.record_async(
        "handler_ts_fast_mode_far_future",
        test_handler_timestamp_fast_mode_far_future_completes_not_errors,
    )
    await r.record_async(
        "handler_cond_oai_demo_fast_mode_awaits",
        test_handler_condition_oai_demo_fast_mode_awaits_explore,
    )
    await r.record_async(
        "handler_cond_live_fm_honors_interval",
        test_handler_condition_live_fast_mode_honors_check_interval_sleep,
    )
    await r.record_async(
        "handler_cond_oai_demo_fm_skips_interval",
        test_handler_condition_oai_demo_fast_mode_skips_inter_check_sleep,
    )
    await r.record_async(
        "handler_cond_leftover_child_honors_interval",
        test_handler_condition_leftover_child_without_root_goal_honors_sleep,
    )
    await r.record_async(
        "handler_cond_leftover_child_inherits_root",
        test_handler_condition_leftover_child_inherits_root_goal_skip_sleep,
    )
    await r.record_async(
        "handler_ts_simulate_skips_wall_clock",
        test_handler_timestamp_simulate_mode_skips_wall_clock_and_advances_sim_clock,
    )
    await r.record_async(
        "handler_ts_simulate_past_on_sim_clock_errors",
        test_handler_timestamp_simulate_mode_past_target_on_sim_clock_still_errors,
    )
    await r.record_async(
        "handler_ts_real_mode_ignores_sim_clock",
        test_handler_timestamp_real_mode_ignores_simulated_clock_helpers,
    )
    await r.record_async(
        "handler_cond_simulate_skips_interval",
        test_handler_condition_simulate_mode_skips_inter_check_sleep_and_advances_sim_clock,
    )
    await r.record_async(
        "handler_ts_simulate_waits_on_shared_world_clock",
        test_handler_timestamp_simulate_mode_waits_on_the_shared_world_clock,
    )
    await r.record_async(
        "handler_cond_simulate_checks_at_world_clock_intervals",
        test_handler_condition_simulate_mode_checks_at_shared_world_clock_intervals,
    )
    await r.record_async("wake_ts_user_message", test_wait_for_timestamp_woken_early_by_user_message)
    await r.record_async("wake_ts_agent_message", test_wait_for_timestamp_woken_early_by_agent_message)
    await r.record_async(
        "wake_multi_day_ts_on_background_finish",
        test_wait_for_multi_day_timestamp_wakes_when_a_background_agent_finishes,
    )
    await r.record_async(
        "wake_ts_ignores_attention_response", test_wait_for_attention_response_does_not_wake_timestamp_wait
    )
    await r.record_async("wake_condition_between_checks", test_wait_for_condition_mode_woken_between_checks)
    await r.record_async("agents_mode_listed_child_only", test_wait_for_agents_mode_wakes_on_listed_child_only)
    await r.record_async("wake_text_names_child_by_path", test_wait_for_wake_text_names_child_by_path_not_id)
    await r.record_async("agents_mode_listed_agent_message", test_wait_for_agents_mode_wakes_on_listed_agent_message)
    await r.record_async("agents_mode_any_and_user_message", test_wait_for_agents_any_and_user_message)
    await r.record_async("agents_mode_parent_reply", test_wait_for_agents_parent_wakes_on_parent_reply)
    await r.record_async(
        "agents_mode_timeout_status", test_wait_for_agents_mode_timeout_reports_status_and_reads_tree_for_others
    )
    await r.record_async("agents_mode_already_finished", test_wait_for_agents_mode_returns_at_once_for_finished_agent)
    await r.record_async("title_never_doubles_waiting_prefix", test_wait_for_title_never_doubles_the_waiting_prefix)
    r.record("agents_mode_schema_validation", test_wait_for_schema_validates_agents_mode)
    r.record("agents_schema_is_plain_string_array", test_wait_for_agents_schema_is_a_plain_string_array)
    await r.record_async(
        "agents_timeout_clamped_to_floor", test_wait_for_agents_timeout_below_minimum_is_clamped_and_noted
    )
    await r.record_async("handler_timeout_requires_agents", test_wait_for_handler_rejects_timeout_without_agents)
    await r.record_async(
        "send_message_no_idle_wait", test_send_message_arms_no_idle_wait_wait_for_agents_waits_for_the_reply
    )
    await r.record_async("agents_mode_park_resume", test_wait_for_agents_mode_parks_and_resumes_across_handoff)
    await r.record_async("dag_planned_wait_hands_back", test_dag_planned_wait_for_hands_back_promptly_on_user_message)
    await r.record_async(
        "wait_wakes_on_message_after_context_poll",
        test_wait_for_wakes_on_messages_that_arrived_after_the_llm_context_poll,
    )
    await r.record_async(
        "dag_hands_back_for_message_after_context_poll",
        test_dag_hands_back_before_its_first_batch_for_a_message_after_the_context_poll,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
