#!/usr/bin/env python3
"""Exercise the owning shell reserve function at a bounded storage transport."""
from pathlib import Path
import concurrent.futures
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import time

os.umask(0o077)
root = Path(__file__).resolve().parents[2]
source = Path(sys.argv[1]).resolve()
work = Path(sys.argv[2]).resolve()
work.mkdir(mode=0o700, parents=True, exist_ok=False)
transport = work / "transport"
transport.mkdir(mode=0o700)
script = source.read_text()
begin = script.index("reserve_cleanup_disk_space() {")
end = script.index("\nrelease_cleanup_disk_reserve() {", begin)
function = script[begin:end]
state = work / "storage.json"
state.write_text(json.dumps({"capacity_mb": 18000, "allocations": {}}))
(transport / "sitecustomize.py").write_text('''
import errno, fcntl, json, os, sys
from pathlib import Path
sys.platform = 'linux'
real_fstat = os.fstat
state = Path(os.environ['RESERVE_TRANSPORT_STATE'])
def allocate(fd, offset, size):
    path = os.environ['EXACT_RESERVE_PATH']
    with (state.parent / 'storage.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = json.loads(state.read_text())
        data['allocations'] = {p:n for p,n in data['allocations'].items() if Path(p).exists()}
        total = sum(data['allocations'].values())
        if total + size > data['capacity_mb'] * 1048576:
            raise OSError(errno.ENOSPC, 'bounded storage transport exhausted')
        os.ftruncate(fd, size)
        data['allocations'][path] = size
        state.write_text(json.dumps(data))
def observed(fd):
    value = real_fstat(fd)
    path = os.environ.get('EXACT_RESERVE_PATH')
    try:
        target = os.stat(path)
        if target.st_ino == value.st_ino and target.st_dev == value.st_dev:
            return os.stat_result(tuple(value), {'st_blocks': value.st_size // 512})
    except (OSError, TypeError):
        pass
    return value
os.posix_fallocate = allocate
os.fstat = observed
''')
df = transport / "df"
df.write_text('''#!/usr/bin/env python3
import fcntl,json,os
from pathlib import Path
p=Path(os.environ['RESERVE_TRANSPORT_STATE'])
with (p.parent/'storage.lock').open('a+') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 d=json.loads(p.read_text());a={k:v for k,v in d['allocations'].items() if Path(k).exists()}
 free=d['capacity_mb']*1048576-sum(a.values())
 print('Filesystem 1024-blocks Used Available Capacity Mounted on')
 print('bounded 20000000 0',free//1024,'0% /bounded')
''')
df.chmod(0o700)
barriers = work / "startup-cohorts"
cohort = barriers / "c001"
cohort.mkdir(parents=True, mode=0o700)
jobs = [f"r{i:03d}-j{i:04d}" for i in range(1, 51)]
(cohort / "manifest.json").write_text(json.dumps({"cohort_id": "c001", "jobs": dict.fromkeys(jobs)}))
parent_lock = (barriers / "parent.lock").open("w")
fcntl.flock(parent_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
ready = work / "ready"
ready.mkdir(mode=0o700)
start = work / "start"
retire = work / "retire"
completed = work / "completed"
completed.mkdir(mode=0o700)
def child(job):
    exact = work / job / "cleanup-disk-reserve"
    exact.parent.mkdir(mode=0o700)
    shell = f'''set -uo pipefail
CLEANUP_DISK_RESERVE_FILE="$1"
{function}
: > "$2"
while [ ! -e "$3" ]; do sleep 0.01; done
if reserve_cleanup_disk_space; then result=0; else result=$?; fi
printf '%s\\n' "$result" > "$4"
if [ "$result" = 0 ]; then
  while [ ! -e "$5" ]; do sleep 0.01; done
fi
exit "$result"
'''
    env = {**os.environ, "PATH": str(transport)+os.pathsep+os.environ['PATH'],
           "PYTHONPATH": str(transport), "RESERVE_TRANSPORT_STATE": str(state),
           "EXACT_RESERVE_PATH": str(exact), "TMPDIR": str(work),
           "RUN_BENCH_CAMPAIGN_BARRIER_DIR": str(cohort),
           "RUN_BENCH_CAMPAIGN_JOB_ID": job, "RUN_BENCH_CAMPAIGN_COHORT": "c001"}
    began = time.time()
    p = subprocess.Popen([('/opt/homebrew/bin/bash' if Path('/opt/homebrew/bin/bash').is_file() else 'bash'),'-c',shell,'reserve',str(exact),str(ready/job),str(start),str(completed/job),str(retire)],
                         env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    out,err = p.communicate()
    (work / (job + '.private.log')).write_text(out+err)
    return {"job_id":job,"exit_code":p.returncode,"seconds":time.time()-began,
            "reserve_exists":exact.exists(),"reserve_size":exact.stat().st_size if exact.exists() else 0}
began = time.time()
with concurrent.futures.ThreadPoolExecutor(max_workers=50) as pool:
    futures = [pool.submit(child, job) for job in jobs]
    while len(list(ready.iterdir())) != 50:
        time.sleep(0.01)
    start.touch()
    while len(list(completed.iterdir())) != 50:
        time.sleep(0.01)
    admission_state = json.loads(state.read_text())
    total_at_live_boundary = sum(n for p,n in admission_state['allocations'].items() if Path(p).exists())
    retire.touch()
    rows = [f.result() for f in futures]
parent_lock.close()
data = json.loads(state.read_text())
total = total_at_live_boundary
checks = {"all50_admitted":all(r['exit_code']==0 for r in rows),
          "all50_min32mb":all(r['reserve_size']>=32*1048576 for r in rows),
          "headroom256mb_per_owner":18000*1048576-total>=50*256*1048576,
          "preferred512_preserved":all(r['reserve_size']<=512*1048576 for r in rows)}
receipt = {"source_sha256":hashlib.sha256(source.read_bytes()).hexdigest(),
           "driver_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
           "started_epoch":began,"finished_epoch":time.time(),"elapsed_s":time.time()-began,
           "physical_transport":"bounded replay; native allocation bytes NOT measured here",
           "provider_calls":0,"task_executions":0,"budget_mb":18000,
           "admitted":sum(r['exit_code']==0 for r in rows),"failed":sum(r['exit_code']!=0 for r in rows),
           "logical_reserved_mb":total//1048576,"assertions":checks,"rows":rows}
(work/'receipt.safe.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:v for k,v in receipt.items() if k!='rows'},indent=2))
assert all(checks.values()), checks
