"""Offline regressions for real RoseClient rotation and Foundry fixture calls."""
import asyncio
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
from unittest.mock import patch, AsyncMock


async def test_fetch_fresh_failure_falls_back_and_cancel_propagates():
    from types import SimpleNamespace
    from providers.rose.client import RoseClient
    from providers.rose import claude_auth_from_token
    from providers.rose.errors import RoseRateLimitError
    from providers.rose.types import StreamChunk
    from _rose_stream_progress_fixture import single_step_waterfall

    events = []

    async def failed_direct(**kwargs):
        events.append('direct')
        raise RoseRateLimitError('fixture original rate limit')
        yield

    async def fetch(_user):
        events.append('fetch')
        raise RuntimeError('fixture backend failure secret-must-not-be-logged')

    async def fallback(**kwargs):
        events.append('fallback')
        yield StreamChunk(kind='metadata', data={'actual_model': 'fixture-fallback'})
        yield StreamChunk(kind='content', data={'text': 'fallback ok'})
        yield StreamChunk(kind='done', data={})

    auth = claude_auth_from_token('fixture-token')
    auth.fetch_fresh = fetch
    auth.user_id = 'fixture-user'
    auth.max_rotations = 1
    client = RoseClient(openrouter_key='fixture-openrouter')
    with (patch('providers.demo_cache.client.ensure_context', AsyncMock(return_value=None)),
          patch('providers.demo_cache.context.current_context', return_value=None),
          patch('providers.rose.client.foundry_configured', return_value=False),
          patch('providers.rose.client._cerebras_api_key', return_value=''),
          patch('providers.rose.client.claude_auth_complete', failed_direct),
          patch('providers.rose.client._openai_api_key', return_value=''),
          patch('providers.rose.client.load_config', return_value=SimpleNamespace(anthropic=SimpleNamespace(api_key=''))),
          patch('providers.rose.client.waterfall_complete', single_step_waterfall(fallback)),
          patch('providers.rose.client.logger') as log):
        chunks = [c async for c in client.complete(pool='rose-1-ultra', messages=[{'role':'user','content':'hi'}],
                    claude_auth=auth, dump_context=False, speed='standard', provider_fast_mode=False, call_site='offline-fetch-fresh-error')]
        assert events == ['direct', 'fetch', 'fallback'], events
        assert any(c.kind == 'content' and c.data.get('text') == 'fallback ok' for c in chunks)
        assert any(c.kind == 'metadata' and c.data.get('claude_token_error') == 'rate_limit' for c in chunks)
        assert 'secret-must-not-be-logged' not in str(log.mock_calls)
        assert any(c.args[0] == 'rose.complete.direct_auth.fetch_fresh_failed' for c in log.warning.call_args_list)
        events.clear()

        async def cancelled(_user):
            events.append('fetch-cancel')
            raise asyncio.CancelledError()

        auth.fetch_fresh = cancelled
        try:
            _ = [c async for c in client.complete(pool='rose-1-ultra', messages=[{'role':'user','content':'hi'}],
                    claude_auth=auth, dump_context=False, speed='standard', provider_fast_mode=False, call_site='offline-fetch-fresh-cancel')]
        except asyncio.CancelledError:
            pass
        else:
            raise AssertionError('caller cancellation was swallowed')
        assert events == ['direct', 'fetch-cancel'], events


async def test_foundry_fixture_uses_current_speed_contract():
    import foundry_shared_cooldown_fixture as fixture
    from providers.rose import foundry

    # Execute the actual fixture main and actual Foundry completion/parser.
    # The fixture owns MockTransport for Foundry; backend authority is isolated
    # here only, because backend HTTP fidelity is covered by its registered owner.
    with (patch.dict(os.environ, {'BACKEND_API_URL':'http://fixture.invalid', 'BACKEND_API_KEY':'fixture'}),
          patch.object(foundry, '_shared_scope', return_value=None),
          patch.object(foundry, '_cooldown_until', {}),
          patch.object(foundry, 'build_codex_responses_body', wraps=foundry.build_codex_responses_body) as builder,
          contextlib.redirect_stdout(io.StringIO()) as output):
        await fixture.main('observe')
    result = json.loads(output.getvalue().splitlines()[-1])
    assert builder.call_args.kwargs['service_tier'] == foundry.foundry_service_tier_for('fast'), builder.call_args
    assert len(result['hits']) == 1, result
    assert result['served'] == result['hits'][0]


async def test_rotation_success_budget_and_cancel_controls():
    from types import SimpleNamespace
    from providers.rose import claude_auth_from_token
    from providers.rose.client import RoseClient
    from providers.rose.errors import RoseRateLimitError
    from providers.rose.types import StreamChunk
    from _rose_stream_progress_fixture import single_step_waterfall

    for mode in ('fresh', 'budget-zero', 'cancel'):
        events = []
        async def direct(**kwargs):
            token = kwargs['auth'].token
            events.append(token)
            if token == 'old':
                raise RoseRateLimitError('fixture original')
            yield StreamChunk(kind='metadata', data={'actual_model':'fixture-direct'})
            yield StreamChunk(kind='content', data={'text':'fresh ok'})
            yield StreamChunk(kind='done', data={})
        async def fetch(_user):
            events.append('fetch')
            if mode == 'cancel': raise asyncio.CancelledError()
            return claude_auth_from_token('fresh')
        async def fallback(**kwargs):
            events.append('fallback')
            yield StreamChunk(kind='metadata', data={'actual_model':'fixture-fallback'})
            yield StreamChunk(kind='content', data={'text':'fallback ok'})
            yield StreamChunk(kind='done', data={})
        auth = claude_auth_from_token('old')
        auth.fetch_fresh = fetch
        auth.max_rotations = 0 if mode == 'budget-zero' else 1
        with (patch('providers.demo_cache.context.current_context', return_value=None),
              patch('providers.demo_cache.client.ensure_context', AsyncMock(return_value=None)),
              patch('providers.rose.client.claude_auth_complete', direct),
              patch('providers.rose.client._openai_api_key', return_value=''),
              patch('providers.rose.client._cerebras_api_key', return_value=''),
              patch('providers.rose.client.foundry_configured', return_value=False),
              patch('providers.rose.client.load_config', return_value=SimpleNamespace(anthropic=SimpleNamespace(api_key=''))),
              patch('providers.rose.client.waterfall_complete', single_step_waterfall(fallback)),
              patch('providers.rose.client.logger')):
            try:
                chunks = [c async for c in RoseClient(openrouter_key='fixture').complete(
                    pool='rose-1-ultra',messages=[{'role':'user','content':'hi'}],claude_auth=auth,
                    speed='standard',provider_fast_mode=False,dump_context=False,call_site='offline-rotation-control')]
            except asyncio.CancelledError:
                assert mode == 'cancel'
                assert events == ['old','fetch'], events
            else:
                assert mode != 'cancel', 'cancellation swallowed'
                assert events == (['old','fetch','fresh'] if mode == 'fresh' else ['old','fallback']), events
                expected = 'fresh ok' if mode == 'fresh' else 'fallback ok'
                assert any(c.kind == 'content' and c.data.get('text') == expected for c in chunks)
