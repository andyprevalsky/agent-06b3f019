#!/usr/bin/env python3
"""Fake-only controls for the unreleased exact negative observer; no native launch."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

MODULE=Path(__file__).resolve().parents[1]/'deploy_test_focused10_settlement.py'
spec=importlib.util.spec_from_file_location('focused10_draft',MODULE)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class NegativeSettlement(unittest.TestCase):
 def native(self):
  return dict(native_exit=1,quiescent=True,error=None,cancelled=False,timed_out=False,orphaned_children=False,remaining=[],term_sent=[],kill_sent=[],child_pid=200000001,supervisor_pid=200000002,reaped=[dict(pid=200000001,status=256)])
 def test_exact_negative_native_and_boolean_refusal(self):
  with mock.patch.object(m,'absent')as absent:
   m.terminal(self.native());self.assertEqual(absent.call_count,2)
   for key,value in [('native_exit',False),('quiescent',False),('error','unknown'),('timed_out',True),('remaining',[7]),('reaped',[])]:
    p=self.native();p[key]=value
    with self.subTest(key=key),self.assertRaises(ValueError):m.terminal(p)
 def test_unknown_or_reused_pid_never_closes(self):
  with mock.patch.object(m,'absent',side_effect=PermissionError('unknown')):
   with self.assertRaises(PermissionError):m.terminal(self.native())
 def test_negative_projection_never_imports_case_pass(self):
  gate=dict(name='new-test-stability',checks=['new-test-stability'],command=['fixture'])
  request=dict(token='token',source={'head':m.SOURCE},checks=['new-test-stability'],skips={})
  with tempfile.TemporaryDirectory()as name:
   folder=Path(name);(folder/'result.json').write_text('{}')
   c=types.SimpleNamespace(validate_result=mock.Mock(return_value=({'new-test-stability':'PASS'},False)))
   row=m.negative_row(gate,request,folder,self.native(),10,c)
   self.assertEqual(row['cases'],{'new-test-stability':'UNVERIFIED'})
   self.assertFalse(row['positive_credit']);self.assertFalse(row['complete'])
   self.assertEqual(row['executed'],'UNKNOWN');self.assertNotIn('started_at',row);self.assertNotIn('finished_at',row)
   self.assertFalse((folder/'receipt.json').exists());self.assertEqual(c.validate_result.call_count,1)
   c.validate_result.return_value=({'new-test-stability':'PASS'},True)
   self.assertEqual(m.negative_row(gate,request,folder,self.native(),10,c)['cases'],{'new-test-stability':'UNVERIFIED'})
   c.validate_result.side_effect=ValueError('worker identity/inventory mismatch')
   negative=m.negative_row(gate,request,folder,self.native(),10,c)
   self.assertFalse(negative['native_validation']['accepted'])
   self.assertEqual(negative['native_validation']['error'],'worker identity/inventory mismatch')
   self.assertEqual(negative['cases'],{'new-test-stability':'UNVERIFIED'})
 def test_wrong_scope_refuses_before_original_scan(self):
  with tempfile.TemporaryDirectory()as name:
   directory=Path(name)
   state=dict(phase='focused',round=10,ready=False,live_failures=[],source={'head':m.SOURCE})
   authority=dict(approved=True,kind=m.KIND,positive_credit=False,reviewed_at=100,deadline=200)
   for key,value in [('round',11),('phase','final'),('ready',True),('running',{'pid':1})]:
    wrong=copy.deepcopy(state);wrong[key]=value
    with mock.patch.object(m.time,'time',return_value=110),self.assertRaises(ValueError):m.prepare(wrong,directory,directory,authority,None)
   bad=dict(authority,positive_credit=True)
   with self.assertRaises(ValueError):m.prepare(state,directory,directory,bad,None)
 def test_automatic_prerequisite_and_exact_request_closure(self):
  names=['smoke','new-test-stability','agents','structural','semantic','typescript']
  state={'focused':{n:{'name':n}for n in names},'plan':{}}
  prerequisite={'name':'cloudbench-controller'}
  c=types.SimpleNamespace(cloud_smoke_prerequisite=mock.Mock(return_value=prerequisite))
  with tempfile.TemporaryDirectory()as name:
   d=Path(name)
   for n in names+['cloudbench-controller']:
    folder=d/'attempts/10/focused'/n;folder.mkdir(parents=True);(folder/'request.json').write_text('{}')
   selected=m.selected_gates(state,d,c)
   self.assertEqual(set(selected),set(names)|{'cloudbench-controller'})
   self.assertEqual(selected['cloudbench-controller'],prerequisite)
   extra=d/'attempts/10/focused/foreign';extra.mkdir();(extra/'request.json').write_text('{}')
   with self.assertRaises(ValueError):m.selected_gates(state,d,c)

 def test_no_generic_missing_request_recognition(self):
  with tempfile.TemporaryDirectory()as name:
   directory=Path(name)
   for path in ['attempts/11/focused/smoke/request.json','attempts/10/final/smoke/request.json','attempts/10/focused/other/request.json']:
    self.assertFalse(m.recognized({},directory,{},directory/path))
 def test_pending_journal_blocks_launch_but_allows_exact_resume(self):
  with tempfile.TemporaryDirectory()as name:
   d=Path(name);(d/m.JOURNAL).write_text('{}')
   for action in ['run','refresh','complete','reexecute','reconcile']:
    with self.assertRaises(ValueError):m.pending_guard(d,action)
   for action in ['status','report','settle-focused10']:m.pending_guard(d,action)
 def test_crash_after_durable_journal_does_not_change_state_or_create_receipt(self):
  with tempfile.TemporaryDirectory()as name:
   d=Path(name);state={'phase':'focused'};before=copy.deepcopy(state)
   proposal=dict(kind=m.KIND,after_state={'phase':'triage'},seals={'fixture':{}})
   authority={'deadline':99999999999}
   def write(path,value):
    Path(path).write_bytes(m.encoded(value))
   c=types.SimpleNamespace(write=write)
   with mock.patch.object(m,'prepare',return_value=proposal):
    with self.assertRaises(RuntimeError):m.settle(state,d,d,authority,c,lambda _:(_ for _ in ()).throw(RuntimeError('interrupted before state commit')))
   self.assertEqual(state,before);self.assertTrue((d/m.JOURNAL).exists());self.assertFalse((d/m.COMMITTED).exists())
   self.assertFalse(list(d.rglob('request.json')));self.assertFalse(list(d.rglob('receipt.json')))
   with self.assertRaises(ValueError):m.pending_guard(d,'run')
 def test_frozen_hub_survives_native_runtime_path_retirement(self):
  with tempfile.TemporaryDirectory()as name:
   path=Path(name)/'old.owner';raw=b'owner_token=token\npid=200000001\npid_start=birth\nargv_sha256=args\n';path.write_bytes(raw)
   meta=dict(hub_owner_file=str(path),hub_owner_token='token',hub_pid='200000001',hub_pid_start='birth',hub_argv_sha256='args')
   with mock.patch.object(m,'absent'):
    saved=m.hub_record(meta);path.unlink()
    self.assertEqual(m.hub_record(meta,[saved]),saved)
    with self.assertRaises(ValueError):m.hub_record(meta)
    path.write_bytes(raw+b'extra=drift\n')
    with self.assertRaises(ValueError):m.hub_record(meta,[saved])
    path.unlink();bad=dict(saved,raw_b64=m.base64.b64encode(b'bad').decode())
    with self.assertRaises(ValueError):m.hub_record(meta,[bad])

 def test_expired_journal_requires_fresh_exact_bound_continuation(self):
  for mode in ('expired','fresh','changed-identity','wrong-journal'):
   with self.subTest(mode=mode),tempfile.TemporaryDirectory()as name:
    d=Path(name);artifact=d/'original';artifact.write_bytes(b'keep')
    before={'phase':'focused'}
    original=dict(approved=True,kind=m.KIND,positive_credit=False,reviewed_at=1,deadline=2,operator_source={'head':m.SOURCE},observer_sha256=m.sha(MODULE),operator_files={},processes={})
    after=dict(phase='triage',environment='fixture-env',focused10_negative_settlement={'retained_services':[]})
    seals={str(artifact):dict(sha256=m.sha(artifact),size=4,mode=oct(artifact.stat().st_mode&0o777))}
    proposal=dict(after_state=after,seals=seals)
    journal=dict(kind=m.KIND,positive_credit=False,spec_sha256=m.digest(original),authority_identity_sha256=m.digest(m.authority_identity(original)),before_state_digest=m.digest(before),proposal_sha256=m.digest(proposal),proposal=proposal)
    (d/m.JOURNAL).write_bytes(m.encoded(journal));authority=copy.deepcopy(original)
    if mode!='expired':authority.update(reviewed_at=100,deadline=200,resume_journal_sha256=m.sha(d/m.JOURNAL))
    if mode=='changed-identity':authority['operator_source']={'head':'wrong'}
    if mode=='wrong-journal':authority['resume_journal_sha256']='wrong'
    persisted=[]
    c=types.SimpleNamespace(source=lambda _:original['operator_source'],environment_digest=lambda:'fixture-env',write=lambda p,v:Path(p).write_bytes(m.encoded(v)))
    with mock.patch.object(m.time,'time',return_value=110),mock.patch.object(m,'absent'),mock.patch.object(m,'zero_allocation'),mock.patch.object(m,'doc',wraps=m.doc)as docs:
     # The zero-allocation helper is separately exercised against original native evidence.
     real_doc=m.doc
     def read(path):
      if str(path)==str(authority.get('no_allocation')):return {}
      if str(path).endswith('smoke/result.json'):return {}
      return docs._mock_wraps(path)
     docs.side_effect=read
     authority.setdefault('no_allocation',str(d/'audit'))
     # This is part of the original identity too; no widening on continuation.
     original.setdefault('no_allocation',str(d/'audit'));journal['spec_sha256']=m.digest(original);journal['authority_identity_sha256']=m.digest(m.authority_identity(original));(d/m.JOURNAL).write_bytes(m.encoded(journal))
     if mode not in ('expired','wrong-journal'):authority['resume_journal_sha256']=m.sha(d/m.JOURNAL)
     if mode=='fresh':
      m.settle(before,d,d,authority,c,persisted.append)
      self.assertEqual(persisted,[after]);self.assertEqual(before,after)
      self.assertTrue((d/m.COMMITTED).exists());self.assertFalse(list(d.rglob('receipt.json')))
     else:
      with self.assertRaises(ValueError):m.settle(before,d,d,authority,c,persisted.append)
      self.assertEqual(persisted,[]);self.assertFalse((d/m.COMMITTED).exists())

 def test_changed_journal_authority_refuses_without_commit(self):
  with tempfile.TemporaryDirectory()as name:
   d=Path(name);(d/m.JOURNAL).write_bytes(m.encoded({'spec_sha256':'wrong'}))
   persist=mock.Mock()
   with self.assertRaises(ValueError):m.settle({},d,d,{},None,persist)
   persist.assert_not_called();self.assertFalse((d/m.COMMITTED).exists())

if __name__=='__main__':unittest.main()
