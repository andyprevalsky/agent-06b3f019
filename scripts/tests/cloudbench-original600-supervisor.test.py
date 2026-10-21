#!/usr/bin/env python3
"""Original600 threshold accounting and explicit early-stop policy; no provider."""
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
   command=['operator',str(epoch),'bash','scripts/run-bench','--concurrency','600','-k','3','--retry-infra','1','--timeout','1200','--e2e-timeout','5400','--e2e-started-at',str(epoch),'--ref','1387ae608e7cfb8e3f0a876daae92093f503b465','--strict-barrier',*tasks]
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
 def test_explicit_disabled_policy_runs_past_threshold_without_changing_counts(self):
     for policy in ("disabled", "enabled"):
         with self.subTest(policy=policy), tempfile.TemporaryDirectory() as name:
             repo = Path(name)
             (repo / "agents").mkdir()
             tasks_path = Path(__file__).parent / "fixtures/original600-tasks.json"
             tasks = json.loads(tasks_path.read_bytes())
             epoch = time.time()
             ref = "a" * 40
             script = repo / "run-bench-campaign.py"
             script.write_text(
                 "import fcntl,signal,sys,time\nfrom pathlib import Path\np=Path(sys.argv[1]);f=(p/'startup-cohorts/parent.lock').open('w');fcntl.flock(f,fcntl.LOCK_EX)\ndef done(*a):\n (p/'ending').write_text('term');sys.exit(7)\nsignal.signal(signal.SIGTERM,done);(p/'ready').write_text('ready');time.sleep(.6);(p/'ending').write_text('natural')\n"
             )
             original_popen = subprocess.Popen
             children = []
             campaigns = []

             def spawn(*unused, **kwargs):
                 cid = kwargs["env"]["RUN_BENCH_CAMPAIGN_ID"]
                 campaign = repo / ".context/benchmarks/campaigns" / cid
                 (campaign / "startup-cohorts/c001").mkdir(parents=True)
                 value = summary(30)
                 value.update(campaign_id=cid, e2e_started_at_epoch=epoch)
                 for job, task in zip(value["jobs"], [t for t in tasks for unused in (1, 2, 3)]):
                     job["task"] = task
                 (campaign / "summary.json").write_text(json.dumps(value))
                 (campaign / "startup-cohorts/c001/manifest.json").write_text(
                     json.dumps(
                         dict(
                             cohort_id="c001",
                             jobs={j["job_id"]: None for j in value["jobs"]},
                             e2e_deadline_monotonic=time.monotonic() + 5400,
                         )
                     )
                 )
                 child = original_popen([sys.executable, str(script), str(campaign)], cwd=repo / "agents")
                 children.append(child)
                 campaigns.append(campaign)
                 end = time.monotonic() + 5
                 while not (campaign / "ready").exists() and time.monotonic() < end:
                     time.sleep(0.01)
                 return child

             command = [
                 "operator",
                 str(epoch),
                 "bash",
                 "scripts/run-bench",
                 "--concurrency",
                 "600",
                 "-k",
                 "3",
                 "--retry-infra",
                 "1",
                 "--timeout",
                 "1200",
                 "--e2e-timeout",
                 "5400",
                 "--e2e-started-at",
                 str(epoch),
                 "--ref",
                 "1387ae608e7cfb8e3f0a876daae92093f503b465",
                 "--strict-barrier",
                 *tasks,
             ]
             env = dict(
                 REVIEWED_OPERATOR_ROOT=str(repo),
                 REVIEWED_OPERATOR_SOURCE_REF=ref,
                 REVIEWED_OPERATOR_TASKS=str(tasks_path),
                 REVIEWED_OPERATOR_TASKS_SHA256=__import__("hashlib").sha256(tasks_path.read_bytes()).hexdigest(),
                 CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP=policy,
             )
             handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
             try:
                 with (
                     patch.dict(os.environ, env),
                     patch.object(sys, "argv", command),
                     patch.object(subprocess, "Popen", side_effect=spawn),
                     patch.object(subprocess, "check_output", return_value=ref + "\n"),
                 ):
                     result = S["main"]()
                 self.assertEqual(result, 0 if policy == "disabled" else 7)
                 self.assertEqual(
                     (campaigns[0] / "ending").read_text(), "natural" if policy == "disabled" else "term"
                 )
                 destination = next((repo / ".context/stress200-host").iterdir())
                 self.assertEqual(
                     json.loads((destination / "infra-threshold-observed.private.json").read_bytes())["infra_true"],
                     30,
                 )
                 self.assertEqual(
                     (destination / "infra-threshold-parent-term.safe.json").exists(), policy == "enabled"
                 )
                 self.assertEqual(
                     json.loads((destination / "infra-early-stop-policy.safe.json").read_bytes())[
                         "infra_early_stop"
                     ],
                     policy,
                 )
             finally:
                 for child in children:
                     if child.poll() is None:
                         child.terminate()
                         child.wait(timeout=5)
                 for sig, handler in handlers.items():
                     signal.signal(sig, handler)

 def test_disabled_policy_does_not_stop_from_a_saved_trigger(self):
     result = S["fold"](summary(30))
     self.assertTrue(S["should_stop"](result, True))
     self.assertFalse(S["should_stop"](result, True, "disabled"))
     for invalid in ("", "false", False, None):
         with self.assertRaises(ValueError):
             S["should_stop"](result, False, invalid)

 def test_term_during_popen_is_forwarded_after_birth(self):
  with tempfile.TemporaryDirectory()as d:
   root=Path(d);done=root/'cleaned';ready=root/'ready';children=[];original_popen=subprocess.Popen
   child_code="import signal,time,sys;from pathlib import Path;signal.signal(signal.SIGTERM,lambda *a:(Path(sys.argv[1]).write_text('joined'),sys.exit(7)));Path(sys.argv[2]).write_text('ready');time.sleep(60)"
   def spawn(*unused,**kwargs):
    child=original_popen([sys.executable,'-c',child_code,str(done),str(ready)]);children.append(child)
    end=time.monotonic()+5
    while not ready.exists()and time.monotonic()<end:time.sleep(.01)
    self.assertTrue(callable(signal.getsignal(signal.SIGTERM)),'TERM handler not armed before Popen')
    os.kill(os.getpid(),signal.SIGTERM)
    return child
   try:
    with patch.object(subprocess,'Popen',side_effect=spawn):
     with S['owned_parent'](['unused'],root,{},root,'a'*40,1)as(parent,identity):
      self.assertEqual(parent.wait(timeout=5),7)
    self.assertTrue(done.exists());self.assertTrue(json.loads((root/'supervisor-parent-joined.safe.json').read_text())['parent_joined'])
   finally:
    for child in children:
     if child.poll()is None:child.terminate();child.wait(timeout=5)
def shard_fixture(manifest,**changes):
 import hashlib
 names=[manifest[1],manifest[50],manifest[199]]
 value=dict(index=2,count=20,tasks=names,tasks_sha256=hashlib.sha256(('\n'.join(names)+'\n').encode()).hexdigest(),task_indexes=[1,50,199],runs=3,group_run_id='campaign-group-fixture',group_total=600,group_started_at=1792287011.18)
 value.update(changes);return value
def shard_summary(shard,infra=0):
 # The same r{run}-j{global index} IDs a single 200-task controller assigns.
 jobs=[]
 for run in range(1,shard['runs']+1):
  for position,task in zip(shard['task_indexes'],shard['tasks']):
   jobs.append(dict(job_id=f"r{run:03d}-j{(run-1)*(shard['group_total']//shard['runs'])+position+1:04d}",task=task,run=run,attempts=[dict(attempt=1,status='failed',finished_at=1,infra_failure=True)] if len(jobs)<infra else []))
 return dict(campaign_id='campaign',e2e_started_at_epoch=1,total_jobs=len(jobs),concurrency=len(jobs),group_total=shard['group_total'],jobs=jobs)
class Shard(unittest.TestCase):
 def setUp(self):self.tasks=json.loads((Path(__file__).parent/'fixtures/original600-tasks.json').read_bytes())
 def test_shard_parameterized_membership_and_threshold(self):
  shard=shard_fixture(self.tasks);self.assertEqual(S['validate_shard'](shard,self.tasks),9)
  v=shard_summary(shard,1);manifest=dict(cohort_id='c001',jobs={j['job_id']:None for j in v['jobs']},e2e_deadline_monotonic=5401)
  result=S['validate_snapshot'](v,manifest,1,'campaign',5401,self.tasks,shard);self.assertEqual((result['infra_true'],result['trigger']),(1,False))
  self.assertTrue(S['validate_snapshot'](shard_summary(shard,9),dict(manifest),1,'campaign',5401,self.tasks,shard)['trigger']is False,'default threshold stays 30')
  low=shard_fixture(self.tasks,infra_threshold=2)
  self.assertFalse(S['validate_snapshot'](v,manifest,1,'campaign',5401,self.tasks,low)['trigger']);self.assertTrue(S['validate_snapshot'](shard_summary(low,2),manifest,1,'campaign',5401,self.tasks,low)['trigger'])
  self.assertTrue(S['fold'](summary(30))['trigger']);self.assertFalse(S['fold'](summary(30),31)['trigger'])
  with self.assertRaises(ValueError):S['fold'](summary(1),0)
  with self.assertRaisesRegex(ValueError,'600 membership'):S['validate_snapshot'](v,manifest,1,'campaign',5401,self.tasks)
  legacy=summary(1);legacy_manifest=dict(cohort_id='c001',jobs={j['job_id']:None for j in legacy['jobs']},e2e_deadline_monotonic=5401)
  with self.assertRaisesRegex(ValueError,'9 membership'):S['validate_snapshot'](legacy,legacy_manifest,1,'campaign',5401,self.tasks,shard)
  self.assertEqual([j['job_id'] for j in v['jobs']][:4],['r001-j0002','r001-j0051','r001-j0200','r002-j0202'])
  # A narrower group (T = group_total/runs = 100) shares one ID space across its shards.
  narrow=shard_fixture(self.tasks,tasks=[self.tasks[1],self.tasks[50],self.tasks[99]],task_indexes=[1,50,99],group_total=300)
  narrow['tasks_sha256']=__import__('hashlib').sha256(('\n'.join(narrow['tasks'])+'\n').encode()).hexdigest();n=shard_summary(narrow)
  self.assertEqual(sorted(j['job_id'] for j in n['jobs'] if j['run']==2),['r002-j0102','r002-j0151','r002-j0200'])
  self.assertFalse(S['validate_snapshot'](n,dict(manifest,jobs={j['job_id']:None for j in n['jobs']}),1,'campaign',5401,self.tasks,narrow)['trigger'])
  with self.assertRaisesRegex(ValueError,'group width'):S['validate_shard'](dict(shard,group_total=300),self.tasks)
  ungrouped=copy.deepcopy(v);del ungrouped['group_total']
  with self.assertRaisesRegex(ValueError,'group total changed'):S['validate_snapshot'](ungrouped,manifest,1,'campaign',5401,self.tasks,shard)
  for mutate in (lambda x:x['jobs'][0].update(job_id='r001-j0001'),lambda x:x['jobs'][0].update(job_id='r002-j0002'),lambda x:x['jobs'][0].update(job_id='s02-r001-j0002'),
                 lambda x:x['jobs'][0].update(task=self.tasks[0]),lambda x:x['jobs'][0].update(run=2)):
   bad=copy.deepcopy(v);mutate(bad);bad_manifest=dict(manifest,jobs={j['job_id']:None for j in bad['jobs']})
   with self.subTest(job=bad['jobs'][0]),self.assertRaises(ValueError):S['validate_snapshot'](bad,bad_manifest,1,'campaign',5401,self.tasks,shard)
  swapped=[self.tasks[50],self.tasks[1],self.tasks[199]];import hashlib
  for bad in (dict(tasks=swapped,tasks_sha256=hashlib.sha256(('\n'.join(swapped)+'\n').encode()).hexdigest(),task_indexes=[50,1,199]),dict(task_indexes=[1,51,199]),dict(task_indexes=[1,50]),
              dict(task_indexes=[1,50,200]),dict(task_indexes=[1,50,True]),dict(tasks_sha256='0'*64),dict(job_prefix='s02-'),dict(runs=0),dict(index=20),dict(group_total=8),dict(group_total=598),dict(extra=True)):
   with self.subTest(bad=bad),self.assertRaises(ValueError):S['validate_shard'](shard_fixture(self.tasks,**bad),self.tasks)
 def run_main(self,repo,shard,environment,infra=0,ending=None,tasks_path=None,timeouts=None):
  import hashlib
  tasks_path=tasks_path or Path(__file__).parent/'fixtures/original600-tasks.json';epoch=time.time();ref='a'*40;context=repo/'.context';context.mkdir(exist_ok=True)
  identity=context/'original600-supervisor.fixture.json';identity.write_text(json.dumps(dict(schema='original600-supervisor-identity-v1',pid=os.getpid(),birth=S['birth'](os.getpid()),machine='1234567890abcd',source_ref=ref,epoch=epoch)));shard_path=identity.with_suffix('.shard.json');shard_path.write_text(json.dumps(shard,sort_keys=True)+'\n')
  script=repo/'run-bench-campaign.py'
  script.write_text("import fcntl,signal,sys,time\nfrom pathlib import Path\np=Path(sys.argv[1]);f=(p/'startup-cohorts/parent.lock').open('w');fcntl.flock(f,fcntl.LOCK_EX)\ndef done(*a):\n (p/'ending').write_text('term');sys.exit(7)\nsignal.signal(signal.SIGTERM,done);(p/'ready').write_text('ready');time.sleep(.6);(p/'ending').write_text('natural')\n")
  original_popen=subprocess.Popen;children=[];campaigns=[]
  def spawn(*unused,**kwargs):
   self.assertEqual(float(kwargs['env']['RUN_BENCH_CAMPAIGN_STARTUP_DEADLINE_EPOCH']), epoch+shard.get('e2e_timeout',5400)-shard.get('task_timeout',1200)-1200)
   cid=kwargs['env']['RUN_BENCH_CAMPAIGN_ID'];campaign=repo/'.context/benchmarks/campaigns'/cid;(campaign/'startup-cohorts/c001').mkdir(parents=True)
   value=shard_summary(shard,infra);value.update(campaign_id=cid,e2e_started_at_epoch=epoch)
   (campaign/'summary.json').write_text(json.dumps(value));(campaign/'startup-cohorts/c001/manifest.json').write_text(json.dumps(dict(cohort_id='c001',jobs={j['job_id']:None for j in value['jobs']},e2e_deadline_monotonic=time.monotonic()+5400)))
   child=original_popen([sys.executable,str(script),str(campaign)],cwd=repo/'agents');children.append(child);campaigns.append(campaign)
   end=time.monotonic()+5
   while not(campaign/'ready').exists()and time.monotonic()<end:time.sleep(.01)
   return child
  jobs=str(len(shard['tasks'])*shard['runs'])
  task_timeout,e2e_timeout=timeouts or (str(shard.get('task_timeout',1200)),str(shard.get('e2e_timeout',5400)))
  command=['operator',str(epoch),'bash','scripts/run-bench','--strict-barrier','--concurrency',jobs,'-k',str(shard['runs']),'--retry-infra','1','--timeout',task_timeout,'--e2e-timeout',e2e_timeout,'--e2e-started-at',str(epoch),'--ref','1387ae608e7cfb8e3f0a876daae92093f503b465',*shard['tasks']]
  env=dict(REVIEWED_OPERATOR_ROOT=str(repo),REVIEWED_OPERATOR_SOURCE_REF=ref,REVIEWED_OPERATOR_TASKS=str(tasks_path),REVIEWED_OPERATOR_TASKS_SHA256=hashlib.sha256(tasks_path.read_bytes()).hexdigest(),
           REVIEWED_OPERATOR_IDENTITY_PATH=str(identity),REVIEWED_OPERATOR_SHARD=str(shard_path),REVIEWED_OPERATOR_SHARD_SHA256=hashlib.sha256(shard_path.read_bytes()).hexdigest(),
           RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER=str(identity.with_suffix('.barrier')),RUN_BENCH_CAMPAIGN_TASK_INDEXES=','.join(map(str,shard['task_indexes'])),RUN_BENCH_CAMPAIGN_GROUP_TOTAL=str(shard['group_total']),
           RUN_BENCH_CAMPAIGN_GROUP_STARTED_AT=str(shard['group_started_at']),BENCHMARK_HUB_GROUP_RUN_ID=shard['group_run_id'],CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION='1')
  env.update(environment);handlers={sig:signal.getsignal(sig)for sig in(signal.SIGTERM,signal.SIGINT)}
  try:
   with patch.dict(os.environ,env),patch.object(sys,'argv',command),patch.object(subprocess,'Popen',side_effect=spawn),patch.object(subprocess,'check_output',return_value=ref+'\n'):
    result=S['main']()
   return result,campaigns,children,identity
  finally:
   for child in children:
    if child.poll()is None:child.terminate();child.wait(timeout=5)
   for sig,handler in handlers.items():signal.signal(sig,handler)
 def test_main_binds_shard_inputs_and_publishes_infra_json(self):
  for threshold,infra,expected_code,ending in ((None,1,0,'natural'),(2,2,7,'term')):
   with self.subTest(threshold=threshold),tempfile.TemporaryDirectory()as name:
    repo=Path(name);(repo/'agents').mkdir();shard=shard_fixture(self.tasks,**({}if threshold is None else dict(infra_threshold=threshold)))
    result,campaigns,children,identity=self.run_main(repo,shard,{},infra)
    self.assertEqual(result,expected_code);self.assertEqual((campaigns[0]/'ending').read_text(),ending)
    raw=identity.with_suffix('.infra.json').read_bytes();status=json.loads(raw);self.assertEqual({k:status[k] for k in ('schema','infra_true','unique_jobs')},dict(schema='original600-shard-infra-v1',infra_true=infra,unique_jobs=9))
    progress=status['progress'];self.assertEqual((progress['jobs'],sum(c[3] for c in progress['combos'])),(9,9),'live scorecard counters cover every logical job')
    self.assertLess(len(raw),16384,'the runner PROBE reads at most 16 KiB')
    self.assertEqual(identity.with_suffix('.infra.json').stat().st_mode&0o777,0o600);self.assertEqual(sorted(x.name for x in identity.parent.iterdir() if x.name.startswith('.original600')),[])
 def test_shard_supervisor_enforces_the_group_threshold_without_a_host(self):
  # 2026-10-20: a host restart killed the operator and both shard runners after
  # release; the guest supervisors kept running a 60-job group with their own
  # threshold left at 30 (= every job of a 30-job shard), so no stop survived.
  import hashlib
  names=[self.tasks[i] for i in range(0,20,2)]
  shard=shard_fixture(self.tasks,index=0,count=2,tasks=names,tasks_sha256=hashlib.sha256(('\n'.join(names)+'\n').encode()).hexdigest(),
                      task_indexes=list(range(0,20,2)),group_total=60)
  self.assertEqual(S['validate_shard'](shard,self.tasks),30)
  for infra,expected_code,ending in ((2,0,'natural'),(3,7,'term')):
   with self.subTest(infra=infra),tempfile.TemporaryDirectory()as name:
    repo=Path(name);(repo/'agents').mkdir()
    result,campaigns,children,identity=self.run_main(repo,shard,{},infra)
    self.assertEqual((result,(campaigns[0]/'ending').read_text()),(expected_code,ending),'3/60 of the group stops this shard; 2/60 continues')
  for total,threshold in ((60,3),(61,4),(70,4),(600,30)):
   with self.subTest(total=total):
    self.assertEqual(S['group_infra_threshold'](dict(group_total=total)),threshold)
    self.assertTrue(20*threshold>=total>20*(threshold-1),'the fixed 5% predicate of the original scheduled group total')
  self.assertEqual(S['group_infra_threshold'](dict(group_total=60,infra_threshold=2)),2,'an explicit bound threshold is kept')
 def test_progress_counters_are_bounded_and_read_each_terminal_card_once(self):
  with tempfile.TemporaryDirectory()as name:
   fleet=Path(name)/'fleet';(fleet/'_batch').mkdir(parents=True)
   (fleet/'_batch/report-card.json').write_text(json.dumps(dict(per_task=[dict(name='t0',failure_reason='Timeout after 480s (backstop=480s) | Agent status: PAUSED 0b6f7c6e-1111-2222-3333-444455556666')])))
   jobs=[dict(job_id=f'r001-j{i:04d}',task=f't{i}',status=s,task_status=v,infra_failure=f,attempts=[dict(attempt=1,status=s,finished_at='x',infra_failure=f)] if s in ('passed','failed') else [])
         for i,(s,v,f) in enumerate([('failed','FAILED',False),('passed','PASSED',False),('running',None,None),('queued',None,None),('failed','INFRA_ERROR',True)])]
   jobs[0]['fleet_dir']=str(fleet)
   jobs+= [dict(job_id=f'r002-j{i:04d}',task='x',status='failed',task_status=f'S{i}',infra_failure=None,attempts=[]) for i in range(80)]
   cache={};reads=[]
   real=Path.read_bytes
   def counted(path):reads.append(path.name);return real(path)
   with patch.object(Path,'read_bytes',counted):
    first=S['progress_counters'](dict(jobs=jobs),cache);second=S['progress_counters'](dict(jobs=jobs),cache)
   self.assertEqual(first,second);self.assertEqual(reads.count('report-card.json'),1,'a terminal card is read once')
   self.assertEqual(first['reasons'],[['AGENT FAIL','Timeout after 480s (backstop=480s)',1]])
   self.assertEqual((first['terminal_attempts'],first['infra_attempts'],first['jobs']),(3,1,85))
   self.assertEqual(len(first['combos']),S['PROGRESS_COMBOS']);self.assertLess(len(json.dumps(first)),16384)
 def test_shard_controls_and_inputs_refused_before_campaign_spawn(self):
  for environment in (dict(RUN_BENCH_CAMPAIGN_TASK_INDEXES='1,50'),dict(BENCHMARK_HUB_GROUP_RUN_ID='other'),dict(RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER='/tmp/elsewhere'),
                      dict(CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION='0'),dict(REVIEWED_OPERATOR_SHARD_SHA256='0'*64)):
   with self.subTest(environment=environment),tempfile.TemporaryDirectory()as name:
    repo=Path(name);(repo/'agents').mkdir()
    with self.assertRaises(ValueError):self.run_main(repo,shard_fixture(self.tasks),environment)
    self.assertFalse((repo/'.context/benchmarks').exists())
class BoundManifest(unittest.TestCase):
 """A fresh sharded run of any ordered manifest: the shard binds its hash and timeouts."""
 def setUp(self):
  import hashlib
  self.tasks=['polar-fixture-%02d'%i for i in range(70)];self.sha=hashlib.sha256(('\n'.join(self.tasks)+'\n').encode()).hexdigest()
 def shard(self,**changes):
  import hashlib
  names=self.tasks[0::3]
  value=dict(index=0,count=3,tasks=names,tasks_sha256=hashlib.sha256(('\n'.join(names)+'\n').encode()).hexdigest(),task_indexes=list(range(0,70,3)),runs=1,
             group_run_id='original600-fixture',group_total=70,group_started_at=1792287011.18,manifest_sha256=self.sha,task_timeout=480)
  value.update(changes);return value
 def test_shard_validates_against_its_bound_manifest_and_timeouts(self):
  self.assertEqual(S['validate_shard'](self.shard(),self.tasks),24);self.assertEqual(S['shard_timeouts'](self.shard()),(480,5400));self.assertEqual(S['shard_timeouts'](self.shard(task_timeout=7200,e2e_timeout=10020)),(7200,10020))
  original=json.loads((Path(__file__).parent/'fixtures/original600-tasks.json').read_bytes())
  self.assertEqual(S['validate_shard'](shard_fixture(original),original),9);self.assertEqual(S['shard_timeouts'](shard_fixture(original)),(1200,5400))
  unbound={k:v for k,v in self.shard().items() if k!='manifest_sha256'}
  for manifest,value,message in [(self.tasks,unbound,'original 200 tasks required'),(list(reversed(self.tasks)),self.shard(),'bound ordered tasks changed'),
                                 (self.tasks+[self.tasks[0]],self.shard(),'distinct ordered tasks'),(original,self.shard(manifest_sha256=S['ORIGINAL_TASK_NAMES_SHA256']),'invalid bound manifest hash'),
                                 (self.tasks,self.shard(task_timeout=1200),'encoded by absence'),(self.tasks,self.shard(task_timeout=30),'task timeout'),
                                 (self.tasks,self.shard(e2e_timeout=1680),'e2e timeout'),(self.tasks,self.shard(e2e_timeout=10021),'e2e timeout'),(self.tasks,self.shard(task_timeout=7200,e2e_timeout=8400),'e2e timeout'),(self.tasks,self.shard(e2e_timeout=1680),'e2e timeout'),(self.tasks,self.shard(task_timeout=7201,e2e_timeout=9300),'task timeout'),(self.tasks,self.shard(group_total=71),'group total')]:
   with self.subTest(message=message),self.assertRaisesRegex(ValueError,message):S['validate_shard'](value,manifest)
 def test_main_runs_the_bound_manifest_with_its_timeouts_and_refuses_original_options(self):
  with tempfile.TemporaryDirectory()as name:
   repo=Path(name);(repo/'agents').mkdir();tasks_path=repo/'polar-tasks.json';tasks_path.write_text(json.dumps(self.tasks,sort_keys=True)+'\n')
   result,campaigns,children,identity=Shard.run_main(self,repo,self.shard(),{},tasks_path=tasks_path)
   self.assertEqual(result,0);self.assertEqual((campaigns[0]/'ending').read_text(),'natural')
   policy=json.loads(next((repo/'.context/stress200-host').glob('*/infra-early-stop-policy.safe.json')).read_bytes())
   self.assertEqual((policy['task_timeout_seconds'],policy['run_timeout_seconds']),(480,5400))
  for timeouts in (('1200','5400'),('480','3000')):
   with self.subTest(timeouts=timeouts),tempfile.TemporaryDirectory()as name:
    repo=Path(name);(repo/'agents').mkdir();tasks_path=repo/'polar-tasks.json';tasks_path.write_text(json.dumps(self.tasks,sort_keys=True)+'\n')
    with self.assertRaisesRegex(ValueError,'original rollout option changed: --(e2e-)?timeout'):Shard.run_main(self,repo,self.shard(),{},tasks_path=tasks_path,timeouts=timeouts)
    self.assertFalse((repo/'.context/benchmarks').exists())
  with tempfile.TemporaryDirectory()as name:
   repo=Path(name);(repo/'agents').mkdir();tasks_path=repo/'polar-tasks.json';tasks_path.write_text(json.dumps(self.tasks[:69])+'\n')
   with self.assertRaisesRegex(ValueError,'bound ordered tasks changed'):Shard.run_main(self,repo,self.shard(),{},tasks_path=tasks_path)
   self.assertFalse((repo/'.context/benchmarks').exists())
class RunnerSelfTest(unittest.TestCase):
 def test_runner_built_in_self_test_runs_in_this_registered_suite(self):
  # The runner's shard argv/env, RELEASE/ABORT and delivery controls live in its
  # built-in self-test; this registered suite executes it unchanged.
  result=subprocess.run([sys.executable,str(ROOT/'cloudbench-original600-runner.py'),'--self-test'],capture_output=True,text=True,timeout=120)
  self.assertEqual(result.returncode,0,result.stderr[-4000:]);self.assertRegex(result.stderr,r'Ran [0-9]+ tests')
if __name__=='__main__':unittest.main()
