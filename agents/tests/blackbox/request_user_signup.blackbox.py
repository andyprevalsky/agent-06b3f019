"""Blackbox tests for request-user-signup domain."""

import asyncio
from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


async def test_emits_in_progress_with_signup_metadata():
    """execute_tool yields an IN_PROGRESS event with signup metadata."""
    from tools.request_user_signup import RequestUserSignupManager
    from tools.base import MessageStatus

    manager = RequestUserSignupManager()

    # Collect only the first event (before the blocking wait_condition)
    events = []
    gen = manager.execute_tool(
        workflow_instance=None,  # Will fail at wait_condition, but first yield is before that
        tool_call={"reason": "Need account to send email"},
        tool_call_id="tc-1",
    )
    # Get the first yielded event (before any blocking)
    event = await gen.__anext__()
    events.append(event)

    assert event.status == MessageStatus.IN_PROGRESS
    assert event.metadata["requestUserSignup"]["isWaitingForUser"] is True
    assert event.metadata["requestUserSignup"]["attentionKind"] == "signup"
    assert event.metadata["isUserAttentionMessage"] is True
    assert "Need account to send email" in event.message


async def test_default_reason():
    """Default reason is used when none provided."""
    from tools.request_user_signup import RequestUserSignupManager
    from tools.base import MessageStatus

    manager = RequestUserSignupManager()

    gen = manager.execute_tool(
        workflow_instance=None,
        tool_call={},
        tool_call_id="tc-2",
    )
    event = await gen.__anext__()

    assert event.status == MessageStatus.IN_PROGRESS
    assert "requires a signed-in account" in event.message


async def test_no_outbound_http_calls():
    """request_user_signup makes zero outbound HTTP calls."""
    from tools.request_user_signup import RequestUserSignupManager

    manager = RequestUserSignupManager()

    gen = manager.execute_tool(
        workflow_instance=None,
        tool_call={"reason": "Test"},
        tool_call_id="tc-3",
    )
    await gen.__anext__()

    assert len(get_captured_requests()) == 0


# -------------------- service.py tests --------------------


def test_extract_reason_with_value():
    from domains.request_user_signup.service import extract_reason
    assert extract_reason({"reason": "custom reason"}) == "custom reason"


def test_extract_reason_default():
    from domains.request_user_signup.service import extract_reason
    from domains.request_user_signup.config import DEFAULT_REASON
    assert extract_reason({}) == DEFAULT_REASON


def test_build_signup_metadata_waiting():
    from domains.request_user_signup.service import build_signup_metadata
    md = build_signup_metadata("Need signup", is_waiting=True)
    assert md["isUserAttentionMessage"] is True
    assert md["attentionMessage"] == "Need signup"
    assert md["requestUserSignup"]["isWaitingForUser"] is True
    assert md["requestUserSignup"]["attentionKind"] == "signup"


def test_build_signup_metadata_not_waiting():
    from domains.request_user_signup.service import build_signup_metadata
    md = build_signup_metadata("r", is_waiting=False)
    assert md["requestUserSignup"]["isWaitingForUser"] is False


def test_resolve_signup_outcome_completed():
    from domains.request_user_signup.service import resolve_signup_outcome
    from domains.request_user_signup.types import SignupOutcome
    assert resolve_signup_outcome(signup_completed=True, signup_dismissed=False) == SignupOutcome.COMPLETED


def test_resolve_signup_outcome_dismissed():
    from domains.request_user_signup.service import resolve_signup_outcome
    from domains.request_user_signup.types import SignupOutcome
    assert resolve_signup_outcome(signup_completed=False, signup_dismissed=True) == SignupOutcome.DISMISSED


def test_resolve_signup_outcome_message():
    from domains.request_user_signup.service import resolve_signup_outcome
    from domains.request_user_signup.types import SignupOutcome
    assert resolve_signup_outcome(signup_completed=False, signup_dismissed=False) == SignupOutcome.MESSAGE


def test_outcome_display_all_values():
    from domains.request_user_signup.service import outcome_display
    from domains.request_user_signup.types import SignupOutcome
    for outcome in (SignupOutcome.COMPLETED, SignupOutcome.DISMISSED, SignupOutcome.MESSAGE):
        title, msg = outcome_display(outcome)
        assert isinstance(title, str) and title
        assert isinstance(msg, str) and msg


# -------------------- handler.py happy-path tests --------------------


async def test_execute_tool_completed_outcome():
    """Happy path: user completes signup → FINISHED event with completed message."""
    from tools.request_user_signup import RequestUserSignupManager
    from tools.base import MessageStatus
    from unittest.mock import patch

    class FakeWorkflow:
        _has_new_messages = False
        _signup_completed = True
        _signup_dismissed = False
        agent_id = "agent-1"

    async def fake_wait_condition(pred):
        return None  # already satisfied

    manager = RequestUserSignupManager()
    events = []
    with patch("temporalio.workflow.wait_condition", fake_wait_condition):
        async for event in manager.execute_tool(
            workflow_instance=FakeWorkflow(),
            tool_call={"reason": "Need signup"},
            tool_call_id="tc-1",
        ):
            events.append(event)

    # IN_PROGRESS + FINISHED
    assert len(events) == 2
    assert events[0].status == MessageStatus.IN_PROGRESS
    assert events[1].status == MessageStatus.FINISHED
    assert "Signup Complete" in events[1].title


async def test_execute_tool_dismissed_outcome():
    """User dismisses → FINISHED event with 'Signup Skipped'."""
    from tools.request_user_signup import RequestUserSignupManager
    from tools.base import MessageStatus
    from unittest.mock import patch

    class FakeWorkflow:
        _has_new_messages = False
        _signup_completed = False
        _signup_dismissed = True
        agent_id = "agent-1"

    async def fake_wait_condition(pred):
        return None

    manager = RequestUserSignupManager()
    events = []
    with patch("temporalio.workflow.wait_condition", fake_wait_condition):
        async for event in manager.execute_tool(
            workflow_instance=FakeWorkflow(),
            tool_call={"reason": "r"},
            tool_call_id="tc-1",
        ):
            events.append(event)

    assert events[-1].status == MessageStatus.FINISHED
    assert "Signup Skipped" in events[-1].title


async def test_execute_tool_wait_condition_raises():
    """If wait_condition raises, ERROR event is yielded."""
    from tools.request_user_signup import RequestUserSignupManager
    from tools.base import MessageStatus
    from unittest.mock import patch

    class FakeWorkflow:
        _has_new_messages = False
        _signup_completed = False
        _signup_dismissed = False
        agent_id = "agent-1"

    async def fake_wait_condition(pred):
        raise RuntimeError("workflow cancelled")

    manager = RequestUserSignupManager()
    events = []
    with patch("temporalio.workflow.wait_condition", fake_wait_condition):
        async for event in manager.execute_tool(
            workflow_instance=FakeWorkflow(),
            tool_call={"reason": "r"},
            tool_call_id="tc-1",
        ):
            events.append(event)

    assert events[-1].status == MessageStatus.ERROR
    assert "workflow cancelled" in events[-1].message


async def test_request_user_signup_entry_point():
    """Entry point iterates events and returns last status."""
    from tools.request_user_signup import request_user_signup
    from tools.base import MessageStatus
    from unittest.mock import patch

    events_sent = []

    class FakeWorkflow:
        _has_new_messages = False
        _signup_completed = True
        _signup_dismissed = False
        agent_id = "agent-1"

        async def _handle_tool_event(self, event, tool_call_id, tool_name):
            events_sent.append(event)

    async def fake_wait_condition(pred):
        return None

    with patch("temporalio.workflow.wait_condition", fake_wait_condition):
        status = await request_user_signup(
            workflow_instance=FakeWorkflow(),
            tool_call={"reason": "r"},
            tool_call_id="tc-1",
        )
    assert status == MessageStatus.FINISHED


async def run_all_tests():
    print("request-user-signup blackbox tests:")
    r = BlackboxResult()
    await r.record_async("emits_in_progress_with_signup_metadata", test_emits_in_progress_with_signup_metadata)
    await r.record_async("default_reason", test_default_reason)
    await r.record_async("no_outbound_http_calls", test_no_outbound_http_calls)
    r.record("extract_reason_with_value", test_extract_reason_with_value)
    r.record("extract_reason_default", test_extract_reason_default)
    r.record("build_signup_metadata_waiting", test_build_signup_metadata_waiting)
    r.record("build_signup_metadata_not_waiting", test_build_signup_metadata_not_waiting)
    r.record("resolve_outcome_completed", test_resolve_signup_outcome_completed)
    r.record("resolve_outcome_dismissed", test_resolve_signup_outcome_dismissed)
    r.record("resolve_outcome_message", test_resolve_signup_outcome_message)
    r.record("outcome_display_all", test_outcome_display_all_values)
    await r.record_async("execute_tool_completed", test_execute_tool_completed_outcome)
    await r.record_async("execute_tool_dismissed", test_execute_tool_dismissed_outcome)
    await r.record_async("execute_tool_raises", test_execute_tool_wait_condition_raises)
    await r.record_async("entry_point", test_request_user_signup_entry_point)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
