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


# --- Phone continuations: one model turn, ordinary per-call execution ---

PHONE_ACTIONS=['phone','read_browser_state','input_text','click','attempt_completion']


async def phone_response(calls):
    c=RoseClient(openrouter_key='offline-unused')
    c.collect=AsyncMock(return_value=RoseResponse(tool_calls=calls,usage={'prompt_tokens':10},request_id='req'))
    with patch('helpers.observability.dump_llm_context'):
        result=await c.complete_browser_use(task='Set up the phone',browser_state={},action_history=[],available_actions=PHONE_ACTIONS)
    assert c.collect.await_count==1
    return result


def op(name,args,id):
    return native('phone',{'mode':'operation','operation':name,'args':args},id)


def phone_view(cursor,lease='lease-1',**extra):
    return {'enabled':True,'interaction':{'cursor':cursor,'lease':{'id':lease,'status':'ACTIVE','browserTaskId':'task',**extra.pop('lease_extra',{})},**extra}}


class FakePhone:
    """Server-shaped lease journal: mutations advance the cursor, reads do not, CAS on expectedCursor."""
    READS={'screen.text','screen.bounds','apps.list'}
    def __init__(self,fail=()):
        self.cursor=4;self.journal=[];self.fail=set(fail)
    def observe(self):
        return phone_view(self.cursor)
    def run(self,operation,expected,operation_id):
        if expected!=self.cursor:
            return {'success':False,'_httpStatus':409}
        status='FAILED' if operation in self.fail else 'SUCCEEDED'
        if status=='SUCCEEDED' and operation not in self.READS:
            self.cursor+=1
        self.journal.append((operation,expected,self.cursor,operation_id,status))
        return {'success':status=='SUCCEEDED','operation':{'id':operation_id,'cursor':self.cursor,'operation':operation,'status':status}}


async def run_phone_batch(calls,phone=None,between=None):
    """Drive the queue exactly as the activity loop does: fresh observe before every dispatch."""
    phone=phone or FakePhone()
    result={**await phone_response(calls),'_phone_snapshot':phone.observe()}
    dom=dom_fixture();messages=[];seen=[]
    q=BrowserActionBatch(lambda a,r,i:_append_browser_turn_messages(messages,unified_action=a,result=r,tool_call_id=i))
    state=lambda:context(dom,'https://shop.test',messages,('account','realm'))
    current=q.begin(result,dom,state(),stream())
    while current is not None:
        a=current['action'];q.started()
        snapshot=current['_phone_snapshot']['interaction']
        seen.append((current['tool_call_id'],(a['params'] or {}).get('operation'),snapshot['cursor']))
        r=phone.run(a['params']['operation'],snapshot['cursor'],current['tool_call_id'])
        _append_browser_turn_messages(messages,unified_action=a,result=r,tool_call_id=current['tool_call_id'])
        await q.completed(a,r)
        if between:between(phone)
        current=await q.next(dom,state(),phone.observe())
    tools=[(m['tool_call_id'],'skipped' in str(m.get('content'))) for m in messages if m['role']=='tool']
    return seen,tools,phone


def test_phone_tap_then_screen_text_runs_in_order_on_fresh_cursors():
    seen,tools,phone=asyncio.run(run_phone_batch([op('input.tap',{'x':74,'y':85},'tap'),op('screen.text',{'min_confidence':0.3},'read')]))
    # The read is dispatched against the cursor the tap left behind, not the planning cursor.
    assert seen==[('tap','input.tap',4),('read','screen.text',5)]
    assert [(j[0],j[1],j[3],j[4]) for j in phone.journal]==[('input.tap',4,'tap','SUCCEEDED'),('screen.text',5,'read','SUCCEEDED')]
    assert tools==[('tap',False),('read',False)]


def test_phone_batch_stops_at_first_failure():
    seen,tools,phone=asyncio.run(run_phone_batch([op('apps.launch',{'name':'Settings','fresh':False},'launch'),op('screen.text',{},'read')],FakePhone(fail={'apps.launch'})))
    assert [s[0] for s in seen]==['launch'] and len(phone.journal)==1
    assert tools==[('launch',False),('read',True)]


def test_phone_navigation_allows_only_reads_until_next_model_turn():
    seen,tools,_=asyncio.run(run_phone_batch([op('input.tap',{'x':1,'y':2},'t1'),op('screen.text',{},'r1'),op('input.tap',{'x':3,'y':4},'t2'),op('screen.text',{},'r2')]))
    assert [s[0] for s in seen]==['t1','r1']
    assert tools==[('t1',False),('r1',False),('t2',True),('r2',True)]
    # Typing does not navigate, so a following read or typing step may continue.
    seen,_,_=asyncio.run(run_phone_batch([op('screen.text',{},'r0'),op('input.text',{'s':'ada@example.test'},'type'),op('screen.text',{},'r1')]))
    assert [s[0] for s in seen]==['r0','type','r1']


@pytest.mark.parametrize('change',['other_actor','lease','attention','pending'])
def test_phone_continuation_refuses_changed_lease_cursor_or_attention(change):
    def between(phone):
        if change=='other_actor':phone.cursor+=1
    phone=FakePhone();observe=phone.observe
    views={'lease':lambda:phone_view(phone.cursor,lease='lease-2'),
           'attention':lambda:phone_view(phone.cursor,lease_extra={'attentionRequestId':'att-1'}),
           'pending':lambda:phone_view(phone.cursor,pendingOperation={'status':'RUNNING'})}
    def swap(p):
        between(p)
        if change in views:p.observe=views[change]
    seen,tools,_=asyncio.run(run_phone_batch([op('input.tap',{'x':1,'y':2},'tap'),op('screen.text',{},'read')],phone,swap))
    assert [s[0] for s in seen]==['tap'] and tools==[('tap',False),('read',True)]
    del observe


@pytest.mark.parametrize('first',[op('credentials.fill_saved',{},'fill'),op('messages.send_approved',{'queueId':'q'},'fill'),
                                  native('phone',{'mode':'release'},'fill'),
                                  native('phone',{'mode':'setup','action':'verify','evidenceOperationIds':['op-1'],'verificationTarget':'portrait_lock'},'fill')])
def test_phone_setup_credential_and_message_calls_still_require_their_own_turn(first):
    from providers.rose.errors import BrowserModelOutputValidationError
    with pytest.raises(BrowserModelOutputValidationError):
        asyncio.run(phone_response([first,op('screen.text',{},'read')]))
    with pytest.raises(BrowserModelOutputValidationError):
        asyncio.run(phone_response([op('screen.text',{},'read'),first]))


def test_queue_never_continues_after_a_non_batchable_phone_receipt():
    async def run():
        fill={'action':'phone','params':{'mode':'operation','operation':'credentials.fill_saved','args':{}}}
        read={'action':'phone','params':{'mode':'operation','operation':'screen.text','args':{}}}
        result={'action':fill,'batch_actions':[{'action':fill,'tool_call_ids':['fill']},{'action':read,'tool_call_ids':['read']}],
                '_phone_snapshot':phone_view(4),'usage':{}}
        dom=dom_fixture();messages=[]
        q=BrowserActionBatch(lambda a,r,i:_append_browser_turn_messages(messages,unified_action=a,result=r,tool_call_id=i))
        state=lambda:context(dom,'https://shop.test',messages,('account','realm'))
        current=q.begin(result,dom,state(),stream());q.started()
        receipt={'success':True,'operation':{'id':'fill','cursor':5,'status':'SUCCEEDED'}}
        _append_browser_turn_messages(messages,unified_action=current['action'],result=receipt,tool_call_id='fill')
        await q.completed(current['action'],receipt)
        assert await q.next(dom,state(),phone_view(5)) is None
        assert [m['tool_call_id'] for m in messages if m['role']=='tool']==['fill','read']
    asyncio.run(run())


class JournalClient:
    """httpx-shaped fake of the iPhone routes behind the real execute_phone (CAS + ordered journal)."""
    def __init__(self,phone):self.phone=phone
    async def request(self,method,url,headers=None,json=None,timeout=None):
        path=url.split('/api/iphone/',1)[1]
        if path.startswith('availability/'):body={'enabled':True,'source':'ready'}
        elif path.endswith('/operations'):
            body=self.phone.run(json['operation'],json['expectedCursor'],json['operationId'])
            body.pop('success',None)
            if body.get('_httpStatus'):return NS(is_success=False,status_code=409,content=b'{}',json=lambda:{})
        elif path.startswith('interactions/') and method=='POST':body={'lease':{'id':'lease-1','status':'ACTIVE'}}
        else:body={}
        return NS(is_success=True,status_code=200,content=b'{}',json=lambda:body)


async def portrait_route_journal(batched):
    """Same portrait-lock route, batched vs one call per model turn, through the real execute_phone."""
    from domains.spawn_browser_agent_v3.phone import execute_phone
    route=[('apps.launch',{'name':'Settings','fresh':False}),('screen.text',{'min_confidence':0.3}),
           ('input.tap',{'x':74,'y':85}),('screen.text',{'min_confidence':0.3})]
    phone=FakePhone();client=JournalClient(phone)
    config=NS(backend=NS(api_url='https://api.test',api_key='k'))
    async def dispatch(name,args,decision,snapshot):
        return await execute_phone({'mode':'operation','operation':name,'args':args},config=config,user_id='user',
                                   agent_id='agent',task_id='task',decision_id=decision,snapshot=snapshot,client=client)
    turns=[route[0:2],route[2:4]] if batched else [[step] for step in route]
    model_turns=0;n=0
    for turn in turns:
        model_turns+=1
        calls=[op(name,args,f'call-{n+i}') for i,(name,args) in enumerate(turn)];n+=len(turn)
        result={**await phone_response(calls),'_phone_snapshot':phone.observe()}
        dom=dom_fixture();messages=[]
        q=BrowserActionBatch(lambda a,r,i:_append_browser_turn_messages(messages,unified_action=a,result=r,tool_call_id=i))
        state=lambda:context(dom,'https://shop.test',messages,('account','realm'))
        current=q.begin(result,dom,state(),stream())
        while current is not None:
            a=current['action'];q.started()
            r=await dispatch(a['params']['operation'],a['params']['args'],current['tool_call_id'],current['_phone_snapshot'])
            assert r['success'] is True
            _append_browser_turn_messages(messages,unified_action=a,result=r,tool_call_id=current['tool_call_id'])
            await q.completed(a,r)
            current=await q.next(dom,state(),phone.observe())
    return model_turns,[(j[0],j[1],j[2],j[4]) for j in phone.journal],[j[3] for j in phone.journal]


def test_portrait_route_journal_is_identical_when_batched():
    single_turns,single,single_ids=asyncio.run(portrait_route_journal(False))
    batch_turns,batched,batch_ids=asyncio.run(portrait_route_journal(True))
    assert (single_turns,batch_turns)==(4,2)
    # Same operations, same expected/resulting cursors, same order; one receipt per native call.
    assert batched==single==[('apps.launch',4,5,'SUCCEEDED'),('screen.text',5,5,'SUCCEEDED'),
                             ('input.tap',5,6,'SUCCEEDED'),('screen.text',6,6,'SUCCEEDED')]
    assert len(set(batch_ids))==4 and len(set(single_ids))==4


def test_phone_prompt_permits_same_response_verification():
    from domains.spawn_browser_agent_v3.phone import PHONE_GUIDANCE
    from providers.rose.browser_use import BROWSER_USE_TOOLS
    assert 'act once' not in PHONE_GUIDANCE and 'put screen.text as the next call in the' in PHONE_GUIDANCE
    assert 'put screen.text after an action in the same response' in BROWSER_USE_TOOLS['phone']['description']


async def full_activity_phone_batch():
    """Actual activity loop: one model turn runs tap then screen.text, each with the loop's fresh observation."""
    import importlib.util
    import os
    from pathlib import Path
    import sys
    root=Path(os.environ.get('ROSE_TEST_SOURCE_ROOT', Path(__file__).resolve().parents[2]))
    path=root/'agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py'
    sys.path.insert(0,str(path.parent))
    spec=importlib.util.spec_from_file_location('phone_batch_activity_harness',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    phone=FakePhone()
    initial={**await phone_response([op('input.tap',{'x':74,'y':85},'tap'),op('screen.text',{'min_confidence':0.3},'read')]),
             '_phone_snapshot':phone.observe()}
    completion={'action':{'action':'attempt_completion','params':{'reasoning':'done'}},'usage':{}}
    executed=[]
    async def execute(*args,**kwargs):
        action=args[2]
        if action['action']!='phone':
            return {'success':True}
        cursor=kwargs['phone_snapshot']['interaction']['cursor']
        executed.append((kwargs['tool_call_id_decision'],action['params']['operation'],cursor))
        return phone.run(action['params']['operation'],cursor,kwargs['tool_call_id_decision'])
    async def observe(*a,**k):
        return phone.observe()
    with patch('domains.spawn_browser_agent_v3.handler.execute_action',new=execute),\
         patch('domains.spawn_browser_agent_v3.phone.observe_phone',new=observe),\
         patch('domains.spawn_browser_agent_v3.phone.phone_profile_enabled',return_value=True),\
         patch('domains.spawn_browser_agent_v3.handler.JEVSession.schedule'),\
         patch('socket.socket.connect',side_effect=AssertionError('No network in phone batch control')):
        actor,judge=await module._exercise_browser_resume_user_input(actor_responses_override=[initial,completion])
    assert actor.await_count==2, 'Phone batch inserted an extra model decision'
    assert executed==[('tap','input.tap',4),('read','screen.text',5)]
    assert [(j[0],j[1],j[4]) for j in phone.journal]==[('input.tap',4,'SUCCEEDED'),('screen.text',5,'SUCCEEDED')]
    turns=actor.captured_turns[-1]
    assert [m['tool_call_id'] for m in turns if m.get('role')=='tool']==['tap','read']


def test_actual_activity_runs_phone_batch_without_extra_model_turn():
    asyncio.run(full_activity_phone_batch())


async def phone_batch_contract():
    """Deploy-path aggregate of the phone batch regressions (blackbox runner is already in a loop)."""
    from providers.rose.errors import BrowserModelOutputValidationError
    seen,tools,_=await run_phone_batch([op('input.tap',{'x':74,'y':85},'tap'),op('screen.text',{},'read')])
    assert seen==[('tap','input.tap',4),('read','screen.text',5)] and tools==[('tap',False),('read',False)]
    seen,tools,_=await run_phone_batch([op('apps.launch',{'name':'Settings'},'launch'),op('screen.text',{},'read')],FakePhone(fail={'apps.launch'}))
    assert tools==[('launch',False),('read',True)]
    seen,tools,_=await run_phone_batch([op('input.tap',{'x':1,'y':2},'t1'),op('input.tap',{'x':3,'y':4},'t2')])
    assert tools==[('t1',False),('t2',True)]
    def interleave(phone):phone.cursor+=1
    seen,tools,_=await run_phone_batch([op('input.tap',{'x':1,'y':2},'tap'),op('screen.text',{},'read')],between=interleave)
    assert tools==[('tap',False),('read',True)]
    try:
        await phone_response([op('credentials.fill_saved',{},'fill'),op('screen.text',{},'read')])
        raise AssertionError('credential fill shared a model turn')
    except BrowserModelOutputValidationError:
        pass
    single=await portrait_route_journal(False);batched=await portrait_route_journal(True)
    assert (single[0],batched[0])==(4,2) and single[1]==batched[1]
    await full_activity_phone_batch()
