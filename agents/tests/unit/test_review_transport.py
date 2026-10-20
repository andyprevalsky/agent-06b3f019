"""Offline owning-boundary regressions; registered by tests/unit pytest discovery."""
import asyncio
import json
import ssl
from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
import pytest


def test_archive_metadata_probe_never_opens_ciphertext(monkeypatch):
    import helpers.trace_archive as archive
    calls = []
    class Missing(Exception):
        response = {"Error": {"Code": "NoSuchKey"}}
    class Client:
        def get_object(self, *, Bucket, Key):
            calls.append(("GET", Key))
            assert Key.endswith('.meta.json'), 'metadata reader opened a ciphertext body'
            raise Missing()
        def head_object(self, *, Bucket, Key):
            calls.append(("HEAD", Key))
            if Key.endswith('absent.enc'):
                raise Missing()
            return {}
    monkeypatch.setattr(archive, '_r2_client', lambda: Client())
    monkeypatch.setattr(archive, '_r2_bucket', lambda: 'test-bucket')
    assert archive.read_r2_artifact_metadata(root_agent_id='root', path='absent.enc') is None
    with pytest.raises(ValueError, match='Archive metadata missing for orphan.enc'):
        archive.read_r2_artifact_metadata(root_agent_id='root', path='orphan.enc')
    absent = archive._object_key('root', 'absent.enc')
    orphan = archive._object_key('root', 'orphan.enc')
    assert calls == [('HEAD', absent), ('HEAD', orphan), ('GET', orphan + '.meta.json')]
    assert all(key.endswith('.meta.json') for method, key in calls if method == 'GET')


def test_archive_metadata_hit_only_reads_sidecar(monkeypatch):
    import helpers.trace_archive as archive
    calls = []
    key = archive._object_key('root', 'hit.enc')
    class Body:
        def read(self):
            return b'{"plaintext_bytes":3}'
    class Client:
        def head_object(self, *, Bucket, Key):
            calls.append(('HEAD', Key))
            assert Key == key
            return {'ContentLength': 3}
        def get_object(self, *, Bucket, Key):
            calls.append(('GET', Key))
            assert Key == key + '.meta.json', 'metadata reader opened a ciphertext body'
            return {'Body': Body()}
    monkeypatch.setattr(archive, '_r2_client', lambda: Client())
    monkeypatch.setattr(archive, '_r2_bucket', lambda: 'test-bucket')
    assert archive.read_r2_artifact_metadata(root_agent_id='root', path='hit.enc') == {'plaintext_bytes':3}
    assert calls == [('HEAD', key), ('GET', key + '.meta.json')]
    assert all(path.endswith('.meta.json') for method, path in calls if method == 'GET')


def test_foundry_original_body_read_failure_matches_observer_off(monkeypatch):
    from providers.rose import foundry
    from providers.rose.pools import get_pool
    from providers.rose.whm_retry_observation import FAILURE_OBSERVER
    original_client = httpx.AsyncClient
    class Broken(httpx.AsyncByteStream):
        async def __aiter__(self):
            raise httpx.ReadError('original body transport')
            yield b''
    def handler(request): return httpx.Response(400, stream=Broken())
    monkeypatch.setattr(foundry.httpx, 'AsyncClient', lambda **kw: original_client(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setenv('AZURE_FOUNDRY_ENDPOINT', 'https://offline.invalid')
    monkeypatch.setenv('AZURE_FOUNDRY_API_KEY', 'synthetic')
    monkeypatch.setenv('AZURE_FOUNDRY_DEPLOYMENTS', 'gpt-6-sol')
    async def call():
        return [item async for item in foundry.foundry_complete(
            pool_spec=get_pool('rose-1-ultra'),messages=[{'role':'user','content':'synthetic'}],
            response_format=None, tools=None, context_tools=None, tool_choice=None,
            temperature=None, effort='high', provider_fast_mode=True, request_id='offline',
            route_key='test',agent_id='test',call_site='test',cache_namespace=None,
            ttft_timeout_s=2,idle_timeout_s=2)]
    errors=[]
    for observer in [None, lambda row: None]:
        foundry._cooldown_until.clear();foundry._auth_cooldown_until.clear()
        token=FAILURE_OBSERVER.set(observer)
        try:
            with pytest.raises(Exception) as error: asyncio.run(call())
            errors.append((type(error.value),str(error.value)))
        finally: FAILURE_OBSERVER.reset(token)
    assert errors[0] == errors[1]
    assert errors[0][1] == 'Foundry transport failed: ReadError'


def test_no_observer_does_not_touch_body():
    from providers.rose.whm_retry_observation import FAILURE_OBSERVER, observe_http_failure
    response = SimpleNamespace(aread=lambda: pytest.fail('body read with no observer'))
    token = FAILURE_OBSERVER.set(None)
    try:
        asyncio.run(observe_http_failure('synthetic-model', response))
    finally:
        FAILURE_OBSERVER.reset(token)


@pytest.mark.parametrize('payload, expected', [
    ({'resolved':False,'enabled':False,'goal':None,'provider_fast_mode':True}, (True, False)),
    ({'resolved':True,'enabled':False,'goal':'','provider_fast_mode':True}, (False, True)),
    ({'enabled':False,'goal':'','provider_fast_mode':True}, (False, True)),
    ({'resolved':True,'enabled':True,'goal':'persisted','provider_fast_mode':False}, (True, False)),
])
def test_workflow_resolution_preserves_failure_but_honors_empty_success(monkeypatch, payload, expected):
    from workflows import agent_workflow as owner
    class Observed(BaseException): pass
    def forbidden_patch(_):
        pytest.fail('generation replacement must not call workflow.patched')
    monkeypatch.setattr(owner.workflow, 'patched', forbidden_patch)
    state = owner.AgentWorkflow()
    from pathlib import Path
    tasks=json.loads((Path(owner.__file__).parents[1]/'benchmarks/tasks.json').read_text())
    demo=next(t['prompt'] for t in tasks if t['name']=='demo-fleet-alpha')
    monkeypatch.setattr(owner.workflow, 'logger', SimpleNamespace(info=lambda *a,**k:None, warning=lambda *a,**k:None, error=lambda *a,**k:None))
    async def noop(*args, **kwargs): return None
    resolved_seen = False
    async def activity(fn, *args, **kwargs):
        nonlocal resolved_seen
        if resolved_seen:
            raise Observed()
        if fn is owner.resolve_fast_cache_context_activity:
            resolved_seen = True
            return payload
        if fn is owner.get_model_context_window:
            return 200000
        if fn is owner.get_agent_source:
            return 'WEB'
        return None
    def stop(*args, **kwargs): raise Observed()
    monkeypatch.setattr(owner.AgentWorkflow, '_world_clock_event', noop)
    monkeypatch.setattr(owner.AgentWorkflow, '_advance_cloud_agent_lifecycle', noop)
    monkeypatch.setattr(owner.workflow, 'now', lambda: datetime(2026, 1, 1, tzinfo=timezone.utc))
    monkeypatch.setattr(owner.workflow, 'execute_activity', activity)
    monkeypatch.setattr(owner.workflow, 'start_activity', stop)
    with pytest.raises(Observed):
        asyncio.run(state.run('agent','user','Buy socks','rose-labs/rose-ultra',256,{},
            world_model_mode='simulate',
            resume_state={'version':1,'kind':'continuation','runtime_state':{
                'fast_mode_cache_enabled':True,'provider_fast_mode':False,
                'fast_cache_goal':demo}}))
    assert state.world_model_mode == 'simulate'
    # Observe actual restored DEMO state after the durable-resolution boundary.
    assert (state.fast_mode_cache_enabled, state.provider_fast_mode) == expected


@pytest.mark.parametrize('resolved, expected', [((False,None,False,None,None,True),False), ((False,'',False,'agent','',True),True)])
def test_activity_exposes_lookup_success_even_for_empty_goal(monkeypatch, resolved, expected):
    from providers.fast_cache import client
    from helpers.fast_cache_goal import resolve_fast_cache_context_activity
    async def lookup(_): return resolved
    monkeypatch.setattr(client, 'resolve_agent_fast_mode', lookup)
    value=asyncio.run(resolve_fast_cache_context_activity('agent'))
    assert value['resolved'] is expected
    assert value['goal'] == resolved[1]


@pytest.mark.parametrize('failure', [httpx.ReadError('broken'), httpx.ReadTimeout('late'), ssl.SSLError('broken TLS')])
def test_actual_cerebras_status_error_is_unchanged_by_observer(monkeypatch, failure):
    from contextlib import asynccontextmanager
    from providers.rose import cerebras
    from providers.rose.pools import get_pool
    from providers.rose.whm_retry_observation import FAILURE_OBSERVER
    class Broken(httpx.AsyncByteStream):
        async def __aiter__(self):
            raise failure
            yield b''
    @asynccontextmanager
    async def response(**kwargs):
        yield httpx.Response(400, stream=Broken())
    async def not_cooled(*args): return False
    monkeypatch.setattr(cerebras, '_cooldown_scope', lambda *args: (('offline',),''))
    monkeypatch.setattr(cerebras, '_cerebras_on_cooldown', not_cooled)
    monkeypatch.setattr(cerebras, 'post_cerebras_stream', response)
    async def call():
        return [item async for item in cerebras.cerebras_complete(
            pool_spec=get_pool('rose-1-flash'),messages=[{'role':'user','content':'synthetic'}],
            cerebras_key='synthetic',request_id='offline')]
    errors=[]
    for observer in [None,lambda row:None]:
        token=FAILURE_OBSERVER.set(observer)
        try:
            with pytest.raises(Exception) as error: asyncio.run(call())
            errors.append((type(error.value),str(error.value),getattr(error.value,'status',None)))
        finally: FAILURE_OBSERVER.reset(token)
    assert errors[0] == errors[1]
    assert errors[0][2] == 400


def test_observer_keeps_quota_and_raw_body_evidence():
    from providers.rose.whm_retry_observation import FAILURE_OBSERVER, observe_http_failure
    rows=[]
    token=FAILURE_OBSERVER.set(rows.append)
    try:
        asyncio.run(observe_http_failure('synthetic',httpx.Response(429,json={'error':{'code':'insufficient_quota'}})))
        assert rows[-1]['permanent'] is True
        assert rows[-1]['response_body_bytes'] > 0
        assert rows[-1]['response_body_sha256']
    finally: FAILURE_OBSERVER.reset(token)


def test_observer_does_not_swallow_cancellation():
    from providers.rose.whm_retry_observation import FAILURE_OBSERVER, observe_http_failure
    class Cancelled(httpx.AsyncByteStream):
        async def __aiter__(self):
            raise asyncio.CancelledError()
            yield b''
    token=FAILURE_OBSERVER.set(lambda row:None)
    try:
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(observe_http_failure('synthetic',httpx.Response(400,stream=Cancelled())))
    finally: FAILURE_OBSERVER.reset(token)


@pytest.mark.parametrize('status, data, expected',[(503,{},False),(200,{'enabled':False,'goal':'','providerFastMode':False},True)])
def test_actual_lookup_distinguishes_error_and_empty_success(monkeypatch,status,data,expected):
    from providers.fast_cache import client
    from helpers.fast_cache_goal import resolve_fast_cache_context_activity
    async def call():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req:httpx.Response(status,json=data))) as http:
            monkeypatch.setattr(client,'_backend',lambda:('https://offline.invalid','synthetic'))
            monkeypatch.setattr(client,'_shared_client',lambda:http)
            monkeypatch.setattr(client,'_AGENT_FASTMODE',{})
            result=await resolve_fast_cache_context_activity('offline-agent')
            assert result['resolved'] is expected
            assert result['goal'] == ('' if status==200 else None)
    asyncio.run(call())
