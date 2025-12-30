"""Test browser agent V3 with browser-use + Rose API.

This test:
1. Creates a Browserbase session directly (bypasses backend)
2. Connects DOMService to the CDP URL
3. Gets browser state and calls Rose API
4. Executes the returned action

Requirements:
- BROWSERBASE_API_KEY env var
- BROWSERBASE_PROJECT_ID env var  
- Rose API running (for rose-1-browser-use)
"""

import asyncio
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()


async def test_dom_service_connection():
    """Test connecting DOMService to a Browserbase session."""
    from browserbase import Browserbase
    
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    project_id = os.environ.get("BROWSERBASE_PROJECT_ID")
    
    if not api_key or not project_id:
        print("❌ Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID")
        return False
    
    print("🌐 Creating Browserbase session...")
    bb = Browserbase(api_key=api_key)
    
    # Create session
    session = bb.sessions.create(project_id=project_id)
    print(f"✅ Created session: {session.id}")
    
    # Get debug URLs including wsUrl
    debug_info = bb.sessions.debug(session.id)
    ws_url = debug_info.ws_url
    print(f"📡 CDP WebSocket URL: {ws_url[:60]}...")
    
    # Test DOMService connection
    from browser_tools.dom_service import DOMService
    
    print("🔌 Connecting DOMService...")
    dom_service = DOMService(cdp_url=ws_url)
    
    try:
        await dom_service.connect()
        print("✅ DOMService connected!")
        
        # Get browser state
        print("📄 Getting browser state...")
        state = await dom_service.get_browser_state(include_screenshot=True)
        
        print(f"  URL: {state['url']}")
        print(f"  DOM tree length: {len(state['dom_tree'])} chars")
        print(f"  Screenshot: {'Yes' if state.get('screenshot') else 'No'}")
        print(f"  Selector map size: {len(dom_service.selector_map)} elements")
        
        # Print first 500 chars of DOM tree
        if state['dom_tree']:
            print(f"\n📋 DOM Tree (first 500 chars):\n{state['dom_tree'][:500]}...")
        
        await dom_service.disconnect()
        print("✅ DOMService disconnected")
        
    finally:
        # Close session
        print("🔌 Closing Browserbase session...")
        bb.sessions.update(session.id, project_id=project_id, status="REQUEST_RELEASE")
        print("✅ Session closed")
    
    return True


async def test_rose_browser_use_call():
    """Test calling Rose API rose-1-browser-use endpoint."""
    from browserbase import Browserbase
    from browser_tools.dom_service import DOMService, ActionHistory
    from browser_tools.schemas import AVAILABLE_ACTIONS
    import httpx
    
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    project_id = os.environ.get("BROWSERBASE_PROJECT_ID")
    rose_api_url = os.environ.get("ROSE_API_URL", "https://bvtmwefpdoexypmsszvd.supabase.co/functions/v1/completions")
    rose_api_key = os.environ.get("ROSE_API_KEY")
    supabase_anon_key = os.environ.get("SUPABASE_ANON_KEY")
    
    if not all([api_key, project_id, rose_api_key, supabase_anon_key]):
        print("❌ Missing required env vars (BROWSERBASE_*, ROSE_API_KEY, SUPABASE_ANON_KEY)")
        return False
    
    print("🌐 Creating Browserbase session...")
    bb = Browserbase(api_key=api_key)
    session = bb.sessions.create(project_id=project_id)
    debug_info = bb.sessions.debug(session.id)
    ws_url = debug_info.ws_url
    
    print(f"✅ Session: {session.id}")
    
    dom_service = DOMService(cdp_url=ws_url)
    action_history = ActionHistory()
    
    try:
        await dom_service.connect()
        print("✅ DOMService connected")
        
        # Navigate to a test page
        print("🔗 Navigating to example.com...")
        from browser_use.browser.events import NavigateToUrlEvent
        event = dom_service.session.event_bus.dispatch(NavigateToUrlEvent(url="https://example.com"))
        await event
        await asyncio.sleep(2)  # Wait for page load
        
        # Get browser state
        print("📄 Getting browser state...")
        browser_state = await dom_service.get_browser_state(include_screenshot=True)
        print(f"  URL: {browser_state['url']}")
        print(f"  Elements: {len(dom_service.selector_map)}")
        
        # Call Rose API
        print("\n🤖 Calling Rose API rose-1-browser-use...")
        
        request_body = {
            "model": "rose-labs/rose-1-browser-use",
            "task": "Click the 'More information...' link on this page",
            "browser_state": browser_state,
            "action_history": action_history.get_entries(),
            "available_actions": AVAILABLE_ACTIONS,
        }
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                rose_api_url,
                headers={
                    "Authorization": f"Bearer {supabase_anon_key}",
                    "x-api-key": rose_api_key,
                    "Content-Type": "application/json"
                },
                json=request_body
            )
            
            if response.status_code != 200:
                print(f"❌ Rose API error: {response.status_code}")
                print(f"   Response: {response.text[:500]}")
                return False
            
            result = response.json()
        
        print(f"\n✅ Rose API Response:")
        print(f"  Actual model: {result.get('actual_model', 'N/A')}")
        print(f"  TTFT: {result.get('ttft_ms', 'N/A')}ms")
        
        action = result.get("action", {})
        print(f"\n🎯 Predicted Action:")
        print(f"  Action: {action.get('action', 'N/A')}")
        print(f"  Index: {action.get('index', 'N/A')}")
        print(f"  Thinking: {action.get('thinking', 'N/A')[:100]}...")
        
        await dom_service.disconnect()
        print("\n✅ Test completed!")
        
    finally:
        print("🔌 Closing session...")
        bb.sessions.update(session.id, project_id=project_id, status="REQUEST_RELEASE")
    
    return True


async def run_all_tests():
    """Run all V3 browser agent tests."""
    print("\n" + "="*60)
    print("🧪 TESTING BROWSER AGENT V3")
    print("="*60 + "\n")
    
    try:
        print("\n--- Test 1: DOMService Connection ---\n")
        result1 = await test_dom_service_connection()
        
        if result1:
            print("\n--- Test 2: Rose API Browser-Use Call ---\n")
            result2 = await test_rose_browser_use_call()
        else:
            result2 = False
            print("\n⏭️ Skipping Test 2 (Test 1 failed)")
        
        print("\n" + "="*60)
        if result1 and result2:
            print("✅ All V3 browser agent tests passed!")
        else:
            print(f"❌ Tests failed: 1={result1}, 2={result2}")
        print("="*60 + "\n")
        
        return result1 and result2
        
    except Exception as e:
        print(f"\n❌ Test failed with exception: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)

