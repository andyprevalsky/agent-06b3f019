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
  self.assertEqual(run.call_args.args[0],['git','diff','--name-only','base...head'])
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
if __name__=='__main__':unittest.main()
