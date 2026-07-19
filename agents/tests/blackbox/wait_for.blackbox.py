"""Blackbox tests for wait-for domain."""

import asyncio
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
                model="rose-1-lite",
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
                model="rose-1-lite",
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
            model="rose-1-lite",
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
            model="rose-1-lite",
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
            model="rose-1-lite",
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
                model="rose-1-lite",
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

    def now(self):
        return self._current_time

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


def _patch_handler_workflow(fake):
    import domains.wait_for.handler as h

    original = h.workflow
    h.workflow = fake

    def restore():
        h.workflow = original

    return restore


class _WFInstance:
    def __init__(self, *, paused=False, cost_limit_reached=False):
        self.user_id = "user-1"
        self.agent_id = "agent-1"
        self.model = "rose-1-lite"
        self.context_gates = {}
        self.is_paused = paused
        self._cost_limit_reached = cost_limit_reached
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
    # Slept ~5 minutes (300 seconds)
    assert 300 in fake.sleep_records


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
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
