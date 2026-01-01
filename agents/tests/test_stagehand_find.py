"""
Test Stagehand find/observe performance on Amazon.com.
Measures timing at each step to identify bottlenecks.
"""
import asyncio
import os
import sys
import time
from pathlib import Path

# Add parent to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv()


def format_duration(seconds: float) -> str:
    """Format duration in human readable form."""
    if seconds < 1:
        return f"{seconds * 1000:.0f}ms"
    return f"{seconds:.2f}s"


async def test_find_on_amazon():
    """Test Stagehand observe() performance on Amazon.com."""
    print("\n" + "=" * 70)
    print("🧪 TEST: Stagehand find/observe() on Amazon.com")
    print("=" * 70)

    import litellm
    from stagehand import Stagehand, StagehandConfig

    # Load env vars
    rose_api_key = os.getenv("ROSE_API_KEY")
    rose_api_url = os.getenv("ROSE_API_URL", "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")
    base_url = rose_api_url.replace("/completions", "")
    browserbase_api_key = os.getenv("BROWSERBASE_API_KEY")
    browserbase_project_id = os.getenv("BROWSERBASE_PROJECT_ID")

    print(f"\n📋 Environment:")
    print(f"  ROSE_API_KEY: {'✅ SET' if rose_api_key else '❌ NOT SET'}")
    print(f"  SUPABASE_ANON_KEY: {'✅ SET' if supabase_anon_key else '❌ NOT SET'}")
    print(f"  BROWSERBASE_API_KEY: {'✅ SET' if browserbase_api_key else '❌ NOT SET'}")
    print(f"  Base URL: {base_url}")

    if not all([rose_api_key, supabase_anon_key, browserbase_api_key, browserbase_project_id]):
        print("❌ Missing required env vars!")
        return False

    # Set litellm headers globally (required for Stagehand)
    litellm.headers = {
        "Authorization": f"Bearer {supabase_anon_key}",
        "x-api-key": rose_api_key,
    }
    print(f"  ✅ Set litellm.headers globally")

    # Stagehand config
    config = StagehandConfig(
        env="BROWSERBASE",
        api_key=browserbase_api_key,
        project_id=browserbase_project_id,
        model_name="openai/rose-1-ultra",
        model_api_key="unused",
        model_client_options={
            "baseURL": base_url,
        },
        use_api=False,
        verbose=2,  # Set to 2 for detailed logs
    )

    timings = {}
    stagehand = None

    try:
        # Step 1: Initialize Stagehand
        print(f"\n⏱️  STEP 1: Initialize Stagehand")
        start = time.time()
        stagehand = Stagehand(config)
        await stagehand.init()
        timings["init"] = time.time() - start
        print(f"  ✅ Done in {format_duration(timings['init'])}")

        # Step 2: Navigate to Amazon
        print(f"\n⏱️  STEP 2: Navigate to Amazon.com")
        start = time.time()
        await stagehand.page.goto("https://www.amazon.com")
        await asyncio.sleep(2)  # Wait for page to stabilize
        timings["navigate"] = time.time() - start
        print(f"  ✅ Done in {format_duration(timings['navigate'])}")

        # Step 3: Search for a product
        print(f"\n⏱️  STEP 3: Search for 'Carhartt beanie'")
        start = time.time()

        # Find search box
        search_results = await stagehand.page.observe(
            instruction="Find the search input box",
            draw_overlay=False
        )

        if search_results:
            search_selector = search_results[0].selector
            print(f"  Found search box: {search_selector}")

            # Type search query
            await stagehand.page.locator(search_selector).fill("Carhartt beanie black")
            await stagehand.page.keyboard.press("Enter")
            await asyncio.sleep(3)  # Wait for results to load

        timings["search"] = time.time() - start
        print(f"  ✅ Done in {format_duration(timings['search'])}")

        # Step 4: Run the main observe test (this is what we're debugging)
        print(f"\n⏱️  STEP 4: Run observe() to find product (THE MAIN TEST)")
        print(f"  Instruction: Find Carhartt black beanie with price under $35")

        # Capture metrics before
        metrics_before = stagehand.metrics
        prompt_before = metrics_before.observe_prompt_tokens
        completion_before = metrics_before.observe_completion_tokens

        start = time.time()
        ttfb = None  # Time to first byte (we'll estimate this)

        # The actual observe call
        results = await stagehand.page.observe(
            instruction="Find the top Carhartt black beanie product. I need: product title, price (should be under $35), star rating, and the Add to Cart or product link button.",
            draw_overlay=True
        )

        total_time = time.time() - start
        timings["observe_main"] = total_time

        # Capture metrics after
        metrics_after = stagehand.metrics
        prompt_tokens = metrics_after.observe_prompt_tokens - prompt_before
        completion_tokens = metrics_after.observe_completion_tokens - completion_before

        print(f"\n  📊 OBSERVE RESULTS:")
        print(f"  ├─ Total time: {format_duration(total_time)}")
        print(f"  ├─ Prompt tokens: {prompt_tokens:,}")
        print(f"  ├─ Completion tokens: {completion_tokens:,}")
        print(f"  ├─ Total tokens: {prompt_tokens + completion_tokens:,}")
        print(f"  └─ Elements found: {len(results) if results else 0}")

        if results:
            print(f"\n  📦 Elements:")
            for i, result in enumerate(results[:5], 1):  # Show first 5
                print(f"    {i}. {getattr(result, 'selector', 'N/A')[:60]}...")
                print(f"       {getattr(result, 'description', 'N/A')[:60]}...")

        # Step 5: Run another observe to compare
        print(f"\n⏱️  STEP 5: Run second observe() for comparison")
        start = time.time()

        results2 = await stagehand.page.observe(
            instruction="Find the search bar",
            draw_overlay=False
        )

        timings["observe_simple"] = time.time() - start
        print(f"  ✅ Simple observe done in {format_duration(timings['observe_simple'])}")
        print(f"  Elements found: {len(results2) if results2 else 0}")

        # Summary
        print(f"\n" + "=" * 70)
        print(f"📊 TIMING SUMMARY")
        print(f"=" * 70)
        print(f"  Stagehand init:      {format_duration(timings['init'])}")
        print(f"  Navigate to Amazon:  {format_duration(timings['navigate'])}")
        print(f"  Search products:     {format_duration(timings['search'])}")
        print(f"  Main observe():      {format_duration(timings['observe_main'])} ⬅️ THE BOTTLENECK?")
        print(f"  Simple observe():    {format_duration(timings['observe_simple'])}")
        print(f"  ─────────────────────")
        print(f"  Total:               {format_duration(sum(timings.values()))}")

        print(f"\n📈 TOKEN ANALYSIS (Main Observe):")
        print(f"  Prompt tokens:    {prompt_tokens:,}")
        print(f"  Expected time:    {prompt_tokens / 5000:.1f}s (@ 5K tokens/sec)")
        print(f"  Actual time:      {timings['observe_main']:.1f}s")
        if timings['observe_main'] > 0:
            actual_rate = prompt_tokens / timings['observe_main']
            print(f"  Actual rate:      {actual_rate:,.0f} tokens/sec")

        return True

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


async def test_raw_llm_timing():
    """Test raw LLM call timing without Stagehand overhead."""
    print("\n" + "=" * 70)
    print("🧪 TEST: Raw LLM call timing (no Stagehand)")
    print("=" * 70)

    import httpx
    import json

    rose_api_key = os.getenv("ROSE_API_KEY")
    rose_api_url = os.getenv("ROSE_API_URL", "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")
    base_url = rose_api_url.replace("/completions", "")

    # Load a sample aria tree from the log file
    log_file = Path(__file__).parent.parent / "navi-worker-log.txt"
    aria_tree = ""

    if log_file.exists():
        import re
        with open(log_file, 'r') as f:
            content = f.read()
        # Find aria tree in the log
        match = re.search(r"Accessibility Tree: (\[2\] RootWebArea.*?)(?=\\n\\n|'\})", content, re.DOTALL)
        if match:
            aria_tree = match.group(1).replace("\\n", "\n")[:30000]  # Limit size
            print(f"  Loaded aria tree from log: {len(aria_tree):,} chars (~{len(aria_tree)//4:,} tokens)")

    if not aria_tree:
        # Use a simulated large tree
        aria_tree = "[2] RootWebArea 'Amazon.com'\n" + "\n".join(
            [f"  [{i}] button 'Product {i}'" for i in range(100, 500)]
        )
        print(f"  Using simulated tree: {len(aria_tree):,} chars (~{len(aria_tree)//4:,} tokens)")

    system_prompt = """You are helping the user automate the browser by finding elements based on what the user wants to observe in the page. You will be given:
1. an instruction of elements to observe
2. a hierarchical accessibility tree showing the semantic structure of the page.

Return a JSON array of elements that match the instruction. Each element should have:
- selector: CSS selector or accessibility tree reference
- description: Brief description of the element"""

    user_message = f"""instruction: Find the top Carhartt black beanie product with price under $35

Accessibility Tree:
{aria_tree}"""

    headers = {
        "Authorization": f"Bearer {supabase_anon_key}",
        "Content-Type": "application/json"
    }

    payload = {
        "model": "rose-1-ultra",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ],
        "temperature": 0.1,
        "max_tokens": 1000,
        "response_format": {"type": "json_object"}
    }

    print(f"\n  Payload size: {len(json.dumps(payload)):,} chars")
    print(f"  Estimated tokens: ~{len(json.dumps(payload))//4:,}")

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            print(f"\n  Sending request...")
            start = time.time()

            response = await client.post(
                f"{base_url}/chat/completions",
                headers=headers,
                json=payload
            )

            total_time = time.time() - start

            print(f"\n  📊 RESULTS:")
            print(f"  ├─ Status: {response.status_code}")
            print(f"  ├─ Total time: {format_duration(total_time)}")

            if response.status_code == 200:
                data = response.json()
                if 'usage' in data:
                    usage = data['usage']
                    print(f"  ├─ Prompt tokens: {usage.get('prompt_tokens', 'N/A'):,}")
                    print(f"  ├─ Completion tokens: {usage.get('completion_tokens', 'N/A'):,}")

                    if total_time > 0 and usage.get('prompt_tokens'):
                        rate = usage['prompt_tokens'] / total_time
                        print(f"  └─ Token rate: {rate:,.0f} tokens/sec")

                if 'choices' in data:
                    content = data['choices'][0]['message']['content']
                    print(f"\n  Response preview: {content[:200]}...")

                return True
            else:
                print(f"  └─ Error: {response.text[:300]}")
                return False

    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


async def main():
    print("\n" + "=" * 70)
    print("🔍 STAGEHAND FIND/OBSERVE PERFORMANCE TEST")
    print("=" * 70)

    results = []

    # Test 1: Raw LLM timing
    results.append(("Raw LLM timing", await test_raw_llm_timing()))

    # Test 2: Full Amazon test
    results.append(("Amazon find test", await test_find_on_amazon()))

    print("\n" + "=" * 70)
    print("📊 FINAL RESULTS")
    print("=" * 70)
    for name, passed in results:
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"  {name}: {status}")

    all_passed = all(r[1] for r in results)
    print("\n" + ("✅ All tests passed!" if all_passed else "❌ Some tests failed"))
    return all_passed


if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)



