"""Test Anthropic Computer Use Agent (CUA) latency for comparison with Yutori n1."""

import asyncio
import time
import httpx
import json
import base64
from typing import List, Dict, Any

ANTHROPIC_API_KEY = "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"
ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"

# Use a direct image URL that won't redirect
SAMPLE_IMAGE_URL = "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png"


def log(msg: str):
    """Print and flush immediately."""
    print(msg, flush=True)


async def fetch_image_as_base64(url: str) -> tuple[str, str]:
    """Fetch image and convert to base64. Returns (base64_data, media_type)."""
    async with httpx.AsyncClient(follow_redirects=True) as client:
        response = await client.get(url)
        content_type = response.headers.get("content-type", "image/png")
        
        # Determine media type
        if "jpeg" in content_type or "jpg" in content_type:
            media_type = "image/jpeg"
        elif "png" in content_type:
            media_type = "image/png"
        elif "gif" in content_type:
            media_type = "image/gif"
        elif "webp" in content_type:
            media_type = "image/webp"
        else:
            media_type = "image/png"
        
        return base64.b64encode(response.content).decode('utf-8'), media_type


def build_messages_anthropic(num_screenshots: int, image_base64: str, media_type: str) -> List[Dict[str, Any]]:
    """Build message history for Anthropic CUA format."""
    messages = []
    
    # Initial user message with task
    messages.append({
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": "Navigate to Google and search for 'Yutori AI'. Here is the current screenshot:"
            },
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": image_base64
                }
            }
        ]
    })
    
    # Add assistant + user pairs for history (simulating multi-turn)
    for i in range(num_screenshots - 1):
        # Assistant response
        messages.append({
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": f"I see the Google homepage. Let me click on the search box. Step {i+1}."
                },
                {
                    "type": "tool_use",
                    "id": f"tool_{i}",
                    "name": "computer",
                    "input": {
                        "action": "mouse_move",
                        "coordinate": [640, 400]
                    }
                }
            ]
        })
        
        # User response with tool result and new screenshot
        messages.append({
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": f"tool_{i}",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": image_base64
                            }
                        }
                    ]
                }
            ]
        })
    
    return messages


async def single_request_anthropic(num_screenshots: int, image_base64: str, media_type: str) -> Dict[str, Any]:
    """Make a single API request to Anthropic CUA."""
    messages = build_messages_anthropic(num_screenshots, image_base64, media_type)
    
    payload = {
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "tools": [
            {
                "type": "computer_20250124",
                "name": "computer",
                "display_width_px": 1280,
                "display_height_px": 800,
                "display_number": 1
            }
        ],
        "messages": messages
    }
    
    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "computer-use-2025-01-24",
        "Content-Type": "application/json"
    }
    
    log(f"  → Sending request with {num_screenshots} screenshot(s)...")
    start_time = time.perf_counter()
    
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(ANTHROPIC_API_URL, json=payload, headers=headers)
        total_time = time.perf_counter() - start_time
        
        if response.status_code != 200:
            log(f"  ✗ ERROR: HTTP {response.status_code}")
            log(f"    {response.text[:300]}")
            return {"error": True, "status": response.status_code, "time_ms": total_time * 1000}
        
        result = response.json()
        content = result.get("content", [])
        
        # Extract text and tool use
        text_parts = [c.get("text", "") for c in content if c.get("type") == "text"]
        tool_uses = [c for c in content if c.get("type") == "tool_use"]
        
        usage = result.get("usage", {})
        input_tokens = usage.get("input_tokens", 0)
        output_tokens = usage.get("output_tokens", 0)
        
        log(f"  ✓ Response in {total_time*1000:.0f}ms (in:{input_tokens}, out:{output_tokens})")
        
        return {
            "error": False,
            "time_ms": total_time * 1000,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "text": " ".join(text_parts),
            "tool_uses": tool_uses,
            "content": content
        }


async def run_tests():
    """Run latency tests comparing to Yutori."""
    log("=" * 60)
    log("ANTHROPIC CUA LATENCY TEST")
    log("=" * 60)
    log(f"Model: claude-sonnet-4-20250514 (computer-use-2025-01-24)")
    log("=" * 60)
    
    # First fetch the image once
    log("\nFetching sample image...")
    try:
        image_base64, media_type = await fetch_image_as_base64(SAMPLE_IMAGE_URL)
        log(f"Image size: {len(image_base64)} chars (base64), type: {media_type}")
    except Exception as e:
        log(f"Failed to fetch image: {e}")
        return []
    
    results = []
    
    for num_ss in range(1, 11):
        log(f"\n[{num_ss}/10] Testing with {num_ss} screenshot(s):")
        
        result = await single_request_anthropic(num_ss, image_base64, media_type)
        result["num_screenshots"] = num_ss
        results.append(result)
        
        if not result.get("error"):
            log(f"  Latency: {result['time_ms']:.0f}ms")
        
        await asyncio.sleep(0.3)
    
    # Summary
    log("\n" + "=" * 60)
    log("SUMMARY")
    log("=" * 60)
    
    valid = [r for r in results if not r.get("error")]
    if valid:
        log(f"\n{'Screenshots':>12} | {'Latency (ms)':>12} | {'In Tokens':>10} | {'Out Tokens':>10}")
        log("-" * 55)
        for r in valid:
            log(f"{r['num_screenshots']:>12} | {r['time_ms']:>12.0f} | {r['input_tokens']:>10} | {r['output_tokens']:>10}")
        
        avg = sum(r['time_ms'] for r in valid) / len(valid)
        log("-" * 55)
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
        log("SAMPLE RESPONSE")
        log("=" * 60)
        log(f"Text: {valid[0].get('text', 'N/A')[:300]}")
        if valid[0].get('tool_uses'):
            log(f"Tool use: {json.dumps(valid[0]['tool_uses'][0], indent=2)[:300]}")
    
    return results


if __name__ == "__main__":
    asyncio.run(run_tests())
