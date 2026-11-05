"""Native batch contract: actual provider normalization, queue and action gates."""
import asyncio
import json
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

import pytest

from providers.rose import RoseClient
from providers.rose.types import RoseResponse
from providers.rose.browser_use import build_browser_use_system_prompt, normalize_browser_use_response
from domains.spawn_browser_agent_v3.action_batch import BrowserActionBatch, context
from domains.spawn_browser_agent_v3.handler import _append_browser_turn_messages
from domains.spawn_browser_agent_v3.streaming import BrowserThinkingStream


def dom_fixture():
    root=NS(backend_node_id=100,parent_node=None)
    def node(i, name, role='textbox'):
        return NS(backend_node_id=i,parent_node=root,target_id='tab',frame_id='frame',node_name='INPUT',
                  ax_node=NS(name=name,role=role),is_visible=True,tag_name='input',attributes={},get_all_children_text=lambda:name)
    dom=NS(session=NS(agent_focus_target_id='tab'),selector_map={1:node(1,'Name'),2:node(2,'Email'),3:node(3,'Pay','button')},url='https://shop.test')
    dom.get_parked_page_identity=lambda:{'target_id':dom.session.agent_focus_target_id,'url':dom.url}
    return dom


def native(name,args,id):
    return {'id':id,'name':name,'arguments':json.dumps(args)}


async def response(calls):
    c=RoseClient(openrouter_key='offline-unused')
    c.collect=AsyncMock(return_value=RoseResponse(tool_calls=calls,usage={'prompt_tokens':10},request_id='req'))
    with patch('helpers.observability.dump_llm_context'):
        result=await c.complete_browser_use(task='Complete the requested form',browser_state={},action_history=[],
                                          available_actions=['read_browser_state','input_text','click','goto','press_key'])
    assert c.collect.await_count==1
    return result


def stream():
    s=BrowserThinkingStream(agent_id='root',task_id='task',iteration=1)
    s.finish_tools=AsyncMock(wraps=s.finish_tools)
    return s


async def form_chain():
    result=await response([native('input_text',{'index':1,'text':'Ada'},'name'),
                           native('input_text',{'index':2,'text':'a@example.test'},'email'),
                           native('click',{'index':3},'pay')])
    assert len(result['batch_actions'])==3
    dom=dom_fixture();messages=[];events=[]
    q=BrowserActionBatch(lambda a,r,i:_append_browser_turn_messages(messages,unified_action=a,result=r,tool_call_id=i))
    s=stream();state=lambda:context(dom,'https://shop.test',messages,('account','realm'))
    current=q.begin(result,dom,state(),s)
    while current is not None:
        a=current['action'];q.started();events.append((current['tool_call_id'],a['action']))
        # Ordinary per-call gate: the Pay click is intercepted, not purchased.
        r={'success':True} if a['action']=='input_text' else {'success':False,'status':'needs_write_approval'}
        _append_browser_turn_messages(messages,unified_action=a,result=r,tool_call_id=current['tool_call_id'])
        await q.completed(a,r)
        current=await q.next(dom,state())
        if current is not None:assert current['usage']=={}
    assert events==[('name','input_text'),('email','input_text'),('pay','click')]
    assert [m['tool_call_id'] for m in messages if m['role']=='tool']==['name','email','pay']


def test_one_model_response_runs_ordered_form_calls():
    asyncio.run(form_chain())


async def observe_chain(fault=None):
    result=await response([native('read_browser_state',{'observation_id':'checkout','targets':[{'key':'pay','role':'button','name':'Pay'}]},'observe'),
                           native('click',{'observation_ref':{'observation_id':'checkout','target':'pay'}},'click-pay')])
    dom=dom_fixture();messages=[];q=BrowserActionBatch(lambda a,r,i:_append_browser_turn_messages(messages,unified_action=a,result=r,tool_call_id=i));s=stream()
    state=lambda:context(dom,'https://shop.test',messages,('account','realm'))
    first=q.begin(result,dom,state(),s);q.started()
    if fault=='ambiguous':dom.selector_map[4]=NS(**{**dom.selector_map[3].__dict__,'backend_node_id':4})
    if fault=='missing':dom.selector_map.pop(3)
    r={'success':fault!='failed','formatted_state':'[1] Name [2] Email [3] Pay [4] Pay'}
    r=q.bind_observation(first['action'],r,dom,state())
    _append_browser_turn_messages(messages,unified_action=first['action'],result=r,tool_call_id=first['tool_call_id'])
    await q.completed(first['action'],r)
    if fault=='changed':dom.selector_map[3].backend_node_id=99
    if fault=='navigation':dom.session.agent_focus_target_id='new-tab'
    following=await q.next(dom,state())
    if fault:
        assert following is None
        assert messages[-1]['tool_call_id']=='click-pay'
        assert json.loads(messages[-1]['content'])['skipped'] is True
    else:
        assert following['action']['index']==3
        assert following['action']['params']=={'index':3}
        assert following['action']['observation_source_call_id']=='observe'
        assert following['tool_call_id']=='click-pay'
        assert following['usage']=={}
        # Actual ordinary executor must still gate this resolved integer action.
        from domains.spawn_browser_agent_v3.service_actions import _execute_interaction_action
        with patch('domains.spawn_browser_agent_v3.service_actions._execute_click',new=AsyncMock(return_value={'success':False,'status':'needs_write_approval'})) as click:
            gated=await _execute_interaction_action(NS(action_name='click',session=dom.session,dom_service=dom,action_history=None,
                element=dom.selector_map[3],index=3,coords=None,thinking='',humanizer=None,write_lock_enabled=True,
                write_lock_approvals={},current_url='https://shop.test',system_name='Rose',secret_refs={}))
        assert gated['status']=='needs_write_approval' and click.await_args.kwargs['write_lock_enabled'] is True


@pytest.mark.parametrize('fault',[None,'ambiguous','missing','failed','changed','navigation'])
def test_same_turn_observe_pay_ref_and_gates(fault):
    asyncio.run(observe_chain(fault))


@pytest.mark.parametrize('fault',['failure','url','node','binding','steering','cancel','navigation-action'])
def test_remainder_is_not_executed_after_invalidating_boundary(fault):
    async def run():
        result=await response([native('input_text',{'index':1,'text':'A'},'a'),native('click',{'index':3},'b')])
        dom=dom_fixture();messages=[];q=BrowserActionBatch(lambda a,r,i:_append_browser_turn_messages(messages,unified_action=a,result=r,tool_call_id=i));state=context(dom,'https://x',messages,'binding');first=q.begin(result,dom,state,stream());q.started()
        action=first['action'];r={'success':fault!='failure'}
        if fault=='navigation-action':action={**action,'action':'goto'}
        await q.completed(action,r)
        url='https://other' if fault=='url' else 'https://x'
        if fault=='url':dom.url=url
        binding='new' if fault=='binding' else 'binding'
        if fault=='node':dom.selector_map[3].backend_node_id=777
        if fault=='steering':messages.append({'role':'user','content':'Stop'})
        if fault=='cancel':await q.discard('cancelled')
        assert await q.next(dom,context(dom,url,messages,binding)) is None
        assert any(m.get('tool_call_id')=='b' and json.loads(m['content']).get('skipped') for m in messages if m['role']=='tool')
    asyncio.run(run())


@pytest.mark.parametrize('calls',[
    [native('read_browser_state',{},'same'),native('click',{'index':3},'same')],
    [native('click',{'observation_ref':{'observation_id':'absent','target':'pay'}},'bad')],
    [native('read_browser_state',{'observation_id':'x'},'x'),native('read_browser_state',{'observation_id':'x'},'y')],
    [native('input_text',{'index':1,'text':'A'},'a'),native('goto',{'not_url':'bad'},'b')],
])
def test_full_native_batch_validation(calls):
    with pytest.raises(ValueError):asyncio.run(response(calls))


def test_legacy_json_batch_preserves_all_actions():
    r=normalize_browser_use_response({'action':[{'input_text':{'index':1,'text':'A'}},{'click':{'index':2}}]})
    assert len(r['batch_actions'])==2


def test_prompt_teaches_batch_boundaries_and_ref_chain():
    p=build_browser_use_system_prompt([])
    assert 'exactly one available' not in p
    for phrase in ['Return one or more browser action tool calls to execute sequentially.', 'Stop at first failure.', 'observation_ref', 'in the same response', "Same-document DOM changes can also invalidate ordinal refs; on 'Unknown ref' or unexpected failures, re-observe."]:
        assert phrase in p


async def streaming_identity():
    from providers.rose.types import StreamChunk
    s=BrowserThinkingStream(agent_id='root',task_id='task',iteration=1)
    with patch('domains.spawn_browser_agent_v3.streaming.stream_assistant_chunk',new=AsyncMock()),patch('domains.spawn_browser_agent_v3.streaming.stream_tool_event',new=AsyncMock()) as events:
        for id in ['one','two']:
            await s.on_chunk(StreamChunk(kind='tool_call',data={'id':id,'name':'input_text','arguments':{}}))
        s.select_tools(['one']);await s.finish_tools(status='FINISHED')
        assert 'two' in s._tool_calls
        await s.finish_tools(status='ERROR',all_tools=True)
        terminals=[x.kwargs for x in events.await_args_list if x.kwargs.get('status')]
        assert [(x['tool_call_id'],x['status']) for x in terminals]==[('one','FINISHED'),('two','ERROR')]


def test_per_call_stream_lifecycle():asyncio.run(streaming_identity())

async def full_activity_batch(dependent=False):
    """Exercise the actual real activity loop with the existing offline harness."""
    import importlib.util
    import os
    from pathlib import Path
    import sys
    root=Path(os.environ.get('ROSE_TEST_SOURCE_ROOT', Path(__file__).resolve().parents[2]))
    path=root/'agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py'
    sys.path.insert(0,str(path.parent))
    spec=importlib.util.spec_from_file_location('r48_existing_activity_harness',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    initial=await response([native('input_text',{'index':1,'text':'Ada'},'name'),
                            native('input_text',{'index':2,'text':'Email'},'email'),
                            native('click',{'index':3},'submit')])
    if dependent:
        initial=await response([native('read_browser_state',{'observation_id':'checkout','targets':[{'key':'pay','role':'button','name':'Pay'}]},'read'),native('click',{'observation_ref':{'observation_id':'checkout','target':'pay'}},'pay')])
    completion={'action':{'action':'attempt_completion','params':{'reasoning':'done'}},'usage':{}}
    original=module._FakeDomService
    class DOM(original):
        def __init__(self,*a,**k):
            super().__init__(*a,**k)
            fixture=dom_fixture();self.selector_map=fixture.selector_map
            self.session.agent_focus_target_id='tab'
        def get_parked_page_identity(self):
            return {'target_id':self.session.agent_focus_target_id,'url':'https://example.com/login'}
        async def get_element_coordinates(self,index):
            return (10,20)
        async def get_browser_state(self,include_screenshot=False):
            return {'url':'https://example.com/login','title':'Form','dom_tree':'[1] Name [2] Email [3] Submit'}
    executed=[]
    async def execute(*args,**kwargs):
        action=args[2];executed.append((kwargs['tool_call_id_decision'],action['action'],action.get('index')))
        if action['action']=='read_browser_state':
            return {'success':True,'current_url':'https://example.com/login','formatted_state':'[1] Name [2] Email [3] Pay'}
        if dependent:
            assert action['index']==3 and action['params']=={'index':3}
        return {'success':True,'current_url':'https://example.com/login'}
    with patch.object(module,'_FakeDomService',DOM),patch('domains.spawn_browser_agent_v3.handler.execute_action',new=execute),patch('domains.spawn_browser_agent_v3.handler.JEVSession.schedule'),patch('socket.socket.connect',side_effect=AssertionError('No network in batch control')):
        actor,judge=await module._exercise_browser_resume_user_input(actor_responses_override=[initial,completion])
    assert actor.await_count==2, 'Batch inserted an extra model decision'
    assert executed==([('read','read_browser_state',None),('pay','click',3)] if dependent else [('name','input_text',1),('email','input_text',2),('submit','click',3)])
    turns=actor.captured_turns[-1]
    assert [m['tool_call_id'] for m in turns if m.get('role')=='tool']==(['read','pay'] if dependent else ['name','email','submit'])


def test_actual_activity_consumes_native_batch_without_extra_model_turn():
    asyncio.run(full_activity_batch())


def test_actual_activity_observes_then_clicks_returned_ref_without_model_turn():
    asyncio.run(full_activity_batch(dependent=True))


def test_original_pay_approval_guard_still_refuses_without_consent():
    from domains.spawn_browser_agent_v3.service_actions import _evaluate_element_text_write_lock
    result=_evaluate_element_text_write_lock(element_text='Pay now',element_text_for_question='Pay now',action_label='click',
        current_url='https://shop.test/checkout',write_lock_approvals={},system_name='Rose')
    assert result['status']=='needs_write_approval'


@pytest.mark.parametrize('change',['label','visibility','document','binding'])
def test_observation_reference_rechecks_authority(change):
    async def run():
        result=await response([native('read_browser_state',{'observation_id':'o','targets':[{'key':'pay','role':'button','name':'Pay'}]},'read'),native('click',{'observation_ref':{'observation_id':'o','target':'pay'}},'click')])
        dom=dom_fixture();messages=[];q=BrowserActionBatch(lambda a,r,i:_append_browser_turn_messages(messages,unified_action=a,result=r,tool_call_id=i));s=stream()
        state=lambda:context(dom,'https://x',messages,'binding')
        first=q.begin(result,dom,state(),s);q.started()
        r=q.bind_observation(first['action'],{'success':True,'formatted_state':'[3] Pay'},dom,state())
        await q.completed(first['action'],r)
        if change=='label':dom.selector_map[3].ax_node.name='Delete'
        if change=='visibility':dom.selector_map[3].is_visible=False
        if change=='document':dom.selector_map[3].parent_node.backend_node_id=200
        if change=='binding':dom.session=NS(agent_focus_target_id='tab')
        assert await q.next(dom,state()) is None
    asyncio.run(run())


async def actual_pay_click_guard():
    from domains.spawn_browser_agent_v3.service_actions import _execute_click
    element=dom_fixture().selector_map[3]
    element.tag_name='button';element.node_name='BUTTON';element.attributes={'type':'submit'}
    element.get_all_children_text=lambda:'Pay now';element.ax_node.name='Pay now'
    mutation=NS(dispatch=lambda _: (_ for _ in ()).throw(AssertionError('unapproved mutation')))
    result=await _execute_click(session=NS(event_bus=mutation),
        dom_service=NS(get_click_coordinates=AsyncMock(return_value=(10,20))),
        action_history=None,element=element,index=3,coords=None,thinking='',humanizer=None,
        write_lock_enabled=True,write_lock_approvals={},current_url='https://shop.test/checkout',system_name='Rose')
    assert result['status']=='needs_write_approval'


def test_actual_click_is_intercepted_before_browser_mutation():
    asyncio.run(actual_pay_click_guard())


def test_coalesced_keys_keep_all_native_result_identities():
    async def run():
        result=await response([native('press_key',{'key':'a'},'a'),native('press_key',{'key':'b'},'b')])
        assert result['action']['params']['text']=='ab'
        messages=[];q=BrowserActionBatch(lambda a,r,i:None);dom=dom_fixture()
        current=q.begin(result,dom,context(dom,'https://x',messages,'binding'),stream())
        assert q.current_ids==['a','b']
        _append_browser_turn_messages(messages,unified_action=current['action'],result={'success':True},tool_call_id='a')
        assert [m['tool_call_id'] for m in messages if m['role']=='tool']==['a','b']
        assert [json.loads(m['tool_calls'][0]['function']['arguments'])['key'] for m in messages if m['role']=='assistant']==['a','b']
    asyncio.run(run())


def test_cached_batch_does_not_reuse_first_targets_for_later_calls():
    async def run():
        result=await response([native('input_text',{'index':1,'text':'A'},'a'),native('input_text',{'index':2,'text':'B'},'b')])
        result['usage']={'from_fast_cache':True};result['_fast_cache_browser_target']={'index':1}
        messages=[];dom=dom_fixture();q=BrowserActionBatch(lambda a,r,i:_append_browser_turn_messages(messages,unified_action=a,result=r,tool_call_id=i));state=context(dom,'https://x',messages,'binding')
        first=q.begin(result,dom,state,stream());q.started();await q.completed(first['action'],{'success':True})
        assert await q.next(dom,state) is None
        assert json.loads(messages[-1]['content'])['skipped'] is True
    asyncio.run(run())


def test_pause_records_unexecuted_suffix_without_replaying_completed_calls():
    async def run():
        result=await response([native('input_text',{'index':1,'text':'A'},'a'),native('click',{'index':3},'b')])
        messages=[];dom=dom_fixture();q=BrowserActionBatch(lambda a,r,i:_append_browser_turn_messages(messages,unified_action=a,result=r,tool_call_id=i));state=context(dom,'https://x',messages,'binding')
        first=q.begin(result,dom,state,stream());q.started();await q.completed(first['action'],{'success':True})
        q.discard_pending('pause before durable resume snapshot')
        assert [m['tool_call_id'] for m in messages if m['role']=='tool']==['b']
        assert not q.pending
    asyncio.run(run())


def test_provider_dispatch_preserves_entire_native_response():
    async def run():
        result=await response([native('input_text',{'index':1,'text':'Ada'},'name'),
                               native('input_text',{'index':2,'text':'Email'},'email'),
                               native('click',{'index':3},'pay')])
        assert len(result.get('batch_actions',[]))==3, 'Actual native response lost later calls before ordinary dispatch'
        assert [item['tool_call_ids'] for item in result['batch_actions']]==[['name'],['email'],['pay']]
    asyncio.run(run())



def test_simulated_queue_discards_changed_state_and_unbound_native_targets():
    async def run():
        messages=[];q=BrowserActionBatch(lambda a,r,i:_append_browser_turn_messages(messages,unified_action=a,result=r,tool_call_id=i))
        result=await response([native('input_text',{'index':1,'text':'A'},'a'),native('click',{'index':3},'b')])
        first=q.begin(result,None,('sim','state','input'),stream());q.started();await q.completed(first['action'],{'success':True})
        assert await q.next(None,('sim','changed','input')) is None
        assert json.loads(messages[-1]['content'])['skipped'] is True
    asyncio.run(run())



def test_selected_target_is_rechecked_immediately_before_dispatch():
    async def run():
        r=await response([native('input_text',{'index':1,'text':'A'},'a'),native('click',{'index':3},'b')])
        dom=dom_fixture();messages=[];q=BrowserActionBatch(lambda *args:None);state=lambda:context(dom,'https://x',messages,'binding')
        first=q.begin(r,dom,state(),stream());q.started();await q.completed(first['action'],{'success':True})
        assert await q.next(dom,state()) is not None
        assert q.current_matches(dom,state())
        dom.selector_map[3].ax_node.name='Delete'
        assert not q.current_matches(dom,state())
    asyncio.run(run())


def test_coalesced_unstarted_batch_handoff_has_one_result_per_native_id():
    """Actual activity handoff before dispatch must not multiply coalesced IDs."""
    async def run():
        import importlib.util
        import os
        from pathlib import Path
        from domains.spawn_browser_agent_v3 import handler
        root=Path(os.environ.get('ROSE_TEST_SOURCE_ROOT',Path(__file__).resolve().parents[2]))
        path=root/'agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py'
        import sys
        sys.path.insert(0,str(path.parent))
        spec=importlib.util.spec_from_file_location('r48_handoff_harness',path)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        initial=await response([native('press_key',{'key':'a'},'a'),native('press_key',{'key':'b'},'b')])
        controls=0
        async def user_control(*args,**kwargs):
            nonlocal controls
            controls+=1
            return controls==2
        with patch.object(handler,'_wait_for_browser_user_control',user_control),patch.object(handler.JEVSession,'schedule'),patch('socket.socket.connect',side_effect=AssertionError('No network')):
            actor,_=await module._exercise_browser_resume_user_input(actor_responses_override=[initial,{'action':{'action':'attempt_completion','params':{'reasoning':'done'}},'usage':{}}])
        results=[m for m in actor.captured_turns[-1] if m.get('role')=='tool']
        assert [m['tool_call_id'] for m in results]==['a','b']
        assert all(json.loads(m['content'])['skipped'] is True for m in results)
    asyncio.run(run())
