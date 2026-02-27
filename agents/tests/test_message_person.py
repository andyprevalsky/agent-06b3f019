"""Test unified message_person tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.message_person import (
    _classify_person_id,
    _format_messages_for_context,
    _format_person_display,
    _build_conversation_summary,
    MessagePersonManager,
)
from tools.base import ToolEvent, MessageStatus


# ================================================================
# Unit tests: _classify_person_id
# ================================================================

def test_classify_phone_e164():
    """Phone in E.164 format."""
    result = _classify_person_id("+19729777432")
    assert result == {"phone": "+19729777432"}
    print("✅ test_classify_phone_e164 passed")


def test_classify_phone_digits_only():
    """10-digit phone gets +1 prefix."""
    result = _classify_person_id("9729777432")
    assert result == {"phone": "+19729777432"}
    print("✅ test_classify_phone_digits_only passed")


def test_classify_phone_formatted():
    """Formatted phone number."""
    result = _classify_person_id("(972) 977-7432")
    assert result == {"phone": "+19729777432"}
    print("✅ test_classify_phone_formatted passed")


def test_classify_email():
    """Email address."""
    result = _classify_person_id("john@example.com")
    assert result == {"email": "john@example.com"}
    print("✅ test_classify_email passed")


def test_classify_email_uppercase():
    """Email gets lowercased."""
    result = _classify_person_id("John@Example.COM")
    assert result == {"email": "john@example.com"}
    print("✅ test_classify_email_uppercase passed")


def test_classify_full_name():
    """Full name with first and last."""
    result = _classify_person_id("John Smith")
    assert result == {"first_name": "John", "last_name": "Smith"}
    print("✅ test_classify_full_name passed")


def test_classify_name_with_middle():
    """Name with middle name."""
    result = _classify_person_id("John William Smith")
    assert result == {"first_name": "John", "last_name": "William Smith"}
    print("✅ test_classify_name_with_middle passed")


# ================================================================
# Unit tests: helpers
# ================================================================

def test_format_messages_empty():
    assert _format_messages_for_context([]) == "No previous messages."
    print("✅ test_format_messages_empty passed")


def test_format_messages_with_data():
    msgs = [{"channel": "SMS", "from": "+1234", "to": "+5678", "timestamp": "2024-01-01", "message": "Hello"}]
    result = _format_messages_for_context(msgs)
    assert "SMS" in result
    assert "Hello" in result
    print("✅ test_format_messages_with_data passed")


def test_format_person_display():
    assert _format_person_display({"firstName": "John", "lastName": "Smith"}) == "John Smith"
    assert _format_person_display({"email": "a@b.com"}) == "a@b.com"
    assert _format_person_display({}) == "Unknown"
    print("✅ test_format_person_display passed")


def test_build_conversation_summary_empty():
    assert _build_conversation_summary([]) == "No conversation history."
    print("✅ test_build_conversation_summary_empty passed")


def test_build_conversation_summary_with_messages():
    ctx = [{"role": "USER", "text": "Hello"}, {"role": "ASSISTANT", "text": "Hi there"}]
    result = _build_conversation_summary(ctx)
    assert "[USER]: Hello" in result
    assert "[ASSISTANT]: Hi there" in result
    print("✅ test_build_conversation_summary_with_messages passed")


# ================================================================
# Integration tests: execute_tool error paths
# ================================================================

def _make_workflow_instance(**overrides):
    """Create a mock workflow instance with sensible defaults."""
    wi = MagicMock()
    wi.user_id = overrides.get("user_id", "user-123")
    wi.agent_id = overrides.get("agent_id", "agent-456")
    wi.model = overrides.get("model", "rose-labs/rose-1-lite")
    wi.system_name = overrides.get("system_name", "Rose")
    wi.context = overrides.get("context", [])
    wi._handle_tool_event = AsyncMock()
    return wi


async def test_missing_person_id():
    """Missing person_id → ERROR."""
    manager = MessagePersonManager()
    wi = _make_workflow_instance()
    events = []
    async for event in manager.execute_tool(wi, {"channel": "imessage", "intent": "say hi"}, "tc-1"):
        events.append(event)
    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "person_id" in events[0].message.lower()
    print("✅ test_missing_person_id passed")


async def test_invalid_channel():
    """Invalid channel → ERROR."""
    manager = MessagePersonManager()
    wi = _make_workflow_instance()
    events = []
    async for event in manager.execute_tool(wi, {"person_id": "John Smith", "channel": "fax", "intent": "hi"}, "tc-1"):
        events.append(event)
    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "channel" in events[0].message.lower()
    print("✅ test_invalid_channel passed")


async def test_missing_intent():
    """Missing intent → ERROR."""
    manager = MessagePersonManager()
    wi = _make_workflow_instance()
    events = []
    async for event in manager.execute_tool(wi, {"person_id": "John Smith", "channel": "imessage"}, "tc-1"):
        events.append(event)
    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "intent" in events[0].message.lower()
    print("✅ test_missing_intent passed")


@patch("tools.message_person.workflow")
async def test_multiple_matches(mock_workflow):
    """Multiple person matches → ERROR with disambiguation context."""
    mock_workflow.execute_activity = AsyncMock(return_value={
        "multiple_matches": True,
        "message": "Multiple people found with the name: John Smith",
        "matches": [
            {"firstName": "John", "lastName": "Smith", "email": "john1@test.com", "phoneNumber": "+1111", "messageCount": 5},
            {"firstName": "John", "lastName": "Smith", "email": "john2@test.com", "phoneNumber": "+2222", "messageCount": 3},
        ],
        "person": None,
        "messages": [],
    })

    manager = MessagePersonManager()
    wi = _make_workflow_instance()
    events = []
    async for event in manager.execute_tool(wi, {"person_id": "John Smith", "channel": "imessage", "intent": "say hi"}, "tc-1"):
        events.append(event)

    # Should have IN_PROGRESS (reading) then ERROR (ambiguous)
    assert any(e.status == MessageStatus.ERROR for e in events)
    error_event = [e for e in events if e.status == MessageStatus.ERROR][0]
    assert "Multiple people" in error_event.message
    assert "john1@test.com" in error_event.message
    assert "john2@test.com" in error_event.message
    print("✅ test_multiple_matches passed")


@patch("tools.message_person.workflow")
async def test_no_person_found(mock_workflow):
    """No person found → ERROR."""
    mock_workflow.execute_activity = AsyncMock(return_value={
        "person": None,
        "messages": [],
        "message": "No person found matching: John Nobody",
    })

    manager = MessagePersonManager()
    wi = _make_workflow_instance()
    events = []
    async for event in manager.execute_tool(wi, {"person_id": "John Nobody", "channel": "imessage", "intent": "say hi"}, "tc-1"):
        events.append(event)

    assert any(e.status == MessageStatus.ERROR for e in events)
    error_event = [e for e in events if e.status == MessageStatus.ERROR][0]
    assert "No person found" in error_event.message
    print("✅ test_no_person_found passed")


@patch("tools.message_person.workflow")
async def test_imessage_no_phone(mock_workflow):
    """iMessage channel but person has no phone → ERROR."""
    mock_workflow.execute_activity = AsyncMock(return_value={
        "person": {"firstName": "John", "lastName": "Smith", "email": "john@test.com"},
        "messages": [],
    })

    manager = MessagePersonManager()
    wi = _make_workflow_instance()
    events = []
    async for event in manager.execute_tool(wi, {"person_id": "John Smith", "channel": "imessage", "intent": "say hi"}, "tc-1"):
        events.append(event)

    assert any(e.status == MessageStatus.ERROR for e in events)
    error_event = [e for e in events if e.status == MessageStatus.ERROR][0]
    assert "No phone number" in error_event.message
    print("✅ test_imessage_no_phone passed")


@patch("tools.message_person.workflow")
async def test_email_no_email(mock_workflow):
    """Email channel but person has no email → ERROR."""
    mock_workflow.execute_activity = AsyncMock(return_value={
        "person": {"firstName": "John", "lastName": "Smith", "phoneNumber": "+19725551234"},
        "messages": [],
    })

    manager = MessagePersonManager()
    wi = _make_workflow_instance()
    events = []
    async for event in manager.execute_tool(wi, {"person_id": "John Smith", "channel": "email", "intent": "say hi"}, "tc-1"):
        events.append(event)

    assert any(e.status == MessageStatus.ERROR for e in events)
    error_event = [e for e in events if e.status == MessageStatus.ERROR][0]
    assert "No email address" in error_event.message
    print("✅ test_email_no_email passed")


def test_manager_singleton():
    """Singleton pattern works."""
    from tools.message_person import get_manager
    m1 = get_manager()
    m2 = get_manager()
    assert m1 is m2
    assert m1.tool_name == "message_person"
    print("✅ test_manager_singleton passed")


# ================================================================
# Full flow test (mocked activities)
# ================================================================

@patch("tools.message_person.request_user_approval_direct", new_callable=AsyncMock)
@patch("tools.message_person.workflow")
async def test_full_imessage_flow(mock_workflow, mock_approval):
    """Full happy path: resolve → enrich → generate → approve → send iMessage."""
    call_count = [0]

    async def mock_execute_activity(activity_fn, args=None, **kwargs):
        call_count[0] += 1
        name = getattr(activity_fn, "__name__", str(activity_fn))

        if "read_message_history" in name:
            return {
                "person": {"firstName": "Alice", "lastName": "Jones", "phoneNumber": "+19725551234", "email": "alice@test.com"},
                "messages": [{"channel": "SMS", "from": "+19725551234", "to": "+1000", "timestamp": "2024-01-01", "message": "Hey!"}],
            }
        elif "people_search" in name:
            return {"answer": "Alice Jones is a software engineer at Acme Corp."}
        elif "generate_message" in name:
            return {"message": "Hey Alice! Just wanted to check in and see how things are going.", "subject": None}
        elif "queue_imessage" in name:
            return {"success": True, "queue_id": "q-123"}
        return {}

    mock_workflow.execute_activity = AsyncMock(side_effect=mock_execute_activity)
    mock_approval.return_value = None  # Approved

    manager = MessagePersonManager()
    wi = _make_workflow_instance()
    events = []
    async for event in manager.execute_tool(wi, {
        "person_id": "Alice Jones",
        "channel": "imessage",
        "intent": "Check in and make sure they feel supported",
    }, "tc-1"):
        events.append(event)

    # Should have: IN_PROGRESS (reading) → IN_PROGRESS (enriching) → IN_PROGRESS (generating)
    #            → IN_PROGRESS (sending) → FINISHED
    statuses = [e.status for e in events]
    assert MessageStatus.FINISHED in statuses, f"Expected FINISHED in {statuses}"
    assert statuses.count(MessageStatus.IN_PROGRESS) >= 3  # reading, enriching, generating, sending

    # Verify approval was called
    mock_approval.assert_called_once()

    # Verify the finished event has the message
    finished = [e for e in events if e.status == MessageStatus.FINISHED][0]
    assert "Alice Jones" in finished.message
    print("✅ test_full_imessage_flow passed")


@patch("tools.message_person.request_user_approval_direct", new_callable=AsyncMock)
@patch("tools.message_person.workflow")
async def test_full_email_flow(mock_workflow, mock_approval):
    """Full happy path for email: resolve → generate → approve → send email."""
    async def mock_execute_activity(activity_fn, args=None, **kwargs):
        name = getattr(activity_fn, "__name__", str(activity_fn))

        if "read_message_history" in name:
            return {
                "person": {"firstName": "Bob", "lastName": "Lee", "phoneNumber": "+19725551234", "email": "bob@test.com"},
                "messages": [],
            }
        elif "people_search" in name:
            return {"answer": "Bob Lee is a VC at Capital Fund."}
        elif "generate_message" in name:
            return {"message": "Hi Bob,\n\nWanted to connect about Rose Labs.\n\nBest,\nRose", "subject": "Quick intro from Rose Labs"}
        elif "send_email" in name:
            return {"messageId": "msg-1", "threadId": "thread-1", "to": "bob@test.com", "subject": "Quick intro"}
        return {}

    mock_workflow.execute_activity = AsyncMock(side_effect=mock_execute_activity)
    mock_approval.return_value = None

    manager = MessagePersonManager()
    wi = _make_workflow_instance()
    events = []
    async for event in manager.execute_tool(wi, {
        "person_id": "Bob Lee",
        "channel": "email",
        "intent": "Get them interested in angel investing in Rose Labs",
    }, "tc-1"):
        events.append(event)

    statuses = [e.status for e in events]
    assert MessageStatus.FINISHED in statuses
    print("✅ test_full_email_flow passed")


# ================================================================
# Runner
# ================================================================

async def run_all_tests():
    print("\n" + "=" * 60)
    print("🧪 TESTING MESSAGE_PERSON (unified)")
    print("=" * 60 + "\n")

    try:
        # Sync tests
        test_classify_phone_e164()
        test_classify_phone_digits_only()
        test_classify_phone_formatted()
        test_classify_email()
        test_classify_email_uppercase()
        test_classify_full_name()
        test_classify_name_with_middle()
        test_format_messages_empty()
        test_format_messages_with_data()
        test_format_person_display()
        test_build_conversation_summary_empty()
        test_build_conversation_summary_with_messages()
        test_manager_singleton()

        # Async tests
        await test_missing_person_id()
        await test_invalid_channel()
        await test_missing_intent()
        await test_multiple_matches()
        await test_no_person_found()
        await test_imessage_no_phone()
        await test_email_no_email()
        await test_full_imessage_flow()
        await test_full_email_flow()

        print("\n✅ All message_person tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)
