"""Exact finalizer identity and deadline controls."""
import copy
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch
import pytest
from helpers import browser_budget_stop as b
NOW=datetime.now(timezone.utc)
INFO=SimpleNamespace(workflow_id='wf',run_id='run',first_execution_run_id='first')
@pytest.mark.parametrize('fault', ['none','task','activity','attempt','nonce','generation','steps','bool','deadline','too-late','revision','paused','kill','orphan'])
def test_ticket_ack_exact(fault):
 o=SimpleNamespace(agent_id='root',is_paused=False,_browser_execution_task_id='tool',_background_tasks={'tool':{}},_response_schema_revision=1)
 with patch.object(b.workflow,'info',return_value=INFO),patch.object(b.workflow,'now',return_value=NOW),patch.object(b.workflow,'uuid4',return_value='nonce'):
  t=b.register_finalizer(o,task_id='task',tool_id='tool',activity_id='activity',limit=100,timeout_seconds=3000)
  payload={'ticket':copy.deepcopy(t),'steps':100,'deadline':NOW.timestamp()+180}
  if fault in ('task','activity','nonce'):payload['ticket'][{'task':'task_id','activity':'activity_id','nonce':'nonce'}[fault]]='wrong'
  if fault=='attempt':payload['ticket']['attempt']=2
  if fault=='generation':payload['ticket']['run_id']='new'
  if fault=='steps':payload['steps']=99
  if fault=='bool':payload['steps']=True
  if fault=='deadline':payload['deadline']=NOW.timestamp()-1
  if fault=='too-late':payload['deadline']=NOW.timestamp()+3001
  if fault=='revision':o._response_schema_revision=2
  if fault=='paused':o.is_paused=True
  if fault=='kill':o._kill_request={}
  if fault=='orphan':o._orphaned=True
  assert b.acknowledge_finalizer(o,payload) is (fault=='none')
@pytest.mark.parametrize('fault',['none','early','wrong-budget','bool','first-run','multiple','expired','feedback','paused','kill'])
def test_stop_requires_current_acknowledged_finalizer(fault):
 o=SimpleNamespace(agent_id='root',is_paused=False,_browser_execution_task_id='tool',_background_tasks={'tool':{}},_response_schema_revision=1)
 with patch.object(b.workflow,'info',return_value=INFO),patch.object(b.workflow,'now',return_value=NOW),patch.object(b.workflow,'uuid4',return_value='nonce'):
  t=b.register_finalizer(o,task_id='task',tool_id='tool',activity_id='activity',limit=100,timeout_seconds=3000)
  if fault!='early':assert b.acknowledge_finalizer(o,{'ticket':t,'steps':100,'deadline':NOW.timestamp()+180})
  req={'budget':100,'first_run_id':'first'}
  if fault=='wrong-budget':req['budget']=101
  if fault=='bool':req['budget']=True
  if fault=='first-run':req['first_run_id']='wrong'
  if fault=='multiple':o._background_tasks['other']={}
  if fault=='expired':o._browser_finalizers['tool']['deadline']=NOW.timestamp()-1
  if fault=='feedback':o._response_schema_revision=2
  if fault=='paused':o.is_paused=True
  if fault=='kill':o._kill_request={}
  assert b.request_budget_stop(o,req)['accepted'] is (fault=='none')
