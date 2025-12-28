"""
Minimal test to validate Stagehand's observe() works with Rose API.
Actually launches a browser and runs observe on a real page.
"""
import asyncio
import os
import sys
from pathlib import Path

# Add parent to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv()


async def test_observe_with_rose():
    """Test Stagehand observe() with Rose LLM on a real page."""
    print("\n" + "="*60)
    print("🧪 TEST: Stagehand observe() with Rose LLM")
    print("="*60)
    
    import litellm
    from stagehand import Stagehand, StagehandConfig
    
    rose_api_key = os.getenv("ROSE_API_KEY")
    rose_api_url = os.getenv("ROSE_API_URL", "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")
    base_url = rose_api_url.replace("/completions", "")
    browserbase_api_key = os.getenv("BROWSERBASE_API_KEY")
    browserbase_project_id = os.getenv("BROWSERBASE_PROJECT_ID")
    
    print(f"ROSE_API_KEY: {'✅ SET' if rose_api_key else '❌ NOT SET'}")
    print(f"SUPABASE_ANON_KEY: {'✅ SET' if supabase_anon_key else '❌ NOT SET'}")
    print(f"BROWSERBASE_API_KEY: {'✅ SET' if browserbase_api_key else '❌ NOT SET'}")
    print(f"Base URL: {base_url}")
    
    if not all([rose_api_key, supabase_anon_key, browserbase_api_key, browserbase_project_id]):
        print("❌ Missing required env vars!")
        return False
    
    # KEY FIX #1: Use openai/ provider instead of openrouter/
    # openrouter/ overwrites Authorization header with its own api_key
    # openai/ passes through extra_headers correctly
    
    # KEY FIX #2: Set litellm.headers globally BEFORE initializing Stagehand
    # Stagehand's LLMClient ignores extra_headers in model_client_options
    litellm.headers = {
        "Authorization": f"Bearer {supabase_anon_key}",
        "x-api-key": rose_api_key,
    }
    print(f"✅ Set litellm.headers globally")
    
    # Config with openai/ provider (NOT openrouter/)
    config = StagehandConfig(
        env="BROWSERBASE",
        api_key=browserbase_api_key,
        project_id=browserbase_project_id,
        model_name="openai/rose-1-ultra",  # FIXED: openai/ not openrouter/
        model_api_key="unused",  # Not used with openai/ provider + litellm.headers
        model_client_options={
            "baseURL": base_url,
        },
        use_api=False,  # Local LLM calls via litellm → Rose
        verbose=2,
    )
    
    print(f"\n📦 Stagehand Config:")
    print(f"  model_name: {config.model_name}")
    print(f"  use_api: {config.use_api}")
    print(f"  baseURL: {base_url}")
    
    stagehand = None
    try:
        print(f"\n🚀 Initializing Stagehand...")
        stagehand = Stagehand(config)
        await stagehand.init()
        print(f"✅ Stagehand initialized")
        
        # Navigate to a simple page
        url = "https://www.google.com"
        print(f"\n🌐 Navigating to {url}...")
        await stagehand.page.goto(url)
        await asyncio.sleep(2)  # Wait for page to fully load
        print(f"✅ Page loaded")
        
        # Test observe
        print(f"\n🔍 Running observe()...")
        instruction = "Find the search input box"
        print(f"  Instruction: {instruction}")
        
        results = await stagehand.page.observe(
            instruction=instruction,
            draw_overlay=True
        )
        
        print(f"\n📊 Observe Results:")
        print(f"  Type: {type(results)}")
        print(f"  Length: {len(results) if results else 0}")
        
        if results:
            for i, result in enumerate(results):
                print(f"\n  Result {i+1}:")
                print(f"    {result}")
            print(f"\n✅ observe() worked! Found {len(results)} element(s)")
            return True
        else:
            print(f"\n❌ observe() returned no results")
            return False
            
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        if stagehand:
            print(f"\n🧹 Cleaning up...")
            try:
                await stagehand.close()
                print(f"✅ Stagehand closed")
            except:
                pass


async def test_observe_debug():
    """Debug version - test the raw LLM call that observe uses internally."""
    print("\n" + "="*60)
    print("🧪 DEBUG: Raw LLM call for observe")
    print("="*60)
    
    import litellm
    
    rose_api_key = os.getenv("ROSE_API_KEY")
    rose_api_url = os.getenv("ROSE_API_URL", "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")
    base_url = rose_api_url.replace("/completions", "")
    
    # Set global headers - required because Stagehand's LLMClient ignores extra_headers
    litellm.headers = {
        "Authorization": f"Bearer {supabase_anon_key}",
        "x-api-key": rose_api_key,
    }
    print(f"✅ Set litellm.headers globally")
    
    # Simulate what Stagehand's observe does - it sends the DOM/aria tree to the LLM
    # and asks it to identify elements matching the instruction
    
    test_prompt = """You are analyzing a webpage. Here is a simplified DOM structure:

<html>
  <body>
    <header>
      <nav>
        <a href="/products">Products</a>
        <a href="/about">About</a>
      </nav>
    </header>
    <main>
      <input type="search" placeholder="Search..." id="search-box" />
      <button>Search</button>
    </main>
  </body>
</html>

User instruction: "Find the search input box"

Return a JSON array of elements that match. Each element should have:
- selector: CSS selector to find the element
- description: Brief description of what the element is

Example response format:
[{"selector": "#search-box", "description": "Search input field"}]
"""
    
    try:
        print(f"Sending test prompt to Rose LLM...")
        response = await litellm.acompletion(
            model="openai/rose-1-ultra",  # Use openai/ provider (not openrouter/)
            messages=[{"role": "user", "content": test_prompt}],
            max_tokens=500,
            temperature=0.1,
            api_key="unused",  # Auth via litellm.headers
            api_base=base_url,
        )
        
        content = response.choices[0].message.content
        print(f"\n✅ Response from LLM:")
        print(content)
        print(f"\n✅ Model used: {response.model}")
        return True
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


async def main():
    print("\n" + "="*60)
    print("🧪 STAGEHAND OBSERVE() TEST WITH ROSE")
    print("="*60)
    
    results = []
    
    # Test 1: Debug LLM call
    results.append(("Debug LLM call", await test_observe_debug()))
    
    # Test 2: Full observe test
    results.append(("Full observe()", await test_observe_with_rose()))
    
    print("\n" + "="*60)
    print("📊 RESULTS")
    print("="*60)
    for name, passed in results:
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"  {name}: {status}")
    
    all_passed = all(r[1] for r in results)
    print("\n" + ("✅ All tests passed!" if all_passed else "❌ Some tests failed"))
    return all_passed


if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)

