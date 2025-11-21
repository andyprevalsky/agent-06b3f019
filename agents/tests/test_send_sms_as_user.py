"""Test send_sms_as_user tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from tools.send_sms_as_user import get_manager, SendSmsAsUserManager
from tools.base import EventType, MessageStatus


async def test_manager_singleton():
    manager1 = get_manager()
    manager2 = get_manager()
    
    assert manager1 is manager2
    assert isinstance(manager1, SendSmsAsUserManager)
    assert manager1.tool_name == "send_sms_as_user"
    
    print("✅ test_manager_singleton passed")


async def test_execute_tool_success():
    manager = get_manager()
    workflow_instance = MagicMock()
    
    tool_call = {
        "phone_number": "+15551234567",
        "message": "Hello from Rose!",
    }
    
    with patch('tools.send_sms_as_user.request_user_attention_direct', new_callable=AsyncMock) as mock_attention:
        mock_attention.return_value = {"response": "Sent"}
        
        events = []
        async for event in manager.execute_tool(workflow_instance, tool_call, "tool-123"):
            events.append(event)
        
        assert len(events) == 2
        assert events[0].status == MessageStatus.IN_PROGRESS
        assert events[1].status == MessageStatus.FINISHED
        
        mock_attention.assert_awaited_once()
        _, kwargs = mock_attention.call_args
        metadata = kwargs.get("metadata")
        assert metadata["onSuccess"] == "sendSmsThroughIMessage"
        assert metadata["to"] == "+15551234567"
        assert metadata["message"] == "Hello from Rose!"
    
    print("✅ test_execute_tool_success passed")


async def test_execute_tool_missing_phone():
    manager = get_manager()
    workflow_instance = MagicMock()
    
    tool_call = {
        "message": "Hello!",
    }
    
    events = []
    async for event in manager.execute_tool(workflow_instance, tool_call, "tool-123"):
        events.append(event)
    
    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "Missing phone number" in events[0].title
    
    print("✅ test_execute_tool_missing_phone passed")


async def test_execute_tool_missing_message():
    manager = get_manager()
    workflow_instance = MagicMock()
    
    tool_call = {
        "phone_number": "+15551234567",
    }
    
    events = []
    async for event in manager.execute_tool(workflow_instance, tool_call, "tool-123"):
        events.append(event)
    
    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "Missing message" in events[0].title
    
    print("✅ test_execute_tool_missing_message passed")


async def test_execute_tool_attention_failure():
    manager = get_manager()
    workflow_instance = MagicMock()
    
    tool_call = {
        "phone_number": "+15551234567",
        "message": "Hello!",
    }
    
    with patch('tools.send_sms_as_user.request_user_attention_direct', new_callable=AsyncMock) as mock_attention:
        mock_attention.side_effect = Exception("API unavailable")
        
        events = []
        try:
            async for event in manager.execute_tool(workflow_instance, tool_call, "tool-123"):
                events.append(event)
        except Exception as exc:
            assert "API unavailable" in str(exc)
        
        assert len(events) == 2
        assert events[-1].status == MessageStatus.ERROR
        assert "Failed to request approval" in events[-1].title
    
    print("✅ test_execute_tool_attention_failure passed")


async def run_all_tests():
    print("\n" + "="*60)
    print("🧪 TESTING SEND_SMS_AS_USER")
    print("="*60 + "\n")
    
    try:
        await test_manager_singleton()
        await test_execute_tool_success()
        await test_execute_tool_missing_phone()
        await test_execute_tool_missing_message()
        await test_execute_tool_attention_failure()
        
        print("\n✅ All send_sms_as_user tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)



