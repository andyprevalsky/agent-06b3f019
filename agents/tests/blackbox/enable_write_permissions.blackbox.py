"""Blackbox tests for enable-write-permissions domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


async def test_missing_reason_yields_error():
    """execute_tool yields an error event when reason is missing."""
    from tools.enable_write_permissions import EnableWritePermissionsManager
    from tools.base import MessageStatus

    manager = EnableWritePermissionsManager()
    events = []
    async for event in manager.execute_tool(
        workflow_instance=None,
        tool_call={"action_description": "Send an email"},
        tool_call_id="tc-1",
    ):
        events.append(event)

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "reason" in events[0].message.lower()


async def test_missing_action_description_yields_error():
    """execute_tool yields an error event when action_description is missing."""
    from tools.enable_write_permissions import EnableWritePermissionsManager
    from tools.base import MessageStatus

    manager = EnableWritePermissionsManager()
    events = []
    async for event in manager.execute_tool(
        workflow_instance=None,
        tool_call={"reason": "User asked to send"},
        tool_call_id="tc-2",
    ):
        events.append(event)

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "action_description" in events[0].message.lower()


async def test_no_outbound_http_calls():
    """enable_write_permissions validation makes zero outbound HTTP calls."""
    from tools.enable_write_permissions import EnableWritePermissionsManager

    manager = EnableWritePermissionsManager()
    # Missing both params — should fail validation before any HTTP
    events = []
    async for event in manager.execute_tool(
        workflow_instance=None,
        tool_call={},
        tool_call_id="tc-3",
    ):
        events.append(event)

    assert len(get_captured_requests()) == 0


# -------------------- service.py tests --------------------


def test_validate_tool_call_missing_reason():
    from domains.enable_write_permissions.service import validate_tool_call, ValidationError

    result = validate_tool_call({"action_description": "send email"})
    assert isinstance(result, ValidationError)
    assert result.field == "reason"


def test_validate_tool_call_missing_action_description():
    from domains.enable_write_permissions.service import validate_tool_call, ValidationError

    result = validate_tool_call({"reason": "user asked"})
    assert isinstance(result, ValidationError)
    assert result.field == "action_description"


def test_validate_tool_call_empty_strings_invalid():
    from domains.enable_write_permissions.service import validate_tool_call, ValidationError

    # Empty/whitespace should fail
    r1 = validate_tool_call({"reason": "   ", "action_description": "x"})
    assert isinstance(r1, ValidationError)
    r2 = validate_tool_call({"reason": "x", "action_description": ""})
    assert isinstance(r2, ValidationError)


def test_validate_tool_call_non_string_reason():
    from domains.enable_write_permissions.service import validate_tool_call, ValidationError

    result = validate_tool_call({"reason": 123, "action_description": "x"})
    assert isinstance(result, ValidationError)
    assert result.field == "reason"


def test_validate_tool_call_happy_path():
    from domains.enable_write_permissions.service import validate_tool_call, ValidationError

    result = validate_tool_call({"reason": "  Need to send email  ", "action_description": "  Send email  "})
    assert not isinstance(result, ValidationError)
    # Strips whitespace
    assert result["reason"] == "Need to send email"
    assert result["action_description"] == "Send email"


def test_build_approval_question_formats_template():
    from domains.enable_write_permissions.service import build_approval_question

    q = build_approval_question({"reason": "R", "action_description": "A"})
    assert "Write Permission Request" in q
    assert "Reason:** R" in q
    assert "Action to be performed:** A" in q
    assert "single-use" in q


def test_build_approval_metadata_format():
    from domains.enable_write_permissions.service import build_approval_metadata

    md = build_approval_metadata({"reason": "R", "action_description": "A"})
    assert md["writePermission"] is True
    assert md["reason"] == "R"
    assert md["actionDescription"] == "A"


# -------------------- handler.py happy path tests --------------------


async def test_execute_tool_granted_yields_success_event():
    """Happy path: valid inputs + granted approval yields FINISHED event with metadata."""
    from tools.enable_write_permissions import EnableWritePermissionsManager
    from tools.base import MessageStatus
    from unittest.mock import patch, AsyncMock
    import domains.enable_write_permissions.handler as handler_mod

    manager = EnableWritePermissionsManager()

    async def fake_request(workflow_instance, validated):
        return {"response": "approved"}

    events = []
    with patch.object(handler_mod, "request_write_permission", fake_request):
        async for event in manager.execute_tool(
            workflow_instance=object(),
            tool_call={"reason": "R", "action_description": "A"},
            tool_call_id="tc-1",
        ):
            events.append(event)

    assert len(events) == 1
    assert events[0].status == MessageStatus.FINISHED
    assert events[0].metadata["writePermission"] is True
    assert events[0].metadata["permissionGranted"] is True


async def test_execute_tool_request_raises_yields_error():
    """If request_write_permission raises, an ERROR event is yielded."""
    from tools.enable_write_permissions import EnableWritePermissionsManager
    from tools.base import MessageStatus
    from unittest.mock import patch
    import domains.enable_write_permissions.handler as handler_mod

    manager = EnableWritePermissionsManager()

    async def fake_request(workflow_instance, validated):
        raise RuntimeError("signal failed")

    events = []
    with patch.object(handler_mod, "request_write_permission", fake_request):
        async for event in manager.execute_tool(
            workflow_instance=object(),
            tool_call={"reason": "R", "action_description": "A"},
            tool_call_id="tc-1",
        ):
            events.append(event)

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "signal failed" in events[0].message


async def test_enable_write_permissions_entry_point():
    """The enable_write_permissions() function iterates events and returns last status."""
    from tools.enable_write_permissions import enable_write_permissions
    from tools.base import MessageStatus
    from unittest.mock import patch, AsyncMock
    import domains.enable_write_permissions.handler as handler_mod

    events_sent = []

    class FakeWorkflow:
        async def _handle_tool_event(self, event, tool_call_id, tool_name):
            events_sent.append((event, tool_call_id, tool_name))

    async def fake_request(workflow_instance, validated):
        return {"response": "approved"}

    with patch.object(handler_mod, "request_write_permission", fake_request):
        status = await enable_write_permissions(
            workflow_instance=FakeWorkflow(),
            tool_call={"reason": "R", "action_description": "A"},
            tool_call_id="tc-1",
        )
    assert status == MessageStatus.FINISHED
    assert len(events_sent) == 1


async def test_enable_write_permissions_entry_point_validation_error():
    """If validation fails, entry point still iterates and returns ERROR status."""
    from tools.enable_write_permissions import enable_write_permissions
    from tools.base import MessageStatus

    events_sent = []

    class FakeWorkflow:
        async def _handle_tool_event(self, event, tool_call_id, tool_name):
            events_sent.append(event)

    status = await enable_write_permissions(
        workflow_instance=FakeWorkflow(),
        tool_call={},  # Missing both
        tool_call_id="tc-1",
    )
    assert status == MessageStatus.ERROR
    assert len(events_sent) == 1


async def run_all_tests():
    print("enable-write-permissions blackbox tests:")
    r = BlackboxResult()
    await r.record_async("missing_reason_yields_error", test_missing_reason_yields_error)
    await r.record_async("missing_action_description_yields_error", test_missing_action_description_yields_error)
    await r.record_async("no_outbound_http_calls", test_no_outbound_http_calls)
    r.record("validate_missing_reason", test_validate_tool_call_missing_reason)
    r.record("validate_missing_action", test_validate_tool_call_missing_action_description)
    r.record("validate_empty_strings_invalid", test_validate_tool_call_empty_strings_invalid)
    r.record("validate_non_string_reason", test_validate_tool_call_non_string_reason)
    r.record("validate_happy_path", test_validate_tool_call_happy_path)
    r.record("build_approval_question", test_build_approval_question_formats_template)
    r.record("build_approval_metadata", test_build_approval_metadata_format)
    await r.record_async("execute_tool_granted", test_execute_tool_granted_yields_success_event)
    await r.record_async("execute_tool_request_raises", test_execute_tool_request_raises_yields_error)
    await r.record_async("entry_point_success", test_enable_write_permissions_entry_point)
    await r.record_async("entry_point_validation_error", test_enable_write_permissions_entry_point_validation_error)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
