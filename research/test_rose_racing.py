#!/usr/bin/env python3
"""
Test Rose racing endpoints with real payloads.
Measures TTFT, model selection distribution, and response times.
"""

import asyncio
import json
import statistics
import time
from collections import defaultdict
from dataclasses import dataclass, field

import httpx

# Configuration
SUPABASE_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co'
ROSE_API_URL = f'{SUPABASE_URL}/functions/v1/completions'
ROSE_API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8'
SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1OTg4OTMzNiwiZXhwIjoyMDc1NDY1MzM2fQ.Iff9HtO2szAAKIpOmzGacxMgMZeeqXQfLzQTxrakF9g'

AGENT_ID = '020a191d-c635-4e1d-9639-8040b79c639c'
NUM_REQUESTS = 10


@dataclass
class RaceStats:
    """Statistics for a single pool's racing results."""

    pool_name: str
    model_counts: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    ttft_values: list[float] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def add_result(self, model: str, ttft_ms: float):
        self.model_counts[model] += 1
        self.ttft_values.append(ttft_ms)

    def add_error(self, error: str):
        self.errors.append(error)

    def print_stats(self):
        total = sum(self.model_counts.values())
        print(f'\n{"=" * 60}')
        print(f'📊 {self.pool_name.upper()} STATISTICS ({total} successful requests)')
        print(f'{"=" * 60}')

        if not self.ttft_values:
            print('❌ No successful requests!')
            if self.errors:
                print(f'   Errors: {len(self.errors)}')
                for e in self.errors[:3]:
                    print(f'   - {e[:100]}')
            return

        # Model distribution
        print('\n🎯 MODEL SELECTION DISTRIBUTION:')
        print('-' * 40)
        for model, count in sorted(self.model_counts.items(), key=lambda x: -x[1]):
            probability = (count / total) * 100
            print(f'   {model}: {count}/{total} ({probability:.1f}%)')

        # TTFT statistics
        print('\n⏱️ TIME TO FIRST TOKEN (TTFT):')
        print('-' * 40)
        print(f'   Average: {statistics.mean(self.ttft_values):.1f}ms')
        print(f'   Median:  {statistics.median(self.ttft_values):.1f}ms')
        print(f'   Min:     {min(self.ttft_values):.1f}ms')
        print(f'   Max:     {max(self.ttft_values):.1f}ms')
        if len(self.ttft_values) > 1:
            print(f'   Std Dev: {statistics.stdev(self.ttft_values):.1f}ms')

        # Errors
        if self.errors:
            print(f'\n❌ ERRORS: {len(self.errors)}')
            for e in self.errors[:5]:
                print(f'   - {e[:100]}')


async def fetch_real_messages(agent_id: str) -> list[dict]:
    """Fetch real messages from the database for the given agent."""
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f'{SUPABASE_URL}/rest/v1/Message',
            params={
                'agentId': f'eq.{agent_id}',
                'select': 'role,text,metadata,createdAt',
                'order': 'createdAt.asc',
                'limit': '20',
            },
            headers={'apikey': SERVICE_ROLE_KEY, 'Authorization': f'Bearer {SERVICE_ROLE_KEY}'},
        )
        response.raise_for_status()
        return response.json()


def convert_to_openai_messages(db_messages: list[dict]) -> list[dict]:
    """Convert database messages to OpenAI format."""
    messages = []

    for msg in db_messages:
        role = msg.get('role', '')
        text = msg.get('text', '')
        metadata = msg.get('metadata') or {}

        if role == 'SYSTEM':
            messages.append({'role': 'system', 'content': text})
        elif role == 'USER':
            messages.append({'role': 'user', 'content': text})
        elif role == 'ASSISTANT':
            messages.append({'role': 'assistant', 'content': text})
        elif role == 'TOOL':
            # Skip IN_PROGRESS and include FINISHED as system context
            if metadata.get('toolStatus') == 'IN_PROGRESS':
                continue
            if text:
                tool_content = text
                if metadata.get('title'):
                    tool_content = f'{metadata["title"]}: {text}'
                messages.append({'role': 'system', 'content': tool_content})

    return messages


async def make_streaming_request(pool: str, messages: list[dict], request_num: int) -> dict | None:
    """
    Make a streaming request to the Rose API.
    Returns dict with model and ttft_ms, or None on error.
    """
    async with httpx.AsyncClient(timeout=60.0) as client:
        start_time = time.time()
        first_chunk_time = None
        actual_model = None
        racing_ttft = None

        try:
            async with client.stream(
                'POST',
                ROSE_API_URL,
                json={
                    'model': pool,
                    'messages': messages,
                    'stream': True,
                    'max_tokens': 20,  # Some models require >= 16
                },
                headers={'Content-Type': 'application/json', 'x-api-key': ROSE_API_KEY},
            ) as response:
                response.raise_for_status()

                async for line in response.aiter_lines():
                    if not line or not line.startswith('data: '):
                        continue

                    data_str = line[6:]
                    if data_str == '[DONE]':
                        break

                    if first_chunk_time is None:
                        first_chunk_time = time.time()

                    try:
                        chunk = json.loads(data_str)
                        if chunk.get('actual_model'):
                            actual_model = chunk['actual_model']
                        if chunk.get('racing_ttft_ms'):
                            racing_ttft = chunk['racing_ttft_ms']
                    except json.JSONDecodeError:
                        continue

                    # Only need first chunk for TTFT
                    break

            if actual_model and first_chunk_time:
                # Use racing_ttft_ms if available (from racing), otherwise calculate
                ttft = racing_ttft if racing_ttft else (first_chunk_time - start_time) * 1000
                return {'model': actual_model, 'ttft_ms': ttft}
            else:
                return None

        except Exception as e:
            return {'error': str(e)}


async def test_pool(pool: str, messages: list[dict], num_requests: int) -> RaceStats:
    """Test a single pool with multiple requests."""
    stats = RaceStats(pool_name=pool)

    print(f'\n🏁 Testing {pool} with {num_requests} requests...')

    # Run requests concurrently in batches of 10
    batch_size = 10
    for batch_start in range(0, num_requests, batch_size):
        batch_end = min(batch_start + batch_size, num_requests)
        batch_num = batch_start // batch_size + 1
        print(
            f'   Batch {batch_num}: requests {batch_start + 1}-{batch_end}...', end=' ', flush=True
        )

        tasks = [make_streaming_request(pool, messages, i) for i in range(batch_start, batch_end)]

        results = await asyncio.gather(*tasks)

        success_count = 0
        for result in results:
            if result is None:
                stats.add_error('No response received')
            elif 'error' in result:
                stats.add_error(result['error'])
            else:
                stats.add_result(result['model'], result['ttft_ms'])
                success_count += 1

        print(f'✅ {success_count}/{len(results)}')

        # Small delay between batches to avoid rate limiting
        if batch_end < num_requests:
            await asyncio.sleep(0.5)

    return stats


async def main():
    print('=' * 60)
    print('🌹 ROSE RACING ENDPOINT TEST')
    print('=' * 60)
    print(f'   Requests per pool: {NUM_REQUESTS}')
    print(f'   Agent ID: {AGENT_ID}')

    # Fetch real messages
    print('\n📥 Fetching real messages from database...')
    try:
        db_messages = await fetch_real_messages(AGENT_ID)
        print(f'   Found {len(db_messages)} messages')
    except Exception as e:
        print(f'❌ Failed to fetch messages: {e}')
        # Use fallback messages
        db_messages = [
            {'role': 'USER', 'text': 'Test agent for x402 status check'},
            {'role': 'ASSISTANT', 'text': "I'll help you with that. Let me check the status."},
        ]
        print(f'   Using fallback messages: {len(db_messages)}')

    # Convert to OpenAI format
    messages = convert_to_openai_messages(db_messages)
    # Add a simple final user message
    messages.append({'role': 'user', 'content': 'Continue with the next step.'})
    print(f'   Converted to {len(messages)} OpenAI messages')

    # Test both pools
    pools = ['rose-labs/rose-1-lite', 'rose-labs/rose-1-ultra']
    all_stats = []

    for pool in pools:
        stats = await test_pool(pool, messages, NUM_REQUESTS)
        all_stats.append(stats)

    # Print all statistics
    print('\n')
    for stats in all_stats:
        stats.print_stats()

    # Summary comparison
    print(f'\n{"=" * 60}')
    print('📈 COMPARISON SUMMARY')
    print(f'{"=" * 60}')

    for stats in all_stats:
        if stats.ttft_values:
            avg_ttft = statistics.mean(stats.ttft_values)
            print(f'\n{stats.pool_name}:')
            print(f'   Avg TTFT: {avg_ttft:.1f}ms')
            print(
                f'   Success rate: {len(stats.ttft_values)}/{NUM_REQUESTS} ({len(stats.ttft_values) / NUM_REQUESTS * 100:.1f}%)'
            )


if __name__ == '__main__':
    asyncio.run(main())
