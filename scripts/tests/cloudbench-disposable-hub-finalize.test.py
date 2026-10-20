#!/usr/bin/env python3
"""Actual local owned Hub process retirement; no provider operations."""
import hashlib,json,os,runpy,subprocess,sys,tempfile,time,types,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
HELPER=Path(os.environ.get('ROSE_CONTROLLER_EXPORT_TEST_SOURCE',ROOT/'scripts/cloudbench-controller-export.py'))
M=runpy.run_path(str(HELPER))
class Finalize(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.repo=Path(self.tmp.name)/'repo';self.hub=self.repo/'.context/fleet/runs/_hub';self.hub.mkdir(parents=True);self.out=Path(self.tmp.name)/'custody';self.out.mkdir();self.script=self.repo/'agents/benchmarks/agent_link_server.py';self.script.parent.mkdir(parents=True);self.script.write_text('import time\ntime.sleep(60)\n')
  self.child=subprocess.Popen([sys.executable,str(self.script)],cwd=self.repo);self.addCleanup(self.join)
  while not M['birth'](self.child.pid):time.sleep(.01)
  argv=[str(self.script)];self.owner=dict(pid=str(self.child.pid),pid_start=M['birth'](self.child.pid),repo_root=str(self.repo),root=str(self.hub.parent),runs_root=str(self.hub.parent),context_dir=str(self.hub),command=str(self.script),status='live-transfer-required',host='127.0.0.1',port='8765',owner_token='a'*32,argv_sha256=hashlib.sha256(b'\0'.join(os.fsencode(x)for x in argv)).hexdigest());self.path=self.hub/('agent-link-server.8765.'+'a'*32+'.owner');self.write()
 def write(self):
  if self.path.exists():self.path.chmod(0o600)
  self.path.write_text(''.join(k+'='+v+'\n'for k,v in self.owner.items()));self.path.chmod(0o444)
 def join(self):
  if self.child.poll()is None:self.child.terminate()
  self.child.wait(timeout=3)
 def test_live_hub_blocks_writer_check_then_exact_retirement_unblocks(self):
  original=Path.iterdir
  def selected(path):return iter([Path('/proc',str(self.child.pid))]) if path==Path('/proc') else original(path)
  with patch.object(Path,'iterdir',selected):self.assertTrue(M['writers']([self.repo],{os.getpid()}))
  M['retire_disposable_hubs'](self.repo,self.out)
  self.child.wait(timeout=3);self.assertEqual(self.child.returncode,-15)
  with patch.object(Path,'iterdir',selected):self.assertFalse(M['writers']([self.repo],{os.getpid()}))
  self.assertEqual(len(list(self.out.glob('*.intent.json'))),1)
  M['retire_disposable_hubs'](self.repo,self.out)
 def test_changed_argv_and_foreign_root_refuse_without_signal(self):
  for key in ['argv_sha256','repo_root']:
   old=self.owner[key];self.owner[key]='0'*64;self.write()
   with self.assertRaises(ValueError):M['retire_disposable_hubs'](self.repo,self.out)
   self.assertIsNone(self.child.poll());self.assertFalse(list(self.out.iterdir()));self.owner[key]=old;self.write()
 def test_reused_birth_never_signals_replacement(self):
  self.owner['pid_start']='proc-start:foreign:1';self.write();M['retire_disposable_hubs'](self.repo,self.out);self.assertIsNone(self.child.poll());self.assertFalse(list(self.out.iterdir()))
 def test_dead_starting_owner_skips_without_signal_but_live_foreign_refuses(self):
  self.owner['status']='starting';self.owner['repo_root']='foreign';self.write()
  with self.assertRaises(ValueError):M['retire_disposable_hubs'](self.repo,self.out)
  self.assertIsNone(self.child.poll());self.assertFalse(list(self.out.iterdir()))
  self.child.terminate();self.child.wait(timeout=3)
  self.path.chmod(0o600) # Incomplete dead starting receipts need no live-owner seal.
  M['retire_disposable_hubs'](self.repo,self.out)
  self.assertFalse(list(self.out.iterdir()))
 def test_rendered_disposable_gate_calls_finalizer_before_writer_check(self):
  gate=Path(os.environ.get('HUB_GATE_SOURCE',ROOT/'scripts/run-cloudbench-controller-gate')).read_text()
  start=gate.index('  if [ "$EXPORT_HOST" = 1 ]; then',gate.index('GATE_FAILED_STEPS${failed_steps}'))
  end=gate.index('\n  fi',start)+5
  rendered=subprocess.check_output(['bash','-c','EXPORT_HOST=1;DISPOSABLE_AUTHORITY=fixture;'+gate[start:end]],text=True)
  adapter=Path(self.tmp.name)/'adapter.py'
  adapter.write_text("""import os,runpy,sys
from pathlib import Path
from unittest.mock import patch
m=runpy.run_path(os.environ['HELPER']);repo=Path(os.environ['REPO']);pid=int(os.environ['CHILD']);original=Path.iterdir
def selected(path):return iter([Path('/proc',str(pid))]) if path==Path('/proc') else original(path)
if '--finalize-disposable-hubs' in sys.argv:m['retire_disposable_hubs'](repo,Path(os.environ['OUT']))
with patch.object(Path,'iterdir',selected):active=m['writers']([repo],{os.getpid()})
raise SystemExit(75 if active else 0)
""")
  script='bound_controller_export() { '+sys.executable+' '+str(adapter)+' "$@"; }; '+rendered+'\nexit "$export_rc"'
  result=subprocess.run(['bash','-c',script],env=dict(os.environ,HELPER=str(ROOT/'scripts/cloudbench-controller-export.py'),REPO=str(self.repo),CHILD=str(self.child.pid),OUT=str(self.out)),text=True,capture_output=True)
  self.assertEqual(result.returncode,0,result.stdout+result.stderr)
 def test_gate_only_disposable_after_wait_and_before_export(self):
  gate=(ROOT/'scripts/run-cloudbench-controller-gate').read_text();a=gate.index('wait "$command_pid"; rc=$?');b=gate.index('controller-command.joined.json',a);c=gate.index('finalize_hubs=""',b);d=gate.index('bound_controller_export export',c)
  self.assertLess(a,b);self.assertLess(b,c);self.assertLess(c,d);self.assertIn('[ -z "$DISPOSABLE_AUTHORITY" ] || finalize_hubs=" --finalize-disposable-hubs"',gate)
class GateExportDownload(unittest.TestCase):
 """The gate's actual member download, against a fake flyctl transport on PATH."""
 def run_get(self,failures,member='manifest.json'):
  gate=Path(os.environ.get('HUB_GATE_SOURCE',ROOT/'scripts/run-cloudbench-controller-gate')).read_text()
  start=gate.index("<<'PY_EXPORT_GET'\n")+len("<<'PY_EXPORT_GET'\n");helper=gate[start:gate.index('\nPY_EXPORT_GET\n',start)]
  tmp=Path(tempfile.mkdtemp());self.addCleanup(__import__('shutil').rmtree,tmp)
  (tmp/'bin').mkdir();(tmp/'export').mkdir();script=tmp/'get.py';script.write_text(helper)
  fly=tmp/'bin/flyctl';fly.write_text('#!/bin/bash\nn=$(($(cat "$STATE" 2>/dev/null || echo 0)+1)); echo $n > "$STATE"\nif [ "$n" -le "$FAILURES" ]; then printf partial > "${@: -1}"; echo "Error: ssh: tunnel closed (attempt $n)" >&2; exit 1; fi\nprintf "%s" "$PAYLOAD" > "${@: -1}"\n');fly.chmod(0o755)
  target=tmp/'export'/member
  result=subprocess.run([sys.executable,'-I','-B',str(script),'120','fixture-app','abc123',member,str(target)],env=dict(os.environ,PATH=str(tmp/'bin')+':'+os.environ['PATH'],STATE=str(tmp/'state'),FAILURES=str(failures),PAYLOAD='{"version": 1}'),capture_output=True,text=True,timeout=60)
  return result,target,tmp/'export'/('export-download-'+member+'.attempts.private.json')
 def test_one_failed_manifest_download_is_retried_with_stderr_retained(self):
  # run600b shard-08: remote GATE_EXPORT exit=0, one manifest transfer failure retained the host.
  result,target,log=self.run_get(1)
  self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(target.read_text(),'{"version": 1}')
  attempts=json.loads(log.read_text())['attempts'];self.assertEqual([a['exit_code'] for a in attempts],[1,0])
  self.assertIn('tunnel closed (attempt 1)',attempts[0]['stderr']);self.assertEqual(log.stat().st_mode&0o777,0o600)
 def test_persistent_transfer_failure_stays_pending_without_partial_member(self):
  result,target,log=self.run_get(5)
  self.assertNotEqual(result.returncode,0);self.assertFalse(os.path.lexists(target))
  self.assertEqual(len(json.loads(log.read_text())['attempts']),3)


class QuiescingOriginalsExport(unittest.TestCase):
 """Real launch/export/verify on private originals; the only fake is ext4's late writeback."""
 def setUp(self):
  global G
  G={"__name__":"quiescing_export_fixture","__file__":str(HELPER)};exec(compile(HELPER.read_bytes(),str(HELPER),"exec"),G)
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);base=Path(self.tmp.name).resolve()
  self.repo=base/'repo';self.common=self.repo/'.git';self.common.mkdir(parents=True);(self.repo/'scripts').mkdir()
  self.log=self.repo/'.context/benchmarks/campaigns/c/r003-j0441.log';self.log.parent.mkdir(parents=True);self.log.write_bytes(b'job output\n'*100)
  (self.repo/'.context/benchmarks/campaigns/c/summary.json').write_text('{}')
  self.custody=base/'custody';self.custody.mkdir();self.ref='a'*40
  self.caller=base/'caller.json';self.caller.write_text('{"pid": 7}')
  self.record=self.custody/'launch.json';self.archive=self.custody/'originals.tar.gz';self.manifest=self.custody/'manifest.json';self.pending=self.custody/'pending.json'
  def git(repo,*args):return str(self.common) if '--git-common-dir' in args else self.ref if args==('rev-parse','HEAD') else ''
  self.flushed=False;self.changes=0;real=G['file_state'];test=self
  def file_state(path):
   value=real(path)
   if Path(path)==test.log and not test.flushed:
    # ext4 delalloc: the final append is reserved, not yet extent-mapped. Writeback
    # (the flusher, ~dirty_expire after the write) adds one extent block: +4096
    # st_blocks bytes with unchanged mtime/ctime, size and content.
    test.changes+=1
    if test.changes>1:test.flushed=True
    return value if test.changes==1 else dict(value,allocated_bytes=value['allocated_bytes'])
   return dict(value,allocated_bytes=value['allocated_bytes']+4096) if Path(path)==test.log and test.flushed else value
  def sync():test.flushed=True
  self.patches=[patch.dict(G,{'git':git,'birth':lambda pid:'proc-start:fixture:'+str(pid),'record_temp_roots':lambda repo,common:[],'file_state':file_state,'writers':lambda roots,permitted:[],'EXPORT_SETTLE_SECONDS':0}),patch.object(G['os'],'sync',sync),patch.dict(os.environ,{'FLY_MACHINE_ID':'abc123','FLY_APP_NAME':'fixture'})]
  for item in self.patches:item.start();self.addCleanup(item.stop)
  os.environ.pop('GATE_WORKSPACE_VOLUME_ID',None)
  G['launch'](types.SimpleNamespace(repo=self.repo,ref=self.ref,driver_pid=os.getpid(),caller=self.caller,image='image@sha256:fixture',record=self.record))
 def export(self):
  return G['export'](types.SimpleNamespace(record=self.record,archive=self.archive,manifest=self.manifest,pending=self.pending,capture_tool_ref=None,finalize_disposable_hubs=False))
 def verify(self):
  return G['verify'](types.SimpleNamespace(record=self.record,archive=self.archive,manifest=self.manifest,caller=self.caller,ref=self.ref,machine='abc123',app='fixture',image='image@sha256:fixture'))
 def test_pending_writeback_of_recent_appends_settles_before_strict_snapshot(self):
  # run600c shards 00/14/15/17/19: export began <30 s after the last campaign appends.
  self.assertEqual(self.export(),0,self.pending.read_text() if self.pending.exists() else '')
  self.assertFalse(self.pending.exists());self.assertEqual(self.verify(),0)
  self.assertEqual(json.loads(self.manifest.read_text())['files']['context/benchmarks/campaigns/c/r003-j0441.log']['bytes'],1100)
 def test_quiescing_writer_retries_fresh_strict_snapshot_with_final_bytes(self):
  self.flushed=True;real=G['export_snapshot'] if 'export_snapshot' in G else None;calls=[]
  original=G['file_state']
  def late_append(path):
   value=original(path)
   if Path(path)==self.log and not calls:
    calls.append(1)
    with self.log.open('ab') as out:out.write(b'final line\n')
   return value
  with patch.dict(G,{'file_state':late_append}):self.assertEqual(self.export(),0,self.pending.read_text() if self.pending.exists() else '')
  self.assertEqual(self.verify(),0)
  self.assertEqual(json.loads(self.manifest.read_text())['files']['context/benchmarks/campaigns/c/r003-j0441.log']['bytes'],1111)
 def test_persistent_change_fails_closed_with_named_evidence_and_no_receipt(self):
  self.flushed=True;original=G['file_state']
  def always(path):
   value=original(path)
   if Path(path)==self.log:
    with self.log.open('ab') as out:out.write(b'x')
   return value
  with patch.dict(G,{'file_state':always}):code=self.export()
  self.assertEqual(code,75);self.assertFalse(self.archive.exists());self.assertFalse(self.manifest.exists())
  pending=json.loads(self.pending.read_text());self.assertEqual(pending['reason'],'controller originals changed during export')
  self.assertEqual(len(pending['snapshot_attempts']),G['EXPORT_SNAPSHOT_ATTEMPTS'])
  self.assertIn(str(self.log),[row['path'] for attempt in pending['snapshot_attempts'] for row in attempt['changed']])
  self.assertFalse(list(self.custody.glob('.controller-export-*')))
 def test_live_writer_after_snapshot_stays_pending_without_receipt(self):
  self.flushed=True;seen=[]
  def writers(roots,permitted):
   seen.append(1);return [{'pid':4242,'birth':'proc-start:fixture:4242'}] if len(seen)>1 else []
  with patch.dict(G,{'writers':writers}):code=self.export()
  self.assertEqual(code,75);self.assertFalse(self.manifest.exists())
  self.assertEqual(json.loads(self.pending.read_text())['reason'],'live controller writers')
if __name__=='__main__':unittest.main()
