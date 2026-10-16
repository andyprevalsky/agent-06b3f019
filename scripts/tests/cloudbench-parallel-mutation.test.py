#!/usr/bin/env python3
"""Owning offline mutation admission; no provider calls."""
import fcntl,hashlib,json,os,runpy,shutil,subprocess,sys,tempfile,time,unittest,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
SOURCE=Path(os.environ.get('PARALLEL_MUTATION_SOURCE',ROOT/'scripts/cloudbench-campaign-mutation.py'))
CLOUD_SOURCE=Path(os.environ.get('PARALLEL_CLOUD_SOURCE',ROOT/'scripts/run-bench-cloud'))
def birth(pid):
 fields=Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()
 return 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+fields[19]
class Admission(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.feed=self.root/'feed';self.feed.mkdir(parents=True)
  self.owner=dict(app='fixture',pid=str(os.getpid()),pid_start=birth(os.getpid()),token='fixture',parent_pid=str(os.getpid()),parent_start=birth(os.getpid()))
  (self.feed/'owner').write_text(''.join(k+'='+v+'\n'for k,v in self.owner.items()))
  self.publish(self.feed)
  auth=dict(directory=str(self.feed),owner=self.owner,source=dict(ref='a'*40,sha256={name:hashlib.sha256((SOURCE.parent/name).read_bytes()).hexdigest()for name in ['cloudbench-campaign-mutation.py','cloudbench-script-snapshot.py']}))
  # Alternate source is copied beside its exact snapshot dependency for old-code controls.
  auth['source']['sha256']['cloudbench-campaign-mutation.py']=hashlib.sha256(SOURCE.read_bytes()).hexdigest()
  self.env=dict(os.environ,CLOUDBENCH_CAMPAIGN_INVENTORY_DIR=str(self.feed),CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY=json.dumps(auth));self.capacity=self.root/'capacity'
 def publish(self,feed,machines=None):
  (feed/'machines.json').write_text(json.dumps(machines or []));(feed/'volumes.json').write_text('[]')
  old=os.environ.get('CLOUDBENCH_INVENTORY_PUBLISHER_TOKEN');os.environ['CLOUDBENCH_INVENTORY_PUBLISHER_TOKEN']='fixture'
  try:runpy.run_path(str(ROOT/'scripts/cloudbench-machine-readiness.py'))['publish_index'](feed/'machines.json',feed/'volumes.json',feed/'inventory')
  finally:
   if old is None:os.environ.pop('CLOUDBENCH_INVENTORY_PUBLISHER_TOKEN',None)
   else:os.environ['CLOUDBENCH_INVENTORY_PUBLISHER_TOKEN']=old
 def command(self,action,*args):return [sys.executable,str(SOURCE),action,'--app','fixture','--root',str(self.capacity),'--owner-pid',str(os.getpid()),'--owner-start',birth(os.getpid()),*args]
 def call(self,action,*args):return subprocess.run(self.command(action,*args),env=self.env,text=True,capture_output=True,timeout=5)
 def require(self,result):self.assertEqual(result.returncode,0,result.stderr);return result.stdout.strip()
 def test_more_than_four_live_native_leases_are_admitted(self):
  tokens=[self.require(self.call('acquire','--slots','4','--wait-seconds','1'))for _ in range(6)]
  self.assertEqual(len(set(tokens)),6);self.assertEqual(len(list(self.capacity.rglob('lease-*.json'))),6)
 def test_healthy_create_has_no_one_second_spacing(self):
  start=time.monotonic()
  for _ in range(4):self.require(self.call('pace','--wait-seconds','2'))
  self.assertLess(time.monotonic()-start,2.5)
  self.assertFalse(list(self.capacity.rglob('provider-backoff.json')))
 def test_actual_rate_event_waits_then_admits_without_fixed_success_delay(self):
  self.require(self.call('backoff','--response-code','429','--retry-after','.3'))
  start=time.monotonic();self.require(self.call('acquire','--wait-seconds','2'));elapsed=time.monotonic()-start
  self.assertGreaterEqual(elapsed,.24);self.assertLess(elapsed,1.5)
  start=time.monotonic();self.require(self.call('acquire','--wait-seconds','2'));self.assertLess(time.monotonic()-start,.7)
 def test_shared_backoff_spends_original_wait_budget(self):
  self.require(self.call('backoff','--response-code','resource_exhausted','--retry-after','1.5'))
  start=time.monotonic();result=self.call('acquire','--wait-seconds','1');self.assertNotEqual(result.returncode,0);self.assertLess(time.monotonic()-start,1.4)
  self.assertFalse(list(self.capacity.rglob('lease-*.json')))
 def test_shared_backoff_cannot_extend_original_strict_campaign_deadline(self):
  consumer=self.root/'consumer';feed=consumer/'.context/campaigns/token/native';feed.mkdir(parents=True)
  (feed/'owner').write_bytes((self.feed/'owner').read_bytes());self.publish(feed)
  auth=json.loads(self.env['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY']);auth['directory']=str(feed);self.env['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY']=json.dumps(auth);self.env['CLOUDBENCH_CAMPAIGN_INVENTORY_DIR']=str(feed)
  barrier=feed.parent/'startup-cohorts/cohort';barrier.mkdir(parents=True);task=consumer/'fleet/runs/run/task';task.mkdir(parents=True)
  deadline=time.monotonic()+.5;(barrier/'manifest.json').write_text(json.dumps(dict(cohort_id='cohort',jobs={'r1-j1':os.getpid()},e2e_deadline_monotonic=deadline)))
  self.env.update(RUN_BENCH_CAMPAIGN_BARRIER_DIR=str(barrier),RUN_BENCH_CAMPAIGN_COHORT='cohort',RUN_BENCH_CAMPAIGN_JOB_ID='r1-j1',RUN_BENCH_CAMPAIGN_TASK='task',RUN_BENCH_CAMPAIGN_E2E_DEADLINE_MONOTONIC=str(deadline))
  with (barrier.parent/'parent.lock').open('w')as held:
   fcntl.flock(held,fcntl.LOCK_EX)
   self.require(self.call('backoff','--response-code','429','--retry-after','2'))
   start=time.monotonic();result=self.call('pace','--wait-seconds','4','--strict-primary','--task-root',str(task));self.assertNotEqual(result.returncode,0);self.assertLess(time.monotonic()-start,.8)
  self.assertFalse(list(self.capacity.rglob('lease-*.json')))
 def test_foreign_source_or_unclassified_response_cannot_grant(self):
  self.assertNotEqual(self.call('backoff','--response-code','500','--retry-after','1').returncode,0)
  auth=json.loads(self.env['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY']);auth['source']['sha256']['cloudbench-campaign-mutation.py']='0'*64;self.env['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY']=json.dumps(auth)
  self.assertNotEqual(self.call('acquire','--wait-seconds','1').returncode,0);self.assertFalse(list(self.capacity.rglob('lease-*.json')))
 def test_exact_native_join_is_required_before_release(self):
  token=self.require(self.call('acquire','--wait-seconds','1'))
  self.assertNotEqual(self.call('release','--lease',token).returncode,0)
  for action in ['start-native','join-native']:self.require(self.call(action,'--lease',token,'--native-owner-pid',str(os.getpid())))
  self.require(self.call('release','--lease',token));self.assertFalse(list(self.capacity.rglob('lease-*.json')))
 def test_dead_unjoined_owner_retains_original_lease(self):
  token=self.require(self.call('acquire','--wait-seconds','1'));path=self.capacity/'campaign-native-mutations'/('lease-'+token+'.json')
  child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'])
  try:
   value=json.loads(path.read_text());value.update(pid=child.pid,birth=birth(child.pid));path.write_text(json.dumps(value));child.terminate();child.wait(timeout=3)
   original=path.read_bytes();self.require(self.call('acquire','--wait-seconds','1'));self.assertEqual(path.read_bytes(),original);self.assertNotEqual(self.call('release','--lease',token).returncode,0)
  finally:
   if child.poll()is None:child.terminate();child.wait(timeout=3)
 def test_ten_thousand_unrelated_leases_and_validated_inventory_are_not_scanned(self):
  self.publish(self.feed,[dict(id=format(i,'014x'),state='stopped',name='fixture-'+str(i),config={})for i in range(10000)])
  directory=self.capacity/'campaign-native-mutations';directory.mkdir(parents=True)
  for i in range(10000):(directory/('lease-'+format(i,'032x')+'.json')).write_text('unresolved foreign record')
  hooks=self.root/'hooks';hooks.mkdir();(hooks/'sitecustomize.py').write_text("""from pathlib import Path
original=Path.read_text
def checked(path,*a,**kw):
 if path.name in ('admission-machines.json','machines.json'):raise AssertionError('whole inventory parsed by admission')
 return original(path,*a,**kw)
def no_scan(*a,**kw):raise AssertionError('per-admission directory scan')
Path.read_text=checked
Path.glob=no_scan
Path.iterdir=no_scan
""")
  self.env['PYTHONPATH']=str(hooks)
  token=self.require(self.call('acquire','--wait-seconds','1'))
  for action in ['start-native','join-native']:self.require(self.call(action,'--lease',token,'--native-owner-pid',str(os.getpid())))
  self.require(self.call('release','--lease',token))
  self.assertEqual((directory/('lease-'+'0'*32+'.json')).read_text(),'unresolved foreign record')
 def test_expired_or_foreign_generation_cannot_grant(self):
  health=self.feed/'inventory/current/health';original=health.read_text()
  for bad in [original.replace('publisher_token=fixture','publisher_token=foreign'),'\n'.join('valid_until=0' if x.startswith('valid_until=') else x for x in original.splitlines())+'\n']:
   health.write_text(bad);self.assertNotEqual(self.call('acquire','--wait-seconds','1').returncode,0)
  health.write_text(original)
 def test_strict_ticket_admission_uses_actual_prepared_key_without_manifest_read(self):
  consumer=self.root/'consumer';feed=consumer/'.context/campaigns/token/native';feed.mkdir(parents=True);(feed/'owner').write_bytes((self.feed/'owner').read_bytes());self.publish(feed)
  auth=json.loads(self.env['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY']);auth['directory']=str(feed)
  helper=ROOT/'scripts/cloudbench-cleanup-tickets.py';auth['source']['sha256'][helper.name]=hashlib.sha256(helper.read_bytes()).hexdigest();self.env['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY']=json.dumps(auth);self.env['CLOUDBENCH_CAMPAIGN_INVENTORY_DIR']=str(feed)
  module=runpy.run_path(str(helper));barrier=feed.parent/'startup-cohorts/cohort';barrier.mkdir(parents=True);task=consumer/'fleet/runs/run/task';task.mkdir(parents=True);reserve=self.root/'reserve';reserve.mkdir()
  deadline=time.monotonic()+10;(barrier/'manifest.json').write_text(json.dumps(dict(cohort_id='cohort',jobs={'r1-j1':os.getpid()},e2e_deadline_monotonic=deadline)))
  self.env.update(RUN_BENCH_CAMPAIGN_BARRIER_DIR=str(barrier),RUN_BENCH_CAMPAIGN_COHORT='cohort',RUN_BENCH_CAMPAIGN_JOB_ID='r1-j1',RUN_BENCH_CAMPAIGN_TASK='task',RUN_BENCH_CAMPAIGN_E2E_DEADLINE_MONOTONIC=str(deadline),RUN_BENCH_CLEANUP_COHORT_DIR=str(barrier),RUN_BENCH_CLEANUP_COHORT_ID='cohort',RUN_BENCH_CLEANUP_JOB='r1-j1',RUN_BENCH_CLEANUP_GENERATION='1')
  from types import SimpleNamespace
  args=SimpleNamespace(cohort=str(barrier),cohort_id='cohort',manifest=str(barrier/'manifest.json'),parent_pid=os.getpid(),parent_start=birth(os.getpid()),preferred=1,minimum=1,headroom=0,reserve_root=str(reserve),deadline=deadline,canary_script='',canary_lock='',job='r1-j1',owner_pid=os.getpid(),owner_start=birth(os.getpid()),generation=1)
  accounting=self.root/'ticket-accounting';accounting.mkdir()
  module['prepare'].__globals__['global_root']=lambda path:(accounting,path.stat().st_dev)
  with (barrier.parent/'parent.lock').open('w')as held:
   fcntl.flock(held,fcntl.LOCK_EX);budget=module['prepare'](args)
   grant=Path(budget['global_root'])/'ticket-grants'/(budget['global_budget_id']+'.json')
   self.addCleanup(lambda:grant.unlink(missing_ok=True))
   module['assign'](args)
   (barrier/'manifest.json').write_text('full manifest must not be read')
   hooks=self.root/'strict-hooks';hooks.mkdir();(hooks/'sitecustomize.py').write_text("""from pathlib import Path
original=Path.read_text
def checked(path,*a,**kw):
 if path.name in ('manifest.json','admission-machines.json','machines.json'):raise AssertionError('aggregate strict admission read')
 return original(path,*a,**kw)
def no_scan(*a,**kw):raise AssertionError('strict admission directory scan')
Path.read_text=checked
Path.glob=no_scan
Path.iterdir=no_scan
""");self.env['PYTHONPATH']=str(hooks)
   self.require(self.call('pace','--wait-seconds','2','--strict-primary','--task-root',str(task)))
   self.env['RUN_BENCH_CLEANUP_GENERATION']='2';self.assertNotEqual(self.call('pace','--wait-seconds','2','--strict-primary','--task-root',str(task)).returncode,0)
   self.env['RUN_BENCH_CLEANUP_GENERATION']='1';auth['source']['sha256'][helper.name]='0'*64;self.env['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY']=json.dumps(auth);self.assertNotEqual(self.call('pace','--wait-seconds','2','--strict-primary','--task-root',str(task)).returncode,0)
 def test_actual_boot_retry_publishes_rate_event_and_uses_remaining_budget(self):
  text=CLOUD_SOURCE.read_text();a=text.index('boot_update_with_capacity_recovery() {');b=text.index('\n}',a)+2;function=text[a:b]
  script='''set -eu
APP=fixture; MUTATION_OWNER_PID_START=fixture; CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION=1; CLOUDBENCH_RUNTIME_SCRIPT_ROOT=/fixture
CLOUDBENCH_BOOT_UPDATE_ATTEMPTS=2; CLOUDBENCH_BOOT_UPDATE_RETRY_SECONDS=1
n=0
cloudbench_mutation_admission() { printf '%s\\n' "$*" >> "$EVENTS"; case "$2" in pace) printf '89\\n';; esac; }
_with_timeout() { printf 'native %s\\n' "$1" >> "$EVENTS"; n=$((n+1)); if [ "$n" = 1 ]; then echo 'Error: HTTP 429 rate limit'; return 1; fi; return 0; }
'''+function+'\nboot_update_with_capacity_recovery "$UPDATE_LOG" fake-update\n'
  events=self.root/'events';result=subprocess.run(['bash','-c',script],env=dict(os.environ,EVENTS=str(events),UPDATE_LOG=str(self.root/'update.log')),text=True,capture_output=True,timeout=5)
  self.assertEqual(result.returncode,0,result.stderr);rows=events.read_text().splitlines();self.assertEqual(sum(' pace 'in row for row in rows),2);self.assertEqual(sum(' backoff 'in row for row in rows),1);self.assertEqual([row for row in rows if row.startswith('native ')],['native 89','native 89'])
 def test_actual_boot_rate_publication_preserves_zero_and_large_local_retry(self):
  text=CLOUD_SOURCE.read_text();a=text.index('boot_update_with_capacity_recovery() {');b=text.index('\n}',a)+2;function=text[a:b]
  for local,shared in [(0,1),(120,90)]:
   with self.subTest(local=local):
    script='''set -eu
APP=fixture; MUTATION_OWNER_PID_START=fixture; CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION=1; CLOUDBENCH_RUNTIME_SCRIPT_ROOT=/fixture
CLOUDBENCH_BOOT_UPDATE_ATTEMPTS=2; CLOUDBENCH_BOOT_UPDATE_RETRY_SECONDS=LOCAL
n=0
sleep() { printf 'sleep %s\\n' "$1" >> "$EVENTS"; }
cloudbench_mutation_admission() { printf '%s\\n' "$*" >> "$EVENTS"; case "$2" in pace) printf '89\\n';; esac; }
_with_timeout() { n=$((n+1)); if [ "$n" = 1 ]; then echo 'Error: HTTP 429 rate limit'; return 1; fi; return 0; }
'''.replace('LOCAL',str(local))+function+'\nboot_update_with_capacity_recovery "$UPDATE_LOG" fake-update\n'
    events=self.root/('events-'+str(local));result=subprocess.run(['bash','-c',script],env=dict(os.environ,EVENTS=str(events),UPDATE_LOG=str(self.root/'update.log')),text=True,capture_output=True,timeout=5)
    self.assertEqual(result.returncode,0,result.stderr);rows=events.read_text().splitlines();reported=[row for row in rows if ' backoff 'in row];self.assertEqual(len(reported),1);self.assertIn('--retry-after '+str(shared),reported[0]);self.assertIn('sleep '+str(local),rows)
if __name__=='__main__':unittest.main()
