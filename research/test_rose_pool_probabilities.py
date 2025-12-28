#!/usr/bin/env python3
"""
Test rose-1-lite pool winner probabilities across different payload sizes.
Runs 50 requests in batches of 10 with varied payloads.
"""
import httpx
import json
import time
import asyncio
from collections import Counter
from typing import Optional

ROSE_API_KEY = "af1ea4b12ea8dbe07c555a45a8ad4dc8"
SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU"
URL = "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions"

HEADERS = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    "x-api-key": ROSE_API_KEY
}

# Load the big payload from prod
with open('reconstructed_payload.json', 'r') as f:
    BIG_PAYLOAD = json.load(f)
BIG_PAYLOAD['model'] = 'rose-labs/rose-1-lite'

# Define payload variants
PAYLOADS = {
    "tiny": {
        "model": "rose-labs/rose-1-lite",
        "messages": [{"role": "user", "content": "Say hi"}],
        "max_tokens": 50,
        "stream": True
    },
    "small": {
        "model": "rose-labs/rose-1-lite",
        "messages": [{"role": "user", "content": "Explain what a neural network is in 2 sentences."}],
        "max_tokens": 200,
        "stream": True
    },
    "medium": {
        "model": "rose-labs/rose-1-lite",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant that provides detailed explanations."},
            {"role": "user", "content": "Compare and contrast supervised learning vs unsupervised learning. Include examples of each."}
        ],
        "max_tokens": 500,
        "stream": True
    },
    "large": {
        "model": "rose-labs/rose-1-lite",
        "messages": [
            {"role": "system", "content": "You are an expert software architect. Provide detailed technical explanations with code examples when appropriate."},
            {"role": "user", "content": "Design a scalable microservices architecture for an e-commerce platform. Include service boundaries, communication patterns, data management strategies, and deployment considerations."}
        ],
        "max_tokens": 2000,
        "stream": True,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "ArchitectureDesign",
                "schema": {
                    "type": "object",
                    "properties": {
                        "services": {"type": "array", "items": {"type": "object"}},
                        "communication": {"type": "string"},
                        "data_strategy": {"type": "string"}
                    },
                    "required": ["services", "communication", "data_strategy"]
                },
                "strict": True
            }
        }
    },
    "big_prod": BIG_PAYLOAD  # 34KB payload from production
}


async def send_request(payload: dict, payload_name: str, request_num: int) -> Optional[dict]:
    """Send a single request and return result."""
    start = time.time()
    
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("POST", URL, json=payload, headers=HEADERS) as response:
                if response.status_code != 200:
                    return {"error": f"HTTP {response.status_code}", "payload": payload_name}
                
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                        delta = chunk.get("choices", [{}])[0].get("delta", {})
                        if delta.get("content") or delta.get("reasoning"):
                            ttft = int((time.time() - start) * 1000)
                            winner = chunk.get("model", "unknown").split("/")[-1]
                            return {
                                "winner": winner,
                                "ttft": ttft,
                                "payload": payload_name,
                                "request_num": request_num
                            }
                    except json.JSONDecodeError:
                        pass
                        
    except Exception as e:
        return {"error": str(e), "payload": payload_name}
    
    return {"error": "No content received", "payload": payload_name}


async def run_batch(batch_num: int, payloads_to_test: list) -> list:
    """Run a batch of 10 requests."""
    print(f"\n{'='*60}")
    print(f"BATCH {batch_num}/5")
    print(f"{'='*60}")
    
    results = []
    for i, (payload_name, payload) in enumerate(payloads_to_test):
        request_num = (batch_num - 1) * 10 + i + 1
        print(f"  [{request_num:2d}/50] {payload_name:10s}...", end=" ", flush=True)
        
        result = await send_request(payload, payload_name, request_num)
        results.append(result)
        
        if result and "winner" in result:
            print(f"✅ {result['winner']:20s} @ {result['ttft']}ms")
        else:
            print(f"❌ {result.get('error', 'unknown error')}")
        
        # Small delay between requests
        await asyncio.sleep(0.5)
    
    return results


async def main():
    print("="*60)
    print("ROSE-1-LITE POOL PROBABILITY TEST")
    print("="*60)
    print(f"\nPayload sizes:")
    for name, payload in PAYLOADS.items():
        size = len(json.dumps(payload))
        print(f"  {name:10s}: {size:,} bytes")
    
    # Create test schedule: 10 requests per batch, 5 batches = 50 total
    # Mix of payload types in each batch
    all_results = []
    
    for batch_num in range(1, 6):
        # Each batch: 2 of each payload type
        batch_payloads = []
        for payload_name, payload in PAYLOADS.items():
            batch_payloads.append((payload_name, payload))
            batch_payloads.append((payload_name, payload))
        
        batch_results = await run_batch(batch_num, batch_payloads)
        all_results.extend(batch_results)
    
    # Analyze results
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    
    successful = [r for r in all_results if r and "winner" in r]
    failed = [r for r in all_results if r and "error" in r]
    
    print(f"\nTotal: {len(all_results)} requests")
    print(f"Success: {len(successful)}")
    print(f"Failed: {len(failed)}")
    
    if successful:
        # Overall winners
        winners = Counter(r["winner"] for r in successful)
        print(f"\n--- OVERALL WINNERS ---")
        for model, count in winners.most_common():
            pct = count / len(successful) * 100
            print(f"  {model:25s}: {count:2d} wins ({pct:5.1f}%)")
        
        # TTFT stats
        ttfts = [r["ttft"] for r in successful]
        print(f"\n--- TTFT STATS ---")
        print(f"  Min:  {min(ttfts)}ms")
        print(f"  Max:  {max(ttfts)}ms")
        print(f"  Avg:  {sum(ttfts)/len(ttfts):.0f}ms")
        
        # Winners by payload type
        print(f"\n--- WINNERS BY PAYLOAD TYPE ---")
        for payload_name in PAYLOADS.keys():
            payload_results = [r for r in successful if r["payload"] == payload_name]
            if payload_results:
                payload_winners = Counter(r["winner"] for r in payload_results)
                avg_ttft = sum(r["ttft"] for r in payload_results) / len(payload_results)
                print(f"\n  {payload_name} (avg TTFT: {avg_ttft:.0f}ms):")
                for model, count in payload_winners.most_common():
                    print(f"    {model}: {count} wins")
    
    if failed:
        print(f"\n--- FAILURES ---")
        for r in failed:
            print(f"  {r['payload']}: {r['error']}")


if __name__ == "__main__":
    asyncio.run(main())


