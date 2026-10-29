"""Narrow offline regressions for reviewed deploy script boundary defects."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))

def module(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m

approval=module('review_approval','scripts/deploy_approval_batch.py')
detail=module('review_detail','scripts/factory_detail.py')
diag=module('review_diag','scripts/factory_diagnostics.py')
pipeline=module('review_pipeline','scripts/run_deploy_pipeline.py')
sat=module('select_affected_tests','scripts/select_affected_tests.py')
coverage_map=module('review_coverage_map','scripts/test-map/build_agents_coverage_map.py')
replay=module('review_replay','scripts/test-map/replay_summary.py')

class ReviewRegressionTest(unittest.TestCase):
 def test_parenthesized_approval_paths(self):
  self.assertEqual(approval._path_of('prompts/example (draft).md'),'prompts/example (draft).md')
  self.assertEqual(approval._path_of('tests/a (draft).py (deleted test file)'),'tests/a (draft).py')
  self.assertEqual(approval._path_of('tasks/a (draft).py (removed benchmark task: NAME)'),'tasks/a (draft).py')
 def test_hex_secret_rejected_except_fix_sha(self):
  token='abcdef0123456789abcdef0123456789'
  self.assertIsNone(detail.safe_text(token))
  self.assertIsNone(detail.safe_text('a' * 32))
  self.assertIsNone(detail.safe_text('1' * 32))
  self.assertNotIn('failing',detail.scan_log('FAILED '+token))
  self.assertEqual(detail.parse_event_detail(['fix_sha='+token])['fix_sha'],token)
 def test_wait_pairs_are_branch_scoped(self):
  rows=[{'branch':branch,'event':event,'value':'codex','recorded_epoch':epoch} for branch,event,epoch in [('a','review-request',0),('b','review-request',2),('a','review-arrival',5),('b','review-arrival',9)]]
  windows=diag._wait_windows(rows)
  self.assertEqual(sorted(b-a for a,b,*_ in windows),[5,7])
 def test_pipeline_rejects_cycle(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp)/'plan.json';p.write_text(json.dumps({'lanes':[{'name':'a','command':['true'],'after':['b']},{'name':'b','command':['true'],'after':['a']}]}))
   with self.assertRaisesRegex(ValueError,'cycl'):pipeline.load_plan_payload(p)
 def test_pipeline_post_lane_timeout(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);receipt={'started_epoch':1,'stage_run_dir':str(root),'source':{'head':'fixture'},'status':'running','lanes':{'x':{'status':'passed'}}}
   times=iter([0,0,2,2,2])
   def sleep(_):raise AssertionError('post-lane wait ignored timeout')
   with patch.object(pipeline,'_read_receipt',return_value=receipt),patch.object(pipeline,'_supervisor_alive',return_value=True),patch.object(pipeline.deploy_stage_wait,'wait_for_stages',return_value=(0,{'event':'passed'})),patch.object(pipeline.deploy_stage_wait,'_rows',return_value=[]),patch.object(pipeline.time,'monotonic',side_effect=lambda:next(times,2)),patch.object(pipeline.time,'sleep',side_effect=sleep),contextlib.redirect_stdout(io.StringIO()):
    self.assertEqual(pipeline.wait(root,1),124)
 def test_glob_does_not_swallow_following_code(self):
  source="const glob = '**/*.test.ts';\nreadFileSync('scripts/critical.sh');\n/** later documentation */\n"
  self.assertIn("readFileSync('scripts/critical.sh')",sat.strip_comments('x.test.ts',source))
  quoted = 'const text = " /*";\nreadFileSync("scripts/critical.sh");\n/** docs */\n'
  self.assertIn('readFileSync("scripts/critical.sh")', sat.strip_comments('x.test.ts', quoted))
  regex_source = r'const pattern = /https?:\/\//; readFileSync("scripts/critical.sh");'
  self.assertIn('readFileSync("scripts/critical.sh")',sat.strip_comments('x.test.ts',regex_source))
  graph=sat.Graph(['x.test.ts','scripts/critical.sh']);graph.text['x.test.ts']=source
  graph.path_edges('x.test.ts')
  self.assertIn('scripts/critical.sh',graph.deps['x.test.ts'])
 def test_nested_templates_preserve_dependency_code(self):
  samples = [
   'const q = `a${`b /*`}c`;\nreadFileSync("scripts/critical.sh");\n/** docs */',
   'const q = `a${`b //`}c`; readFileSync("scripts/critical.sh");',
  ]
  for source in samples:
   with self.subTest(source=source):
    stripped=sat.strip_comments('x.test.ts',source)
    self.assertIn('readFileSync("scripts/critical.sh")',stripped)
    graph=sat.Graph(['x.test.ts','scripts/critical.sh']);graph.text['x.test.ts']=source
    graph.path_edges('x.test.ts')
    self.assertIn('scripts/critical.sh',graph.deps['x.test.ts'])
 def test_file_grep_keeps_dependency(self):
  source='grep -q "x" scripts/critical.sh\ngrep -f scripts/patterns scripts/input\nps aux | grep -q python\npgrep -f "python3 agents/x.py"\n'
  stripped=sat.strip_comments('scripts/test.sh',source)
  self.assertIn('scripts/critical.sh',stripped);self.assertIn('scripts/patterns',stripped)
  self.assertNotIn('pgrep',stripped);self.assertNotIn('ps aux',stripped)
  graph=sat.Graph(['scripts/test.sh','scripts/critical.sh','scripts/patterns','scripts/input']);graph.text['scripts/test.sh']=source
  graph.path_edges('scripts/test.sh')
  self.assertIn('scripts/critical.sh',graph.deps['scripts/test.sh'])
 def test_explicit_git_range_has_only_range_argument(self):
  with patch.object(sat.subprocess,'run',return_value=types.SimpleNamespace(stdout='x.py\n')) as run:
   self.assertEqual(sat.changed_files('base','head'),['x.py'])
  self.assertEqual(run.call_args.args[0],['git','diff','--no-renames','--name-only','base...head'])
 def coverage_attempt(self,status,with_data,partial=False):
  with tempfile.TemporaryDirectory() as tmp:
   out=Path(tmp)/'map.json';out.write_text('preserved')
   agents=Path(tmp)/'agents';domains=agents/'tests/blackbox';domains.mkdir(parents=True)
   (domains/'sample.blackbox.py').touch()
   if partial:(domains/'missing.blackbox.py').touch()
   class Data:
    def __init__(self,basename):pass
    def read(self):pass
    def measured_files(self):return [str(coverage_map.ROOT/'agents/x.py')]
    def lines(self,_):return [1]
   def run(*args,**kwargs):
    self.assertTrue('AGENTS_BLACKBOX_DOMAINS' not in kwargs['env'], 'coverage refresh inherited a domain selector')
    if with_data:
     shim=Path(kwargs['env']['COVERAGE_BIN']).read_text();data=Path(shim.split('COVERAGE_FILE="')[1].split('/cov.')[0]);(data/'cov.sample').touch()
    return types.SimpleNamespace(returncode=status)
   with patch.object(coverage_map,'AGENTS',agents),patch.dict(sys.modules,{'coverage':types.SimpleNamespace(CoverageData=Data)}),patch.object(coverage_map.subprocess,'run',side_effect=run),patch.object(sys,'argv',['build','--out',str(out)]),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):result=coverage_map.main()
   return result,out.read_text()
 def test_coverage_empty_preserves_map(self):
  status,data=self.coverage_attempt(0,False);self.assertNotEqual(status,0);self.assertEqual(data,'preserved')
 def test_coverage_runner_failure_preserves_map(self):
  status,data=self.coverage_attempt(7,True);self.assertEqual(status,7);self.assertEqual(data,'preserved')
 def test_coverage_success_requires_complete_inventory(self):
  with patch.dict(os.environ,{'AGENTS_BLACKBOX_DOMAINS':'sample'}):
   status,data=self.coverage_attempt(0,True,partial=True)
  self.assertNotEqual(status,0);self.assertEqual(data,'preserved')
 def test_coverage_success_rejects_partial_without_selector(self):
  status,data=self.coverage_attempt(0,True,partial=True)
  self.assertNotEqual(status,0);self.assertEqual(data,'preserved')
 def test_coverage_complete_success_writes_map(self):
  status,data=self.coverage_attempt(0,True)
  self.assertEqual(status,0);self.assertIn('sample',json.loads(data)['domains'])
 def test_replay_empty_finishes_without_fake_measurement(self):
  with tempfile.TemporaryDirectory() as tmp:
   file=Path(tmp)/'replay.jsonl';file.write_text('');out=io.StringIO()
   with patch.object(sys,'argv',['replay',str(file)]),patch.object(sat,'load_edges',return_value={'no_tests':[]}),contextlib.redirect_stdout(out):self.assertEqual(replay.main(),0)
   self.assertIn("today's path gating",out.getvalue());self.assertIn('unmeasured',out.getvalue())

class C8ScriptRegressionTest(unittest.TestCase):
 def test_approval_git_timeout_is_bounded_and_typed(self):
  def timeout(*args,**kwargs):
   self.assertGreater(kwargs.get('timeout',0),0)
   raise subprocess.TimeoutExpired('git',kwargs['timeout'])
  with patch.object(approval.subprocess,'run',side_effect=timeout):
   with self.assertRaises(approval.BatchError):approval._git(ROOT,'status')
 def test_approval_guard_timeout_is_bounded_and_typed(self):
  calls=[]
  def timeout(*args,**kwargs):
   self.assertGreater(kwargs.get('timeout',0),0)
   raise subprocess.TimeoutExpired('guard',kwargs['timeout'])
  def communicate(*args,**kwargs):
   self.assertGreater(kwargs.get('timeout',0),0)
   calls.append(1)
   if len(calls)==1:raise subprocess.TimeoutExpired('guard',kwargs['timeout'])
   return '', ''
  child=types.SimpleNamespace(pid=12345,returncode=-15,stdout=io.StringIO(),stderr=io.StringIO(),communicate=communicate)
  with patch.object(approval,'guard_commands',return_value={'test':('guard',)}),patch.object(approval.subprocess,'run',side_effect=timeout),patch.object(approval.subprocess,'Popen',return_value=child),patch.object(approval.os,'killpg'):
   with self.assertRaises(approval.BatchError):approval.run_guards(ROOT)
 def test_source_git_failure_is_unknown_not_empty(self):
  def run(command,**kwargs):
   if command[1:]==['rev-parse','HEAD']:return types.SimpleNamespace(stdout='a'*40)
   if command[1:]==['merge-base','HEAD','origin/main']:return types.SimpleNamespace(stdout='b'*40)
   raise subprocess.TimeoutExpired(command,30)
  with patch.object(detail.subprocess,'run',side_effect=run):value=detail.source_detail(ROOT)
  self.assertEqual(value,{'sha':'a'*40,'base_sha':'b'*40})
 def test_source_partial_stats_do_not_claim_total_without_untracked(self):
  def run(command,**kwargs):
   args=command[1:]
   if args==['rev-parse','HEAD']:return types.SimpleNamespace(stdout='a'*40)
   if args[:1]==['merge-base']:return types.SimpleNamespace(stdout='b'*40)
   if args[:2]==['diff','--no-ext-diff']:return types.SimpleNamespace(stdout='')
   if args[:2]==['diff','--numstat']:return types.SimpleNamespace(stdout='1\t2\tscripts/x.py\n')
   raise OSError('git unavailable')
  with patch.object(detail.subprocess,'run',side_effect=run):value=detail.source_detail(ROOT)
  self.assertIs(value['dirty'],False)
  self.assertNotIn('files_changed',value);self.assertNotIn('lanes',value)
  self.assertEqual((value['insertions'],value['deletions']),(1,2))
 def test_unknown_source_does_not_claim_unchanged_retry(self):
  with tempfile.TemporaryDirectory() as raw:
   p=Path(raw);p.joinpath('stages.jsonl').write_text(json.dumps({'stage':'lint','status':'failed','started_epoch':1,'detail':{'source':{'sha':'a'*40,'dirty':False}}})+'\n')
   result=detail.attempt_detail(p,'lint',{'sha':'a'*40})
   self.assertNotEqual(result.get('retry_cause'),'unchanged-source')
   self.assertNotEqual(result.get('retry_cause'),'worktree-edit')
 def test_integer_validation_always_raises_detail_error(self):
  for raw in ['²','١','9'*19,'9'*5000]:
   with self.subTest(length=len(raw)):
    with self.assertRaises(detail.DetailError):detail.parse_event_detail(['attempt='+raw])
  self.assertEqual(detail.parse_event_detail(['attempt=18'])['attempt'],18)
 def test_malformed_ledger_rows_rejected_before_sort_and_counted(self):
  review=module('c8_factory_review','scripts/factory_review.py')
  good={'kind':'deploy-stage','run_id':'r','stage':'s','started_epoch':0,'finished_epoch':1,'status':'passed'}
  bad=[{**good,'started_epoch':v} for v in [None,'invalid',float('nan'),float('inf')]]
  bad.append({'kind':'factory-event','workflow':'deploy','event':'review-request'})
  with tempfile.TemporaryDirectory() as raw:
   p=Path(raw)/'ledger.jsonl';p.write_text('\n'.join(json.dumps(r) for r in [good,*bad,good]))
   rows=review.load_ledger_rows(p,[])
   self.assertEqual(list(rows),[good]);self.assertEqual(getattr(rows,'rejected_rows',None),5)
   output=diag.analyze_ledger(rows)
   self.assertEqual(output['coverage']['rejected_rows'],5)
   direct=diag.analyze_ledger([good,*bad])
   self.assertEqual(direct['coverage']['rejected_rows'],5)
 def test_pipeline_source_git_calls_are_bounded(self):
  calls=[]
  def run(command,**kwargs):
   calls.append(command);self.assertGreater(kwargs.get('timeout',0),0)
   return types.SimpleNamespace(stdout=b'a'*40 if 'rev-parse' in command else b'')
  with patch.object(pipeline.subprocess,'run',side_effect=run):pipeline.source_digest(ROOT)
  self.assertGreaterEqual(len(calls),3)
 def host_failure(self,position):
  good={'cpus':4,'mem_available_mb':20000,'mem_total_mb':20000,'watchdog_cap_mb':18000}
  active={};started=[];reaped=[];samples=[];failed=False;last_good=True
  def host(*args,**kwargs):
   nonlocal failed,last_good
   trigger=(position=='periodic' and bool(active)) or (position=='admission' and bool(active)) or (position=='final' and bool(reaped) and not active)
   if trigger and not failed:
    failed=True;last_good=False;raise ValueError('fixture memory sample unavailable')
   last_good=True;return good
  def popen(command,**kwargs):
   self.assertTrue(last_good,'lane admitted using an unknown/stale memory sample')
   process=types.SimpleNamespace(pid=100+len(started),returncode=None)
   started.append(command[2]);active[process.pid]=process;return process
  waits={}
  def wait4(pid,flags):
   waits[pid]=waits.get(pid,0)+1
   if waits[pid]==1:return 0,0,types.SimpleNamespace(ru_maxrss=1024)
   active.pop(pid,None);reaped.append(pid);return pid,0,types.SimpleNamespace(ru_maxrss=1024)
  with tempfile.TemporaryDirectory() as raw:
   p=Path(raw);plan=p/'plan.json';plan.write_text(json.dumps({'lanes':[{'name':n,'command':['true'],'memory_mb':1} for n in ['a','b']]}))
   with patch.object(pipeline,'host_resources',side_effect=host),patch.object(pipeline,'source_digest',return_value={'head':'fixture','digest':'same'}),patch.object(pipeline,'_stage_run_dir',return_value=None),patch.object(pipeline,'watchdog_terminations',return_value=[]),patch.object(pipeline,'HOST_SAMPLE_SECONDS',0 if position=='periodic' else 100000),patch.object(pipeline.subprocess,'Popen',side_effect=popen),patch.object(pipeline.os,'wait4',side_effect=wait4),patch.object(pipeline.signal,'signal'),patch.object(pipeline.time,'sleep'),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
    result=pipeline.run(plan,p/'state',max_parallel=1 if position=='periodic' else 2)
   receipt=json.loads((p/'state/receipt.json').read_text())
   self.assertTrue(failed);self.assertEqual(result,0);self.assertEqual(len(reaped),len(started));self.assertFalse(active)
   self.assertTrue(any(row.get('error')=='fixture memory sample unavailable' and row.get('headroom_mb') is None for row in receipt['host_samples']))
 def test_periodic_memory_failure_keeps_reaping(self):self.host_failure('periodic')
 def test_admission_memory_failure_never_uses_stale_headroom(self):self.host_failure('admission')
 def test_final_memory_failure_keeps_terminal_receipt(self):self.host_failure('final')
 def test_renames_include_old_path_in_all_diff_modes(self):
  def run(command,**kwargs):
   return types.SimpleNamespace(stdout='old.py\nnew.py\n' if '--no-renames' in command else 'new.py\n')
  for base,head in [('base','head'),(None,'head'),('base',None)]:
   with self.subTest(base=base,head=head),patch.object(sat.subprocess,'run',side_effect=run):
    self.assertIn('old.py',sat.changed_files(base,head))
 def test_unknown_memory_before_first_admission_refuses_lane(self):
  good={'cpus':4,'mem_available_mb':20000,'mem_total_mb':20000,'watchdog_cap_mb':18000}
  with tempfile.TemporaryDirectory() as raw:
   p=Path(raw);plan=p/'plan.json';plan.write_text(json.dumps({'lanes':[{'name':'a','command':['true'],'memory_mb':1}]}))
   with patch.object(pipeline,'host_resources',side_effect=[good,ValueError('probe failed'),good]),patch.object(pipeline,'source_digest',return_value={'head':'fixture','digest':'same'}),patch.object(pipeline,'_stage_run_dir',return_value=None),patch.object(pipeline,'watchdog_terminations',return_value=[]),patch.object(pipeline.subprocess,'Popen') as spawn,patch.object(pipeline.signal,'signal'),patch.object(pipeline,'HOST_SAMPLE_SECONDS',100000),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
    result=pipeline.run(plan,p/'state')
   self.assertEqual(result,1);spawn.assert_not_called()
   receipt=json.loads((p/'state/receipt.json').read_text());self.assertEqual(receipt['status'],'failed')
   self.assertIn('headroom None',receipt['lanes']['a']['note'])
 def test_real_child_is_reaped_after_transient_memory_failure(self):
  good={'cpus':4,'mem_available_mb':20000,'mem_total_mb':20000,'watchdog_cap_mb':18000}
  real_popen=subprocess.Popen;children=[];failed=False
  def spawn(*args,**kwargs):
   process=real_popen(*args,**kwargs);children.append(process);return process
  def host(*args,**kwargs):
   nonlocal failed
   if children and not failed:
    failed=True;raise ValueError('real child probe failure')
   return good
  with tempfile.TemporaryDirectory() as raw:
   p=Path(raw);wrapper=p/'stage.sh';wrapper.write_text('#!/bin/bash\nshift\nif [ "$1" = "--reuse-passed" ]; then shift; fi\nshift\nexec "$@"\n')
   plan=p/'plan.json';plan.write_text(json.dumps({'lanes':[{'name':'child','command':[sys.executable,'-c','import time; time.sleep(.03)'],'memory_mb':1}]}))
   try:
    with patch.object(pipeline,'STAGE_WRAPPER',wrapper),patch.object(pipeline,'host_resources',side_effect=host),patch.object(pipeline,'source_digest',return_value={'head':'fixture','digest':'same'}),patch.object(pipeline,'_stage_run_dir',return_value=None),patch.object(pipeline,'watchdog_terminations',return_value=[]),patch.object(pipeline,'HOST_SAMPLE_SECONDS',0),patch.object(pipeline.subprocess,'Popen',side_effect=spawn),patch.object(pipeline.signal,'signal'),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
     result=pipeline.run(plan,p/'state')
    self.assertTrue(failed);self.assertEqual(result,0);self.assertTrue(children)
    self.assertTrue(all(child.returncode==0 for child in children),'supervisor left a real child unreaped')
   finally:
    for child in children:
     if child.poll() is None:child.terminate();child.wait(timeout=5)
 def test_real_git_rename_preserves_old_path(self):
  with tempfile.TemporaryDirectory() as raw:
   root=Path(raw)
   def git(*args):
    return subprocess.run(['git','-c','commit.gpgsign=false','-c','diff.renames=true',*args],cwd=root,check=True,capture_output=True,text=True).stdout.strip()
   git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','fixture')
   (root/'old.py').write_text('print("fixture")\n');git('add','.');git('commit','-qm','base');base=git('rev-parse','HEAD')
   git('mv','old.py','new.py');git('commit','-qm','rename');head=git('rev-parse','HEAD')
   with patch.object(sat,'ROOT',root):
    self.assertEqual(sat.changed_files(base,head),['new.py','old.py'])
    self.assertEqual(sat.changed_files(None,head),['new.py','old.py'])
    git('mv','new.py','latest.py')
    self.assertEqual(sat.changed_files(base,None),['latest.py','new.py','old.py'])
 def test_guard_timeout_stops_real_grandchild(self):
  import signal
  with tempfile.TemporaryDirectory() as raw:
   root=Path(raw);pidfile=root/'pid';child=root/'child.py';guard=root/'guard.sh'
   child.write_text('import os,signal,time\nfrom pathlib import Path\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nPath('+repr(str(pidfile))+').write_text(str(os.getpid()))\ntime.sleep(30)\n')
   guard.write_text('"'+sys.executable+'" "'+str(child)+'" &\nwait\n')
   pid=None
   try:
    with patch.object(approval,'SUBPROCESS_TIMEOUT_SECONDS',.3),patch.object(approval,'guard_commands',return_value={'fixture':('bash',str(guard))}):
     with self.assertRaises(approval.BatchError):approval.run_guards(root)
    self.assertTrue(pidfile.exists(),'grandchild did not start')
    pid=int(pidfile.read_text())
    observed=subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True,timeout=5)
    self.assertTrue(observed.returncode!=0 or observed.stdout.strip().startswith('Z'),'timed-out guard left its grandchild running')
   finally:
    if pid is None and pidfile.exists():pid=int(pidfile.read_text())
    if pid is not None:
     try:os.kill(pid,signal.SIGKILL)
     except ProcessLookupError:pass


class Main338ScriptRegressionTest(unittest.TestCase):
 def test_guard_override_requires_explicit_test_mode(self):
  for raw in ['{}','{"x":["true"]}']:
   with self.subTest(raw=raw),patch.dict(os.environ,{'DEPLOY_APPROVAL_GUARDS':raw},clear=True):
    with self.assertRaises(approval.BatchError):approval.guard_commands()
 def test_guard_override_test_mode_rejects_empty_map(self):
  with patch.dict(os.environ,{'DEPLOY_APPROVAL_GUARDS':'{}','DEPLOY_APPROVAL_BATCH_TEST_MODE':'1'},clear=True):
   with self.assertRaises(approval.BatchError):approval.guard_commands()
  with patch.dict(os.environ,{'DEPLOY_APPROVAL_GUARDS':'{"x":["true"]}','DEPLOY_APPROVAL_BATCH_TEST_MODE':'1'},clear=True):
   self.assertEqual(approval.guard_commands(),{'x':('true',)})
 def test_git_invalid_utf8_remains_observed(self):
  with tempfile.TemporaryDirectory() as raw:
   root=Path(raw)
   def git(*args):return subprocess.run(['git','-c','commit.gpgsign=false',*args],cwd=root,capture_output=True,check=True)
   git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','fixture')
   (root/'f').write_text('plain\n');git('add','.');git('commit','-qm','base')
   (root/'f').write_bytes(b'nonutf \xff\n')
   value=detail._git(root,'diff','--no-ext-diff','HEAD')
   self.assertIsInstance(value,str);self.assertIn('\ufffd',value)
   state=detail.source_detail(root,'HEAD');self.assertTrue(state['dirty']);self.assertIn('dirty_digest',state)
 def test_nonfinite_and_bool_metrics_are_unmeasured(self):
  for invalid in [float('nan'),float('inf'),-float('inf'),True,False]:
   with self.subTest(value=str(invalid)):
    row={'kind':'deploy-stage','stage':'gate','status':'passed','run_id':'run','detail':{'timing':{'setup_seconds':invalid,'queue_seconds':invalid,'exec_seconds':invalid},'host':{'load1_peak':invalid,'mem_available_min_mb':invalid}}}
    result=diag.gate_diagnostics([row])[0]
    for key in ['median_setup_seconds','median_queue_seconds','median_exec_seconds','max_load1','min_mem_available_mb']:self.assertIsNone(result[key],key)
    with tempfile.TemporaryDirectory() as raw:
     path=Path(raw)/'attempts';path.write_text(json.dumps({'run_id':'run','task':'task','timestamp':'now','duration_seconds':invalid})+'\n')
     result=diag.benchmark_diagnostics(path)['runs'][0]
     self.assertIsNone(result['median_seconds']);self.assertIsNone(result['max_seconds'])
     json.dumps(result,allow_nan=False)
 def test_head_range_excludes_non_source_trees(self):
  with patch.object(sat.subprocess,'run',return_value=types.SimpleNamespace(stdout='codex/a.py\nopenclaw/b.py\ndocs/handoffs/c.md\nagents/x.py\n')):
   self.assertEqual(sat.changed_files('base','head'),['agents/x.py'])
 def test_explicit_empty_changes_do_not_query_git(self):
  selected=[]
  class Selector:
   def select(self,changed):
    selected.append(changed);return types.SimpleNamespace(all_lanes=False,reasons=[],selected={},totals={},full_lanes=set())
  with tempfile.TemporaryDirectory() as raw:
   path=Path(raw)/'empty';path.write_text('')
   with patch.object(sat,'Selector',Selector),patch.object(sat,'changed_files',side_effect=AssertionError('unexpected git selection')),contextlib.redirect_stdout(io.StringIO()):
    self.assertEqual(sat.main(['--changed-files-from',str(path),'--format','json']),0)
  self.assertEqual(selected,[[]])
 def test_structural_directory_roots_expand_to_files(self):
  files=['scripts/live_display/server.py','scripts/live_display/view.html','scripts/other.py']
  source=types.SimpleNamespace(files=files,fileset=set(files),dirs={'scripts','scripts/live_display'},exists=lambda name:name in files or name in {'scripts','scripts/live_display'})
  with patch.object(sat,'src',return_value=source),patch.object(sat,'_glob',return_value=[]),patch.object(sat,'_backend_structural',return_value=[]),patch.object(sat,'_structural_gates',return_value=[('display',('python3','-m','pytest','scripts/live_display'))]):
   lanes=sat.discover_lanes()
  self.assertEqual(lanes['deploy-structural-gates'].units[0].roots,files[:2])
  selector=sat.Selector.__new__(sat.Selector)
  selector.graph=sat.Graph(files);selector.rev={};selector.rev_data={}
  selector.lanes=lanes;selector.config={'run_all':[],'no_tests':[],'edges':[]};selector.coverage={}
  from collections import defaultdict
  selector.root_units=defaultdict(list)
  for lane in lanes.values():
   for unit in lane.units:
    for root in unit.roots:selector.root_units[root].append(unit)
  result=selector.select(['scripts/live_display/view.html'])
  self.assertIn('display',result.selected['deploy-structural-gates'])
  self.assertFalse(result.all_lanes,'directory root should be mapped, not require fallback')

 def test_claude_mixed_permission_exhaustion_blocks(self):
  claude=module('review_claude','scripts/claude_review_fallback_diagnose.py')
  for status,message in [(403,'permission denied'),(None,'access denied'),(429,'forbidden')]:
   self.assertEqual(claude.classify({'is_error':True,'api_error_status':status,'result':message,'errors':['usage limit reached']}),claude.PROVIDER_ERROR)
  self.assertEqual(claude.classify({'is_error':True,'api_error_status':429,'result':'usage limit reached'}),claude.USAGE_EXHAUSTED)
 def test_stage_finish_published_between_snapshot_and_dead_pid(self):
  waiter=module('review_waiter','scripts/deploy_stage_wait.py')
  row={'stage':'owned','started_epoch':20,'status':'passed'}
  for final,expected in [(row,waiter.EXIT_PASSED),({**row,'status':'failed'},waiter.EXIT_FAILED),(None,waiter.EXIT_DIED),({**row,'started_epoch':1},waiter.EXIT_DIED)]:
   with self.subTest(final=final),patch.object(waiter,'_rows',side_effect=[[],[final] if final else []]),patch.object(waiter,'_admissions',return_value={'owned':[123]}),patch.object(waiter,'_pid_alive',return_value=False):
    code,event=waiter.wait_for_stages(Path('/unused'),['owned'],since=10,timeout=1)
    self.assertEqual(code,expected)
 def test_factory_rca_labels_and_benchmark_task_shapes(self):
  for key in ['outcome_class','failure_class']:
   for bad in [['bad'],{'bad':1}]:
    row={'kind':'factory-event','workflow':'rca','event':'outcome','detail':{key:bad}}
    self.assertEqual(diag.rca_diagnostics([row])['outcome_classes'],[{'name':'unrecorded','count':1}])
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp)/'attempts';p.write_text('\n'.join(json.dumps({'run_id':'r','task':task}) for task in ['valid',['bad'],{'bad':1},None]))
   result=diag.benchmark_diagnostics(p)
   self.assertEqual(result['runs'][0]['tasks'],1)
   self.assertEqual(result['runs'][0]['attempts'],4)
 def test_replay_paths_are_nul_framed_and_excluded_inputs_filtered(self):
  import shutil
  history=module('review_history','scripts/test-map/replay_history.py')
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp)
   def git(*args):
    return subprocess.run(['git',*args],cwd=root,check=True,capture_output=True,text=True).stdout
   git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','fixture')
   product='agents/naïve\nname.py';test='agents/tests/test_naïve\nname.py'
   for name in [product,test]:
    p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('initial')
   git('add','.');git('commit','-qm','initial')
   for name in [product,test]:(root/name).write_text('fixed')
   git('commit','-qam','fix unicode newline boundary')
   with patch.object(history,'ROOT',root):
    rows=history.candidates('2000-01-01','HEAD',10)
   self.assertEqual(len(rows),1)
   self.assertEqual(set(rows[0][2]),{product,test})
   (root/product).rename(root/'agents/renamed.py');(root/test).write_text('fixed again');git('add','-A');git('commit','-qm','fix rename')
   with patch.object(history,'ROOT',root):rows=history.candidates('2000-01-01','HEAD',10)
   self.assertIn(product,rows[0][2]);self.assertIn('agents/renamed.py',rows[0][2])
   (root/'codex').mkdir();(root/'codex/a.py').write_text('excluded');(root/test).write_text('excluded edit');git('add','-A');git('commit','-qm','fix excluded only')
   with patch.object(history,'ROOT',root):rows=history.candidates('2000-01-01','HEAD',10)
   self.assertEqual(len(rows),2)
  seen=[]
  selector=types.SimpleNamespace(lanes={},select=lambda files:(seen.append(files) or types.SimpleNamespace(selected={},all_lanes=False,reasons=[],totals={})))
  with patch.object(history.sat,'Source',return_value=object()),patch.object(history.sat,'Selector',return_value=selector):
   history.replay(('a','fix',['agents/code.py','codex/excluded.py','agents/tests/test_code.py']))
  self.assertEqual(seen,[['agents/code.py']])
 def test_pipeline_blocked_lanes_share_sample_without_unbounded_receipts(self, end_tick=10):
  import signal
  from contextlib import ExitStack
  tick=[0];started=[];samples=[];high={'cpus':8,'mem_available_mb':10000};low={'cpus':8,'mem_available_mb':0}
  class Process:
   def __init__(self,*args,**kwargs):self.pid=100+len(started);self.returncode=None;started.append(self)
  def sample():samples.append(tick[0]);return high if tick[0]>=end_tick or not started else low
  def wait4(pid,flags):
   return (pid,0,types.SimpleNamespace(ru_maxrss=1024)) if tick[0]>=end_tick else (0,0,None)
  def sleep(delay):tick[0]+=1;self.assertLess(tick[0],end_tick+10)
  with tempfile.TemporaryDirectory() as tmp,ExitStack() as stack:
   root=Path(tmp);plan=root/'plan.json';plan.write_text(json.dumps({'lanes':[{'name':str(i),'command':['true'],'memory_mb':1} for i in range(4)]}))
   for obj,name,value in [(pipeline,'host_resources',lambda:high),(pipeline,'runtime_host_resources',sample),(pipeline,'memory_budget_mb',lambda host:host['mem_available_mb']),(pipeline,'source_digest',lambda:{}),(pipeline,'_stage_run_dir',lambda:str(root)),(pipeline,'watchdog_terminations',lambda *args:[]),(pipeline,'_now',lambda:str(tick[0])),(pipeline.signal,'signal',lambda *args:None),(pipeline.subprocess,'Popen',Process),(pipeline.os,'wait4',wait4),(pipeline.time,'monotonic',lambda:tick[0]*.2),(pipeline.time,'sleep',sleep)]:stack.enter_context(patch.object(obj,name,value))
   self.assertEqual(pipeline.run(plan,root/'state',max_parallel=4,budget_mb=10000),0)
   receipt=json.loads((root/'state/receipt.json').read_text())
  self.assertLessEqual(len(receipt['host_samples']),end_tick//5+8,'blocked lane samples grew per tick instead of bounded cadence')
  self.assertLessEqual(max(samples.count(i) for i in range(1,end_tick)),2,'each blocked lane resampled the same scheduling pass')
  self.assertEqual(len(started),4)
  low_ticks=[int(row['at']) for row in receipt['host_samples'] if row.get('mem_available_mb')==0]
  self.assertGreaterEqual(len(low_ticks),(end_tick-1)//5,'periodic known-low evidence lost')
  self.assertTrue(all(b-a<=6 for a,b in zip(low_ticks,low_ticks[1:])),low_ticks)
 def test_pipeline_prolonged_low_headroom_keeps_periodic_evidence(self):
  self.test_pipeline_blocked_lanes_share_sample_without_unbounded_receipts(end_tick=30)

 def test_replay_excluded_only_commit_not_candidate(self):
  history=module('review_history_excluded','scripts/test-map/replay_history.py')
  def git(*args):
   if args[0]=='log':return 'abc\x01fix excluded\n' if '--name-only' not in args else '\0abc\x01fix excluded\ncodex/a.py\nagents/tests/test_a.py\n'
   return 'codex/a.py\0agents/tests/test_a.py\0'
  with patch.object(history,'git',side_effect=git):self.assertEqual(history.candidates('2000','HEAD',1),[])
 def test_replay_excluded_input_never_reaches_selector(self):
  history=module('review_history_inputs','scripts/test-map/replay_history.py');seen=[]
  selector=types.SimpleNamespace(lanes={},select=lambda files:(seen.append(files) or types.SimpleNamespace(selected={},all_lanes=False,reasons=[],totals={})))
  with patch.object(history.sat,'Source',return_value=object()),patch.object(history.sat,'Selector',return_value=selector):
   history.replay(('a','fix',['agents/code.py','codex/excluded.py','agents/tests/test_code.py']))
  self.assertEqual(seen,[['agents/code.py']])
 def test_benchmark_malformed_task_names_not_counted_as_tasks(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp)/'attempts';p.write_text('\n'.join(json.dumps({'run_id':'r','task':task}) for task in ['valid',['bad'],{'bad':1},None]))
   result=diag.benchmark_diagnostics(p)
   self.assertEqual(result['runs'][0]['tasks'],1);self.assertEqual(result['runs'][0]['attempts'],4)

if __name__=='__main__':unittest.main()
