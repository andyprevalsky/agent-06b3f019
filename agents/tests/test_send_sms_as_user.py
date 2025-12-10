"""Test send_sms_as_user tool (DISABLED)."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path
from unittest.mock import MagicMock

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


async def test_tool_is_disabled():
    """Test that send_sms_as_user returns disabled message."""
    manager = get_manager()
    workflow_instance = MagicMock()
    
    tool_call = {
        "phone_number": "+15551234567",
        "message": "Hello from Rose!",
    }
    
    events = []
    async for event in manager.execute_tool(workflow_instance, tool_call, "tool-123"):
        events.append(event)
    
    # Tool should return a single event saying it's disabled
    assert len(events) == 1
    assert events[0].status == MessageStatus.FINISHED
    assert "disabled" in events[0].title.lower() or "disabled" in events[0].message.lower()
    
    print("✅ test_tool_is_disabled passed")


async def run_all_tests():
    print("\n" + "="*60)
    print("🧪 TESTING SEND_SMS_AS_USER (DISABLED)")
    print("="*60 + "\n")
    
    try:
        await test_manager_singleton()
        await test_tool_is_disabled()
        
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
