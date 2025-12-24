#!/usr/bin/env python3
"""
Test the exact reconstructed payload from agent logs.
Compares: racing (rose-1-lite) vs passthrough (direct models)
"""
import asyncio
import httpx
import json
import time
import sys

# Keys
ROSE_API_KEY = "af1ea4b12ea8dbe07c555a45a8ad4dc8"
SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU"
URL = "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions"

# Load the reconstructed payload
with open('reconstructed_payload.json', 'r') as f:
    BASE_PAYLOAD = json.load(f)


async def test_single_request(model: str, label: str, timeout: float = 60.0) -> dict:
    """Send a single request and measure TTFT."""
    payload = BASE_PAYLOAD.copy()
    payload['model'] = model
    
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
        "x-api-key": ROSE_API_KEY
    }
    
    start = time.time()
    ttft = None
    model_selected = None
    total_chars = 0
    error = None
    
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", URL, json=payload, headers=headers) as response:
                if response.status_code != 200:
                    text = await response.aread()
                    error = f"HTTP {response.status_code}: {text[:200].decode()}"
                    print(f"  [{label}] ❌ {error}")
                    return {"label": label, "model": model, "error": error}
                
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    
                    try:
                        chunk = json.loads(data)
                        
                        # Get TTFT on first content
                        if ttft is None:
                            delta = chunk.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content") or delta.get("reasoning")
                            if content:
                                ttft = int((time.time() - start) * 1000)
                                print(f"  [{label}] TTFT: {ttft}ms (model: {chunk.get('model', 'unknown')[:30]})")
                        
                        # Get model from first chunk
                        if model_selected is None:
                            model_selected = chunk.get("model", "unknown")
                        
                        # Count content
                        delta = chunk.get("choices", [{}])[0].get("delta", {})
                        if delta.get("content"):
                            total_chars += len(delta["content"])
                            
                    except json.JSONDecodeError:
                        pass
                
                total_time = int((time.time() - start) * 1000)
                
    except asyncio.TimeoutError:
        error = f"Timeout after {timeout}s"
        print(f"  [{label}] ⏰ {error}")
        return {"label": label, "model": model, "error": error}
    except Exception as e:
        error = str(e)
        print(f"  [{label}] ❌ Exception: {error}")
        return {"label": label, "model": model, "error": error}
    
    return {
        "label": label,
        "model_requested": model,
        "model_selected": model_selected,
        "ttft_ms": ttft,
        "total_ms": total_time,
        "chars": total_chars,
    }


async def run_test(label: str, model: str, num_requests: int = 3):
    """Run multiple requests and compute average."""
    print(f"\n{'='*60}")
    print(f"TEST: {label}")
    print(f"Model: {model}")
    print(f"{'='*60}")
    
    results = []
    for i in range(num_requests):
        print(f"\nRequest {i+1}/{num_requests}:")
        result = await test_single_request(model, f"#{i+1}")
        results.append(result)
        await asyncio.sleep(1)  # Brief pause between requests
    
    # Compute stats
    successful = [r for r in results if "error" not in r]
    if successful:
        avg_ttft = sum(r["ttft_ms"] for r in successful if r["ttft_ms"]) / len([r for r in successful if r["ttft_ms"]])
        avg_total = sum(r["total_ms"] for r in successful) / len(successful)
        print(f"\n📊 Summary ({len(successful)}/{num_requests} successful):")
        print(f"   Avg TTFT: {avg_ttft:.0f}ms")
        print(f"   Avg Total: {avg_total:.0f}ms")
        
        models_used = set(r["model_selected"] for r in successful if r.get("model_selected"))
        print(f"   Models used: {models_used}")
    else:
        print(f"\n❌ All {num_requests} requests failed")
    
    return results


async def main():
    print("="*60)
    print("RECONSTRUCTED PAYLOAD TEST")
    print(f"Payload size: {len(json.dumps(BASE_PAYLOAD)):,} bytes")
    print("="*60)
    
    # Test 1: Racing (rose-labs/rose-1-lite)
    await run_test(
        "RACING (rose-1-lite pool)", 
        "rose-labs/rose-1-lite",
        num_requests=5
    )
    
    # Test 2: Direct passthrough to individual models
    passthrough_models = [
        "openai/gpt-4.1-mini",
        "google/gemini-2.5-flash",
        "anthropic/claude-haiku-4",
    ]
    
    for model in passthrough_models:
        await run_test(
            f"PASSTHROUGH ({model})", 
            model,
            num_requests=3
        )


if __name__ == "__main__":
    asyncio.run(main())
