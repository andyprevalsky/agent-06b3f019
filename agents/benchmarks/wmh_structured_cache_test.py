from __future__ import annotations
import asyncio,json,socket,sys,types
import httpx,pytest
from pydantic import BaseModel,ConfigDict
from wmh.providers.base import Message
from providers.rose.types import RoseResponse,StreamChunk
from providers.rose import RoseClient
from providers.demo_cache import client as cache_client
from providers.demo_cache.context import current_context,set_context,reset_context
from providers.demo_cache.rose_cache import request_key_material
from benchmarks import wmh_rose_provider as module
from benchmarks.wmh_provider_capture import REJECTION_RECORDER
class NativeFixture(BaseModel):
 model_config=ConfigDict(extra='forbid')
 message:str
 tool_results:list[dict]
 state:dict
 terminal:bool

def payload(call='call-1'):
 return {'message':'','tool_results':[{'call_id':call,'content':'Observed sanitized fixture.','is_error':False}],'state':{},'terminal':False}
def wire():
 return [{'role':'user','content':json.dumps({'candidate_response':{'tool_calls':[{'call_id':'call-1'}]}})}]
@pytest.fixture(autouse=True)
def deny_network(monkeypatch):
 def denied(*a,**k):raise AssertionError('No externalnetwork in owning control')
 monkeypatch.setattr(socket.socket,'connect',denied)
 monkeypatch.setattr(socket,'create_connection',denied)
@pytest.mark.parametrize('recovery',[False,True])
@pytest.mark.parametrize('recorder',[False,True])
@pytest.mark.parametrize('shape',['tool','phases','restart'])
def test_wmh_structured_guard_uses_canonical_consumer(monkeypatch,recorder,shape,recovery):
 text=json.dumps(payload());safe=[]
 async def stream(self,**kwargs):
  yield StreamChunk(kind='metadata',data={'actual_model':'sanitized-model'})
  if shape=='tool':yield StreamChunk(kind='tool_call',data={'name':'submit_response','arguments':text,'id':'raw-output-tool-id'})
  else:
   yield StreamChunk(kind='content',data={'text':'discard commentary','phase':'commentary','item_id':'commentary'})
   if shape=='restart':
    yield StreamChunk(kind='content',data={'text':'bad prior','phase':'final_answer','item_id':'old'})
    yield StreamChunk(kind='restart')
   yield StreamChunk(kind='content',data={'text':text,'phase':'final_answer','item_id':'final'})
  yield StreamChunk(kind='usage',data={'prompt_tokens':10,'completion_tokens':5,'compute_token_used':{'type':'gpt','source':'fixture','access_token':'must-not-persist'}})
  yield StreamChunk(kind='done')
 monkeypatch.setattr(RoseClient,'_complete_impl',stream)
 monkeypatch.setattr(RoseClient,'_complete_once',stream)
 async def record(v):raise AssertionError('Valid authoritative result must not be rejected')
 async def run():
  token=REJECTION_RECORDER.set(record) if recorder else None
  try:
   client=object.__new__(module._WMHCacheSafeRoseClient)
   async for chunk in client._complete_impl(response_model=NativeFixture,call_site='wmh_world_model_v3',messages=wire(),recover_truncation=recovery):safe.append(chunk)
  finally:
   if token is not None:REJECTION_RECORDER.reset(token)
 asyncio.run(run());assert any(c.kind=='done' for c in safe);u=next(c.data for c in safe if c.kind=='usage');assert u['compute_token_used']=={'type':'gpt','source':'fixture'}

@pytest.mark.parametrize('case',['valid','valid_tool','cache_valid_tool','wrong_call','truncated','malformed','cache_valid','cache_wrong','duplicate_keys','unknown_keys','nonfinite'])
def test_wmh_schema_results_store_only_after_all_native_validation(monkeypatch,case):
 posts=[];body=payload('wrong' if case in ['wrong_call','cache_wrong'] else 'call-1');text='not json' if case=='malformed' else json.dumps(body);usage={'prompt_tokens':10,'completion_tokens':5,'finish_reason':'length' if case=='truncated' else 'stop','from_fast_cache':case.startswith('cache_')}
 if case=='duplicate_keys':text=text.replace('"terminal": false','"terminal": true, "terminal": false')
 if case=='unknown_keys':text=text[:-1]+', "unknown": 1}'
 if case=='nonfinite':text=text.replace('"state": {}','"state": {"bad": NaN}')
 if case=='valid':text=json.dumps(body,indent=2)
 captured=[]
 response=RoseResponse(content='' if case.endswith('_tool') else text,tool_calls=[{'name':'submit_response','arguments':text,'id':'unaltered-tool-id'}] if case.endswith('_tool') else [],usage=usage,actual_model='sanitized-model',pool_name='fixture',request_id='fixture-request')
 class Client:
  async def collect(self,**kwargs):captured.append(kwargs);return response
 provider=module.RoseWMHProvider(client=Client(),protocol='text-world-model-v3')
 async def no_auth():return None,None
 monkeypatch.setattr(provider,'_lease_auth',no_auth)
 monkeypatch.setattr(cache_client,'cache_write_allowed',lambda *a,**k:True)
 async def noarchive(*a,**k):return None
 monkeypatch.setattr(cache_client,'_archive_cache_write',noarchive)
 monkeypatch.setattr(cache_client,'_backend',lambda:('http://owned-cache.invalid','sanitized-key'))
 def transport(request):
  assert request.url.path=='/api/fast-cache/set';posts.append(json.loads(request.content));return httpx.Response(200,json={'ok':True,'stored':True})
 http=httpx.AsyncClient(transport=httpx.MockTransport(transport));monkeypatch.setattr(cache_client,'_shared_client',lambda:http)
 ctx=module._WMHDemoCacheContext(enabled=True,goal='DEMO FIXTURE ONLY structured native cache',write_enabled=True,root_goal='DEMO FIXTURE ONLY structured native cache',provider_fast_mode=True)
 async def run():
  prior=current_context();token=set_context(ctx)
  try:
   if case in ['valid','valid_tool','cache_valid','cache_valid_tool']:
    result=await provider._complete_async('System fixture',[Message(role='user',content=wire()[0]['content'])],max_tokens=16384);assert json.loads(result.text)==body
   else:
    with pytest.raises((module._WMHInvalidPrediction,ValueError)):await provider._complete_async('System fixture',[Message(role='user',content=wire()[0]['content'])],max_tokens=16384)
   assert current_context() is ctx
  finally:reset_context(token);await http.aclose()
  assert current_context() is prior
 asyncio.run(run());assert len(posts)==(1 if case in ['valid','valid_tool'] else 0),'Structured output must persist once AFTER schema/native validation; rejected/cache replay must not write'
 if posts:
  raw={k:v for k,v in captured[0].items() if k not in ['claude_auth','gpt_auth']};raw['provider_fast_mode']=True;expected=ctx.llm_key(raw['call_site'],request_key_material(raw));assert posts[0]['key']==expected
  assert posts[0]['value']['content']==text, 'Preserve exact authoritative original payload bytes'
  p=posts[0];assert json.loads(p['value']['content'])==body;assert p['value']['usage']==usage;assert p['value']['actual_model']=='sanitized-model';assert p['value']['tool_calls']==response.tool_calls

@pytest.mark.parametrize('shape',['multiple_final','multiple_tools','unknown_tool','mixed_ambiguous','competing_single','extra_tool'])
def test_wmh_structured_cardinality_rejected_before_done(monkeypatch,shape):
 async def stream(self,**kwargs):
  if shape in ['multiple_final','mixed_ambiguous']:
   for name in ['first','second']:yield StreamChunk(kind='content',data={'text':json.dumps(payload()),'phase':'final_answer','item_id':name})
  elif shape not in ['competing_single']:
   for i in range(2 if shape=='multiple_tools' else 1):yield StreamChunk(kind='tool_call',data={'name':'submit_response' if shape=='multiple_tools' else 'unrelated_tool','arguments':json.dumps(payload()),'id':str(i)})
  if shape=='competing_single':
   other=payload();other['state']={'conflict':True}
   yield StreamChunk(kind='content',data={'text':json.dumps(other),'phase':'final_answer','item_id':'single'})
  if shape in ['mixed_ambiguous','competing_single','extra_tool']:yield StreamChunk(kind='tool_call',data={'name':'submit_response','arguments':json.dumps(payload()),'id':'synthetic'})
  yield StreamChunk(kind='done')
 monkeypatch.setattr(RoseClient,'_complete_impl',stream)
 async def run():
  seen=[];client=object.__new__(module._WMHCacheSafeRoseClient)
  with pytest.raises((module._WMHInvalidPrediction,ValueError)):
   async for chunk in client._complete_impl(response_model=NativeFixture,call_site='wmh_world_model_v3',messages=wire()):seen.append(chunk)
  assert not any(x.kind=='done' for x in seen)
 asyncio.run(run())

def test_wmh_schema_rejection_preserves_private_bytes_without_public_values():
 from benchmarks.wmh_response_schema import NativeTransition
 marker = 'private-schema-output-marker'
 body = payload()
 body['tool_results'][0]['content'] = {'private': marker}
 text = json.dumps(body)
 response = RoseResponse(content=text, actual_model='sanitized-model', usage={'prompt_tokens': 10})
 with pytest.raises(module._WMHInvalidPrediction) as caught:
  module._wmh_response_content(response, NativeTransition)
 assert marker not in str(caught.value)
 assert caught.value.rejected_response['content'] == text

@pytest.mark.parametrize('shape', ['content', 'tool'])
def test_wmh_structured_completion_replays_through_stock_cache(monkeypatch, shape):
 text = json.dumps(payload(), indent=2)
 stored = {}
 live_calls = []
 writes = []
 async def stream(self, **kwargs):
  live_calls.append(kwargs)
  yield StreamChunk(kind='metadata', data={'actual_model': 'sanitized-model', 'pool_name': 'fixture'})
  if shape == 'tool':
   yield StreamChunk(kind='tool_call', data={'name': 'submit_response', 'arguments': text, 'id': 'unaltered-output-id'})
  else:
   yield StreamChunk(kind='content', data={'text': text, 'phase': 'final_answer', 'item_id': 'final'})
  yield StreamChunk(kind='usage', data={'prompt_tokens': 10, 'completion_tokens': 5, 'finish_reason': 'stop'})
  yield StreamChunk(kind='done')
 monkeypatch.setattr(RoseClient, '_complete_impl', stream)
 async def noarchive(*args, **kwargs):
  return None
 monkeypatch.setattr(cache_client, '_archive_cache_write', noarchive)
 monkeypatch.setattr(cache_client, 'cache_write_allowed', lambda *args, **kwargs: True)
 monkeypatch.setattr(cache_client, '_backend', lambda: ('http://owned-cache.invalid', 'sanitized-key'))
 def transport(request):
  body = json.loads(request.content)
  if request.url.path == '/api/fast-cache/get-many':
   return httpx.Response(200, json={'results': {
    key: {'hit': key in stored, 'value': stored.get(key)} for key in body['keys']
   }})
  if request.url.path == '/api/fast-cache/get':
   value = stored.get(body['key'])
   return httpx.Response(200, json={'hit': value is not None, 'value': value})
  assert request.url.path == '/api/fast-cache/set'
  writes.append(body)
  stored[body['key']] = body['value']
  return httpx.Response(200, json={'stored': True})
 http = httpx.AsyncClient(transport=httpx.MockTransport(transport))
 monkeypatch.setattr(cache_client, '_shared_client', lambda: http)
 provider = module.RoseWMHProvider(client=module._WMHCacheSafeRoseClient(openrouter_key='offline-test'), protocol='text-world-model-v3')
 async def no_auth():
  return None, None
 monkeypatch.setattr(provider, '_lease_auth', no_auth)
 ctx = module._WMHDemoCacheContext(enabled=True, goal='DEMO FIXTURE ONLY structured native cache', write_enabled=True, root_goal='DEMO FIXTURE ONLY structured native cache')
 async def run():
  token = set_context(ctx)
  try:
   first = await provider._complete_async('System fixture', [Message(role='user', content=wire()[0]['content'])], max_tokens=16384)
   assert first.text == text
   assert len(live_calls) == len(writes) == 1
   second = await provider._complete_async('System fixture', [Message(role='user', content=wire()[0]['content'])], max_tokens=16384)
   assert second.text == text
   assert second.usage.input_tokens == second.usage.output_tokens == 0
   assert len(live_calls) == len(writes) == 1
   value = next(iter(stored.values()))
   assert value['content'] == text
   bad = json.dumps(payload('wrong-call'))
   value['content'] = bad
   if value['tool_calls']:
    value['tool_calls'][0]['arguments'] = bad
   with pytest.raises(module._WMHInvalidPrediction):
    await provider._complete_async('System fixture', [Message(role='user', content=wire()[0]['content'])], max_tokens=16384)
   assert len(live_calls) == len(writes) == 1
  finally:
   reset_context(token)
   await http.aclose()
 asyncio.run(run())
