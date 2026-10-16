#!/usr/bin/env python3
"""Actual local owned Hub process retirement; no provider operations."""
import hashlib,json,os,runpy,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
M=runpy.run_path(str(ROOT/'scripts/cloudbench-controller-export.py'))
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
if __name__=='__main__':unittest.main()
