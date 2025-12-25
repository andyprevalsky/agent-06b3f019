"""
Minimal test to validate Stagehand LLM config with Rose API.
Tests the exact path that Stagehand uses internally.
"""
import asyncio
import os
import sys
from pathlib import Path

# Add parent to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv()

import litellm


async def test_litellm_direct():
    """Test litellm with openrouter/ prefix pointing to Rose API via /chat/completions proxy."""
    print("\n" + "="*60)
    print("TEST 1: litellm → Rose via /chat/completions proxy")
    print("="*60)
    
    rose_api_key = os.getenv("ROSE_API_KEY")
    rose_api_url = os.getenv("ROSE_API_URL", "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")
    base_url = rose_api_url.replace("/completions", "")
    
    print(f"ROSE_API_KEY: {'✅ SET' if rose_api_key else '❌ NOT SET'}")
    print(f"SUPABASE_ANON_KEY: {'✅ SET' if supabase_anon_key else '❌ NOT SET'}")
    print(f"Base URL: {base_url}")
    print(f"Endpoint: {base_url}/chat/completions (proxies to /completions)")
    
    if not rose_api_key:
        print("❌ ROSE_API_KEY not set!")
        return False
    
    try:
        response = await litellm.acompletion(
            model="openrouter/rose-1-ultra",  # Rose pool via openrouter/ provider
            messages=[{"role": "user", "content": "Say 'hello' and nothing else."}],
            max_tokens=50,  # Min is 16 for some models
            temperature=1,
            api_key=rose_api_key,
            api_base=base_url,
            extra_headers={
                "Authorization": f"Bearer {supabase_anon_key}",
                "x-api-key": rose_api_key,
            }
        )
        print(f"✅ Response: {response.choices[0].message.content}")
        print(f"✅ Model used: {response.model}")
        return True
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


async def test_stagehand_llm_client():
    """Test Stagehand's LLMClient class with Rose via /chat/completions proxy."""
    print("\n" + "="*60)
    print("TEST 2: Stagehand LLMClient → Rose")
    print("="*60)
    
    from stagehand.llm.client import LLMClient
    from stagehand.logging import StagehandLogger
    
    rose_api_key = os.getenv("ROSE_API_KEY")
    rose_api_url = os.getenv("ROSE_API_URL", "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")
    base_url = rose_api_url.replace("/completions", "")
    
    print(f"ROSE_API_KEY: {'✅ SET' if rose_api_key else '❌ NOT SET'}")
    
    if not rose_api_key:
        print("❌ ROSE_API_KEY not set!")
        return False
    
    # Create logger
    logger = StagehandLogger(verbose=2)
    
    # Create LLMClient with Rose config (same as spawn_browser_agent.py)
    llm_client = LLMClient(
        stagehand_logger=logger,
        api_key=rose_api_key,
        default_model="openrouter/rose-1-ultra",
        baseURL=base_url,
    )
    
    try:
        response = await llm_client.create_response(
            messages=[{"role": "user", "content": "Say 'test passed' and nothing else."}],
            max_tokens=50,
            temperature=1,
            extra_headers={
                "Authorization": f"Bearer {supabase_anon_key}",
                "x-api-key": rose_api_key,
            }
        )
        content = response.choices[0].message.content
        print(f"\n✅ Response: {content}")
        print(f"✅ Model used: {response.model}")
        return True
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


async def test_full_stagehand_config():
    """Test full Stagehand config with Rose (use_api=False)."""
    print("\n" + "="*60)
    print("TEST 3: Full Stagehand config with Rose")
    print("="*60)
    
    from stagehand import Stagehand, StagehandConfig
    
    rose_api_key = os.getenv("ROSE_API_KEY")
    rose_api_url = os.getenv("ROSE_API_URL", "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")
    base_url = rose_api_url.replace("/completions", "")
    browserbase_api_key = os.getenv("BROWSERBASE_API_KEY")
    browserbase_project_id = os.getenv("BROWSERBASE_PROJECT_ID")
    
    print(f"ROSE_API_KEY: {'✅ SET' if rose_api_key else '❌ NOT SET'}")
    print(f"BROWSERBASE_API_KEY: {'✅ SET' if browserbase_api_key else '❌ NOT SET'}")
    print(f"use_api: False (local LLM calls via Rose)")
    
    # Config exactly as spawn_browser_agent.py does
    config = StagehandConfig(
        env="BROWSERBASE",
        api_key=browserbase_api_key,
        project_id=browserbase_project_id,
        model_name="openrouter/rose-1-ultra",  # Rose pool via openrouter/ provider
        model_api_key=rose_api_key,
        model_client_options={
            "baseURL": base_url,
            "extra_headers": {
                "Authorization": f"Bearer {supabase_anon_key}",
                "x-api-key": rose_api_key,
            },
        },
        use_api=False,  # Local LLM calls via litellm → Rose
        verbose=2,
    )
    
    print(f"\nConfig created successfully")
    print(f"  model_name: {config.model_name}")
    print(f"  model_api_key: {'✅ SET' if config.model_api_key else '❌ NOT SET'}")
    print(f"  model_client_options: baseURL={base_url}")
    print(f"  use_api: {config.use_api}")
    
    if config.use_api == False and config.model_api_key:
        print("\n✅ Config correct - Stagehand will use litellm → Rose for observe/act/extract")
        return True
    else:
        print("\n❌ Config issue")
        return False


async def main():
    print("\n" + "="*60)
    print("🧪 STAGEHAND + ROSE API INTEGRATION TEST")
    print("="*60)
    
    results = []
    
    # Test 1: Direct litellm
    results.append(("litellm direct", await test_litellm_direct()))
    
    # Test 2: Stagehand LLMClient
    results.append(("Stagehand LLMClient", await test_stagehand_llm_client()))
    
    # Test 3: Full config
    results.append(("Full Stagehand config", await test_full_stagehand_config()))
    
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

