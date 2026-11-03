#!/usr/bin/env python3
"""Exercise the owning shell reserve function at a bounded storage transport."""
import atexit
import concurrent.futures
import fcntl
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from benchmarks.fixture_host_guard import FIXTURE_DRAIN_SECONDS, FIXTURE_HOST_GUARD_SECONDS

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
owner_count=int(os.environ.get("RESERVE_FIXTURE_OWNER_COUNT","50"));capacity_mb=int(os.environ.get("RESERVE_FIXTURE_CAPACITY_MB","18000"));unsealed=os.environ.get("RESERVE_FIXTURE_UNSEALED")=="1"
assert 1<=owner_count<=200 and capacity_mb>=owner_count*288
state.write_text(json.dumps({"capacity_mb": capacity_mb, "allocations": {}}))
nested_mode = os.environ.get("RESERVE_FIXTURE_NESTED", "")
assert nested_mode in ("", "1", "foreign", "unknown-parent")
nested_result = None
nested_live_floor = False
nested_start = work / "nested-start"
os.mkfifo(nested_start, 0o600)
nested_channel = os.open(nested_start, os.O_RDWR)
nested_exact = work / "nested" / "cleanup-disk-reserve"
nested_exact.parent.mkdir(mode=0o700)
nested_release = work / "nested-release"
os.mkfifo(nested_release, 0o600)
nested_release_channel = os.open(nested_release, os.O_RDWR)
nested_script = work / "nested-canary.sh"
nested_script.write_text("set -uo pipefail\nCLEANUP_DISK_RESERVE_FILE=\"$EXACT_RESERVE_PATH\"\nINFRA_CANARY_PREFLIGHT_SCRIPT=\"$RESERVE_CANARY_SCRIPT\"\nFLEET_INFRA_CANARY_LOCK=\"$EXACT_RESERVE_PATH.lock\"\n" + function + "\nif reserve_cleanup_disk_space; then rc=0; else rc=$?; fi\nprintf '%s\\n' \"$rc\" > \"$EXACT_RESERVE_PATH.admitted\"\nif [ \"$rc\" = 0 ]; then read -r release < \"$RESERVE_NESTED_RELEASE\"; fi\nexit \"$rc\"\n")
(transport / "sitecustomize.py").write_text('''
import errno, fcntl, json, os, sys, subprocess
from pathlib import Path
sys.platform = 'linux'
real_fstat = os.fstat
real_lstat = Path.lstat
state = Path(os.environ['RESERVE_TRANSPORT_STATE'])
def isolated_parent(self, *args, **kwargs):
    observed = real_lstat(self, *args, **kwargs)
    if str(self) == os.environ['RESERVE_TEST_PARENT']:
        fields = list(observed)
        fields[2] = int(os.environ['RESERVE_TEST_DEVICE'])
        return os.stat_result(fields)
    if str(self).endswith('/cleanup-disk-reserve'):
        with (state.parent / 'storage.lock').open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_SH)
            allocated = json.loads(state.read_text())['allocations'].get(str(self))
        if allocated is not None:
            return os.stat_result(tuple(observed), {'st_blocks': allocated // 512})
    return observed
Path.lstat = isolated_parent
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
original_run = subprocess.run
def ancestry_transport(arguments, *args, **kwargs):
    if os.environ.get('RESERVE_TEST_UNKNOWN_PARENT') == '1' and arguments == ['ps', '-axo', 'pid=,ppid=']:
        return subprocess.CompletedProcess(arguments, 0, '', '')
    result = original_run(arguments, *args, **kwargs)
    if os.environ.get('RESERVE_TEST_UNKNOWN_PARENT') == '1' and arguments == ['ps', '-axo', 'pid=,ppid=,lstart=']:
        # Preserve real native births while withholding only the ancestry map.
        result.stdout = '\\n'.join(fields[0] + ' ? ' + fields[2]
                                  for line in result.stdout.splitlines()
                                  if len(fields := line.split(None, 2)) == 3)
    return result
subprocess.run = ancestry_transport
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
jobs = [f"r{i:03d}-j{i:04d}" for i in range(1, owner_count+1)]
(cohort / "manifest.json").write_text(json.dumps({"cohort_id": "c001", "jobs": dict.fromkeys(jobs)}))
parent_lock = (barriers / "parent.lock").open("w")
fcntl.flock(parent_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
ready = work / "ready"
ready.mkdir(mode=0o700)
start = work / "start"
retire = work / "retire"
os.mkfifo(start, 0o600)
os.mkfifo(retire, 0o600)
start_channel = os.open(start, os.O_RDWR)
retire_channel = os.open(retire, os.O_RDWR)
completed = work / "completed"
completed.mkdir(mode=0o700)
processes = []
job_processes = {}
process_lock = threading.Lock()
retiring = threading.Event()
# Each run gets its own admission-ledger namespace. A reused pytest basetemp path must not
# inherit an earlier run's admission groups, whose recorded parent-lock identity no longer
# matches the recreated lock ("campaign parent lock identity changed" for every owner).
namespace = int(hashlib.sha256(f"{work}:{os.getpid()}:{time.time_ns()}".encode()).hexdigest()[:14], 16)
atexit.register(shutil.rmtree, Path("/tmp") / f"rose-cloudbench-cleanup-admission-{os.getuid()}" / str(namespace), True)
owner_births = {}


def native_owners():
    result = subprocess.run(
        ["ps", "-axo", "pid=,pgid=,lstart=,command="],
        env={**os.environ, "TZ": "UTC"}, capture_output=True, text=True,
        check=True, timeout=FIXTURE_HOST_GUARD_SECONDS,
    )
    observed = {}
    for line in result.stdout.splitlines():
        fields = line.split(None, 7)
        if len(fields) == 8 and fields[0].isdigit() and fields[1].isdigit():
            pid, pgid = map(int, fields[:2])
            birth = " ".join(fields[2:7])
            if str(work) in fields[7] and "cleanup-disk-reserve" in fields[7]:
                proc = Path(f"/proc/{pid}/stat")
                if proc.is_file():
                    ticks = proc.read_text().rsplit(")", 1)[1].split()[19]
                    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
                    birth = f"proc-start:{boot}:{ticks}"
                observed[pid] = (pgid, birth)
    return observed
def child(job):
    exact = work / job / "cleanup-disk-reserve"
    exact.parent.mkdir(mode=0o700)
    shell = f'''set -uo pipefail
CLEANUP_DISK_RESERVE_FILE="$1"
INFRA_CANARY_PREFLIGHT_SCRIPT="$9"
FLEET_INFRA_CANARY_LOCK="${{7}}.lock"
{function}
: > "$2"
read -r permission < "$3"
if reserve_cleanup_disk_space; then result=0; else result=$?; fi
printf '%s\\n' "$result" > "$4"
if [ "$result" = 0 ]; then
  if [ -n "$6" ]; then
    read -r permission < "$6"
    if EXACT_RESERVE_PATH="$7" RESERVE_TEST_PARENT="$(dirname "$7")" RESERVE_TEST_UNKNOWN_PARENT="${{RESERVE_FIXTURE_UNKNOWN_PARENT:-0}}" \
      python3 "$9" --stamp "${{7}}.stamp" --lock "${{7}}.lock" --ttl-seconds 3600 \
      --width 2 --canary "$8" --nested-controller-lock fixture-nested; then nested_rc=0; else nested_rc=$?; fi
    printf '%s\\n' "$nested_rc" > "${{7}}.status"
  fi
  read -r permission < "$5"
fi
exit "$result"
'''
    env = {**os.environ, "PATH": str(transport)+os.pathsep+os.environ['PATH'],
           "PYTHONPATH": str(transport), "RESERVE_TRANSPORT_STATE": str(state),
           "EXACT_RESERVE_PATH": str(exact), "TMPDIR": str(work),
           "RESERVE_TEST_PARENT": str(exact.parent), "RESERVE_TEST_DEVICE": str(namespace),
           "RUN_BENCH_CAMPAIGN_BARRIER_DIR": str(cohort),
           "RUN_BENCH_CAMPAIGN_JOB_ID": job, "RUN_BENCH_CAMPAIGN_COHORT": "c001",
           "RESERVE_NESTED_RELEASE": str(nested_release), "RESERVE_CANARY_SCRIPT": str(source.parent/"cloudbench-infra-canary-preflight.py"), "RESERVE_FIXTURE_UNKNOWN_PARENT": "1" if nested_mode=="unknown-parent" else "0"}
    if unsealed:
        env.pop("RUN_BENCH_CAMPAIGN_BARRIER_DIR",None);env.pop("RUN_BENCH_CAMPAIGN_COHORT",None);env.pop("RUN_BENCH_CAMPAIGN_JOB_ID",None)
    began = time.time()
    with process_lock:
        if retiring.is_set():
            raise RuntimeError("cohort fixture retired before child launch")
        p = subprocess.Popen([('/opt/homebrew/bin/bash' if Path('/opt/homebrew/bin/bash').is_file() else 'bash'),'-c',shell,'reserve',str(exact),str(ready/job),str(start),str(completed/job),str(retire),str(nested_start) if nested_mode in ("1", "unknown-parent") and job==jobs[0] else '',str(nested_exact),str(nested_script),str(source.parent/'cloudbench-infra-canary-preflight.py')],
                             env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
                             start_new_session=True)
        processes.append(p)
        job_processes[job] = p.pid
    out,err = p.communicate(timeout=FIXTURE_HOST_GUARD_SECONDS)
    (work / (job + '.private.log')).write_text(out+err)
    return {"job_id":job,"exit_code":p.returncode,"seconds":time.time()-began,
            "reserve_exists":exact.exists(),"reserve_size":exact.stat().st_size if exact.exists() else 0}
began = time.time()
def interrupted(signum, frame):
    raise SystemExit(128 + signum)
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
pool = concurrent.futures.ThreadPoolExecutor(max_workers=owner_count)
try:
    futures = [pool.submit(child, job) for job in jobs]
    deadline = time.monotonic() + FIXTURE_HOST_GUARD_SECONDS
    while len(list(ready.iterdir())) != owner_count:
        if time.monotonic() >= deadline:
            raise TimeoutError("cohort fixture ready handoff timed out")
        time.sleep(0.05)
    owner_births = native_owners()
    assert all(owner_births.get(p.pid, (None,))[0] == p.pid for p in processes)
    print(json.dumps({"stage": "cohort-ready", "owners": owner_count}), flush=True)
    if os.environ.get("RESERVE_FIXTURE_HOLD_READY") == "1":
        threading.Event().wait(FIXTURE_HOST_GUARD_SECONDS)
        raise TimeoutError("held cohort fixture was not cancelled")
    # Mirror the scheduler's actual physical controller publication before
    # those declared members reach post-canary admission.
    manifest = {"cohort_id":"c001","jobs":dict(job_processes)}
    (cohort / "manifest.json").write_text(json.dumps(manifest))
    os.write(start_channel, b"\n" * owner_count)
    while len(list(completed.iterdir())) != owner_count:
        if time.monotonic() >= deadline:
            raise TimeoutError("cohort fixture admission handoff timed out")
        time.sleep(0.05)
    admission_state = json.loads(state.read_text())
    total_at_live_boundary = sum(n for p,n in admission_state['allocations'].items() if Path(p).exists())
    if nested_mode == "foreign":
        foreign_environment = {**os.environ, "PATH": str(transport)+os.pathsep+os.environ['PATH'],
            "PYTHONPATH": str(transport), "RESERVE_TRANSPORT_STATE": str(state),
            "RESERVE_NESTED_RELEASE": str(nested_release), "RESERVE_CANARY_SCRIPT": str(source.parent/"cloudbench-infra-canary-preflight.py"), "EXACT_RESERVE_PATH": str(nested_exact), "RESERVE_TEST_PARENT": str(nested_exact.parent),
            "RESERVE_TEST_DEVICE": str(namespace)}
        foreign = subprocess.run([sys.executable, str(source.parent/'cloudbench-infra-canary-preflight.py'),
            '--stamp', str(nested_exact)+'.stamp', '--lock', str(nested_exact)+'.lock', '--ttl-seconds', '3600',
            '--width', '2', '--canary', str(nested_script), '--nested-controller-lock', 'fixture-nested'],
            env=foreign_environment, text=True, capture_output=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
        (work/'foreign.private.log').write_text(foreign.stdout+foreign.stderr)
        nested_result = foreign.returncode
    elif nested_mode:
        os.write(nested_channel, b"\n")
        admitted_path = Path(str(nested_exact) + '.admitted')
        while not admitted_path.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError("nested canary did not reach live boundary")
            time.sleep(0.05)
        if admitted_path.read_text().strip() == "0":
            nested_live_state = json.loads(state.read_text())
            total_nested_live = sum(n for p,n in nested_live_state["allocations"].items() if Path(p).exists())
            nested_live_floor = nested_live_state["capacity_mb"] - total_nested_live // 1048576 >= (owner_count+1) * 256
        os.write(nested_release_channel, b"\n")
        status_path = Path(str(nested_exact) + '.status')
        while not status_path.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError("nested canary admission did not return")
            time.sleep(0.05)
        nested_result = int(status_path.read_text())
    os.write(retire_channel, b"\n" * owner_count)
    rows = [f.result() for f in futures]
finally:
    with process_lock:
        retiring.set()
        owned = list(processes)
    if not owner_births:
        owner_births = native_owners()
    current = native_owners()
    os.write(nested_release_channel, b"\n")
    os.write(start_channel, b"\n" * owner_count)
    os.write(retire_channel, b"\n" * owner_count)
    for process in owned:
        # Match exact native birth, private fixture path and private session.
        # Exited or recycled leaders never grant signaling authority.
        if process.poll() is None and current.get(process.pid) == owner_births.get(process.pid) \
                and current.get(process.pid, (None,))[0] == process.pid:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for process in owned:
        try:
            process.wait(timeout=FIXTURE_DRAIN_SECONDS)
        except subprocess.TimeoutExpired:
            current = native_owners()
            if process.poll() is None and current.get(process.pid) == owner_births.get(process.pid) \
                    and current.get(process.pid, (None,))[0] == process.pid:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=FIXTURE_DRAIN_SECONDS)
    pool.shutdown(wait=True, cancel_futures=True)
    os.close(nested_channel)
    os.close(nested_release_channel)
    os.close(start_channel)
    os.close(retire_channel)
    parent_lock.close()
    (work / "child-drain.safe.json").write_text(json.dumps({
        "created": len(owned), "all_reaped": all(p.poll() is not None for p in owned),
        "private_session_pids": [p.pid for p in owned],
        "isolated_admission_namespace": namespace,
    }) + "\n")
data = json.loads(state.read_text())
total = total_at_live_boundary
checks = {"all50_admitted":all(r['exit_code']==0 for r in rows),
          "all50_min32mb":all(r['reserve_size']>=32*1048576 for r in rows),
          "headroom256mb_per_owner":capacity_mb*1048576-total>=owner_count*256*1048576,
          "preferred512_preserved":all(r['reserve_size']<=512*1048576 for r in rows)}
if nested_mode == "1":
    checks["all_51_controller_headroom_floors_at_nested_live_boundary"] = nested_live_floor
if nested_mode:
    checks["nested_canary_expected_admission_without_lowering_parent_floors"] = (nested_result == 0) == (nested_mode == "1")
receipt = {"nested_canary_exit":nested_result,"source_sha256":hashlib.sha256(source.read_bytes()).hexdigest(),
           "driver_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
           "started_epoch":began,"finished_epoch":time.time(),"elapsed_s":time.time()-began,
           "physical_transport":"bounded replay; native allocation bytes NOT measured here",
           "provider_calls":0,"task_executions":0,"budget_mb":capacity_mb,"owner_count":owner_count,"unsealed":unsealed,
           "admitted":sum(r['exit_code']==0 for r in rows),"failed":sum(r['exit_code']!=0 for r in rows),
           "logical_reserved_mb":total//1048576,"assertions":checks,"rows":rows}
(work/'receipt.safe.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:v for k,v in receipt.items() if k!='rows'},indent=2))
assert all(checks.values()), checks
