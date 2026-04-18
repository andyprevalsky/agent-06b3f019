#!/usr/bin/env python3
"""
Test Racing vs No Racing TTFT with complex query.
Also captures response object shapes for each model in Rose pool.
"""

import asyncio
import json
import os
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

# Rose model pools (from completions/index.ts)
MODEL_POOLS = {
    'rose-1-lite': [
        'moonshotai/kimi-k2-0905',
        'openai/gpt-5.2',
        'google/gemini-2.5-flash',
        'x-ai/grok-4-fast',
    ],
    'rose-1-ultra': [
        'openai/gpt-5.2',
        'anthropic/claude-sonnet-4.5',
        'moonshotai/kimi-k2-thinking',
        'google/gemini-3-pro-preview',
        'x-ai/grok-4.1-fast',
    ],
}

# Model preferences (hardcoded mappings)
MODEL_PREFERENCES = {
    'SMART': 'openai/gpt-5.2',
    'FAST': 'qwen-3-235b-a22b-instruct-2507',  # Cerebras
    'CHEAP': 'google/gemini-2.5-flash',
}

# Complex system prompt for testing
COMPLEX_SYSTEM_PROMPT = """You are an autonomous agent with access to tools. Your job is to accomplish the user's goal using the minimum energy expenditure.

TWO-AXIS PLANNING FRAMEWORK
---------------------------
All progress toward a goal happens along two orthogonal axes:
1. Reducing UNCERTAINTY (ambiguity, unknown constraints, unknown strategy)
2. Reducing REMAINING WORK (doing known steps once the world is understood)

OUTPUT FORMAT: Return JSON with {"reasoning": string, "response": string, "tool_calls": []}
"""

COMPLEX_QUERY = "Research the top 3 AI startups in NYC that raised Series A in 2024, find their founders' LinkedIn profiles, and draft a personalized outreach message for each."

AGENT_ACTION_SCHEMA = {
    'type': 'object',
    'properties': {
        'reasoning': {'type': 'string', 'description': 'Internal reasoning'},
        'response': {'type': 'string', 'description': 'Your response'},
        'tool_calls': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {'tool': {'type': 'string'}, 'arguments': {'type': 'object'}},
                'required': ['tool'],
            },
        },
    },
    'required': ['reasoning', 'response', 'tool_calls'],
    'additionalProperties': False,
}


async def test_single_request(api_url: str, headers: dict, request_body: dict, label: str) -> dict:
    """Make a single request and capture timing + response shape."""

    start_time = time.perf_counter()
    ttft = None
    first_content_time = None
    chunk_count = 0
    total_content = ''
    first_chunk_data = None
    last_chunk_data = None
    all_fields_seen = set()

    try:
        async with (
            httpx.AsyncClient(timeout=120.0) as client,
            client.stream('POST', api_url, json=request_body, headers=headers) as response,
        ):
            response.raise_for_status()

            connect_time = time.perf_counter() - start_time

            async for line in response.aiter_lines():
                chunk_count += 1
                current_time = time.perf_counter()

                if ttft is None:
                    ttft = current_time - start_time

                if not line or not line.startswith('data: '):
                    continue

                data_str = line[6:]
                if data_str == '[DONE]':
                    break

                try:
                    chunk_data = json.loads(data_str)

                    # Capture first chunk for shape analysis
                    if first_chunk_data is None:
                        first_chunk_data = chunk_data
                    last_chunk_data = chunk_data

                    # Track all fields seen
                    def collect_fields(obj, prefix=''):
                        if isinstance(obj, dict):
                            for k, v in obj.items():
                                full_key = f'{prefix}.{k}' if prefix else k
                                all_fields_seen.add(full_key)
                                collect_fields(v, full_key)
                        elif isinstance(obj, list) and obj:
                            collect_fields(obj[0], f'{prefix}[]')

                    collect_fields(chunk_data)

                    delta = chunk_data.get('choices', [{}])[0].get('delta', {})
                    content = delta.get('content', '')

                    if content and first_content_time is None:
                        first_content_time = current_time - start_time

                    if content:
                        total_content += content

                except json.JSONDecodeError:
                    pass

            total_time = time.perf_counter() - start_time

            return {
                'label': label,
                'success': True,
                'connect_ms': connect_time * 1000,
                'ttft_ms': ttft * 1000 if ttft else None,
                'first_content_ms': first_content_time * 1000 if first_content_time else None,
                'total_ms': total_time * 1000,
                'chunk_count': chunk_count,
                'content_preview': total_content[:200],
                'first_chunk': first_chunk_data,
                'last_chunk': last_chunk_data,
                'all_fields': sorted(all_fields_seen),
                'actual_model': first_chunk_data.get('actual_model') if first_chunk_data else None,
            }

    except Exception as e:
        return {
            'label': label,
            'success': False,
            'error': str(e),
            'total_ms': (time.perf_counter() - start_time) * 1000,
        }


async def test_racing_vs_no_racing():
    """Compare TTFT: racing (default) vs no racing (model_preference=SMART)."""

    api_url = os.getenv(
        'ROSE_API_URL', 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions'
    )
    supabase_anon_key = os.getenv('SUPABASE_ANON_KEY', '')
    rose_api_key = os.getenv('ROSE_API_KEY', '')

    if not supabase_anon_key or not rose_api_key:
        print('❌ Missing SUPABASE_ANON_KEY or ROSE_API_KEY')
        return

    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {supabase_anon_key}',
        'x-api-key': rose_api_key,
    }

    base_body = {
        'model': 'rose-labs/rose-1-lite',
        'messages': [
            {'role': 'system', 'content': COMPLEX_SYSTEM_PROMPT},
            {'role': 'user', 'content': COMPLEX_QUERY},
        ],
        'temperature': 0.7,
        'max_tokens': 4096,
        'stream': True,
        'response_format': {
            'type': 'json_schema',
            'json_schema': {'name': 'AgentAction', 'schema': AGENT_ACTION_SCHEMA, 'strict': True},
        },
    }

    print('\n' + '=' * 70)
    print('🏁 RACING vs NO RACING TTFT TEST')
    print('=' * 70)
    print(f'Query: {COMPLEX_QUERY[:60]}...')
    print()

    # Test 1: Racing (default - no model_preference)
    print('📡 Test 1: RACING (trio of 3 models)...')
    racing_body = {**base_body}
    racing_result = await test_single_request(api_url, headers, racing_body, 'racing')

    if racing_result['success']:
        print(f'   ✅ TTFT: {racing_result["ttft_ms"]:.0f}ms')
        print(f'   ⏱️  First content: {racing_result["first_content_ms"]:.0f}ms')
        print(f'   🏆 Winner: {racing_result["actual_model"]}')
    else:
        print(f'   ❌ Error: {racing_result["error"]}')

    await asyncio.sleep(2)  # Brief pause between tests

    # Test 2: No Racing (model_preference=SMART forces single model)
    print('\n📡 Test 2: NO RACING (model_preference=SMART)...')
    no_racing_body = {**base_body, 'model_preference': 'SMART'}
    no_racing_result = await test_single_request(api_url, headers, no_racing_body, 'no_racing')

    if no_racing_result['success']:
        print(f'   ✅ TTFT: {no_racing_result["ttft_ms"]:.0f}ms')
        print(f'   ⏱️  First content: {no_racing_result["first_content_ms"]:.0f}ms')
        print(f'   🎯 Model: {no_racing_result["actual_model"]}')
    else:
        print(f'   ❌ Error: {no_racing_result["error"]}')

    # Summary
    print('\n' + '-' * 70)
    print('📊 COMPARISON')
    print('-' * 70)

    if racing_result['success'] and no_racing_result['success']:
        racing_ttft = racing_result['first_content_ms']
        no_racing_ttft = no_racing_result['first_content_ms']
        diff = no_racing_ttft - racing_ttft

        print(f'   Racing TTFT:    {racing_ttft:.0f}ms (winner: {racing_result["actual_model"]})')
        print(f'   No Racing TTFT: {no_racing_ttft:.0f}ms ({no_racing_result["actual_model"]})')
        print(
            f'   Difference:     {diff:+.0f}ms ({"racing faster" if diff > 0 else "no racing faster"})'
        )

    return racing_result, no_racing_result


async def get_model_response_shapes():
    """Get response object shapes for each model in Rose pool."""

    api_url = os.getenv(
        'ROSE_API_URL', 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions'
    )
    supabase_anon_key = os.getenv('SUPABASE_ANON_KEY', '')
    rose_api_key = os.getenv('ROSE_API_KEY', '')

    if not supabase_anon_key or not rose_api_key:
        print('❌ Missing SUPABASE_ANON_KEY or ROSE_API_KEY')
        return

    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {supabase_anon_key}',
        'x-api-key': rose_api_key,
    }

    print('\n' + '=' * 70)
    print('📦 RESPONSE OBJECT SHAPES BY MODEL')
    print('=' * 70)

    # Simple prompt for quick responses
    simple_body = {
        'messages': [{'role': 'user', 'content': "Say 'hello' in one word."}],
        'temperature': 0.7,
        'max_tokens': 50,
        'stream': True,
    }

    all_shapes = {}

    # Test each model directly
    all_models = list(
        set(MODEL_POOLS['rose-1-lite'] + MODEL_POOLS['rose-1-ultra'] + [MODEL_PREFERENCES['FAST']])
    )

    for model in all_models:
        print(f'\n🔍 Testing: {model}')

        body = {**simple_body, 'model': model}
        result = await test_single_request(api_url, headers, body, model)

        if result['success']:
            print(f'   ✅ TTFT: {result["ttft_ms"]:.0f}ms')
            all_shapes[model] = {
                'first_chunk': result['first_chunk'],
                'last_chunk': result['last_chunk'],
                'all_fields': result['all_fields'],
            }
        else:
            print(f'   ❌ Error: {result["error"]}')
            all_shapes[model] = {'error': result['error']}

        await asyncio.sleep(1)

    # Print detailed shapes
    print('\n' + '=' * 70)
    print('📋 DETAILED RESPONSE SHAPES')
    print('=' * 70)

    for model, shape in all_shapes.items():
        print(f'\n{"=" * 50}')
        print(f'MODEL: {model}')
        print('=' * 50)

        if 'error' in shape:
            print(f'ERROR: {shape["error"]}')
            continue

        print('\n📦 First Chunk (full):')
        print(json.dumps(shape['first_chunk'], indent=2, default=str))

        print('\n📦 Last Chunk (full):')
        print(json.dumps(shape['last_chunk'], indent=2, default=str))

        print('\n🏷️  All fields seen:')
        for field in shape['all_fields']:
            print(f'   - {field}')

    return all_shapes


async def main():
    print('🌹 Rose API TTFT & Response Shape Test')
    print('=' * 70)

    # Run racing comparison
    await test_racing_vs_no_racing()

    print('\n\n')

    # Get response shapes
    await get_model_response_shapes()


if __name__ == '__main__':
    asyncio.run(main())
