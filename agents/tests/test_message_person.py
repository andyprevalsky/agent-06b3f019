"""Test message_person tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.message_person import (
    _normalize_phone,
    _normalize_email,
    _check_read_history_in_context,
    MessagePersonManager
)


def test_normalize_phone():
    """Test phone number normalization."""
    assert _normalize_phone("+1 (972) 977-7432") == "+19729777432"
    assert _normalize_phone("972-977-7432") == "9729777432"
    assert _normalize_phone("+19729777432") == "+19729777432"
    assert _normalize_phone(None) is None
    assert _normalize_phone("") is None
    
    print("✅ test_normalize_phone passed")


def test_normalize_email():
    """Test email normalization."""
    assert _normalize_email("John@Example.com") == "john@example.com"
    assert _normalize_email("  bob@test.com  ") == "bob@test.com"
    assert _normalize_email(None) is None
    assert _normalize_email("") is None
    
    print("✅ test_normalize_email passed")


def test_check_read_history_in_context_by_phone():
    """Test context check for read history by phone."""
    context = [
        {
            "role": "TOOL",
            "text": "Found 5 messages",
            "metadata": {
                "read_message_history_person": {
                    "phone": "+19729777432",
                    "email": None,
                    "first_name": None,
                    "last_name": None,
                    "person_id": "person-123",
                    "person_phone": "+19729777432",
                    "person_email": "john@example.com"
                }
            }
        }
    ]
    
    # Match by phone
    found, info = _check_read_history_in_context(context, phone="+19729777432")
    assert found is True
    assert info is not None
    assert info["person_id"] == "person-123"
    
    # Match with different format
    found, info = _check_read_history_in_context(context, phone="+1 (972) 977-7432")
    assert found is True
    
    # No match - different phone
    found, info = _check_read_history_in_context(context, phone="+14155551234")
    assert found is False
    
    print("✅ test_check_read_history_in_context_by_phone passed")


def test_check_read_history_in_context_by_email():
    """Test context check for read history by email."""
    context = [
        {
            "role": "TOOL",
            "text": "Found 3 messages",
            "metadata": {
                "read_message_history_person": {
                    "phone": None,
                    "email": "bob@example.com",
                    "first_name": None,
                    "last_name": None,
                    "person_id": "person-456",
                    "person_phone": None,
                    "person_email": "bob@example.com"
                }
            }
        }
    ]
    
    # Match by email (case insensitive)
    found, info = _check_read_history_in_context(context, email="Bob@Example.com")
    assert found is True
    assert info["person_id"] == "person-456"
    
    # No match
    found, info = _check_read_history_in_context(context, email="other@example.com")
    assert found is False
    
    print("✅ test_check_read_history_in_context_by_email passed")


def test_check_read_history_in_context_by_name():
    """Test context check for read history by name."""
    context = [
        {
            "role": "TOOL",
            "text": "Found 2 messages",
            "metadata": {
                "read_message_history_person": {
                    "phone": None,
                    "email": None,
                    "first_name": "Alice",
                    "last_name": "Johnson",
                    "person_id": "person-789",
                    "person_phone": "+14155559999",
                    "person_email": "alice@example.com"
                }
            }
        }
    ]
    
    # Match by name (case insensitive)
    found, info = _check_read_history_in_context(
        context, first_name="alice", last_name="JOHNSON"
    )
    assert found is True
    assert info["person_id"] == "person-789"
    
    # No match - wrong last name
    found, info = _check_read_history_in_context(
        context, first_name="Alice", last_name="Smith"
    )
    assert found is False
    
    print("✅ test_check_read_history_in_context_by_name passed")


def test_check_read_history_no_metadata():
    """Test context check when no read_message_history_person metadata exists."""
    context = [
        {"role": "USER", "text": "Send a message to John"},
        {"role": "ASSISTANT", "text": "I'll help you with that"},
        {"role": "TOOL", "text": "Search complete", "metadata": {"toolName": "web_search"}}
    ]
    
    found, info = _check_read_history_in_context(context, phone="+19729777432")
    assert found is False
    assert info is None
    
    print("✅ test_check_read_history_no_metadata passed")


def test_manager_singleton():
    """Test that manager singleton works correctly."""
    from tools.message_person import get_manager
    
    manager1 = get_manager()
    manager2 = get_manager()
    
    assert manager1 is manager2
    assert manager1.tool_name == "message_person"
    
    print("✅ test_manager_singleton passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING MESSAGE_PERSON")
    print("="*60 + "\n")
    
    try:
        # Sync tests
        test_normalize_phone()
        test_normalize_email()
        test_check_read_history_in_context_by_phone()
        test_check_read_history_in_context_by_email()
        test_check_read_history_in_context_by_name()
        test_check_read_history_no_metadata()
        test_manager_singleton()
        
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





