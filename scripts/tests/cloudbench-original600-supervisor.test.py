#!/usr/bin/env python3
"""Fixed 30/600 operator threshold; no provider access."""
import copy, json, os, runpy, signal, subprocess, sys, tempfile, time, unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
S=runpy.run_path(os.environ.get('CLOUDBENCH_TEST_OLD_INFRA30_SOURCE',str(ROOT/'cloudbench-original600-supervisor.py')))
def summary(n=0):
 jobs=[]
 for i in range(200):
  for r in (1,2,3):
   number=len(jobs)
   jobs.append(dict(job_id=f'j{number}',task=f't{i}',run=r,attempts=[dict(attempt=1,status='failed',finished_at=1,infra_failure=True)] if number<n else []))
 return dict(campaign_id='campaign',e2e_started_at_epoch=1,total_jobs=600,concurrency=600,jobs=jobs)
class Threshold(unittest.TestCase):
 def test_one_of_600_continues(self):
  r=S['fold'](summary(1));self.assertFalse(r['trigger']);self.assertEqual(r['records'][0]['task'],'t0')
 def test_29_of_600_continues(self):self.assertFalse(S['fold'](summary(29))['trigger'])
 def test_30_of_600_stops(self):self.assertTrue(S['fold'](summary(30))['trigger'])
 def test_retry_same_job_counts_once(self):
  v=summary(29);v['jobs'][0]['attempts'].append(dict(attempt=2,status='failed',finished_at=2,infra_failure=True))
  result=S['fold'](v);self.assertEqual(result['infra_true'],29);self.assertFalse(result['trigger'])
 def test_unknown_agent_cancel_separate(self):
  v=summary(29)
  for index,flag,status in [(29,None,'failed'),(30,False,'failed'),(31,True,'cancelled')]:v['jobs'][index]['attempts']=[dict(attempt=1,status=status,finished_at=1,infra_failure=flag)]
  r=S['fold'](v);self.assertFalse(r['trigger']);self.assertEqual((r['infra_unknown'],r['agent_failed_unique'],r['cancelled_unique']),(1,1,1))
 def test_duplicate_physical_attempt_refuses(self):
  v=summary(1);v['jobs'][0]['attempts']*=2
  with self.assertRaises(ValueError):S['fold'](v)
 def test_original_membership_and_clock(self):
  v=summary(1);manifest=dict(cohort_id='c001',jobs={j['job_id']:None for j in v['jobs']},e2e_deadline_monotonic=5401)
  tasks=[f't{i}'for i in range(200)]
  self.assertFalse(S['validate_snapshot'](v,manifest,1,'campaign',5401,tasks)['trigger'])
  v['jobs'][0]['task']='foreign'
  with self.assertRaises(ValueError):S['validate_snapshot'](v,manifest,1,'campaign',5401,tasks)
 def test_real_exact_parent_term_and_join(self):
  with tempfile.TemporaryDirectory()as d:
   repo=Path(d);(repo/'agents').mkdir();campaign=repo/'campaign';(campaign/'startup-cohorts').mkdir(parents=True)
   script=repo/'run-bench-campaign.py';script.write_text('''import fcntl,signal,sys,time
from pathlib import Path
p=Path(sys.argv[1]);f=(p/'startup-cohorts/parent.lock').open('w');fcntl.flock(f,fcntl.LOCK_EX)
def done(*args):
 (p/'cleaned').write_text('joined');sys.exit(7)
signal.signal(signal.SIGTERM,done);(p/'ready').write_text('ready')
while True:time.sleep(.01)
''')
   parent=subprocess.Popen([sys.executable,str(script),str(campaign)],cwd=repo/'agents')
   try:
    end=time.monotonic()+5
    while not(campaign/'ready').exists()and time.monotonic()<end:time.sleep(.01)
    self.assertTrue((campaign/'ready').exists());birth=S['birth'](parent.pid)
    with patch.object(S['fence'].__globals__['subprocess'],'check_output',return_value='a'*40+'\n'):
     with self.assertRaises(ValueError):S['fence'](repo,parent,'wrong-birth','a'*40,campaign)
     self.assertIsNone(parent.poll());S['fence'](repo,parent,birth,'a'*40,campaign)
     parent.send_signal(signal.SIGTERM)
    self.assertEqual(parent.wait(timeout=5),7);self.assertEqual((campaign/'cleaned').read_text(),'joined')
   finally:
    if parent.poll()is None:parent.terminate();parent.wait(timeout=5)
 def test_main_post_spawn_save_failure_terms_and_joins_parent(self):
  with tempfile.TemporaryDirectory()as d:
   repo=Path(d);(repo/'agents').mkdir();tasks_path=Path(__file__).parent/'fixtures/original600-tasks.json';tasks=json.loads(tasks_path.read_bytes());epoch=time.time();ref='a'*40
   script=repo/'run-bench-campaign.py';script.write_text("import fcntl,signal,sys,time\nfrom pathlib import Path\np=Path(sys.argv[1]);f=(p/'startup-cohorts/parent.lock').open('w');fcntl.flock(f,fcntl.LOCK_EX)\ndef done(*a):\n (p/'cleaned').write_text('done');sys.exit(7)\nsignal.signal(signal.SIGTERM,done);(p/'ready').write_text('ready')\nwhile True:time.sleep(.01)\n")
   original_popen=subprocess.Popen;children=[];campaigns=[]
   def spawn(*unused,**kwargs):
    cid=kwargs['env']['RUN_BENCH_CAMPAIGN_ID'];c=repo/'.context/benchmarks/campaigns'/cid;(c/'startup-cohorts/c001').mkdir(parents=True)
    v=summary();v['campaign_id']=cid;v['e2e_started_at_epoch']=epoch
    for j,t in zip(v['jobs'],[t for t in tasks for unused in (1,2,3)]):j['task']=t
    (c/'summary.json').write_text(json.dumps(v));(c/'startup-cohorts/c001/manifest.json').write_text(json.dumps(dict(cohort_id='c001',jobs={j['job_id']:None for j in v['jobs']},e2e_deadline_monotonic=time.monotonic()+5400)))
    child=original_popen([sys.executable,str(script),str(c)],cwd=repo/'agents');children.append(child);campaigns.append(c)
    end=time.monotonic()+5
    while not(c/'ready').exists()and time.monotonic()<end:time.sleep(.01)
    return child
   real_save=S['save_once']
   def fail_save(path,raw):
    if path.name=='threshold-original-parent.private.json':raise OSError('injected post-spawn save failure')
    return real_save(path,raw)
   command=['operator',str(epoch),'bash','scripts/run-bench','--concurrency','600','-k','3','--retry-infra','1','--timeout','1200','--e2e-timeout','5400','--e2e-started-at',str(epoch),'--ref','570830dbf17635e13d16a6f03b4d705f6b6443b1','--strict-barrier',*tasks]
   env=dict(REVIEWED_OPERATOR_ROOT=str(repo),REVIEWED_OPERATOR_SOURCE_REF=ref,REVIEWED_OPERATOR_TASKS=str(tasks_path),REVIEWED_OPERATOR_TASKS_SHA256=__import__('hashlib').sha256(tasks_path.read_bytes()).hexdigest())
   handlers={s:signal.getsignal(s)for s in(signal.SIGTERM,signal.SIGINT)}
   try:
    with patch.dict(os.environ,env),patch.object(sys,'argv',command),patch.object(subprocess,'Popen',side_effect=spawn),patch.object(subprocess,'check_output',return_value=ref+'\n'),patch.dict(S['main'].__globals__,save_once=fail_save):
     with self.assertRaises(OSError):S['main']()
    self.assertEqual(len(children),1);self.assertIsNotNone(children[0].poll(),'supervisor orphaned its campaign parent');self.assertEqual(children[0].wait(timeout=5),7);self.assertTrue((campaigns[0]/'cleaned').exists())
   finally:
    for child in children:
     if child.poll()is None:child.terminate();child.wait(timeout=5)
    for sig,handler in handlers.items():signal.signal(sig,handler)
if __name__=='__main__':unittest.main()
