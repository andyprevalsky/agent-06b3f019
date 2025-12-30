"""Standalone test for browser-use BrowserSession with Browserbase.

This bypasses the agent code and tests browser-use directly.
"""

import asyncio
import os
from dotenv import load_dotenv

load_dotenv()


async def test_browser_use_connection():
    """Test connecting browser-use BrowserSession to Browserbase via CDP."""
    from browserbase import Browserbase
    from browser_use.browser.session import BrowserSession
    from browser_use.browser.profile import BrowserProfile
    
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
    
    # Connect browser-use BrowserSession via CDP
    print("\n🔌 Connecting browser-use BrowserSession...")
    
    profile = BrowserProfile(
        cdp_url=ws_url,
        is_local=False,
    )
    
    browser_session = BrowserSession(browser_profile=profile)
    
    try:
        await browser_session.start()
        print("✅ BrowserSession started!")
        
        # Get browser state
        print("\n📄 Getting browser state...")
        state = await browser_session.get_browser_state_summary(include_screenshot=True)
        
        print(f"  URL: {state.url}")
        print(f"  Title: {getattr(state, 'title', 'N/A')}")
        print(f"  Screenshot: {'Yes' if state.screenshot else 'No'}")
        
        if state.dom_state:
            selector_map = state.dom_state.selector_map or {}
            print(f"  DOM elements: {len(selector_map)}")
            
            # Get LLM representation
            llm_repr = state.dom_state.llm_representation()
            print(f"\n📋 DOM Tree (first 800 chars):\n{llm_repr[:800]}...")
        
        # Navigate to a test page
        print("\n🔗 Navigating to example.com...")
        from browser_use.browser.events import NavigateToUrlEvent
        event = browser_session.event_bus.dispatch(NavigateToUrlEvent(url="https://example.com"))
        await event
        await asyncio.sleep(2)
        
        # Get updated state
        print("\n📄 Getting updated browser state...")
        state = await browser_session.get_browser_state_summary(include_screenshot=True)
        
        print(f"  URL: {state.url}")
        if state.dom_state:
            selector_map = state.dom_state.selector_map or {}
            print(f"  DOM elements: {len(selector_map)}")
            llm_repr = state.dom_state.llm_representation()
            print(f"\n📋 DOM Tree:\n{llm_repr[:1000]}...")
        
        print("\n✅ Test completed successfully!")
        return True
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False
        
    finally:
        print("\n🔌 Closing Browserbase session...")
        bb.sessions.update(session.id, project_id=project_id, status="REQUEST_RELEASE")
        print("✅ Session closed")


async def test_click_action():
    """Test clicking an element using browser-use events."""
    from browserbase import Browserbase
    from browser_use.browser.session import BrowserSession
    from browser_use.browser.profile import BrowserProfile
    from browser_use.browser.events import NavigateToUrlEvent, ClickElementEvent
    
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    project_id = os.environ.get("BROWSERBASE_PROJECT_ID")
    
    if not api_key or not project_id:
        print("❌ Missing env vars")
        return False
    
    print("🌐 Creating session for click test...")
    bb = Browserbase(api_key=api_key)
    session = bb.sessions.create(project_id=project_id)
    debug_info = bb.sessions.debug(session.id)
    
    profile = BrowserProfile(cdp_url=debug_info.ws_url, is_local=False)
    browser_session = BrowserSession(browser_profile=profile)
    
    try:
        await browser_session.start()
        
        # Navigate
        print("🔗 Navigating to example.com...")
        event = browser_session.event_bus.dispatch(NavigateToUrlEvent(url="https://example.com"))
        await event
        await asyncio.sleep(2)
        
        # Get state and find a clickable element
        state = await browser_session.get_browser_state_summary()
        if not state.dom_state or not state.dom_state.selector_map:
            print("❌ No DOM state")
            return False
        
        selector_map = state.dom_state.selector_map
        print(f"📋 Found {len(selector_map)} elements")
        
        # Find the "More information..." link
        target_element = None
        for index, element in selector_map.items():
            text = getattr(element, 'text_content', '') or ''
            if 'more information' in text.lower():
                target_element = element
                print(f"🎯 Found target: [{index}] {element.tag_name} '{text[:50]}'")
                break
        
        if not target_element:
            # Just click the first link
            for index, element in selector_map.items():
                if element.tag_name == 'a':
                    target_element = element
                    print(f"🎯 Using first link: [{index}] {element.tag_name}")
                    break
        
        if target_element:
            print("👆 Clicking element...")
            click_event = browser_session.event_bus.dispatch(ClickElementEvent(node=target_element))
            await click_event
            await click_event.event_result(raise_if_any=True, raise_if_none=False)
            
            await asyncio.sleep(2)
            
            # Get new state
            new_state = await browser_session.get_browser_state_summary()
            print(f"✅ After click, URL: {new_state.url}")
        
        return True
        
    finally:
        bb.sessions.update(session.id, project_id=project_id, status="REQUEST_RELEASE")
        print("✅ Session closed")


async def main():
    print("\n" + "="*60)
    print("🧪 STANDALONE BROWSER-USE + BROWSERBASE TEST")
    print("="*60)
    
    print("\n--- Test 1: Browser Connection & DOM ---\n")
    result1 = await test_browser_use_connection()
    
    if result1:
        print("\n--- Test 2: Click Action ---\n")
        result2 = await test_click_action()
    else:
        result2 = False
    
    print("\n" + "="*60)
    if result1 and result2:
        print("✅ All tests passed!")
    else:
        print(f"❌ Results: Connection={result1}, Click={result2}")
    print("="*60)


if __name__ == "__main__":
    asyncio.run(main())

