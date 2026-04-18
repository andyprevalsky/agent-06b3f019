"""Test Yutori n1-latest API latency with varying number of screenshots.

Outputs results immediately after each API call for debugging.
"""

import asyncio
import json
import time
from typing import Any

import httpx

YUTORI_API_KEY = 'yt_9vPF-8hXpt8pIY_pnBJK_3w2yiw2IV-uINYJXw3jr7c'
YUTORI_API_URL = 'https://api.yutori.com/v1/chat/completions'

# Sample screenshot URL (Google homepage)
SAMPLE_SCREENSHOT_URL = 'https://upload.wikimedia.org/wikipedia/commons/5/53/Google_homepage_%28as_of_January_2024%29.jpg'


def log(msg: str):
    """Print and flush immediately."""
    print(msg, flush=True)


def build_messages(num_screenshots: int) -> list[dict[str, Any]]:
    """Build message history with specified number of screenshots.

    n1-latest format:
    - First screenshot goes in user message
    - Subsequent screenshots go in tool messages after assistant tool_calls
    """
    messages = [
        {
            'role': 'user',
            'content': [
                {'type': 'text', 'text': "Navigate to Google and search for 'Yutori AI'."},
                {'type': 'image_url', 'image_url': {'url': SAMPLE_SCREENSHOT_URL}},
            ],
        }
    ]

    for i in range(num_screenshots - 1):  # -1 because first screenshot is in user msg
        tool_call_id = f'call_{i}'

        # Assistant message with tool_call
        messages.append(
            {
                'role': 'assistant',
                'content': f'Step {i + 1}: Continuing task.',
                'tool_calls': [
                    {
                        'id': tool_call_id,
                        'type': 'function',
                        'function': {
                            'name': 'left_click',
                            'arguments': json.dumps({'coordinates': [500, 400]}),
                        },
                    }
                ],
            }
        )

        # Tool response with screenshot
        messages.append(
            {
                'role': 'tool',
                'tool_call_id': tool_call_id,
                'content': [{'type': 'image_url', 'image_url': {'url': SAMPLE_SCREENSHOT_URL}}],
            }
        )

    return messages


async def single_request(num_screenshots: int) -> dict[str, Any]:
    """Make a single API request and return timing info."""
    messages = build_messages(num_screenshots)

    payload = {'model': 'n1-latest', 'messages': messages, 'temperature': 0.3}

    headers = {'Authorization': f'Bearer {YUTORI_API_KEY}', 'Content-Type': 'application/json'}

    log(f'  → Sending request with {num_screenshots} screenshot(s)...')
    start_time = time.perf_counter()

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(YUTORI_API_URL, json=payload, headers=headers)
        total_time = time.perf_counter() - start_time

        if response.status_code != 200:
            log(f'  ✗ ERROR: HTTP {response.status_code}')
            log(f'    {response.text[:200]}')
            return {'error': True, 'status': response.status_code, 'time_ms': total_time * 1000}

        result = response.json()
        message = result.get('choices', [{}])[0].get('message', {})
        content = message.get('content', '')
        tool_calls = message.get('tool_calls', [])

        tool_info = ''
        if tool_calls:
            tc = tool_calls[0]
            tool_info = f' | tool: {tc["function"]["name"]}'

        log(
            f'  ✓ Response in {total_time * 1000:.0f}ms (reasoning: {len(content)} chars{tool_info})'
        )

        return {
            'error': False,
            'time_ms': total_time * 1000,
            'content_length': len(content),
            'content': content,
            'tool_calls': tool_calls,
        }


async def run_tests():
    """Run latency tests, outputting after each call."""
    log('=' * 60)
    log('YUTORI n1 LATENCY TEST')
    log('=' * 60)
    log('Model: n1-latest')
    log('Image: Wikipedia Google homepage')
    log('=' * 60)

    results = []

    for num_ss in range(1, 11):
        log(f'\n[{num_ss}/10] Testing with {num_ss} screenshot(s):')

        result = await single_request(num_ss)
        result['num_screenshots'] = num_ss
        results.append(result)

        if not result.get('error'):
            log(f'  Latency: {result["time_ms"]:.0f}ms')

        # Brief pause between requests
        await asyncio.sleep(0.3)

    # Summary
    log('\n' + '=' * 60)
    log('SUMMARY')
    log('=' * 60)

    valid = [r for r in results if not r.get('error')]
    if valid:
        log(f'\n{"Screenshots":>12} | {"Latency (ms)":>12}')
        log('-' * 30)
        for r in valid:
            log(f'{r["num_screenshots"]:>12} | {r["time_ms"]:>12.0f}')

        avg = sum(r['time_ms'] for r in valid) / len(valid)
        log('-' * 30)
        log(f'{"Average":>12} | {avg:>12.0f}')

        # Scaling analysis
        small = [r for r in valid if r['num_screenshots'] <= 3]
        large = [r for r in valid if r['num_screenshots'] >= 7]

        if small and large:
            avg_small = sum(r['time_ms'] for r in small) / len(small)
            avg_large = sum(r['time_ms'] for r in large) / len(large)
            log(f'\n1-3 screenshots: {avg_small:.0f}ms avg')
            log(f'7-10 screenshots: {avg_large:.0f}ms avg')
            log(f'Scaling: {(avg_large - avg_small) / avg_small * 100:+.1f}%')

    # Sample response
    if valid:
        log('\n' + '=' * 60)
        log('SAMPLE RESPONSE (1 screenshot)')
        log('=' * 60)
        log(f'Reasoning: {valid[0].get("content", "N/A")[:400]}')
        if valid[0].get('tool_calls'):
            tc = valid[0]['tool_calls'][0]
            log(f'Tool: {tc["function"]["name"]}')
            log(f'Args: {tc["function"]["arguments"]}')

    return results


if __name__ == '__main__':
    asyncio.run(run_tests())
