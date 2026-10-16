#!/usr/bin/env python3
"""Actual canonical campaign producer -> child reserve/release -> next cohort."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]
class CampaignTickets(unittest.TestCase):
 def test_actual_campaign_dispatches_independent_ticket_owners_and_retires_each_cohort(self):
  with tempfile.TemporaryDirectory(prefix='cleanup-ticket-campaign-') as temporary:
   root=Path(temporary);scripts=root/'scripts';scripts.mkdir()
   for name in ('run-bench-campaign.py','cloudbench-cleanup-tickets.py','cloudbench-infra-canary-preflight.py'):
    shutil.copyfile(ROOT/'scripts'/name,scripts/name)
   source=(ROOT/'scripts/run-bench-fleet').read_text()
   start=source.index('reserve_cleanup_disk_space() {');end=source.index('\nreap_orphaned_fleet_proxies()',start)
   functions=source[start:end]
   (scripts/'run-bench').write_text('''#!/bin/bash
set -euo pipefail
ROOT_DIR="$FIXTURE_ROOT"
FLEET_OWNER_PID_START="$(python3 -c 'from pathlib import Path;import os;print("proc-start:"+Path("/proc/sys/kernel/random/boot_id").read_text().strip()+":"+Path("/proc/self/stat").read_text().rsplit(") ",1)[1].split()[19])')"
# Capture the shell's birth rather than its short-lived Python child.
FLEET_OWNER_PID_START="$(python3 - "$PPID" "$$" <<'BIRTH'
from pathlib import Path
import sys
print('proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+Path('/proc',sys.argv[2],'stat').read_text().rsplit(') ',1)[1].split()[19])
BIRTH
)"
CLEANUP_DISK_RESERVE_FILE="$FIXTURE_ROOT/.git/cloudbench-fleet-ownership/$RUN_BENCH_CAMPAIGN_JOB_ID/cleanup-disk-reserve"
mkdir -p "$(dirname "$CLEANUP_DISK_RESERVE_FILE")"
'''+functions+'''
trap release_cleanup_disk_reserve EXIT
reserve_cleanup_disk_space
python3 - "$RUN_BENCH_CAMPAIGN_BARRIER_DIR" "$RUN_BENCH_CAMPAIGN_JOB_ID" "$$" <<'READY'
import json,sys,time
from pathlib import Path
cohort=Path(sys.argv[1]);job=sys.argv[2]
(cohort/'ready'/(job+'.json')).write_text(json.dumps(dict(cohort_id=cohort.name,job_id=job,controller_pid=int(sys.argv[3]),ready_at=time.time())))
end=time.monotonic()+10
while not(cohort/'release.json').exists():
 if time.monotonic()>end:raise TimeoutError('campaign did not release ready cohort')
 time.sleep(.01)
READY
''')
   subprocess.run(['git','init','-q',str(root)],check=True)
   subprocess.run(['git','-C',str(root),'add','.'],check=True)
   subprocess.run(['git','-C',str(root),'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','owning ticket source'],check=True)
   transport=root/'transport';transport.mkdir()
   device=int.from_bytes(os.urandom(5),'big')
   self.addCleanup(shutil.rmtree,Path('/tmp')/('rose-cloudbench-cleanup-admission-'+str(os.getuid()))/str(device),ignore_errors=True)
   (transport/'sitecustomize.py').write_text('''import os,stat
prefix=os.environ['FIXTURE_RESERVE_PREFIX']
def wrapper(original):
 def observed(path,*a,**k):
  value=original(path,*a,**k)
  if isinstance(path,(str,bytes,os.PathLike)) and os.path.abspath(os.fsdecode(path)).startswith(prefix) and stat.S_ISDIR(value.st_mode):
   fields=list(value);fields[2]=int(os.environ['FIXTURE_DEVICE']);return os.stat_result(fields)
  return value
 return observed
os.stat=wrapper(os.stat);os.lstat=wrapper(os.lstat)
''')
   env=dict(os.environ,PYTHONPATH=str(transport),FIXTURE_DEVICE=str(device),FIXTURE_RESERVE_PREFIX=str(root/'.git/cloudbench-fleet-ownership'),FIXTURE_ROOT=str(root),BENCHMARK_HUB_GROUP_RUN_ID='fixture',CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY='0',CLOUDBENCH_CLEANUP_DISK_RESERVE_MB='1',CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB='1',CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB='0')
   for name in list(env):
    if name.startswith('RUN_BENCH_CAMPAIGN_') or name.startswith('RUN_BENCH_CLEANUP_'):env.pop(name)
   result=subprocess.run([sys.executable,str(scripts/'run-bench-campaign.py'),'--root',str(root),'--runs','2','--concurrency','3','--task','fixture-a','--task','fixture-b','--task','fixture-c','--forward-arg=--strict-barrier'],env=env,capture_output=True,text=True,timeout=25)
   summaries=list((root/'.context/benchmarks/campaigns').glob('*/summary.json'))
   details='\n'.join(p.read_text() for p in (root/'.context/benchmarks/campaigns').glob('*/*.log'))
   self.assertEqual(result.returncode,0,result.stdout+result.stderr+details)
   self.assertEqual(len(summaries),1)
   summary=json.loads(summaries[0].read_text());self.assertEqual(summary['status'],'passed')
   self.assertEqual(len(summary['startup_cohorts']),2)
   for cohort in summaries[0].parent.joinpath('startup-cohorts').glob('c*'):
    base=cohort/'cleanup-budget';self.assertTrue((base/'retired.json').exists())
    self.assertEqual(len(list((base/'owners').glob('*/*/*.json'))),3)
    self.assertEqual(len(list((base/'terminal').glob('*/*/*.released.json'))),3)
    budget=json.loads((base/'budget.json').read_text())
    self.assertFalse((Path(budget['global_root'])/'ticket-grants'/(budget['global_budget_id']+'.json')).exists())
if __name__=='__main__':unittest.main()
