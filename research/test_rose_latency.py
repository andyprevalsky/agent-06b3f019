import asyncio
import json
import os
import time

import httpx

# Get keys from env
ROSE_API_KEY = os.environ.get('ROSE_API_KEY', 'af1ea4b12ea8dbe07c555a45a8ad4dc8')
SUPABASE_ANON_KEY = os.environ.get(
    'SUPABASE_ANON_KEY',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU',
)

URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions'

# Reconstructed payload from the log (simplified - same structure, shorter content)
PAYLOAD_TEMPLATE = {
    'model': 'rose-labs/rose-1-lite',
    'messages': [
        {
            'role': 'system',
            'content': """ROLE / IDENTITY
You are an autonomous agent. Your job is to accomplish goals using tools.

CONTEXT / CAPABILITIES
You have access to: web_search, spawn_browser_agent, send_message_to_user, set_plan, find_all, enrich, monitor, check_monitor_events, search_user_network_for_people, read_message_history_with_person, message_person, deep_research, search_x402_bazaar, pay_for_x402_bazaar_service, progress_to_autonomous_execution_phase

USER CONTEXT:
AUTHENTICATED BROWSER SESSIONS: amazon.com, ebay.com, etsy.com, google.com, github.com, linkedin.com, instagram.com, facebook.com, twitter.com, reddit.com, youtube.com, netflix.com, spotify.com, airbnb.com, uber.com, doordash.com, chase.com, wells fargo.com, paypal.com, venmo.com

USER PROFILE
Name: Andy Prevalsky
Phone: +19729777432
Location: New York, New York, United States

FREQUENT CONTACTS
- Mom | weekly | +19729787787
- Anna Sim | weekly | +12144764182
- Aman | weekly | +17134712306
- Ben Klenk | weekly | +12158214931

CURRENT PHASE: PLAN
Create a plan to accomplish the goal. Use set_plan to define tasks and dependencies.

OUTPUT CONTRACT
Return valid JSON matching {"reasoning": string, "response": string, "tool_calls": []}.
""",
        },
        {'role': 'user', 'content': 'Get me a black beanie < 35$ and well-made'},
        {
            'role': 'assistant',
            'content': 'Beginning with initial assessment of available platforms for purchasing a black beanie under $35 that is well-made. Will prioritize authenticated retail sites where user is already logged in.',
        },
        {'role': 'system', 'content': 'Searched for similar goals: '},
    ],
    'temperature': 0.7,
    'max_tokens': 4096,
    'stream': True,
    'response_format': {
        'type': 'json_schema',
        'json_schema': {
            'name': 'AgentAction',
            'schema': {
                'type': 'object',
                'properties': {
                    'response': {'type': 'string', 'description': 'Message to user'},
                    'tool_calls': {'type': 'array', 'items': {'type': 'object'}},
                },
                'required': ['response', 'tool_calls'],
                'additionalProperties': False,
            },
            'strict': True,
        },
    },
    'model_preference': 'FAST',
    'reasoning': {'max_tokens': 256},
}


async def test_request(name: str, payload: dict, num_requests: int = 3):
    """Test a request configuration multiple times."""
    print(f'\n{"=" * 60}')
    print(f'TEST: {name}')
    print(f'{"=" * 60}')

    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {SUPABASE_ANON_KEY}',
        'x-api-key': ROSE_API_KEY,
    }

    results = []

    for i in range(num_requests):
        start = time.time()
        ttft = None
        model_selected = None

        try:
            async with (
                httpx.AsyncClient(timeout=60.0) as client,
                client.stream('POST', URL, json=payload, headers=headers) as response,
            ):
                if response.status_code != 200:
                    text = await response.aread()
                    print(f'  #{i + 1}: ERROR {response.status_code} - {text[:200]}')
                    continue

                async for line in response.aiter_lines():
                    if not line.startswith('data: '):
                        continue

                    data = line[6:]
                    if data == '[DONE]':
                        break

                    try:
                        chunk = json.loads(data)

                        # Get TTFT on first content
                        if ttft is None:
                            delta = chunk.get('choices', [{}])[0].get('delta', {})
                            if delta.get('content') or delta.get('reasoning'):
                                ttft = int((time.time() - start) * 1000)

                        # Get model from first chunk
                        if model_selected is None:
                            model_selected = chunk.get('model', 'unknown')

                    except json.JSONDecodeError:
                        pass

                total_time = int((time.time() - start) * 1000)
                results.append({'ttft': ttft, 'total': total_time, 'model': model_selected})
                print(f'  #{i + 1}: TTFT={ttft}ms, Total={total_time}ms, Model={model_selected}')

        except Exception as e:
            print(f'  #{i + 1}: EXCEPTION - {e}')

    if results:
        avg_ttft = sum(r['ttft'] for r in results if r['ttft']) / len(
            [r for r in results if r['ttft']]
        )
        avg_total = sum(r['total'] for r in results) / len(results)
        print(f'\n  AVG: TTFT={avg_ttft:.0f}ms, Total={avg_total:.0f}ms')

    return results


async def main():
    print('Testing rose-lite latency with reconstructed payload')
    print(f'Payload size: {len(json.dumps(PAYLOAD_TEMPLATE)):,} bytes')

    # Test 1: Racing (rose-labs/rose-1-lite)
    payload_racing = PAYLOAD_TEMPLATE.copy()
    await test_request('RACING (rose-labs/rose-1-lite)', payload_racing, num_requests=5)

    # Test 2: Direct passthrough to different models
    for model in ['openai/gpt-4.1-mini', 'google/gemini-2.5-flash', 'anthropic/claude-haiku-4']:
        payload_direct = PAYLOAD_TEMPLATE.copy()
        payload_direct['model'] = model
        await test_request(f'PASSTHROUGH ({model})', payload_direct, num_requests=3)


if __name__ == '__main__':
    asyncio.run(main())
