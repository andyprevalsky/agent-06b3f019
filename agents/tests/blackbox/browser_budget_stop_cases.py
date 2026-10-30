"""Actual browser activity/manager finalization handshake regression."""
import ast
import asyncio
import copy
import dataclasses
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from temporalio.testing import ActivityEnvironment

async def exercise_finalizer_handoff(namespace, fixture_path, mode="budget"):
    from helpers import browser_budget_stop as budget, query_parent_state as parent
    from domains.spawn_browser_agent_v3 import handler as h
    bb = SimpleNamespace(**namespace)
    CANDIDATE = True
    source=ast.parse(fixture_path.read_text())
    node=copy.deepcopy(next(n for n in source.body if isinstance(n,ast.AsyncFunctionDef) and n.name=='test_spawn_browser_activity_verified_completion_message_leads_with_goal'))
    class Adapt(ast.NodeTransformer):
     def visit_Assert(self,node):return None
     def visit_Call(self,node):
      node=self.generic_visit(node)
      if isinstance(node.func,ast.Name) and node.func.id=='patch' and node.args and isinstance(node.args[0],ast.Constant):
       if node.args[0].value.endswith('._call_browser_use_with_rotation'):
        node.args[1]=ast.Name(id='actor',ctx=ast.Load())
       if node.args[0].value.endswith('.call_temporal_activity_from_activity'):
        node.args[1]=ast.Name(id='verifier',ctx=ast.Load())
       if node.args[0].value.endswith('.close_browser_session'):
        node.args[1]=ast.Name(id='close_fixture',ctx=ast.Load())
       if node.args[0].value.endswith('.propagate_browser_run_credentials'):
        node.args[1]=ast.Name(id='propagate_fixture',ctx=ast.Load())
      if isinstance(node.func,ast.Name) and node.func.id=='spawn_browser_agent_activity_v3' and CANDIDATE:
       node.keywords.append(ast.keyword(arg='budget_finalizer',value=ast.Name(id='ticket',ctx=ast.Load())))
      if isinstance(node.func,ast.Name) and node.func.id=='spawn_browser_agent_activity_v3':
       node.keywords.append(ast.keyword(arg='await_owner_cleanup',value=ast.Constant(value=True)))
      return node
    node=Adapt().visit(node);node.decorator_list=[];node.body.append(ast.Return(value=ast.Name(id='result',ctx=ast.Load())))
    async def actor(**kwargs):
     events.append('actor')
     return {'action':{'action':'evaluate','params':{'script':'document.title'}},'usage':{},'mode':'waterfall'}
    async def verifier(*a,**kw):
     events.append('verifier-start');started.set();await release.wait()
     events.append('verifier-done')
     return {'score':0.5,'task_completed':False,'structured_response':{'result':'partial'},'usage':{}}
    async def close_fixture(*a,**kw): events.append('cleanup')
    async def propagate_fixture(*a,**kw):
     events.append('credentials')
     return {'outcome':'unknown','refs':0,'applied':0}
    ns=dict(bb.__dict__,actor=actor,verifier=verifier,close_fixture=close_fixture,propagate_fixture=propagate_fixture,ticket=None)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'existing-full-native-fixture','exec'),ns)
    fixture=ns[node.name]
    now=datetime.now(timezone.utc)
    info=SimpleNamespace(workflow_id='wf',run_id='run',first_execution_run_id='first')
    async def pause():owner.is_paused=True;events.append('pause')
    owner=SimpleNamespace(agent_id='agent-1',user_id='user-1',is_paused=False,write_lock_enabled=True,system_name='Rose',_browser_execution_task_id='tool-1',_background_tasks={'tool-1':{}},_response_schema_revision=1,_background_handles={},pause=pause)
    class Handle:
     def done(self):return task.done()
     def cancel(self):events.append('cancel');task.cancel()
     def __await__(self):return task.__await__()
    class ClientHandle:
     async def execute_update(self,name,payload,**kwargs):
      if mode=='noack': raise RuntimeError('fixture unavailable')
      assert name=='browser_finalizer_ready';return budget.acknowledge_finalizer(owner,payload)
    class Client:
     def get_workflow_handle(self,wid,**kwargs):assert wid=='wf' and kwargs['run_id']=='run';return ClientHandle()
    client=Client();events=[];task=None;ticket=None;started=None;release=None
    async def start_native(*args,**kwargs):pass

    def start_activity(fn,*,args,**kwargs):
     nonlocal task,ticket
     assert kwargs['start_to_close_timeout']==timedelta(minutes=30)
     env=ActivityEnvironment()
     env.info=dataclasses.replace(env.info,workflow_id='wf',workflow_run_id='run',activity_id=kwargs.get('activity_id','activity'),attempt=1,started_time=now,start_to_close_timeout=timedelta(minutes=30))
     if CANDIDATE:
      ticket=args[-1];ns['ticket']=ticket
     task=asyncio.create_task(env.run(fixture));return Handle()
    async def wait_condition(predicate):
     await started.wait()
     if mode == 'user':
      await owner.pause()
     elif mode == 'kill':
      owner._kill_request = {}
      owner._interrupted_tool_calls = {'tool-1'}
     else:
      receipt=budget.request_budget_stop(owner,{'budget':1,'first_run_id':'first'})
      if mode == 'noack':
       assert receipt['accepted'] is False
       await owner.pause()
      else:
       assert receipt['accepted'] is True
       if mode == 'budget':
        from workflows.background_agents import BackgroundAgentsMixin
        assert (await BackgroundAgentsMixin._start_background_spawn(owner, {}, 'new'))['error']
        assert (await BackgroundAgentsMixin._wake_background_task(owner, 'other', 'next', message_id=None, sender=None))['woke'] is False
        try:
         BackgroundAgentsMixin._launch_background_task(owner, 'new')
        except RuntimeError:
         pass
        else:
         raise AssertionError('new dispatch after accepted budget stop')
       if mode == 'feedback': owner._response_schema_revision += 1
     # Equivalent exhausted-action boundary, with no new actor request.
     if mode == 'budget':release.set()
     while not predicate():await asyncio.sleep(0)
    async def main():
     nonlocal started,release
     started=asyncio.Event();release=asyncio.Event()
     with patch.object(parent,'get_temporal_client',return_value=client), patch('domains.spawn_browser_agent_v3.handler.persist_paused_conversation', AsyncMock()), patch('domains.spawn_browser_agent_v3.handler.poll_new_messages', AsyncMock(return_value=[await bb.native_browser_start_source('1970-01-01T00:00:00+00:00', tool_call_id='tool-1')]), create=True), patch.object(budget.workflow,'info',return_value=info),patch.object(budget.workflow,'now',side_effect=lambda:datetime.now(timezone.utc)),patch.object(budget.workflow,'uuid4',side_effect=['activity','nonce']),patch.object(h,'MAX_ITERATIONS',1),patch.object(h.workflow,'patched',return_value=True),patch.object(h,'execute_action',AsyncMock(return_value={'success':True})),patch.object(h.workflow,'start_activity',side_effect=start_activity),patch.object(h.workflow,'wait_condition',side_effect=wait_condition):
      bb.setup_mock({})
      results=[]
      async for e in h.SpawnBrowserAgentManagerV3().execute_tool(owner,{'goal':'Open example.com and report the main heading.','output_schema':{'fields':[{'name':'result','type':'str'}]}},'tool-1'):
       results.append(e)
      assert events.count('actor') == 1, events
      if mode == 'budget':
       assert 'verifier-done' in events and 'cancel' not in events, events
       assert owner.is_paused
       assert events.index('credentials') < events.index('pause'), events
       assert events.index('cleanup') < events.index('pause'), events
       final=next(e for e in reversed(results) if (e.metadata or {}).get('structured_response'))
       assert final.metadata['structured_response'] == {'result':'partial'}
       assert final.metadata['success'] is False
      else:
       assert 'verifier-done' not in events and 'cancel' in events, events
       assert not any((e.metadata or {}).get('structured_response') for e in results)
      assert not getattr(owner,'_browser_finalizers',{})
      print('FULL NATIVE ACTIVITY + MANAGER HANDOFF PASS',events)
    try:
     await main()
    finally:
     bb.teardown_mock()
