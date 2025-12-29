"""
Test raw LLM call timing without Stagehand.
Isolates the LLM latency from other overhead.
"""
import asyncio
import time
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv()


async def test_raw_llm():
    """Test raw LLM call timing without any Stagehand."""
    import httpx
    import json

    rose_api_key = os.getenv("ROSE_API_KEY")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")
    base_url = "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1"

    print(f"\n{'='*70}")
    print(f"🧪 RAW LLM TIMING TEST (No Stagehand)")
    print(f"{'='*70}")
    print(f"ROSE_API_KEY: {'✅ SET' if rose_api_key else '❌ NOT SET'}")
    print(f"SUPABASE_ANON_KEY: {'✅ SET' if supabase_anon_key else '❌ NOT SET'}")

    # Create a simulated ~10K token aria tree (similar to real Amazon page)
    aria_tree = "[2] RootWebArea 'Amazon.com. Spend less. Smile more.'\n"
    for i in range(100, 2500):  # ~10K tokens worth of tree
        aria_tree += f"  [{i}] listitem\n"
        aria_tree += f"    [{i+10000}] link: Product {i} - Carhartt Men's Beanie ${i % 50 + 10}.99\n"
        aria_tree += f"    [{i+20000}] button: Add to Cart\n"
    
    print(f"\nAria tree size: {len(aria_tree):,} chars (~{len(aria_tree)//4:,} tokens)")

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
        "x-api-key": rose_api_key,
        "Content-Type": "application/json"
    }

    payload = {
        "model": "rose-1-ultra",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ],
        "temperature": 0.1,
        "max_tokens": 500,
        "response_format": {"type": "json_object"}
    }

    total_chars = len(json.dumps(payload))
    print(f"Total payload: {total_chars:,} chars (~{total_chars//4:,} tokens)")
    
    async with httpx.AsyncClient(timeout=120.0) as client:
        print(f"\n⏱️  Sending request to rose-1-ultra...")
        start = time.time()
        
        response = await client.post(
            f"{base_url}/chat/completions",
            headers=headers,
            json=payload
        )
        
        total_time = time.time() - start
        
        print(f"\n📊 RESULTS:")
        print(f"  Status: {response.status_code}")
        print(f"  Total time: {total_time:.2f}s")
        
        if response.status_code == 200:
            data = response.json()
            if 'usage' in data:
                usage = data['usage']
                prompt_tokens = usage.get('prompt_tokens', 0)
                completion_tokens = usage.get('completion_tokens', 0)
                print(f"  Prompt tokens: {prompt_tokens:,}")
                print(f"  Completion tokens: {completion_tokens:,}")
                if total_time > 0 and prompt_tokens:
                    print(f"  Token rate: {prompt_tokens / total_time:,.0f} tokens/sec")
                    print(f"\n💡 ANALYSIS:")
                    print(f"  At 5K tokens/sec, expected time: {prompt_tokens / 5000:.1f}s")
                    print(f"  Actual time: {total_time:.1f}s")
                    if total_time > prompt_tokens / 5000 * 1.5:
                        print(f"  ⚠️  Slower than expected! Possible bottleneck:")
                        print(f"     - Network latency")
                        print(f"     - Queue wait time in Rose pool")
                        print(f"     - Model cold start")
            if 'choices' in data:
                content = data['choices'][0]['message']['content']
                print(f"\n  Response preview: {content[:300]}...")
            return True
        else:
            print(f"  Error: {response.text[:500]}")
            return False


async def test_multiple_sizes():
    """Test LLM timing with different payload sizes."""
    import httpx
    import json

    rose_api_key = os.getenv("ROSE_API_KEY")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")
    base_url = "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1"

    print(f"\n{'='*70}")
    print(f"🧪 PAYLOAD SIZE vs LATENCY TEST")
    print(f"{'='*70}")

    sizes = [500, 1000, 2000, 5000, 10000]  # Different token counts to test
    
    headers = {
        "Authorization": f"Bearer {supabase_anon_key}",
        "x-api-key": rose_api_key,
        "Content-Type": "application/json"
    }

    results = []
    
    for target_tokens in sizes:
        # Create aria tree of approximately target size
        aria_tree = "[2] RootWebArea 'Amazon.com'\n"
        nodes_needed = target_tokens // 15  # ~15 tokens per node entry
        for i in range(100, 100 + nodes_needed):
            aria_tree += f"  [{i}] button: Product {i}\n"
        
        payload = {
            "model": "rose-1-ultra",
            "messages": [
                {"role": "system", "content": "Find matching elements. Return JSON array."},
                {"role": "user", "content": f"Find the search box\n\nTree:\n{aria_tree}"}
            ],
            "temperature": 0.1,
            "max_tokens": 200,
            "response_format": {"type": "json_object"}
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            print(f"\n⏱️  Testing ~{target_tokens:,} tokens...")
            start = time.time()
            
            response = await client.post(
                f"{base_url}/chat/completions",
                headers=headers,
                json=payload
            )
            
            total_time = time.time() - start
            
            if response.status_code == 200:
                data = response.json()
                usage = data.get('usage', {})
                prompt_tokens = usage.get('prompt_tokens', 0)
                results.append({
                    'target': target_tokens,
                    'actual': prompt_tokens,
                    'time': total_time
                })
                print(f"  {prompt_tokens:,} tokens → {total_time:.2f}s ({prompt_tokens/total_time:.0f} tok/s)")
            else:
                print(f"  Error: {response.status_code}")

    print(f"\n📊 SUMMARY:")
    print(f"{'Tokens':>10} {'Time':>10} {'Rate':>12}")
    print("-" * 35)
    for r in results:
        rate = r['actual'] / r['time'] if r['time'] > 0 else 0
        print(f"{r['actual']:>10,} {r['time']:>9.2f}s {rate:>10,.0f}/s")


if __name__ == "__main__":
    asyncio.run(test_raw_llm())
    print("\n")
    asyncio.run(test_multiple_sizes())

