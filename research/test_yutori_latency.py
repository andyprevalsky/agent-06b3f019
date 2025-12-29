"""Test Yutori n1 API latency with varying number of screenshots.

Outputs results immediately after each API call for debugging.
"""

import asyncio
import time
import httpx
import json
import sys
from typing import List, Dict, Any

YUTORI_API_KEY = "yt_9vPF-8hXpt8pIY_pnBJK_3w2yiw2IV-uINYJXw3jr7c"
YUTORI_API_URL = "https://api.yutori.com/v1/chat/completions"

# Sample screenshot URL (Google homepage)
SAMPLE_SCREENSHOT_URL = "https://upload.wikimedia.org/wikipedia/commons/5/53/Google_homepage_%28as_of_January_2024%29.jpg"


def log(msg: str):
    """Print and flush immediately."""
    print(msg, flush=True)


def build_messages(num_screenshots: int) -> List[Dict[str, Any]]:
    """Build message history with specified number of screenshots."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "Navigate to Google and search for 'Yutori AI'."
                }
            ]
        }
    ]
    
    for i in range(num_screenshots):
        messages.append({
            "role": "observation",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {
                        "url": SAMPLE_SCREENSHOT_URL
                    }
                }
            ]
        })
        
        if i < num_screenshots - 1:
            messages.append({
                "role": "assistant",
                "content": json.dumps({
                    "thoughts": f"Step {i+1}: Continuing task.",
                    "actions": [{"action_type": "click", "center_coordinates": [500, 400]}]
                })
            })
    
    return messages


async def single_request(num_screenshots: int) -> Dict[str, Any]:
    """Make a single API request and return timing info."""
    messages = build_messages(num_screenshots)
    
    payload = {
        "model": "n1-preview-2025-11",
        "messages": messages,
        "temperature": 0.3
    }
    
    headers = {
        "Authorization": f"Bearer {YUTORI_API_KEY}",
        "Content-Type": "application/json"
    }
    
    log(f"  → Sending request with {num_screenshots} screenshot(s)...")
    start_time = time.perf_counter()
    
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(YUTORI_API_URL, json=payload, headers=headers)
        total_time = time.perf_counter() - start_time
        
        if response.status_code != 200:
            log(f"  ✗ ERROR: HTTP {response.status_code}")
            log(f"    {response.text[:200]}")
            return {"error": True, "status": response.status_code, "time_ms": total_time * 1000}
        
        result = response.json()
        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        
        log(f"  ✓ Response in {total_time*1000:.0f}ms ({len(content)} chars)")
        
        return {
            "error": False,
            "time_ms": total_time * 1000,
            "content_length": len(content),
            "content": content
        }


async def run_tests():
    """Run latency tests, outputting after each call."""
    log("=" * 60)
    log("YUTORI n1 LATENCY TEST")
    log("=" * 60)
    log(f"Model: n1-preview-2025-11")
    log(f"Image: Wikipedia Google homepage")
    log("=" * 60)
    
    results = []
    
    for num_ss in range(1, 11):
        log(f"\n[{num_ss}/10] Testing with {num_ss} screenshot(s):")
        
        result = await single_request(num_ss)
        result["num_screenshots"] = num_ss
        results.append(result)
        
        if not result.get("error"):
            log(f"  Latency: {result['time_ms']:.0f}ms")
        
        # Brief pause between requests
        await asyncio.sleep(0.3)
    
    # Summary
    log("\n" + "=" * 60)
    log("SUMMARY")
    log("=" * 60)
    
    valid = [r for r in results if not r.get("error")]
    if valid:
        log(f"\n{'Screenshots':>12} | {'Latency (ms)':>12}")
        log("-" * 30)
        for r in valid:
            log(f"{r['num_screenshots']:>12} | {r['time_ms']:>12.0f}")
        
        avg = sum(r['time_ms'] for r in valid) / len(valid)
        log("-" * 30)
        log(f"{'Average':>12} | {avg:>12.0f}")
        
        # Scaling analysis
        small = [r for r in valid if r['num_screenshots'] <= 3]
        large = [r for r in valid if r['num_screenshots'] >= 7]
        
        if small and large:
            avg_small = sum(r['time_ms'] for r in small) / len(small)
            avg_large = sum(r['time_ms'] for r in large) / len(large)
            log(f"\n1-3 screenshots: {avg_small:.0f}ms avg")
            log(f"7-10 screenshots: {avg_large:.0f}ms avg")
            log(f"Scaling: {(avg_large-avg_small)/avg_small*100:+.1f}%")
    
    # Sample response
    if valid:
        log("\n" + "=" * 60)
        log("SAMPLE RESPONSE (1 screenshot)")
        log("=" * 60)
        log(valid[0].get('content', 'N/A')[:400])
    
    return results


if __name__ == "__main__":
    asyncio.run(run_tests())
