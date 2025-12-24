#!/usr/bin/env python3
"""
Get exact reasoning and reasoning_details values for each model in Rose pool.
Uses complex query with max_tokens 4096.
"""

import asyncio
import httpx
import time
import os
import json
from dotenv import load_dotenv

load_dotenv()

# All models to test
ALL_MODELS = [
    'openai/gpt-5.2',
    'anthropic/claude-sonnet-4.5',
    'google/gemini-2.5-flash',
    'google/gemini-3-pro-preview',
    'x-ai/grok-4-fast',
    'x-ai/grok-4.1-fast',
    'moonshotai/kimi-k2-0905',
    'moonshotai/kimi-k2-thinking',
]

COMPLEX_QUERY = """You are a venture capital analyst. Analyze the following:

1. What are the key differences between Series A, B, and C funding rounds?
2. For a B2B SaaS startup with $2M ARR and 120% NRR, what valuation multiple would be appropriate in 2024?
3. List 3 red flags investors look for in due diligence.

Be thorough and provide specific examples."""


async def test_model_reasoning(model: str, api_url: str, headers: dict) -> dict:
    """Test a single model and capture all reasoning fields."""
    
    request_body = {
        "model": model,
        "messages": [{"role": "user", "content": COMPLEX_QUERY}],
        "temperature": 0.7,
        "max_tokens": 4096,
        "stream": True,
    }
    
    start_time = time.perf_counter()
    
    # Collect ALL reasoning and reasoning_details across all chunks
    all_reasoning_chunks = []
    all_reasoning_details = []
    all_content_chunks = []
    chunk_samples = []  # First few chunks with reasoning
    
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            async with client.stream(
                'POST',
                api_url,
                json=request_body,
                headers=headers
            ) as response:
                response.raise_for_status()
                
                chunk_idx = 0
                async for line in response.aiter_lines():
                    if not line or not line.startswith('data: '):
                        continue
                    
                    data_str = line[6:]
                    if data_str == '[DONE]':
                        break
                    
                    try:
                        chunk = json.loads(data_str)
                        delta = chunk.get("choices", [{}])[0].get("delta", {})
                        
                        # Capture content
                        content = delta.get("content", "")
                        if content:
                            all_content_chunks.append(content)
                        
                        # Capture reasoning (string field)
                        reasoning = delta.get("reasoning")
                        if reasoning is not None and reasoning != "":
                            all_reasoning_chunks.append(reasoning)
                        
                        # Capture reasoning_details (array field)
                        reasoning_details = delta.get("reasoning_details")
                        if reasoning_details is not None and len(reasoning_details) > 0:
                            all_reasoning_details.extend(reasoning_details)
                        
                        # Store first 3 chunks that have reasoning for shape analysis
                        if (reasoning is not None or (reasoning_details and len(reasoning_details) > 0)):
                            if len(chunk_samples) < 3:
                                chunk_samples.append({
                                    "chunk_idx": chunk_idx,
                                    "delta": delta
                                })
                        
                        chunk_idx += 1
                        
                    except json.JSONDecodeError:
                        pass
                
                total_time = time.perf_counter() - start_time
                
                return {
                    "model": model,
                    "success": True,
                    "total_ms": total_time * 1000,
                    "total_chunks": chunk_idx,
                    "content_preview": "".join(all_content_chunks)[:500],
                    "reasoning_chunks_count": len(all_reasoning_chunks),
                    "reasoning_full": "".join(all_reasoning_chunks) if all_reasoning_chunks else None,
                    "reasoning_details_count": len(all_reasoning_details),
                    "reasoning_details_full": all_reasoning_details if all_reasoning_details else None,
                    "sample_chunks": chunk_samples,
                }
                
    except Exception as e:
        return {
            "model": model,
            "success": False,
            "error": str(e),
        }


async def main():
    api_url = os.getenv("ROSE_API_URL", "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY", "")
    rose_api_key = os.getenv("ROSE_API_KEY", "")
    
    if not supabase_anon_key or not rose_api_key:
        print("❌ Missing SUPABASE_ANON_KEY or ROSE_API_KEY")
        return
    
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {supabase_anon_key}",
        "x-api-key": rose_api_key,
    }
    
    print("=" * 80)
    print("🧠 REASONING & REASONING_DETAILS BY MODEL")
    print("=" * 80)
    print(f"Query: {COMPLEX_QUERY[:80]}...")
    print(f"Max tokens: 4096")
    print()
    
    results = {}
    
    for model in ALL_MODELS:
        print(f"\n{'=' * 80}")
        print(f"🔍 MODEL: {model}")
        print("=" * 80)
        
        result = await test_model_reasoning(model, api_url, headers)
        results[model] = result
        
        if not result["success"]:
            print(f"❌ Error: {result['error']}")
            continue
        
        print(f"✅ Completed in {result['total_ms']:.0f}ms ({result['total_chunks']} chunks)")
        
        # Reasoning field
        print(f"\n📝 REASONING FIELD:")
        print(f"   Chunks with reasoning: {result['reasoning_chunks_count']}")
        if result['reasoning_full']:
            reasoning_preview = result['reasoning_full'][:1000]
            if len(result['reasoning_full']) > 1000:
                reasoning_preview += f"\n... [truncated, total {len(result['reasoning_full'])} chars]"
            print(f"   Value:\n{reasoning_preview}")
        else:
            print(f"   Value: null / empty / not present")
        
        # Reasoning details field
        print(f"\n📋 REASONING_DETAILS FIELD:")
        print(f"   Items in array: {result['reasoning_details_count']}")
        if result['reasoning_details_full']:
            # Show first 3 items in full
            for i, detail in enumerate(result['reasoning_details_full'][:3]):
                print(f"\n   Item [{i}]:")
                print(f"   {json.dumps(detail, indent=6)}")
            if len(result['reasoning_details_full']) > 3:
                print(f"\n   ... and {len(result['reasoning_details_full']) - 3} more items")
        else:
            print(f"   Value: [] / null / not present")
        
        # Sample chunk deltas
        print(f"\n🔬 SAMPLE DELTA OBJECTS (first 3 with reasoning):")
        if result['sample_chunks']:
            for sample in result['sample_chunks']:
                print(f"\n   Chunk #{sample['chunk_idx']}:")
                print(f"   {json.dumps(sample['delta'], indent=6)}")
        else:
            print("   No chunks had reasoning fields")
        
        print(f"\n📄 CONTENT PREVIEW:")
        print(f"   {result['content_preview'][:300]}...")
        
        await asyncio.sleep(2)  # Rate limiting
    
    # Summary table
    print("\n\n" + "=" * 80)
    print("📊 SUMMARY TABLE")
    print("=" * 80)
    print(f"{'Model':<35} {'reasoning':<15} {'reasoning_details':<20} {'Format'}")
    print("-" * 80)
    
    for model, result in results.items():
        if not result["success"]:
            print(f"{model:<35} {'ERROR':<15} {'':<20}")
            continue
        
        has_reasoning = "✅ Yes" if result['reasoning_full'] else "❌ No"
        has_details = f"✅ {result['reasoning_details_count']}" if result['reasoning_details_full'] else "❌ No"
        
        # Detect format from first detail
        fmt = "-"
        if result['reasoning_details_full']:
            first = result['reasoning_details_full'][0]
            if 'format' in first:
                fmt = first.get('format', 'unknown')
            elif 'id' in first and 'data' in first:
                fmt = "xai-style"
            elif 'text' in first:
                fmt = "text-style"
        
        print(f"{model:<35} {has_reasoning:<15} {has_details:<20} {fmt}")


if __name__ == "__main__":
    asyncio.run(main())


