#!/usr/bin/env python3
"""Native multiprocess cleanup reservations: short accounting lock, parallel allocation."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts' / 'lib'))
from condition_wait import WaitTimeout, wait_until
SOURCE = Path(os.environ.get('CLEANUP_PARALLEL_SOURCE', ROOT / 'scripts/run-bench-fleet'))
MB = 1048576
SITE = r'''
import errno,json,os,sys,time
from pathlib import Path
if sys.argv[0]=='-' and len(sys.argv)>=9:
    root=Path(os.environ['PAR_ROOT']);parent=str(Path(sys.argv[1]).parent)
    real_lstat=Path.lstat
    def lstat(path,*a,**kw):
        value=real_lstat(path,*a,**kw)
        if str(path)==parent:
            fields=list(value);fields[2]=int(os.environ['PAR_DEVICE']);return os.stat_result(fields)
        return value
    Path.lstat=lstat
    original=os.posix_fallocate;attempts=0
    native_fsync=os.fsync;allocation_fd=None
    def fsync(fd):
        native_fsync(fd)
        if os.environ.get('PAR_MODE')=='postallocate' and fd==allocation_fd:
            info=os.fstat(fd)
            marker=root/'events'/('allocated-'+str(os.getpid())+'.json')
            marker.write_text(json.dumps(dict(pid=os.getpid(),blocks=info.st_blocks*512)))
            until=time.monotonic()+12
            while not(root/'commit-release').exists():
                if time.monotonic()>until:raise TimeoutError('fixture commit barrier expired')
                time.sleep(.01)
    os.fsync=fsync
    native_sleep=time.sleep;backoffs=0
    def sleep(seconds):
        # Record the allocator's own busy backoff (retry_pause) so tests observe a re-evaluation.
        global backoffs
        if sys._getframe(1).f_code.co_name=='retry_pause':
            backoffs+=1
            (root/'events'/('backoff-'+str(os.getpid())+'-'+str(backoffs)+'.json')).write_text(json.dumps(dict(pid=os.getpid())))
        native_sleep(seconds)
    time.sleep=sleep
    def allocate(fd,offset,size):
        global attempts,allocation_fd
        attempts+=1;info=os.fstat(fd)
        state_path=Path(os.environ['PAR_STATE'])
        state=json.loads(state_path.read_text()) if state_path.exists()else None
        row=dict(pid=os.getpid(),owner=int(sys.argv[8]),fd=fd,identity=[info.st_dev,info.st_ino],
                 path=sys.argv[1],attempt=attempts,size=size,state=state,epoch=time.monotonic())
        event=root/'events'/('entry-'+str(os.getpid())+'-'+str(attempts)+'.json')
        temporary=event.with_name('.'+event.name+'.tmp')
        temporary.write_text(json.dumps(row));os.replace(temporary,event)
        mode=os.environ.get('PAR_MODE','normal')
        if mode=='transient' and attempts<=3:
            raise OSError([errno.EINTR,errno.EAGAIN,errno.EBUSY][attempts-1],'fixture transient')
        if mode in('barrier','hold'):
            until=time.monotonic()+12
            while not(root/'release').exists():
                if time.monotonic()>until:raise TimeoutError('fixture allocation barrier expired')
                time.sleep(.01)
        original(fd,offset,size)
        allocation_fd=fd
        if mode=='consume-after-allocate' and not (root/'consumed').exists():
            # Another consumer grows after this allocation (worktree, /tmp, peer fleet).
            temporary=root/'.budget.consume';temporary.write_text(str(int((root/'budget').read_text())-1))
            os.replace(temporary,root/'budget');(root/'consumed').touch()
        (root/'events'/('finished-'+str(os.getpid())+'.json')).write_text(json.dumps(dict(pid=os.getpid(),epoch=time.monotonic())))
    os.posix_fallocate=allocate
'''
DF = r'''#!{python}
import os
from pathlib import Path
root=Path(os.environ['PAR_ROOT'])
used=0
for p in root.glob('job*/cleanup-disk-reserve'):
    try:used+=p.stat().st_blocks*512
    except FileNotFoundError:pass
budget=int((root/'budget').read_text())
available=max(0,budget*1048576-used)//1024
print('Filesystem 1024-blocks Used Available Capacity Mounted on')
print('fixture 1048576 0 '+str(available)+' 0% /')
'''


class Fixture:
    def __init__(self, case, budget=16, cohort=0, legacy=False):
        self.case = case
        self.tmp = tempfile.TemporaryDirectory(prefix='cleanup-parallel-')
        case.addCleanup(self.close)
        self.root = Path(self.tmp.name)
        (self.root / 'events').mkdir()
        self.transport = self.root / 'transport'
        self.transport.mkdir()
        (self.transport / 'sitecustomize.py').write_text(SITE)
        (self.transport / 'df').write_text(DF.format(python=sys.executable))
        (self.transport / 'df').chmod(0o700)
        self.device = int(hashlib.sha256(str(self.root).encode()).hexdigest()[:12], 16)
        self.admission = Path('/tmp') / ('rose-cloudbench-cleanup-admission-' + str(os.getuid())) / str(self.device)
        self.state = self.admission / 'state.json'
        self.children = []
        self.stderr_paths = {}
        self.lock = None
        self.budget = budget
        (self.root/'budget').write_text(str(budget))
        self.cohort = cohort
        text = SOURCE.read_text()
        first = text.index('reserve_cleanup_disk_space() {')
        last = text.index('\nrelease_cleanup_disk_reserve() {', first)
        self.command = 'set -uo pipefail\nCLEANUP_DISK_RESERVE_FILE="$1"\n' + text[first:last] + '\nreserve_cleanup_disk_space ${PAR_WAIT:+"$PAR_WAIT"}\n'
        if cohort:
            folder = self.root / 'campaign/startup-cohorts/c001'
            folder.mkdir(parents=True)
            self.cohort_path = folder
            self.lock = (folder.parent / 'parent.lock').open('w')
            fcntl.flock(self.lock, fcntl.LOCK_EX)
            (folder / 'manifest.json').write_text(json.dumps(dict(cohort_id='c001', jobs={f'r001-j{i:04}': None for i in range(cohort)})))
        if legacy:
            self.admission.mkdir(parents=True, mode=0o700)
            self.state.write_text(json.dumps(dict(version=1, groups={})))
            self.state.chmod(0o600)

    def spawn(self, index, mode='normal', path_index=None, wait=None, headroom=0):
        parent = self.root / ('job' + str(index if path_index is None else path_index))
        parent.mkdir(exist_ok=True)
        temporary=self.root/'.budget.tmp'
        temporary.write_text(str(self.budget));os.replace(temporary,self.root/'budget')
        env = dict(os.environ, PYTHONPATH=str(self.transport), PATH=str(self.transport) + os.pathsep + os.environ['PATH'],
                   PAR_ROOT=str(self.root), PAR_STATE=str(self.state), PAR_DEVICE=str(self.device),
                   PAR_MODE=mode, PAR_BUDGET=str(self.budget),
                   CLOUDBENCH_CLEANUP_DISK_RESERVE_MB='1', CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB='1',
                   CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB=str(headroom),
                   CLOUDBENCH_CLEANUP_RESERVE_RETRY_SECONDS='1')
        env.pop('PAR_WAIT', None)
        if wait is not None:
            env['PAR_WAIT'] = str(wait)
        for key in ('RUN_BENCH_CAMPAIGN_BARRIER_DIR','RUN_BENCH_CAMPAIGN_JOB_ID','RUN_BENCH_CAMPAIGN_COHORT','INFRA_CANARY_PREFLIGHT_SCRIPT','FLEET_INFRA_CANARY_LOCK'):
            env.pop(key, None)
        if self.cohort:
            env.update(RUN_BENCH_CAMPAIGN_BARRIER_DIR=str(self.cohort_path),
                       RUN_BENCH_CAMPAIGN_JOB_ID=f'r001-j{index:04}', RUN_BENCH_CAMPAIGN_COHORT='c001')
        # stderr goes to a file so a test can observe the controller's progress while it runs.
        stderr_path = self.root / ('stderr-' + str(len(self.children)) + '.log')
        with stderr_path.open('w') as stderr:
            process = subprocess.Popen(['bash','-c',self.command,'fixture',str(parent/'cleanup-disk-reserve')],
                                       env=env, stdout=subprocess.PIPE, stderr=stderr, text=True,
                                       start_new_session=True)
        self.stderr_paths[process.pid] = stderr_path
        self.children.append(process)
        return process

    def stderr(self, p):
        return self.stderr_paths[p.pid].read_text()

    def wait_capacity_retries(self, p, count=2, timeout=20):
        # Each capacity-wait retry prints one ⏳ line before its retry sleep; an
        # exit (refusal) ends the wait early so the caller's assertion reports it.
        wait_until(lambda: p.poll() is not None or self.stderr(p).count('⏳') >= count,
                   timeout=timeout, description=str(count) + ' capacity-wait retries or an exit')

    def entries(self):
        return [json.loads(p.read_text())for p in (self.root/'events').glob('entry-*.json')]

    def backoff_pids(self):
        return [json.loads(p.read_text())['pid'] for p in (self.root/'events').glob('backoff-*.json')]

    def wait_entries(self, count, timeout=4):
        def enough():
            rows=self.entries()
            return rows if len({r['pid'] for r in rows})>=count else None
        try:return wait_until(enough,timeout=timeout,description=str(count)+' allocator entries')
        except WaitTimeout:return self.entries()

    def release(self):
        (self.root/'release').touch()
        (self.root/'commit-release').touch()

    def result(self,p):
        out,_=p.communicate(timeout=15)
        return p.returncode,out,self.stderr(p)

    def close(self):
        self.release()
        for p in self.children:
            try:p.wait(timeout=2)
            except subprocess.TimeoutExpired:
                # Exact private test process group, always a positive non-init PGID.
                if p.pid>1:os.killpg(p.pid,signal.SIGKILL)
                p.wait(timeout=3)
            for stream in (p.stdout,p.stderr):
                if stream:stream.close()
        if self.lock:self.lock.close()
        shutil.rmtree(self.admission,ignore_errors=True)
        self.tmp.cleanup()


class ParallelReservations(unittest.TestCase):
    def test_three_actual_allocations_overlap_with_durable_debits(self):
        f=Fixture(self,budget=8,cohort=3)
        children=[f.spawn(i,'barrier')for i in range(3)]
        rows=f.wait_entries(3)
        try:
            self.assertEqual(len({r['pid']for r in rows}),3,'physical allocations serialized under the accounting lock')
            state=json.loads(f.state.read_text())
            self.assertEqual(state['version'],2)
            self.assertEqual(len(state['inflight']),3)
            self.assertEqual(sum(len(g['consumed'])for g in state['groups'].values()),3)
            self.assertFalse(list((f.root/'events').glob('finished-*')))
        finally:f.release()
        for p in children:
            code,out,err=f.result(p);self.assertEqual(code,0,out+err)
        self.assertFalse(json.loads(f.state.read_text())['inflight'])
        self.assertEqual(sum((f.root/f'job{i}/cleanup-disk-reserve').stat().st_blocks*512 for i in range(3)),3*MB)

    def test_allocated_pending_bytes_do_not_force_an_artificial_wave(self):
        f=Fixture(self,budget=6)
        peers=[f.spawn(i,'postallocate')for i in range(3)]
        wait_until(lambda:len(list((f.root/'events').glob('allocated-*')))>=3,timeout=4,
                   description='three physical allocations before commit')
        self.assertEqual(len(list((f.root/'events').glob('allocated-*'))),3)
        self.assertEqual(sum((f.root/f'job{i}/cleanup-disk-reserve').stat().st_blocks*512 for i in range(3)),3*MB)
        self.assertEqual(len(json.loads(f.state.read_text())['inflight']),3)
        # Simulate two MiB consumed elsewhere: all peers now see the same tight free space.
        f.budget=4
        second=f.spawn(3)
        rows=f.wait_entries(4,timeout=3)
        try:
            self.assertEqual(len({r['pid']for r in rows}),4,
                             'already allocated pending blocks were debited twice and forced a commit wave')
            self.assertFalse((f.root/'commit-release').exists())
        finally:f.release()
        for p in (*peers,second):
            code,out,err=f.result(p);self.assertEqual(code,0,out+err)
        self.assertEqual(sum(p.stat().st_blocks*512 for p in f.root.glob('job*/cleanup-disk-reserve')),4*MB)

    def test_simultaneous_budget_cannot_overspend(self):
        f=Fixture(self,budget=2)
        children=[f.spawn(i,'barrier')for i in range(3)]
        rows=f.wait_entries(2)
        self.assertEqual(len({r['pid']for r in rows}),2)
        # The third allocator decides while both peers still hold the allocation barrier:
        # it re-evaluates against the pending liability twice (busy backoff) or refuses.
        held={r['pid']for r in rows}
        wait_until(lambda:sum(pid not in held for pid in f.backoff_pids())>=2 or any(p.poll() is not None for p in children),
                   timeout=10,description='the third allocator to back off twice against pending liability or refuse')
        self.assertEqual(len({r['pid']for r in f.entries()}),2,'third allocator overspent pending physical liability')
        f.release()
        results=[f.result(p)for p in children]
        self.assertEqual(sum(code==0 for code,_,_ in results),2,repr(results))
        used=sum(p.stat().st_blocks*512 for p in f.root.glob('job*/cleanup-disk-reserve'))
        self.assertLessEqual(used,2*MB)
        self.assertFalse(json.loads(f.state.read_text())['inflight'])

    def test_transient_allocation_retries_same_inode_and_single_debit(self):
        f=Fixture(self,budget=4)
        p=f.spawn(0,'transient');code,out,err=f.result(p)
        self.assertEqual(code,0,out+err)
        rows=sorted(f.entries(),key=lambda r:r['attempt'])
        self.assertEqual(len(rows),4)
        self.assertEqual(len({tuple(r['identity'])for r in rows}),1)
        self.assertEqual(len({r['fd']for r in rows}),1)
        for r in rows:
            self.assertEqual(len(r['state']['inflight']),1)
            self.assertEqual(sum(len(g['consumed'])for g in r['state']['groups'].values()),1)
        self.assertEqual((f.root/'job0/cleanup-disk-reserve').stat().st_blocks*512,MB)

    def test_dead_allocator_liability_recovered_only_after_exact_process_exit(self):
        f=Fixture(self,budget=4)
        first=f.spawn(0,'hold');rows=f.wait_entries(1)
        self.assertEqual(len(rows),1)
        before=json.loads(f.state.read_text());self.assertEqual(len(before['inflight']),1)
        allocator=rows[0]['pid'];self.assertGreater(allocator,1)
        self.assertEqual(rows[0]['owner'],first.pid)
        # Owner death alone cannot release an allocator's still-held inode lock.
        os.kill(first.pid,signal.SIGKILL)
        first.wait(timeout=3)
        peer=f.spawn(1);code,out,err=f.result(peer);self.assertEqual(code,0,out+err)
        pending=json.loads(f.state.read_text())['inflight']
        self.assertEqual(len(pending),1)
        self.assertEqual(next(iter(pending.values()))['allocator_pid'],allocator)
        os.kill(allocator,signal.SIGKILL)
        self.assertNotEqual(f.result(first)[0],0)
        # Killing the allocator does not itself rewrite or erase durable liability.
        self.assertEqual(len(json.loads(f.state.read_text())['inflight']),1)
        f.release()
        f.budget=0
        refused=f.spawn(2);code,out,err=f.result(refused)
        self.assertNotEqual(code,0,'new allocation must respect the reduced physical budget')
        state=json.loads(f.state.read_text());self.assertFalse(state['inflight'])
        self.assertTrue(state['failures'],'reclamation must persist even when the next admission refuses')
        self.assertFalse((f.root/'job0/cleanup-disk-reserve').exists())
        failures=state['failures']
        f.budget=4
        second=f.spawn(3);code,out,err=f.result(second);self.assertEqual(code,0,out+err)
        self.assertEqual(json.loads(f.state.read_text())['failures'],failures)
        # Retirement of dead A must survive a later corrupt dead B in the same scan.
        g=Fixture(self,budget=4)
        a=g.spawn(0,'hold');g.wait_entries(1)
        b=g.spawn(1,'hold');events=g.wait_entries(2);self.assertEqual(len(events),2)
        events.sort(key=lambda r:r['path'])
        for event in events:os.kill(event['pid'],signal.SIGKILL)
        for process in (a,b):self.assertNotEqual(g.result(process)[0],0)
        bad=g.root/'job1/cleanup-disk-reserve';bad.rename(bad.with_name('old-corrupt-B'));bad.touch(mode=0o600)
        refused=g.spawn(2);code,out,err=g.result(refused);self.assertNotEqual(code,0)
        state=json.loads(g.state.read_text())
        self.assertEqual(len(state['inflight']),1)
        self.assertEqual(next(iter(state['inflight'].values()))['path'],str(bad))
        self.assertTrue(any(v['path']==str(g.root/'job0/cleanup-disk-reserve')for v in state['failures'].values()))
        self.assertFalse((g.root/'job0/cleanup-disk-reserve').exists())
        self.assertEqual(bad.stat().st_size,0)

    def test_live_allocator_and_replaced_path_cannot_be_silently_pruned(self):
        f=Fixture(self,budget=8)
        first=f.spawn(0,'hold');rows=f.wait_entries(1);self.assertEqual(len(rows),1)
        original=f.root/'job0/cleanup-disk-reserve';original.rename(original.with_name('held-original'))
        original.touch(mode=0o600)
        second=f.spawn(1);code,out,err=f.result(second)
        self.assertEqual(code,0,out+err)  # Unrelated work may proceed within the remaining budget.
        pending=json.loads(f.state.read_text())['inflight']
        self.assertEqual(len(pending),1)
        self.assertEqual(next(iter(pending.values()))['identity'],rows[0]['identity'])
        self.assertEqual(original.stat().st_size,0,'replacement must not be unlinked or allocated')
        f.release();self.assertNotEqual(f.result(first)[0],0)
        self.assertEqual(len(json.loads(f.state.read_text())['inflight']),1,
                         'failed exact-file rollback must retain ambiguous liability')

    def test_same_path_different_member_cannot_replace_live_debit(self):
        f=Fixture(self,budget=8,cohort=2)
        first=f.spawn(0,'hold');rows=f.wait_entries(1);self.assertEqual(len(rows),1)
        original=f.root/'job0/cleanup-disk-reserve'
        before=json.loads(f.state.read_text())['inflight']
        identity=(original.stat().st_dev,original.stat().st_ino)
        collision=f.spawn(1,path_index=0);code,out,err=f.result(collision)
        self.assertNotEqual(code,0,'different cohort member must not replace a live same-path debit')
        self.assertEqual(json.loads(f.state.read_text())['inflight'],before)
        self.assertEqual((original.stat().st_dev,original.stat().st_ino),identity)
        f.release();code,out,err=f.result(first);self.assertEqual(code,0,out+err)
        self.assertFalse(json.loads(f.state.read_text())['inflight'])
        self.assertEqual(original.stat().st_blocks*512,MB)

    def test_legacy_state_migrates_and_cohort_future_n2_floor_is_preserved(self):
        legacy=Fixture(self,budget=4,legacy=True)
        p=legacy.spawn(0);code,out,err=legacy.result(p);self.assertEqual(code,0,out+err)
        self.assertEqual(json.loads(legacy.state.read_text())['version'],2)
        tight=Fixture(self,budget=3,cohort=3)
        p=tight.spawn(0);code,out,err=tight.result(p)
        self.assertNotEqual(code,0,'three primary floors must retain the fourth nested N2 floor')
        self.assertFalse(tight.entries())
        self.assertFalse((tight.root/'job0/cleanup-disk-reserve').exists())
        retired=Fixture(self,budget=8,cohort=3);retired.lock.close();retired.lock=None
        p=retired.spawn(0);self.assertNotEqual(retired.result(p)[0],0)
        self.assertFalse(retired.entries())


    # A disk shortage before any provider mutation is capacity, not infra: a
    # standalone controller waits for peers to release reserves (2026-11-16,
    # two rolling campaigns tripped the 5% infra stop at reserve admission).
    def test_headroom_consumed_after_allocation_rolls_back_and_waits_instead_of_failing(self):
        f=Fixture(self,budget=2)
        waiter=f.spawn(0,'consume-after-allocate',wait=30,headroom=1)
        wait_until(lambda:(f.root/'consumed').exists(),timeout=8,description='fixture reaching physical allocation')
        f.wait_capacity_retries(waiter)
        self.assertIsNone(waiter.poll(),'reserve shortage after allocation failed the controller instead of waiting')
        self.assertFalse((f.root/'job0/cleanup-disk-reserve').exists(),'rolled-back reserve still holds blocks while waiting')
        self.assertFalse(json.loads(f.state.read_text())['inflight'])
        # The other consumer releases space (a peer fleet finished): admission proceeds.
        temporary=f.root/'.budget.tmp';temporary.write_text('2');os.replace(temporary,f.root/'budget')
        code,out,err=f.result(waiter)
        self.assertEqual(code,0,out+err)
        self.assertIn('cleanup reserve consumed controller operating headroom',err)
        self.assertIn('⏳',err)
        self.assertEqual((f.root/'job0/cleanup-disk-reserve').stat().st_blocks*512,MB)
        self.assertFalse(json.loads(f.state.read_text())['inflight'])

    def test_standalone_shortage_waits_for_a_released_peer_reserve_then_admits(self):
        f=Fixture(self,budget=1)
        holder=f.spawn(0);code,out,err=f.result(holder);self.assertEqual(code,0,out+err)
        held=f.root/'job0/cleanup-disk-reserve';self.assertEqual(held.stat().st_blocks*512,MB)
        waiter=f.spawn(1,wait=30)
        f.wait_capacity_retries(waiter)
        self.assertIsNone(waiter.poll(),'standalone reserve shortage refused instead of waiting for peers')
        self.assertFalse((f.root/'job1/cleanup-disk-reserve').exists())
        held.unlink()  # the peer fleet's finalizer releases its exact reserve
        code,out,err=f.result(waiter)
        self.assertEqual(code,0,out+err)
        self.assertEqual((f.root/'job1/cleanup-disk-reserve').stat().st_blocks*512,MB)

    def test_capacity_wait_expiry_is_retryable_capacity_with_nothing_held(self):
        f=Fixture(self,budget=0)
        started=time.monotonic()
        code,out,err=f.result(f.spawn(0,wait=2))
        self.assertEqual(code,75,out+err)
        # Bash SECONDS has whole-second resolution: the bounded wait retried at least once.
        self.assertGreaterEqual(time.monotonic()-started,1)
        self.assertIn('⏳',err)
        self.assertIn('CLOUDBENCH_RETRYABLE_CAPACITY=cleanup_disk_reserve',err)
        self.assertIn('insufficient physical cleanup floors',err)
        self.assertFalse((f.root/'job0/cleanup-disk-reserve').exists())
        self.assertFalse(f.state.exists() and json.loads(f.state.read_text())['inflight'])

    def test_sealed_cohort_shortage_keeps_its_own_clock_and_never_waits(self):
        f=Fixture(self,budget=0,cohort=2)
        started=time.monotonic()
        code,out,err=f.result(f.spawn(0,wait=30))
        self.assertNotEqual(code,0,out+err)
        self.assertLess(time.monotonic()-started,10)


class CapacityDeferralClassification(unittest.TestCase):
    """The expired wait reaches the campaign as CAPACITY_DEFERRED, never INFRA_ERROR."""

    def fleet(self, defer):
        f=Fixture(self,budget=0)
        fleet=f.root/'fleet';(fleet/'_batch').mkdir(parents=True)
        (fleet/'_batch/benches.json').write_text(json.dumps([{'name':'polar-bu-045'}]))
        text=SOURCE.read_text()
        first=text.index('reserve_cleanup_disk_space() {')
        last=text.index('\nrelease_cleanup_disk_reserve() {',first)
        command=('set -uo pipefail\nCLEANUP_DISK_RESERVE_FILE="$1"\nFLEET_DIR="$2"\n'+text[first:last]
                 +'\nadmit_cleanup_disk_reserve\n')
        parent=f.root/'job0';parent.mkdir()
        env=dict(os.environ,PYTHONPATH=str(f.transport),PATH=str(f.transport)+os.pathsep+os.environ['PATH'],
                 PAR_ROOT=str(f.root),PAR_STATE=str(f.state),PAR_DEVICE=str(f.device),PAR_MODE='normal',
                 CLOUDBENCH_CLEANUP_DISK_RESERVE_MB='1',CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB='1',
                 CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB='0',CLOUDBENCH_CLEANUP_RESERVE_WAIT_SECONDS='1',
                 CLOUDBENCH_CLEANUP_RESERVE_RETRY_SECONDS='1')
        for key in ('RUN_BENCH_CAMPAIGN_BARRIER_DIR','RUN_BENCH_CLEANUP_COHORT_DIR','RUN_BENCH_CAMPAIGN_JOB_ID'):
            env.pop(key,None)
        if defer:
            result=subprocess.run(['bash','-c',command,'fixture',str(parent/'cleanup-disk-reserve'),str(fleet)],
                                  env=env,capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,75,result.stdout+result.stderr)
            self.assertIn('could not allocate the emergency fleet teardown disk reserve',result.stderr)
        aggregate=subprocess.run([sys.executable,str(ROOT/'scripts/cloudbench-aggregate-runs.py'),str(fleet),
                                  str(fleet/'_batch/run.json')],capture_output=True,text=True,timeout=30)
        self.assertEqual(aggregate.returncode,0,aggregate.stderr)
        return json.loads((fleet/'_batch/run.json').read_text())['tasks'][0]

    def campaign(self):
        import runpy
        return runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'))

    def test_expired_reserve_wait_is_deferred_capacity_outside_the_infra_stop(self):
        row=self.fleet(defer=True)
        self.assertEqual(row['status'],'CAPACITY_DEFERRED')
        self.assertIs(row['passed'],False)
        self.assertIn('emergency teardown reserve',row['failure_reason'])
        campaign=self.campaign()
        verdict=campaign['task_verdict'](row)
        self.assertIs(verdict['infra_failure'],False)
        self.assertIs(verdict['terminal_task'],False)
        job={'job_id':'r001-j0045','status':'failed',**verdict}
        self.assertIsNone(campaign['infra_stop_receipt']([job],1,'enabled'))

    def test_missing_artifact_without_deferral_stays_confirmed_infra(self):
        row=self.fleet(defer=False)
        self.assertEqual((row['status'],row['failure_reason']),('INFRA_ERROR','no current run artifact produced'))
        self.assertIs(self.campaign()['task_verdict'](row)['infra_failure'],True)


class CampaignReserveDiskPreflight(unittest.TestCase):
    def check(self, width, free_mb, **env):
        import io, runpy
        refusal=runpy.run_path(str(ROOT/'scripts/run-bench-campaign.py'))['cleanup_reserve_disk_refusal']
        stream=io.StringIO()
        code=refusal(Path('/'),width,environ=env,stream=stream,free_bytes=free_mb*MB)
        return code,stream.getvalue()

    def test_width_that_fits_free_disk_is_silent(self):
        self.assertEqual(self.check(20,20*768),(0,''))

    def test_width_above_free_disk_warns_with_effective_width_and_actions(self):
        code,text=self.check(28,15*1024)
        self.assertEqual(code,0)
        self.assertIn('28 controllers',text)
        self.assertIn('--concurrency 20',text)
        self.assertIn('WAIT',text)
        self.assertNotIn('INFRA_ERROR',text.replace('not INFRA_ERROR',''))

    def test_free_disk_below_one_controller_refuses_before_any_controller(self):
        code,text=self.check(4,700)
        self.assertEqual(code,78)
        self.assertIn('no campaign controller admitted',text)
        code,text=self.check(4,700,CLOUDBENCH_CLEANUP_DISK_RESERVE_MB='256',CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB='256')
        self.assertEqual(code,0)
        self.assertIn('--concurrency 1',text)


if __name__=='__main__':unittest.main()
