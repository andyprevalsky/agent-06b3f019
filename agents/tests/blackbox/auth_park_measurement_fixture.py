import asyncio, importlib.util, json, sys, socket
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
B=Path(__file__).parent; A=B.parents[1]
sys.path[:0]=[str(A/'tests/blackbox'),str(A)]
import _test_utils
spec=importlib.util.spec_from_file_location('owning_browser_tests', A/'tests/blackbox/spawn_browser_agent_v3.blackbox.py');tests=importlib.util.module_from_spec(spec);spec.loader.exec_module(tests)
async def _pipeline(native, origin, *, unknown=False, workflow_root_mode=None):
 from helpers.handle_tool_event import handle_tool_event
 async def serialized_event(event):
  calls=[]
  async def execute(_function,**kwargs):calls.append(kwargs['args'])
  await handle_tool_event(event,'agent-1','tool-1','spawn_browser_agent',execute,user_id='user-1')
  args=calls[-1]
  return {'role':args[2],'metadata':args[3],'timestamp':'2026-10-17T05:00:00.000001+00:00'}
 from domains.spawn_browser_agent_v3.handler import SpawnBrowserAgentManagerV3
 from benchmarks import run_benchmark as rb, auth_test_site
 from temporalio.testing import ActivityEnvironment
 from domains.spawn_browser_agent_v3.handler import disconnect_browser_after_passkey_capture
 from browser_tools.dom_service import DOMService
 original_init=tests._FakeDomService.__init__
 def native_init(self,*args,**kwargs):
  original_init(self,*args,**kwargs)
  self.register_secret_refs({'fixture-query-secret':'private-query-token','fixture-key-collision':'origin'})
  self._session.agent_focus_target_id=native['targetId']
  self._session.session_manager=SimpleNamespace(get_target=lambda tid: SimpleNamespace(target_id=native['targetId'],target_type='page',url=native['url']))
 if hasattr(DOMService,"get_parked_page_identity"):
  tests._FakeDomService.get_parked_page_identity=DOMService.get_parked_page_identity
 private_snapshot=AsyncMock(return_value={})
 review={'persist_resume':private_snapshot,'disconnect':disconnect_browser_after_passkey_capture,'inventory':{'realm':'shop.example'},'actions':[{'action':'request_user_assistance_for_authentication','thinking':'Fixture exhausted','params':{}}]}
 with patch.object(tests._FakeDomService,'__init__',native_init),patch('domains.spawn_browser_agent_v3.service.list_session_files',AsyncMock(return_value=[])),patch('domains.spawn_browser_agent_v3.repo.list_session_files',AsyncMock(return_value=[])):
  await ActivityEnvironment().run(tests.test_auth_handoff_consumes_otp_received_during_decision,case='empty',auth_review=review)
 actual=review['result']
 class Handle:
  def done(self):return True
  def cancel(self):raise AssertionError('completed activity cancelled')
  def __await__(self):
   async def finished():return actual
   return finished().__await__()
 wf=SimpleNamespace(user_id='user-1',agent_id='agent-1',is_paused=False,write_lock_enabled=True,system_name='Rose',_signal_responses={},_response_schema_feedback=[],_update_tree_state=AsyncMock())
 api_row={'status':'ACTIVE'};park_status={}
 if workflow_root_mode is not None:
  from workflows.agent_workflow import AgentWorkflow
  from types import MethodType
  wf.bus_id='test-owned-bus' if workflow_root_mode=='bus' else None
  wf._cost_limit_reached=False;wf._has_credits=True;wf.tools_in_use=[];wf.subtree_cost_cents=0;wf.output_schema=None;wf.parent_agent_id=None;wf.depth=0;wf.goal='Read my member number';wf.message_count=1
  wf._update_tree_state=MethodType(AgentWorkflow._update_tree_state,wf)
  # _update_tree_state's own real helpers (background-task snapshot + send).
  wf._background_tree_snapshot=MethodType(AgentWorkflow._background_tree_snapshot,wf)
  wf._send_tree_state=MethodType(AgentWorkflow._send_tree_state,wf)
  async def persist_tree(_fn,**kwargs):
   assert wf.bus_id=='test-owned-bus'
   api_row['status']=kwargs['args'][3]['status']
  actual_tree_activity=AsyncMock(side_effect=persist_tree)
 else:actual_tree_activity=AsyncMock()
 park_ready=asyncio.Event();release_wait=asyncio.Event()
 async def owned_wait(*args,**kwargs):
  if args and args[0]():return
  park_status.update(api_row);park_ready.set();await release_wait.wait()
 events=[]
 with patch('workflows.agent_workflow.workflow.execute_activity',actual_tree_activity), patch('domains.spawn_browser_agent_v3.handler.workflow.start_activity',return_value=Handle()), patch('domains.spawn_browser_agent_v3.handler.workflow.wait_condition',AsyncMock(side_effect=owned_wait) if workflow_root_mode is not None else AsyncMock()):
  gen=SpawnBrowserAgentManagerV3().execute_tool(wf,{'goal':'Read my member number'},'tool-1')
  try:
   async for event in gen:
    events.append(event)
    if (event.metadata or {}).get('requestUserAuthentication'):break
   if workflow_root_mode is not None:
    pending=asyncio.create_task(gen.__anext__());await asyncio.wait_for(park_ready.wait(),5)
    assert wf.is_paused is True
    assert park_status['status']==('PAUSED' if workflow_root_mode=='bus' else 'ACTIVE')
    assert actual_tree_activity.await_count==(1 if workflow_root_mode=='bus' else 0)
    wf._signal_responses['request-1']='The user signed in';release_wait.set();resume_event=await pending
   else:
    wf._signal_responses['request-1']='The user signed in'
    resume_event=await gen.__anext__()
  finally:await gen.aclose()
 parked=next(e for e in events if (e.metadata or {}).get('requestUserAuthentication'))
 import httpx
 original_client=httpx.AsyncClient
 wire=json.loads((B/'fixtures/agent_park_wire.json').read_text())
 if workflow_root_mode is not None:wire['agent']['status']=park_status['status']
 def transport(request):
  assert request.url.path=='/api/agents/agent-1'
  return httpx.Response(200,json=wire)
 with patch.dict('os.environ',{'BLACKBOX_TEST_CAPTURE_OUTBOUND':'0'}),patch.object(rb,'_api_headers',AsyncMock(return_value={})),patch.object(httpx,'AsyncClient',lambda *a,**k:original_client(*a,**k,transport=httpx.MockTransport(transport))):
  source_shaped=await rb.get_agent('http://127.0.0.1:1','agent-1')
 assert source_shaped['agent']['agent_id']=='agent-1' and 'id' not in source_shaped['agent']
 data={'agent':source_shaped['agent'],'messages':[await serialized_event(parked)], '_benchmark':{'pending_attention_requests':[{'id':'request-1','agent_id':'agent-1','kind':'auth_assistance'}],'attention_request_id':'request-1','attention_requests_seen':[{'id':'request-1','metadata':{'requestUserAuthentication':{'requestId':'request-1','taskId':'task-1','steelSessionId':'session-1'}}}]}}
 auth_test_site.set_active_manifest({'siteId':'local-owned','entryUrl':origin+'/site/local-owned/','realm':'shop.example'})
 try:
  with patch.object(auth_test_site,'fetch_report',AsyncMock(return_value={'lastPagePath':'/','attempts':[],'sessions':[]})),patch.object(rb,'_api_headers',AsyncMock(return_value={})),patch.object(rb,'_current_benchmark_user_id',return_value='user-1'):
   from benchmarks.benchmark_tasks import get_task_by_name
   await rb._hydrate_auth_test_site_evidence(data,'http://127.0.0.1:1',task=get_task_by_name('browser-auth-all-options-fail-assistance'))
 finally:auth_test_site.set_active_manifest(None)
 if workflow_root_mode is not None and not unknown:
  req={'id':'request-1','agentId':'agent-1','metadata':{'attentionKind':'auth_assistance'}}
  stats={'total_messages':0,'agent_count':1,'total_cost_cents':0,'all_agents':[],'failed_count':0,'active_count':1}
  snapshots=AsyncMock(side_effect=[data,asyncio.CancelledError()]);auth_test_site.set_active_manifest({'siteId':'local-owned','entryUrl':origin+'/site/local-owned/','realm':'shop.example'})
  try:
   with patch.object(rb,'get_agent',snapshots),patch.object(rb,'get_attention_requests',AsyncMock(return_value=[req])),patch.object(rb,'_fetch_tree_stats',AsyncMock(return_value=stats)),patch.object(rb,'_current_benchmark_user_id',return_value='user-1'),patch.object(rb.asyncio,'sleep',AsyncMock()):
    try:waited,observed,resolved,poll_error=await rb._poll_agent('http://127.0.0.1:1','agent-1',get_task_by_name('browser-auth-all-options-fail-assistance'))
    except asyncio.CancelledError:raise AssertionError('OWNING RED: valid task-owned park rejected by normal poll with global '+park_status['status']) from None
   assert snapshots.await_count==1 and observed==1 and resolved==0 and poll_error is None
   assert auth_test_site.evaluate_outcome({'expect':'no_session','left_on_sign_in_form':True},waited['_benchmark']['auth_test_site'] if 'auth_test_site' in waited['_benchmark'] else data['_benchmark']['auth_test_site'],'')[0]
  finally:auth_test_site.set_active_manifest(None)
 out={'activity_status':actual['status'],'activity_has_native_park_observation':'browser_page_observation' in actual,'manager_has_native_park_observation':'browser_page_observation' in parked.metadata,'raw_hosted_report':data['_benchmark']['auth_test_site']['report'],'measurement':data['_benchmark']['auth_test_site'].get('browser_page_observation'),'scope':'Actual activity/detach helper and manager/hydration with fake external edges; actual DOM native target-cache reader populated from real owned Chromium CDP selected target; no real provider'}
 print(json.dumps(out))
 assert out['activity_has_native_park_observation'],'OWNING RED: actual parked activity result loses native focused-page observation before manager/hydration'
 assert 'private-query-token' not in json.dumps(actual),'Raw native URL leaked through public activity result'
 assert 'private-query-token' not in json.dumps(parked.metadata),'Raw native URL leaked through public manager event'
 if unknown:
  assert out['measurement'] is None
  assert 'private-query-token' not in json.dumps(actual)
  assert 'private-query-token' not in json.dumps(parked.metadata)
  return
 assert out['measurement']['target_id']==native['targetId']
 assert 'url' not in out['measurement']
 assert 'private-query-token' not in json.dumps(actual)
 assert 'private-query-token' not in json.dumps(parked.metadata)
 assert tests._FakeDomService.last_instance.get_parked_page_identity()['url']==native['url']
 assert out['measurement']['path']=='/login/code/verify'
 assert out['raw_hosted_report']['lastPagePath']=='/'
 ok,reason=auth_test_site.evaluate_outcome({'expect':'no_session','left_on_sign_in_form':True},data['_benchmark']['auth_test_site'],'')
 assert ok,reason
 from benchmarks.parked_browser_page import parked_page_observation
 import copy
 manifest={'siteId':'local-owned','entryUrl':origin+'/site/local-owned/'}
 for status in ['COMPLETED','FAILED','ERROR','CANCELLED','ABORTED','UNKNOWN',None,'',True,[],{}]:
  terminal=copy.deepcopy(data);terminal['agent']['status']=status
  assert parked_page_observation(terminal,manifest,'user-1') is None,status
 missing_status=copy.deepcopy(data);missing_status['agent'].pop('status')
 assert parked_page_observation(missing_status,manifest,'user-1') is None
 active_without_park=copy.deepcopy(data);active_without_park['agent']['status']='ACTIVE';active_without_park['messages'][0]['metadata'].pop('browser_page_observation')
 assert parked_page_observation(active_without_park,manifest,'user-1') is None
 for key,value in [('agent_id','foreign'),('user_id','foreign'),('task_id','foreign'),('session_id','foreign'),('request_id','foreign'),('phase','report_time'),('path','/foreign/login'),('path','{{secret:old-url}}'),('origin','http://foreign.invalid'),('target_id','')]:
  bad=copy.deepcopy(data);bad['messages'][0]['metadata']['browser_page_observation'][key]=value
  assert parked_page_observation(bad,manifest,'user-1') is None,key
 resumed=copy.deepcopy(data);resume_row=await serialized_event(resume_event);resume_row['timestamp']='2026-10-17T05:00:01+00:00';resumed['messages'].append(resume_row)
 assert parked_page_observation(resumed,manifest,'user-1') is None
 home=copy.deepcopy(data);home['messages'][0]['metadata']['browser_page_observation']['path']='/site/local-owned/'
 home_obs=parked_page_observation(home,manifest,'user-1');assert home_obs['path']=='/'
 bad_evidence={**data['_benchmark']['auth_test_site'],'browser_page_observation':home_obs}
 assert auth_test_site.evaluate_outcome({'expect':'no_session','left_on_sign_in_form':True},bad_evidence,'')[0] is False
 # Readiness uses the normal poll owner, its original task and deadline.
 from benchmarks.benchmark_tasks import get_task_by_name
 first={'agent':{'agent_id':'agent-1','status':'ACTIVE'},'messages':[]}
 snapshots=AsyncMock(side_effect=[first,data,asyncio.CancelledError()])
 req={'id':'request-1','agentId':'agent-1','metadata':{'attentionKind':'auth_assistance'}}
 task=get_task_by_name('browser-auth-all-options-fail-assistance')
 stats={'total_messages':0,'agent_count':1,'total_cost_cents':0,'all_agents':[],'failed_count':0,'active_count':1}
 auth_test_site.set_active_manifest(manifest)
 try:
  with patch.object(rb,'get_agent',snapshots),patch.object(rb,'get_attention_requests',AsyncMock(return_value=[req])),patch.object(rb,'_fetch_tree_stats',AsyncMock(return_value=stats)),patch.object(rb,'_current_benchmark_user_id',return_value='user-1'),patch.object(rb.asyncio,'sleep',AsyncMock()):
   waited,count,resolved,error=await rb._poll_agent('http://127.0.0.1:1','agent-1',task)
  assert snapshots.await_count==2 and count==1 and resolved==0 and error is None
  assert waited['messages']==data['messages']
  assert task.timeout_seconds==1200
  # Historical seen requests must not certify a now answered/absent handoff.
  for later_requests in [[{**req, 'response':'answered'}], []]:
   changed=AsyncMock(side_effect=[copy.deepcopy(first),copy.deepcopy(data),asyncio.CancelledError()])
   attention=AsyncMock(side_effect=[[req],later_requests,[]])
   with patch.object(rb,'get_agent',changed),patch.object(rb,'get_attention_requests',attention),patch.object(rb,'_fetch_tree_stats',AsyncMock(return_value=stats)),patch.object(rb,'_current_benchmark_user_id',return_value='user-1'),patch.object(rb.asyncio,'sleep',AsyncMock()):
    try:await rb._poll_agent('http://127.0.0.1:1','agent-1',task)
    except asyncio.CancelledError:assert changed.await_count==3
    else:raise AssertionError('Historical attention cache returned a closed/absent park')
 finally:auth_test_site.set_active_manifest(None)
 # Closure/read failure and target mismatch are not observations.
 from domains.spawn_browser_agent_v3.handler import disconnect_browser_after_passkey_capture
 from browser_tools.dom_service import DOMService
 order=[]
 async def passkeys():order.append('passkeys')
 async def detach():order.append('detach')
 dom=SimpleNamespace(disconnect=detach)
 def observe():order.append('snapshot');return {'owned':True}
 assert await disconnect_browser_after_passkey_capture(dom,passkeys,observe_parked_page=observe)=={'owned':True}
 assert order==['passkeys','snapshot','detach']
 async def failed_detach():raise RuntimeError('owned disconnect failed')
 dom.disconnect=failed_detach
 assert await disconnect_browser_after_passkey_capture(dom,passkeys,observe_parked_page=observe) is None
 def failed_read():raise RuntimeError('target gone')
 dom.disconnect=detach
 assert await disconnect_browser_after_passkey_capture(dom,passkeys,observe_parked_page=failed_read) is None
 reader=object.__new__(DOMService)
 for target in [None,SimpleNamespace(target_id='foreign',target_type='page',url=native['url']),SimpleNamespace(target_id=native['targetId'],target_type='worker',url=native['url'])]:
  reader._session=SimpleNamespace(agent_focus_target_id=native['targetId'],session_manager=SimpleNamespace(get_target=lambda tid,t=target:t))
  try:reader.get_parked_page_identity()
  except RuntimeError:pass
  else:raise AssertionError('closed/foreign/non-page target became native proof')
 later_input=copy.deepcopy(data);later_input['messages'].append({'role':'USER','text':'New task instruction','timestamp':'2026-10-17T05:00:02+00:00'})
 assert parked_page_observation(later_input,manifest,'user-1') is None
 closed=copy.deepcopy(data);closed['_benchmark']['pending_attention_requests']=[]
 assert parked_page_observation(closed,manifest,'user-1') is None
 fenced=copy.deepcopy(data);fenced['messages'].append({'role':'TOOL','timestamp':'2026-10-17T05:00:03+00:00','metadata':{**fenced['messages'][0]['metadata'],'task_id':None,'toolStatus':'FINISHED','deploymentFenced':True}})
 assert parked_page_observation(fenced,manifest,'user-1') is None
 for key in ['toolStatus','action_type']:
  wrong=copy.deepcopy(data);wrong['messages'][0]['metadata'][key]='foreign'
  assert parked_page_observation(wrong,manifest,'user-1') is None
 tied=copy.deepcopy(data);tied['messages'].append(copy.deepcopy(tied['messages'][0]))
 assert parked_page_observation(tied,manifest,'user-1') is None
 wrong_id=copy.deepcopy(data);wrong_id['agent']['agent_id']='foreign'
 assert parked_page_observation(wrong_id,manifest,'user-1') is None
 missing_id=copy.deepcopy(data);missing_id['agent'].pop('agent_id')
 assert parked_page_observation(missing_id,manifest,'user-1') is None
 print('PIPELINE_AND_BINDING_AND_READINESS_AND_PRIVACY_CONTROLS_PASS')

async def run_pipeline(*, workflow_root_mode=None):
 from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
 import threading
 from playwright.async_api import async_playwright
 class Page(BaseHTTPRequestHandler):
  def do_GET(self):
   body=b'<title>Owned fixture</title><input name="code">';self.send_response(200);self.end_headers();self.wfile.write(body)
  def log_message(self,*args):pass
 server=ThreadingHTTPServer(('127.0.0.1',0),Page);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 origin='http://127.0.0.1:'+str(server.server_port)
 try:
  async with async_playwright() as pw:
   browser=await pw.chromium.launch(headless=True,args=['--disable-background-networking','--disable-component-update','--no-proxy-server'])
   try:
    context=await browser.new_context(service_workers='block')
    async def guard(route):
     if route.request.url.startswith(origin+'/'):await route.continue_()
     else:raise AssertionError('foreign browser request')
    await context.route('**/*',guard)
    login=await context.new_page();await login.goto(origin+'/site/local-owned/login/code/verify?token=private-query-token#private-query-token')
    home=await context.new_page();await home.goto(origin+'/site/local-owned/');await login.bring_to_front()
    cdp=await context.new_cdp_session(login);native=(await cdp.send('Target.getTargetInfo'))['targetInfo'];await cdp.detach()
    assert native['url']==login.url
    await _pipeline(native,origin,workflow_root_mode=workflow_root_mode)
    await login.goto(origin+'/site/local-owned/login/private-query-token')
    cdp=await context.new_cdp_session(login);path_secret=(await cdp.send('Target.getTargetInfo'))['targetInfo'];await cdp.detach()
    await _pipeline(path_secret,origin,unknown=True,workflow_root_mode=workflow_root_mode)
   finally:await browser.close()
 finally:server.shutdown();server.server_close();thread.join(timeout=5);assert not thread.is_alive()


async def check_unrelated_task_measurement_input_absence():
 import copy
 from benchmarks import run_benchmark as rb, auth_test_site
 from benchmarks.benchmark_tasks import get_task_by_name
 task=get_task_by_name('browser-auth-existing-browser-session')
 data={'agent':{'agent_id':'agent-1','status':'COMPLETED'},'messages':[]}
 req={'id':'unrelated-request','agentId':'agent-1','metadata':{'attentionKind':'auth_assistance'}}
 stats={'total_messages':0,'agent_count':1,'total_cost_cents':0,'all_agents':[],'failed_count':0,'active_count':0}
 with patch.object(rb,'get_agent',AsyncMock(return_value=copy.deepcopy(data))),patch.object(rb,'get_attention_requests',AsyncMock(return_value=[req])),patch.object(rb,'_fetch_tree_stats',AsyncMock(return_value=stats)):
  polled,_,_,error=await rb._poll_agent('http://127.0.0.1:1','agent-1',task)
 assert error is None
 compact=rb._compact_benchmark_state_for_judge(polled)
 assert 'pending_attention_requests' not in polled['_benchmark'],'Unrelated task acquired measurement-only pending rows'
 assert 'pending_attention_requests' not in compact,'Measurement-only rows entered unrelated semantic judge input'
 manifest={'siteId':'local-owned','entryUrl':'https://shop.example/site/local-owned/'}
 auth_test_site.set_active_manifest(manifest)
 try:
  with patch.object(auth_test_site,'fetch_report',AsyncMock(return_value={'lastPagePath':'/'})),patch.object(rb,'_api_headers',AsyncMock(return_value={})):
   await rb._hydrate_auth_test_site_evidence(polled,'http://127.0.0.1:1')
   assert 'browser_page_observation' not in polled['_benchmark']['auth_test_site']
   await rb._hydrate_auth_test_site_evidence(polled,'http://127.0.0.1:1',task=task)
  assert 'browser_page_observation' not in polled['_benchmark']['auth_test_site'],'Unrelated auth hydration acquired null measurement field'
  assert 'browser_page_observation' not in rb._compact_benchmark_state_for_judge(polled)['auth_test_site']
 finally:auth_test_site.set_active_manifest(None)
 print('UNRELATED_TASK_NORMAL_POLL_COMPACT_HYDRATION_ABSENCE_PASS')
