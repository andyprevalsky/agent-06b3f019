"""Owned fresh recording boundaries, using local manifests and offline providers."""
import asyncio
import contextlib
import hashlib
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

@contextlib.contextmanager
def recording():
    from benchmarks.local import REPO_ROOT, apply_owned_wmh_recording
    from providers.demo_cache.env import DEMO_CACHE_ENV_ALIASES
    with tempfile.TemporaryDirectory(prefix='owned-recording-test-') as directory:
        manifest=Path(directory)/'owner.json'; url='postgresql://offline@localhost:5432/victoria_wmh_recording_blackbox'
        owner=dict(checkout=str(REPO_ROOT.resolve()),owner_workspace='recording-test',database='victoria_wmh_recording_blackbox',host='localhost',url_sha256=hashlib.sha256(url.encode()).hexdigest(),retained_across_iterations=True)
        manifest.write_text(json.dumps(owner))
        env={'FAST_MODE_CACHE_RECORD_DEMO':'1','WMH_OWNED_RECORDING_CACHE_DATABASE_URL':url,'WMH_OWNED_RECORDING_CACHE_MANIFEST':str(manifest),'CONDUCTOR_WORKSPACE_NAME':'recording-test','BENCHMARK_ISOLATED_RUN':'true','BENCHMARK_WORLD_MODEL_MODE':'simulate','DATABASE_URL':'postgresql://offline@localhost/fixture'}
        from types import SimpleNamespace
        assert apply_owned_wmh_recording(env,isolated=True,simulate=True,tasks=[SimpleNamespace(demo_cache='on')],workspace='recording-test',fixture_database='fixture')
        with patch.dict(os.environ,env):
            # Remove unrelated inherited selectors, not the caller's other environment.
            for key in ('BENCHMARK_DEMO_CACHE_READ_ONLY','DEMO_CACHE_RECORD_DEMO','DEMO_CACHE_DATABASE_URL','DEMO_CACHE_DISABLE_WRITE_THROUGH'):
                if key not in env: os.environ.pop(key,None)
            yield manifest,owner

async def test_recording_never_consumes_legacy_hits():
    from providers.demo_cache import client as c
    with recording():
        key='fastmode:v43:llm:goal:execute_loop:p:1:c:old'
        old={'content':'OLD TRAJECTORY','task_completed':True}
        with patch.object(c,'_pop_valid_prefetched_record',return_value={'hit':True,'value':old,'blobPath':None}) as prefetch:
            actual=await c.cache_get_record(key)
        assert actual['hit'] is False, actual
        prefetch.assert_not_called()
        c._position_memo[('goal','execute_loop',1)]=(old,key,__import__('time').monotonic()+100)
        try:
            with patch.object(c,'_shared_client',side_effect=AssertionError('no cache network')):
                assert await c.cache_get_position_fallback('goal','execute_loop',1)==(None,None)
                assert await c.trajectory_prior_exists('goal','execute_loop',2) is False
                assert await c.cache_get_first([key,key+'2'])==(None,None)
                await c.prefetch_cache_records([key])
                c._schedule_position_prefetch('goal','execute_loop',1)
        finally: c._position_memo.pop(('goal','execute_loop',1),None)

async def test_recording_direct_browser_is_genuine():
    from providers.demo_cache.browser_use_cache import cached_browser_decision
    from providers.demo_cache import client as c
    from benchmarks.benchmark_tasks import get_task_by_name
    task=get_task_by_name('test-mass-agent-run-0'); goal=task.prompt
    fresh={'action':{'action':'read_browser_state','params':{}},'task_completed':False,'score':0.5,'output':{'missing':'must remain missing'}}
    with recording(),patch.object(c,'cache_get',AsyncMock(return_value=None)) as read,patch.object(c,'cache_set',AsyncMock(return_value=True)) as write:
        live=AsyncMock(return_value=fresh)
        actual=await cached_browser_decision(enabled=True,goal=goal,request={'task':goal},call_llm=live,write_enabled=True)
        assert actual==fresh,actual
        live.assert_awaited_once(); read.assert_not_awaited(); assert write.await_args.args[3]==fresh
        live.side_effect=asyncio.CancelledError()
        try: await cached_browser_decision(enabled=True,goal=goal,request={},call_llm=live,write_enabled=True)
        except asyncio.CancelledError: pass
        else: raise AssertionError('cancel swallowed')

async def test_recording_blobs_never_replace_historical_paths():
    from providers.demo_cache.blob_store import blob_path_for_key, upload_blob
    key='fastmode:v43:file:goal:artifact'
    old=f'fast-mode-cache/{hashlib.sha256(key.encode()).hexdigest()[:2]}/{hashlib.sha256(key.encode()).hexdigest()}'
    with recording():
        actual=blob_path_for_key(key)
        assert actual!=old,(actual,old)
        assert actual.startswith('fast-mode-cache/owned-recording/')
        try: await upload_blob(old,b'never upload')
        except ValueError: pass
        else: raise AssertionError('historical blob replacement admitted')
    assert blob_path_for_key(key)==old

async def test_recording_owner_identity_and_bounded_validation():
    import builtins
    from providers.demo_cache import context as owner, client
    from benchmarks.wmh_rose_provider import _WMHDemoCacheContext
    with recording() as (manifest, identity):
        owner._recording_manifest.cache_clear()
        real_open=builtins.open
        with patch('builtins.open',wraps=real_open) as opened:
            namespaces=[owner.owned_recording_namespace() for _ in range(10000)]
        assert len(set(namespaces))==1 and namespaces[0]
        assert sum(call.args[0]==str(manifest.resolve()) for call in opened.call_args_list)==1
        assert owner._recording_manifest.cache_info().currsize<=8
        for kind in (owner.DemoCacheContext,_WMHDemoCacheContext):
            ctx=kind(enabled=True,goal='task',write_enabled=True)
            assert ctx.active and ctx.should_write and not ctx.read_enabled and not ctx.soft_complete_allowed
        assert owner.write_through_enabled_for_user('test-only-non-allowlisted-user')
        saved=client._AGENT_FASTMODE.get('recording-agent')
        client._AGENT_FASTMODE['recording-agent']=(True,'goal',True,'root','root goal',False)
        try:
            assert await client.resolve_agent_fast_mode('recording-agent')==(False,'goal',True,'root','root goal',False)
        finally:
            if saved is None: client._AGENT_FASTMODE.pop('recording-agent',None)
            else: client._AGENT_FASTMODE['recording-agent']=saved
        class Flags:
            async def post(self,*args,**kwargs):
                class Response:
                    status_code=200
                    def json(self): return {'enabled':True,'goal':'new goal','writeEnabled':True,'rootAgentId':'root','rootGoal':'root goal','providerFastMode':False}
                return Response()
        with patch.object(client,'_shared_client',return_value=Flags()),patch.object(client,'_backend',return_value=('http://offline','unused')):
            try:
                assert await client.resolve_agent_fast_mode('recording-refresh',refresh=True)==(False,'new goal',True,'root','root goal',False)
            finally:
                client._AGENT_FASTMODE.pop('recording-refresh',None); client._AGENT_SPEED.pop('recording-refresh',None)
        identity['owner_workspace']='other'; manifest.write_text(json.dumps(identity))
        try: owner.owned_recording_namespace()
        except ValueError: pass
        else: raise AssertionError('mutated manifest reused cached admission')
    # A flag alone is the old general record/replay switch, not fresh admission.
    with patch.dict(os.environ,{'FAST_MODE_CACHE_RECORD_DEMO':'1'}):
        for key in ('WMH_OWNED_RECORDING_CACHE_DATABASE_URL','WMH_OWNED_RECORDING_CACHE_MANIFEST'):
            os.environ.pop(key,None)
        assert owner.owned_recording_namespace() is None
        assert owner.DemoCacheContext(enabled=True,goal='ordinary',write_enabled=True).read_enabled

async def test_recording_native_and_compatibility_verdict_transport():
    from providers.demo_cache import client, context, rose_cache
    from providers.rose.client import RoseClient
    from providers.rose.types import StreamChunk
    from helpers.llm import _build_verifier_response_model
    from pydantic import ValidationError
    schema={'fields': [{'description': '', 'name': 'creator_name', 'nullable': False, 'properties': [], 'required': True, 'type': 'str'}, {'description': '', 'name': 'rank_from_initial_list', 'nullable': False, 'properties': [], 'required': True, 'type': 'int'}, {'description': '', 'name': 'platform_handles_and_urls', 'nullable': False, 'properties': [], 'required': True, 'type': 'str'}, {'description': '', 'name': 'posting_cadence_by_platform', 'nullable': False, 'properties': [], 'required': True, 'type': 'str'}, {'description': '', 'name': 'hook_formulas', 'nullable': False, 'properties': [], 'required': True, 'type': 'list[str]'}, {'description': '', 'name': 'top_5_performing_pieces_last_90_days', 'nullable': False, 'properties': [{'description': '', 'name': 'platform', 'nullable': False, 'required': True, 'type': 'str'}, {'description': '', 'name': 'title_or_topic', 'nullable': False, 'required': True, 'type': 'str'}, {'description': '', 'name': 'url', 'nullable': False, 'required': True, 'type': 'str'}, {'description': '', 'name': 'date', 'nullable': False, 'required': True, 'type': 'str'}, {'description': '', 'name': 'metrics_or_proxy', 'nullable': False, 'required': True, 'type': 'str'}, {'description': '', 'name': 'why_it_performed', 'nullable': False, 'required': True, 'type': 'str'}], 'required': True, 'type': 'list[object]'}, {'description': '', 'name': 'core_content_pillars', 'nullable': False, 'properties': [], 'required': True, 'type': 'list[str]'}, {'description': '', 'name': 'audience_persona', 'nullable': False, 'properties': [], 'required': True, 'type': 'str'}, {'description': '', 'name': 'monetization_funnels', 'nullable': False, 'properties': [], 'required': True, 'type': 'str'}, {'description': '', 'name': 'content_gaps', 'nullable': False, 'properties': [], 'required': True, 'type': 'list[str]'}, {'description': '', 'name': 'opportunities_for_aman', 'nullable': False, 'properties': [], 'required': True, 'type': 'str'}, {'description': '', 'name': 'engagement_approach', 'nullable': False, 'properties': [], 'required': True, 'type': 'str'}, {'description': '', 'name': 'citations_sources', 'nullable': False, 'properties': [], 'required': True, 'type': 'list[str]'}, {'description': '', 'name': 'confidence_level', 'nullable': False, 'properties': [], 'required': True, 'type': 'str'}]}
    # Exact captured child schema; values below only test transport and strict shape.
    current={'reasoning': 'offline transport control', 'task_completed': False, 'score': 0.5, 'output': {'creator_name': 'offline shape fixture', 'rank_from_initial_list': 1, 'platform_handles_and_urls': 'offline shape fixture', 'posting_cadence_by_platform': 'offline shape fixture', 'hook_formulas': [], 'top_5_performing_pieces_last_90_days': [], 'core_content_pillars': [], 'audience_persona': 'offline shape fixture', 'monetization_funnels': 'offline shape fixture', 'content_gaps': [], 'opportunities_for_aman': 'offline shape fixture', 'engagement_approach': 'offline shape fixture', 'citations_sources': [], 'confidence_level': 'offline shape fixture'}}
    model=_build_verifier_response_model(schema,require_task_completion=True)
    assert model.model_validate(current).task_completed is False
    for key in ('task_completed','output'):
        bad=dict(current);bad.pop(key)
        try:model.model_validate(bad)
        except ValidationError:pass
        else:raise AssertionError('strict parser accepted missing required value')
    bad={**current,'task_completed':'true'}
    try:model.model_validate(bad)
    except ValidationError:pass
    else:raise AssertionError('strict parser coerced task boolean')
    wire=json.dumps(current); calls=[]
    async def stream(**kwargs):
        calls.append(kwargs)
        yield StreamChunk(kind='content',data={'text':wire})
        yield StreamChunk(kind='done',data={})
    for compatibility in (False,True):
        rose=RoseClient(openrouter_key='offline-unused')
        with recording(),patch.object(rose,'_complete_impl',stream),patch.object(client,'cache_get_first',AsyncMock(side_effect=AssertionError('old lookup'))) as read,patch.object(client,'cache_set',AsyncMock(return_value=True)) as write:
            token=context.set_context(context.DemoCacheContext(enabled=True,goal='recording',write_enabled=True,base_step=1))
            try:
                kwargs=dict(pool='rose-1-flash',messages=[{'role':'user','content':'same current request'}],dump_context=False)
                source=rose_cache.cached_complete(rose,call_site='verifier',**kwargs) if compatibility else rose.complete(call_site='verifier',**kwargs)
                chunks=[chunk async for chunk in source]
                actual=json.loads(''.join(chunk.data.get('text','') for chunk in chunks if chunk.kind=='content'))
                assert actual==current and actual['task_completed'] is False
                assert json.loads(write.await_args.args[3]['content'])==current
                read.assert_not_awaited()
            finally:context.reset_context(token)
    assert len(calls)==2

async def test_recording_direct_file_and_http_reads_are_bypassed():
    from providers.demo_cache import client
    from providers.demo_cache.browser_http import BrowserHttpCache
    with recording(),patch.object(client,'_shared_client',side_effect=AssertionError('historical backend read')):
        assert await BrowserHttpCache('goal',read_enabled=True).lookup('GET','https://offline.example/file','document') is None
        assert await client._cache_get_record_direct('k')==({'hit':False,'value':None,'blobPath':None},200)
        assert await client._cache_get_record_batched('k')=={'hit':False,'value':None,'blobPath':None}
        assert await client._fetch_cache_records_many(['k'])=={'k':{'hit':False,'value':None,'blobPath':None}}
        assert await client._fetch_position_http('g','s',1)==(None,None)
        assert await client._fetch_position_http_once('g','s',1)==(None,None)


async def test_recording_file_download_uses_current_bytes_and_owned_blob():
    from domains.web_fetch import service
    from providers.demo_cache import client,blob_store
    body=b'current file bytes from offline transport fixture'
    url='https://offline.example/current.csv'
    with recording(),patch.object(service,'download_files_batch',AsyncMock(return_value={url:body})) as download,patch.object(blob_store,'download_blob',AsyncMock(side_effect=AssertionError('historical blob read'))),patch.object(blob_store,'upload_blob',AsyncMock(return_value=True)) as upload,patch.object(client,'cache_set',AsyncMock(return_value=True)) as write:
        actual=await service._download_files_with_demo_cache([url],fast_mode_cache_enabled=True,fast_mode_goal='recording goal',fast_mode_cache_write_enabled=True,agent_id=None)
        assert actual=={url:body}; download.assert_awaited_once_with([url])
        path,uploaded=upload.await_args.args
        assert uploaded==body and path.startswith('fast-mode-cache/owned-recording/')
        assert write.await_args.kwargs['blob_path']==path

async def test_recording_runtime_mode_loss_never_soft_completes():
    from providers.demo_cache import browser_use_cache,client
    from benchmarks.benchmark_tasks import get_task_by_name
    goal=get_task_by_name('test-mass-agent-run-0').prompt
    with recording(),patch.dict(os.environ,{'BENCHMARK_WORLD_MODEL_MODE':'unsupported'}),patch.object(client,'cache_get',AsyncMock(return_value=None)):
        live=AsyncMock(side_effect=AssertionError('invalid owner must not execute'))
        try:
            result=await browser_use_cache.cached_browser_decision(enabled=True,goal=goal,request={},call_llm=live,write_enabled=True)
        except ValueError:
            pass
        else:
            raise AssertionError(f'invalid recording silently returned {result}')
        live.assert_not_awaited()


async def test_recording_invalid_owner_cannot_write_directly():
    from providers.demo_cache import client
    with recording() as (manifest,owner):
        owner['host']='another-owner';manifest.write_text(json.dumps(owner))
        with patch.object(client,'_shared_client',side_effect=AssertionError('must reject before HTTP')):
            try: await client.cache_set('key','llm','goal',{'task_completed':False})
            except ValueError: pass
            else: raise AssertionError('direct write accepted invalid owner')

async def test_real_recording_bypasses_history_and_soft_completion():
    from providers.demo_cache import context,client,browser_use_cache
    from benchmarks.benchmark_tasks import get_task_by_name
    goal=get_task_by_name('test-mass-agent-run-0').prompt
    fresh={'action':{'action':'read_browser_state','params':{}},'task_completed':False,'score':0.5}
    # Establish valid owner bindings, then exercise the explicit REAL runtime.
    with recording():
        from providers.demo_cache import normalize
        simulated_key=normalize.browser_use_key(goal,{})
    with recording(),patch.dict(os.environ,{'BENCHMARK_WORLD_MODEL_MODE':'real'}):
        real_key=normalize.browser_use_key(goal,{})
        assert real_key != simulated_key and ':sim.' not in real_key
        assert not context.DemoCacheContext(enabled=True,goal=goal,write_enabled=True).read_enabled
        with patch.object(client,'_pop_valid_prefetched_record',return_value={'hit':True,'value':{'old':True},'blobPath':None}) as warm,patch.object(client,'_shared_client',side_effect=AssertionError('historical read forbidden')):
            assert (await client.cache_get_record('real-key'))['hit'] is False
            warm.assert_not_called()
            assert await client.soft_complete_allowed_for_agent(None,goal) is False
        live=AsyncMock(return_value=fresh)
        with patch.object(client,'cache_get',AsyncMock(return_value=None)) as read,patch.object(client,'cache_set',AsyncMock(return_value=True)):
            assert await browser_use_cache.cached_browser_decision(enabled=True,goal=goal,request={},call_llm=live,write_enabled=True)==fresh
            live.assert_awaited_once();read.assert_not_awaited()
        assert os.environ['BENCHMARK_WORLD_MODEL_MODE']=='real'
