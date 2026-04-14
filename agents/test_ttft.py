#!/usr/bin/env python3
"""
Test Time-To-First-Token (TTFT) for Rose API.

Reconstructed from navi-worker-log.txt to reproduce the slow second LLM call.
"""

import asyncio
import os
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

# ============================================================================
# RECONSTRUCTED PAYLOAD FROM navi-worker-log.txt
# This is what the second LLM call sent (5 messages, with reasoning + json_schema)
# ============================================================================

SYSTEM_PROMPT = """ROLE / IDENTITY
----------------
You are a nurturer of metaphysical seeds. The user has given you a seed in the form of a goal; your job is to nurture it to fruition (100% accomplishment) using the tools available.

Operate with the lowest energy expenditure possible—each tool invocation consumes human attention, social credibility, or monetary capital. You are autonomous; never ask "how can I help?" and never hand execution back to the user.
TO BE ABSOLUTELY CLEAR: you are you're own autonomous entity. You are to not burden the user with constant questions. You behave like a world class COO, you don't get blocked because you make reasonable assumptions and you move on.


GOAL / SUCCESS CRITERIA
----------------------------
CURRENT PHASE: PLAN

TWO-AXIS PLANNING FRAMEWORK
---------------------------
All progress toward a goal happens along two orthogonal axes:
1. Reducing UNCERTAINTY (ambiguity, unknown constraints, unknown strategy, unknown correctness)
2. Reducing REMAINING WORK (doing known steps once the world is understood)

Decision heuristic:
- If uncertainty > decomposability → use join='any' (hypotheses to reduce uncertainty first)
- If decomposability >= uncertainty → use join='all' (parallelize work)
- Parallelism is only safe when entropy/uncertainty is low

USER CONTEXT:

AUTHENTICATED BROWSER SESSIONS
You have stored auth credentials for these sites. When using spawn_browser_agent
for these domains, the user is already logged in - no authentication required:
adobe.com, adprime.com, affirm.com, airbnb.com, airwallex.com, amazon.com, aritzia.com, ashbyhq.com, bing.com, boardy.ai, browserbase.com, carta.com, chase.com, chatgpt.com, classpass.com, claude.ai, coda.io, colossusssp.com, cookunity.com, director.ai, docusign.com, doordash.com, ebay.com, etsy.com, facebook.com, fastmail.com, firecrawl.dev, getadblock.com, gitbook.com, github.com, google.com, happenstance.ai, homedepot.com, hotplate.com, instagram.com, jdsports.com, johnvarvatos.com, krushmedia.com, lightfield.app, linkedin.com, litellm.ai, lovable.dev, loveable.dev, massimodutti.com, mindbodyonline.com, muji.us, nebula.org, nips.cc, onlyfans.com, openrouter.ai

USER PROFILE
Name: Andy Prevalsky
Phone: +19729777432
When sending SMS messages to the user, use: +19729777432
Location: New York, New York, United States

FREQUENT CONTACTS
- Tatti | weekly | @ George Prevalsky's Boxing & Muay Thai Boxing Club | +19729775605
- Mom | weekly | +19729787787
- Anna Sim | weekly | +12144764182
- Aya | weekly | +19729461122
- Cali | monthly | +14699995163
- Ina | weekly | +19728225709
- Aman | weekly | +17134712306
- Rohit | monthly | +19723107210

OUTPUT FORMAT
-------------
Respond with JSON containing:
- response: Your plan/reasoning
- tool_calls: Array of tool calls (if any)
"""

FIRST_ASSISTANT_RESPONSE = """To secure $1 million in funding, I will begin by gathering detailed information about your business, including the industry, stage, revenue, traction, and funding history. I'll also identify the most suitable funding sources—such as venture capital firms, angel investors, or alternative financing platforms—based on your profile and location in New York. Next, I will prepare a compelling pitch deck and executive summary tailored to high-probability investors, then initiate outreach through warm connections, LinkedIn, and direct messaging. I will track all interactions and refine the approach based on response rates. All actions will be executed autonomously using available tools and authenticated platforms.

Assumptions: You are seeking equity or debt financing for a startup or business venture. No explicit constraints on equity dilution or repayment terms were provided.

Next step: Use spawn_browser_agent to research and compile a profile of Andy Prevalsky's business background and current venture using public sources (LinkedIn, GitHub, etc.)."""

# The actual 5-message payload from the second LLM call
REAL_PAYLOAD_MESSAGES = [
    {"role": "system", "content": SYSTEM_PROMPT},
    {"role": "user", "content": "Raise me 1 million dollars"},
    {"role": "assistant", "content": FIRST_ASSISTANT_RESPONSE},
    {"role": "system", "content": "Phase transition: PLAN → continue planning with tools now available."},
    {"role": "user", "content": "Based on everything so far, what should I do next?"},
]

AGENT_ACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "response": {"type": "string", "description": "Your reasoning and response to the user"},
        "tool_calls": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"tool": {"type": "string"}, "arguments": {"type": "object"}},
                "required": ["tool"],
            },
            "description": "List of tool calls to execute",
        },
    },
    "required": ["response", "tool_calls"],
    "additionalProperties": False,
}


async def test_ttft(  # noqa: C901
    prompt: str = "What is 2+2? Reply in one word.",
    model: str = "rose-labs/rose-1-lite",
    num_requests: int = 5,
    use_real_payload: bool = False,
):
    """Test TTFT for the Rose API."""

    api_url = os.getenv("ROSE_API_URL", "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY", "")
    rose_api_key = os.getenv("ROSE_API_KEY", "")

    if not supabase_anon_key:
        print("❌ SUPABASE_ANON_KEY not set")
        return

    print("\n🌹 Testing TTFT for Rose API")
    print(f"   URL: {api_url}")
    print(f"   Model: {model}")
    print(f"   Requests: {num_requests}")

    if use_real_payload:
        print("   📋 Using REAL payload from navi-worker-log.txt (5 messages)")
        messages = REAL_PAYLOAD_MESSAGES
        schema = AGENT_ACTION_SCHEMA
    else:
        print(f"   Prompt: {prompt[:50]}...")
        messages = [{"role": "user", "content": prompt}]
        schema = {
            "type": "object",
            "properties": {"response": {"type": "string"}},
            "required": ["response"],
            "additionalProperties": False,
        }

    print("-" * 60)

    request_body = {
        "model": model,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 4096,
        "stream": True,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "AgentAction" if use_real_payload else "TestResponse",
                "schema": schema,
                "strict": True,
            },
        },
        "reasoning": {"max_tokens": 256},
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {supabase_anon_key}",
        "x-api-key": rose_api_key,
    }

    ttft_results = []
    total_time_results = []

    for i in range(num_requests):
        print(f"\n📡 Request {i + 1}/{num_requests}...")

        start_time = time.perf_counter()
        ttft = None
        first_content_time = None
        chunk_count = 0
        total_content = ""

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream("POST", api_url, json=request_body, headers=headers) as response:
                    response.raise_for_status()

                    connect_time = time.perf_counter() - start_time
                    print(
                        f"   ✅ Connection established in {connect_time * 1000:.1f}ms (status={response.status_code})"
                    )

                    async for line in response.aiter_lines():
                        chunk_count += 1
                        current_time = time.perf_counter()

                        # Record time to first line
                        if ttft is None:
                            ttft = current_time - start_time
                            print(f"   📦 First line received in {ttft * 1000:.1f}ms")

                        if not line or not line.startswith("data: "):
                            continue

                        data_str = line[6:]
                        if data_str == "[DONE]":
                            break

                        try:
                            import json

                            chunk_data = json.loads(data_str)
                            delta = chunk_data.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content", "")

                            if content and first_content_time is None:
                                first_content_time = current_time - start_time
                                print(
                                    f"   ✨ First content token in {first_content_time * 1000:.1f}ms: {repr(content[:30])}"
                                )

                            if content:
                                total_content += content

                        except json.JSONDecodeError:
                            pass

                    total_time = time.perf_counter() - start_time
                    print(f"   ⏱️  Total time: {total_time * 1000:.1f}ms ({chunk_count} chunks)")
                    print(f"   📝 Response preview: {total_content[:100]}...")

                    if first_content_time:
                        ttft_results.append(first_content_time)
                    total_time_results.append(total_time)

        except httpx.HTTPStatusError as e:
            print(f"   ❌ HTTP Error: {e.response.status_code}")
            print(f"      {e.response.text[:200]}")
        except Exception as e:
            print(f"   ❌ Error: {e}")

        # Small delay between requests
        if i < num_requests - 1:
            await asyncio.sleep(1)

    # Summary
    print("\n" + "=" * 60)
    print("📊 TTFT SUMMARY")
    print("=" * 60)

    if ttft_results:
        avg_ttft = sum(ttft_results) / len(ttft_results)
        min_ttft = min(ttft_results)
        max_ttft = max(ttft_results)
        print(f"   Average TTFT: {avg_ttft * 1000:.1f}ms")
        print(f"   Min TTFT:     {min_ttft * 1000:.1f}ms")
        print(f"   Max TTFT:     {max_ttft * 1000:.1f}ms")
        print(f"   All values:   {[f'{t * 1000:.0f}ms' for t in ttft_results]}")

    if total_time_results:
        avg_total = sum(total_time_results) / len(total_time_results)
        print(f"\n   Average Total: {avg_total * 1000:.1f}ms")


async def test_ttft_parallel(num_parallel: int = 3):
    """Test TTFT with parallel requests to check for queuing."""

    api_url = os.getenv("ROSE_API_URL", "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY", "")
    rose_api_key = os.getenv("ROSE_API_KEY", "")

    print(f"\n🔀 Testing {num_parallel} PARALLEL requests to check for queuing...")
    print("-" * 60)

    request_body = {
        "model": "rose-labs/rose-1-lite",
        "messages": [{"role": "user", "content": "Say hello in one word."}],
        "temperature": 0.7,
        "max_tokens": 100,
        "stream": True,
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {supabase_anon_key}",
        "x-api-key": rose_api_key,
    }

    async def single_request(idx: int):
        start = time.perf_counter()
        ttft = None

        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream("POST", api_url, json=request_body, headers=headers) as response:
                async for line in response.aiter_lines():
                    if ttft is None:
                        ttft = time.perf_counter() - start
                    if line.startswith("data: ") and line[6:] == "[DONE]":
                        break

        total = time.perf_counter() - start
        return idx, ttft, total

    # Fire all requests in parallel
    results = await asyncio.gather(*[single_request(i) for i in range(num_parallel)])

    print("\nParallel request results:")
    for idx, ttft, total in sorted(results):
        print(f"   Request {idx}: TTFT={ttft * 1000:.0f}ms, Total={total * 1000:.0f}ms")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Test TTFT for Rose API")
    parser.add_argument("--requests", "-n", type=int, default=5, help="Number of requests")
    parser.add_argument("--parallel", "-p", type=int, default=0, help="Test N parallel requests")
    parser.add_argument("--prompt", type=str, default="What is 2+2? Reply in one word.", help="Test prompt")
    parser.add_argument("--real", "-r", action="store_true", help="Use real payload from navi-worker-log.txt")

    args = parser.parse_args()

    if args.parallel > 0:
        asyncio.run(test_ttft_parallel(args.parallel))
    else:
        asyncio.run(test_ttft(prompt=args.prompt, num_requests=args.requests, use_real_payload=args.real))
