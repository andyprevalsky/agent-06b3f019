#!/usr/bin/env python3
"""Owning tests for sealed cohort tickets and constant-cost per-job allocation."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT/'scripts/cloudbench-cleanup-tickets.py'
MB = 1048576

# Enabled only in the per-job subprocess. Parent preparation may read the full
# manifest once; the claimant must touch only its explicitly selected files.
# File sizes count conservatively as bytes available to read at each open.
SITE = r'''
import errno,json,os,sys,time
# Model capacity for the synthetic 10k cohort, while all few physical writes
# still use native allocation and fsync on the local filesystem.
if os.environ.get('TICKET_FIXTURE_ROOT'):
    reserve_root=os.environ['TICKET_RESERVE_ROOT']
    native_stat_capacity=os.stat
    native_lstat_capacity=os.lstat
    def capacity_stat(native):
        def call(path,*args,**kwargs):
            value=native(path,*args,**kwargs)
            if isinstance(path,(str,bytes,os.PathLike)) and os.path.abspath(os.fsdecode(path))==reserve_root:
                fields=list(value);fields[2]=int(os.environ['TICKET_DEVICE']);return os.stat_result(fields)
            return value
        return call
    os.stat=capacity_stat(native_stat_capacity)
    os.lstat=capacity_stat(native_lstat_capacity)
    native_vfs=os.statvfs
    def capacity_vfs(path):
        value=list(native_vfs(path));value[3]=value[4]=(64*1024**3)//value[1]
        return os.statvfs_result(value)
    os.statvfs=capacity_vfs
if os.environ.get('TICKET_RELEASE_CRASH'):
    native_unlink=os.unlink
    def interrupted_unlink(path,*args,**kwargs):
        if os.path.abspath(os.fsdecode(path))==os.environ['TICKET_RELEASE_CRASH']:
            raise OSError('fixture interrupted after durable released receipt')
        return native_unlink(path,*args,**kwargs)
    os.unlink=interrupted_unlink
if os.environ.get('TICKET_TRACE'):
    native_open=os.open
    native_stat=os.stat
    native_lstat=os.lstat
    trace=native_open(os.environ['TICKET_TRACE'],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    metadata=os.environ['TICKET_METADATA'].rstrip('/')+'/'
    allowed=set(json.loads(os.environ['TICKET_ALLOWED']))
    forbidden_global=os.environ.get('TICKET_GLOBAL','').rstrip('/')+'/'
    busy=False
    def emit(value):
        os.write(trace,(json.dumps(value,sort_keys=True)+'\n').encode())
    def audit(event,args):
        global busy
        if busy:return
        busy=True
        try:
            if event=='open' and isinstance(args[0],(str,bytes)):
                path=os.path.abspath(os.fsdecode(args[0]))
                if forbidden_global!='/' and path.startswith(forbidden_global):raise AssertionError('per-job global accounting access: '+path)
                if path.startswith(metadata):
                    try:size=native_stat(path,follow_symlinks=False).st_size
                    except FileNotFoundError:size=0
                    emit(dict(event='metadata_open',path=path,size=size,mode=args[1],flags=args[2]))
                    if path not in allowed:raise AssertionError('non-keyed metadata access: '+path)
            elif event in('os.listdir','os.scandir'):
                path=args[0]
                if isinstance(path,(str,bytes)):
                    path=os.path.abspath(os.fsdecode(path))
                    if path.startswith(metadata.rstrip('/')) or path=='/proc' or forbidden_global!='/' and path.startswith(forbidden_global.rstrip('/')):
                        emit(dict(event='forbidden_walk',path=path))
                        raise AssertionError('per-job global directory walk: '+path)
            elif event=='subprocess.Popen':
                argv=args[1]
                if isinstance(argv,(list,tuple)) and argv:
                    name=os.path.basename(os.fsdecode(argv[0]))
                    if name=='ps' and any(str(v).startswith('-a') or str(v)=='-e' for v in argv[1:]):
                        emit(dict(event='forbidden_ps',argv=list(argv)))
                        raise AssertionError('per-job global process scan')
        finally:busy=False
    def measured_stat(native,event):
        def inspect(path,*args,**kwargs):
            global busy
            if not busy and isinstance(path,(str,bytes,os.PathLike)):
                name=os.path.abspath(os.fsdecode(path))
                if forbidden_global!='/' and name.startswith(forbidden_global):raise AssertionError('per-job global accounting stat: '+name)
                if name.startswith(metadata):
                    busy=True
                    try:
                        emit(dict(event=event,path=name))
                        if name not in allowed:raise AssertionError('non-keyed metadata stat: '+name)
                    finally:busy=False
            return native(path,*args,**kwargs)
        return inspect
    os.stat=measured_stat(native_stat,'metadata_stat')
    os.lstat=measured_stat(native_lstat,'metadata_lstat')
    sys.addaudithook(audit)
    native_allocate=os.posix_fallocate
    attempts=0
    def allocate(fd,offset,size):
        global attempts
        attempts+=1;info=os.fstat(fd)
        emit(dict(event='allocate',pid=os.getpid(),fd=fd,identity=[info.st_dev,info.st_ino],size=size,attempt=attempts))
        if os.environ.get('TICKET_MODE')=='transient' and attempts<=3:
            raise OSError((errno.EINTR,errno.EAGAIN,errno.EBUSY)[attempts-1],'fixture transient')
        if os.environ.get('TICKET_MODE')=='barrier':
            end=time.monotonic()+10
            while not os.path.exists(os.environ['TICKET_RELEASE']):
                if time.monotonic()>=end:raise TimeoutError('local allocation barrier expired')
                time.sleep(.01)
        native_allocate(fd,offset,size)
        emit(dict(event='allocated',pid=os.getpid(),attempt=attempts,blocks=os.fstat(fd).st_blocks*512))
    os.posix_fallocate=allocate
'''


def birth(pid):
    return 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def stop_owned(process):
    if process.poll() is None:
        if process.pid <= 1:
            raise AssertionError('unsafe fixture process ID')
        os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=3)
    for stream in (process.stdout,process.stderr):
        if stream:stream.close()

# All tests invoke the production CLI; there is no substitute allocator.


class TicketFixture:
    def __init__(self, case, width):
        self.tmp = tempfile.TemporaryDirectory(prefix='cleanup-tickets-')
        case.addCleanup(self.close)
        self.root = Path(self.tmp.name)
        self.cohort = self.root/'campaign/startup-cohorts/c001'
        self.cohort.mkdir(parents=True)
        self.reserve_root = self.root/'reserves'
        self.reserve_root.mkdir()
        self.manifest = self.cohort/'manifest.json'
        self.jobs = ['r001-j'+str(index).zfill(5) for index in range(width)]
        self.manifest.write_text(json.dumps(dict(cohort_id='c001',jobs=dict.fromkeys(self.jobs))))
        self.transport = self.root/'transport'
        self.transport.mkdir()
        (self.transport/'sitecustomize.py').write_text(SITE)
        (self.root/'free-kib').write_text('67108864')
        (self.transport/'df').write_text('#!/bin/sh\nfree=$(cat "$TICKET_FIXTURE_ROOT/free-kib")\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 67108864 0 %s 0%%%% /\\n" "$free"\n')
        (self.transport/'df').chmod(0o700)
        self.children = []
        self.owners = []
        self.device = int.from_bytes(os.urandom(5),'big')
        self.env = dict(os.environ, PYTHONPATH=str(self.transport), PATH=str(self.transport)+os.pathsep+os.environ['PATH'], TICKET_FIXTURE_ROOT=str(self.root), TICKET_DEVICE=str(self.device), TICKET_RESERVE_ROOT=str(self.reserve_root))
        self.base = [sys.executable,str(MODULE),'--cohort',str(self.cohort),'--cohort-id','c001']
        self.parent_pid = os.getpid()
        self.parent_start = birth(self.parent_pid)
        self.parent_lock=(self.cohort.parent/'parent.lock').open('w')
        fcntl.flock(self.parent_lock,fcntl.LOCK_EX)

    def command(self, action, args=(), env=None):
        return subprocess.run([sys.executable,str(MODULE),action,*self.base[2:],*map(str,args)],env=env or self.env,capture_output=True,text=True,timeout=15)

    def prepare(self,extra=()):
        return self.command('prepare',['--manifest',self.manifest,'--reserve-root',self.reserve_root,'--parent-pid',self.parent_pid,'--parent-start',self.parent_start,'--preferred',1,'--minimum',1,'--headroom',0,*extra])

    def owner(self):
        process=subprocess.Popen(['bash','-c','read -r unused'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        self.owners.append(process)
        return process

    def key_paths(self, job, generation=1):
        import hashlib
        key=hashlib.sha256(job.encode()).hexdigest()
        root=self.cohort/'cleanup-budget'
        paths={root/'budget.json',root/'ready.json',root/'closing.json',root/'scope.lock'}
        paths.add(root/'members'/key[:2]/(key+'.json'))
        paths.add(root/'current'/key[:2]/(key+'.json'))
        paths.add(root/'locks'/key[:2]/(key+'.json'))
        for number in set((generation,max(1,generation-1))):
            for namespace in ('owners','claims'):
                paths.add(root/namespace/key[:2]/key/('g'+str(number).zfill(4)+'.json'))
            for status in ('committed','released','failed'):
                paths.add(root/'terminal'/key[:2]/key/('g'+str(number).zfill(4)+'.'+status+'.json'))
        for status in ('committed','released','failed'):
            paths.add(root/'terminal'/key[:2]/key/('g'+str(generation).zfill(4)+'.'+status+'.json'))
        # Directories may be stat'ed for private/physical checks, never enumerated.
        for path in tuple(paths):
            paths.update(parent for parent in path.parents if parent==root or root in parent.parents)
        return paths

    def assign(self,index,owner,generation=1):
        return self.command('assign',['--job',self.jobs[index],'--owner-pid',owner.pid,'--owner-start',birth(owner.pid),'--generation',generation])

    def claim(self,index,owner,mode='normal',generation=1,deadline=None):
        job=self.jobs[index]; reserve=self.reserve_root/(job+'.reserve')
        trace=self.root/('trace-'+str(index)+'-'+str(time.time_ns())+'.jsonl')
        env=dict(self.env,TICKET_GLOBAL=json.loads((self.cohort/'cleanup-budget/budget.json').read_bytes())['global_root'],TICKET_TRACE=str(trace),TICKET_METADATA=str(self.cohort/'cleanup-budget'),TICKET_ALLOWED=json.dumps(sorted(map(str,self.key_paths(job,generation)))),TICKET_MODE=mode,TICKET_RELEASE=str(self.root/'release'))
        argv=[sys.executable,str(MODULE),'claim',*self.base[2:],'--job',job,'--owner-pid',str(owner.pid),'--owner-start',birth(owner.pid),'--generation',str(generation),'--reserve',str(reserve)]
        if deadline is not None:argv += ['--deadline',str(deadline)]
        process=subprocess.Popen(argv,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        self.children.append(process)
        return process,trace,reserve

    def release_barriers(self):
        (self.root/'release').touch()

    def close(self):
        self.release_barriers()
        for process in self.children+self.owners:
            stop_owned(process)
            if process.stdin:process.stdin.close()
        # A unique virtual device isolates the test-only global grant namespace.
        import shutil
        shutil.rmtree(Path('/tmp')/('rose-cloudbench-cleanup-admission-'+str(os.getuid()))/str(self.device),ignore_errors=True)
        self.parent_lock.close()
        self.tmp.cleanup()


class CohortTickets(unittest.TestCase):
    def assert_ok(self,result):
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    def stale_standalone_fixture(self, mode='dead'):
        import hashlib
        fixture=TicketFixture(self,14)
        (fixture.root/'free-kib').write_text(str(6500*1024))
        legacy=Path('/tmp')/('rose-cloudbench-cleanup-admission-'+str(os.getuid()))/str(fixture.device)
        legacy.mkdir(parents=True,mode=0o700)
        groups={}
        guard_pids=[]
        for index in range(10):
            owner=fixture.owner();stamp=birth(owner.pid)
            if mode not in ('live','reused'):
                owner.stdin.close();owner.wait(timeout=3)
            if mode=='reused':stamp='proc-start:00000000-0000-0000-0000-000000000000:1'
            if mode=='malformed-pid':pid=True
            else:pid=owner.pid
            if mode=='malformed-birth':stamp='unverifiable birth'
            if mode=='legacy-date':stamp='Sat Nov 7 18:33:07 2026'
            key=hashlib.sha256(('standalone-'+str(index)).encode()).hexdigest();member='standalone-'+key
            groups[key]=dict(directory=None,parent_lock_identity=None,members=[member],consumed={member:dict(pid=pid,birth=stamp)},preferred=512,minimum=32,headroom=256)
            if mode=='pending':groups[key]['consumed']={}
            if mode=='cohort':groups[key]['directory']=str(fixture.root/'prior-cohort')
            if mode=='malformed-member':groups[key]['members']=['unknown-member']
            if mode=='malformed-group':groups[key]['unknown']='unsupported'
            if mode in ('permission','birth-error'):guard_pids.append(owner.pid)
        if guard_pids:
            with (fixture.transport/'sitecustomize.py').open('a') as stream:
                stream.write("\nfrom pathlib import Path\n_old_read=Path.read_text\n_guard_paths="+repr({'/proc/'+str(pid)+'/stat' for pid in guard_pids})+"\ndef read_guard(self,*args,**kwargs):\n if str(self) in _guard_paths:raise "+('PermissionError' if mode=='permission' else 'OSError')+"('fixture unknown owner')\n return _old_read(self,*args,**kwargs)\nPath.read_text=read_guard\n")
        state=dict(version=2,groups=groups,inflight={},failures={})
        if mode=='inflight':
            key=next(iter(groups));record=next(iter(groups[key]['consumed'].values()))
            state['inflight']['opaque-debit']=dict(group=key,job=groups[key]['members'][0],pid=record['pid'],birth=record['birth'],allocator_pid=record['pid'],allocator_birth=record['birth'],path=str(fixture.root/'unconfirmed-reserve'),identity=[1,1],amount=4096)
        path=legacy/'state.json';path.write_text(json.dumps(state,sort_keys=True));before=path.read_bytes()
        result=fixture.prepare(['--preferred',512,'--minimum',32,'--headroom',256])
        self.assertEqual(path.read_bytes(),before,'capacity observation mutated historical ledger')
        if mode in ('dead','legacy-date'):
            self.assert_ok(result)
            budget=json.loads((fixture.cohort/'cleanup-budget/budget.json').read_text())
            self.assertEqual((budget['preferred'],budget['minimum'],budget['headroom'],budget['job_count']),(512,32,256,14))
            self.assertGreaterEqual(budget['amount'],32)
        else:
            self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertFalse((fixture.cohort/'cleanup-budget/budget.json').exists())
            if mode.startswith('malformed'):self.assertIn('invalid legacy',result.stderr)

    def test_retired_standalone_headroom_does_not_block_fourteen_floors(self):
        self.stale_standalone_fixture()

    def test_native_ps_unknown_or_failed_absence_never_releases_headroom(self):
        import runpy
        from unittest import mock
        function=runpy.run_path(str(MODULE))['legacy_owner_absent']
        owner=dict(pid=os.getpid(),birth=birth(os.getpid()))
        with mock.patch.dict(function.__globals__,birth=lambda _pid:''),mock.patch.object(Path,'exists',return_value=False):
            for code,stdout,stderr,expected in ((1,'','',True),(0,'','',False),(1,'warning','',False),(1,'','warning',False),(2,'','',False)):
                with self.subTest(code=code,stdout=stdout,stderr=stderr),mock.patch.object(subprocess,'run',return_value=subprocess.CompletedProcess(['ps'],code,stdout,stderr)):
                    self.assertEqual(function(owner),expected)
            with mock.patch.object(subprocess,'run',side_effect=OSError('fixture unavailable process observation')):
                self.assertFalse(function(owner))

    def test_retired_legacy_date_birth_also_releases_only_headroom(self):
        self.stale_standalone_fixture('legacy-date')

    def test_live_reused_unknown_pending_cohort_and_inflight_liability_is_preserved(self):
        for mode in ('live','reused','permission','birth-error','pending','cohort','inflight','malformed-pid','malformed-birth','malformed-member','malformed-group'):
            with self.subTest(mode=mode):self.stale_standalone_fixture(mode)

    def test_selected_job_access_is_bounded_at_ten_thousand_members(self):
        counts=[]
        for width in (8,10000):
            fixture=TicketFixture(self,width)
            self.assert_ok(fixture.prepare())
            owner=fixture.owner()
            self.assert_ok(fixture.assign(width-1,owner))
            process,trace,reserve=fixture.claim(width-1,owner)
            stdout,stderr=process.communicate(timeout=10)
            self.assertEqual(process.returncode,0,stdout+stderr)
            events=rows(trace)
            touched=[event for event in events if event['event'].startswith('metadata_')]
            self.assertTrue(touched,'no real claimant metadata accesses captured')
            counts.append((len(touched),sum(event.get('size',0)for event in touched)))
            self.assertEqual(reserve.stat().st_blocks*512,MB)
            self.assertFalse(any(event['event'].startswith('forbidden_')for event in events))
        print('keyed metadata width8/10000 operations, conservative bytes:',counts,flush=True)
        self.assertEqual(counts[0][0],counts[1][0],'per-job metadata operations grow with cohort width')
        self.assertLessEqual(counts[1][1],counts[0][1]+2048,'per-job read size grows with cohort width')

    def test_three_physical_ticket_allocators_overlap(self):
        fixture=TicketFixture(self,8)
        self.assert_ok(fixture.prepare())
        children=[]
        for index in range(3):
            owner=fixture.owner();self.assert_ok(fixture.assign(index,owner))
            children.append(fixture.claim(index,owner,'barrier'))
        end=time.monotonic()+5
        while time.monotonic()<end:
            if all(any(event['event']=='allocate'for event in rows(trace))for _,trace,_ in children):break
            time.sleep(.01)
        try:
            self.assertTrue(all(any(event['event']=='allocate'for event in rows(trace))for _,trace,_ in children),'physical ticket allocators serialized')
            self.assertTrue(all(process.poll()is None for process,_,_ in children))
        finally:fixture.release_barriers()
        for process,trace,reserve in children:
            stdout,stderr=process.communicate(timeout=10)
            self.assertEqual(process.returncode,0,stdout+stderr)
            self.assertEqual(reserve.stat().st_blocks*512,MB)

    def test_transient_allocation_uses_same_fd_and_identity(self):
        fixture=TicketFixture(self,8)
        self.assert_ok(fixture.prepare())
        owner=fixture.owner();self.assert_ok(fixture.assign(0,owner))
        process,trace,reserve=fixture.claim(0,owner,'transient')
        stdout,stderr=process.communicate(timeout=10)
        self.assertEqual(process.returncode,0,stdout+stderr)
        events=[event for event in rows(trace)if event['event']=='allocate']
        self.assertEqual(len(events),4)
        self.assertEqual(len({event['fd']for event in events}),1)
        self.assertEqual(len({tuple(event['identity'])for event in events}),1)
        self.assertEqual(reserve.stat().st_blocks*512,MB)


    def test_duplicate_live_claim_preserves_single_inode_and_generation(self):
        fixture=TicketFixture(self,8)
        self.assert_ok(fixture.prepare())
        owner=fixture.owner();self.assert_ok(fixture.assign(0,owner))
        first,first_trace,reserve=fixture.claim(0,owner,'barrier')
        end=time.monotonic()+4
        while time.monotonic()<end and not any(event['event']=='allocate'for event in rows(first_trace)):time.sleep(.01)
        self.assertTrue(any(event['event']=='allocate'for event in rows(first_trace)))
        identity=(reserve.stat().st_dev,reserve.stat().st_ino)
        second,second_trace,_=fixture.claim(0,owner)
        try:
            time.sleep(.15)
            self.assertIsNone(second.poll(),'duplicate bypassed the keyed owner lock')
            self.assertFalse(any(event['event']=='allocate'for event in rows(second_trace)))
            self.assertEqual((reserve.stat().st_dev,reserve.stat().st_ino),identity)
            self.assertIsNone(first.poll())
        finally:fixture.release_barriers()
        stdout,stderr=first.communicate(timeout=10)
        self.assertEqual(first.returncode,0,stdout+stderr)
        stdout,stderr=second.communicate(timeout=10)
        self.assertNotEqual(second.returncode,0,stdout+stderr)
        self.assertFalse(any(event['event']=='allocate'for event in rows(second_trace)))

    def test_owner_death_cannot_reassign_a_live_allocator(self):
        fixture=TicketFixture(self,8)
        self.assert_ok(fixture.prepare())
        owner=fixture.owner();self.assert_ok(fixture.assign(0,owner))
        first,trace,reserve=fixture.claim(0,owner,'barrier')
        end=time.monotonic()+4
        while time.monotonic()<end and not any(event['event']=='allocate'for event in rows(trace)):time.sleep(.01)
        self.assertTrue(any(event['event']=='allocate'for event in rows(trace)))
        identity=(reserve.stat().st_dev,reserve.stat().st_ino)
        stop_owned(owner)
        successor=fixture.owner()
        args=['--job',fixture.jobs[0],'--owner-pid',str(successor.pid),'--owner-start',birth(successor.pid),'--generation','2']
        assignment=subprocess.Popen([sys.executable,str(MODULE),'assign',*fixture.base[2:],*args],env=fixture.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        fixture.children.append(assignment)
        time.sleep(.15)
        self.assertIsNone(assignment.poll(),'dead owner was treated as proof its allocator had joined')
        self.assertEqual((reserve.stat().st_dev,reserve.stat().st_ino),identity)
        self.assertIsNone(first.poll())
        fixture.release_barriers()
        first.communicate(timeout=10)
        stdout,stderr=assignment.communicate(timeout=10)
        self.assertNotEqual(assignment.returncode,0,stdout+stderr)


    def test_cross_cohort_budget_is_debited_once_including_nested_floor(self):
        fixture=TicketFixture(self,3)
        (fixture.root/'free-kib').write_text(str(5*1024))
        self.assert_ok(fixture.prepare())
        budget_path=fixture.cohort/'cleanup-budget/budget.json'
        before=budget_path.read_bytes()
        self.assert_ok(fixture.prepare())
        self.assertEqual(budget_path.read_bytes(),before)
        budget=json.loads(before)
        grants=Path(budget['global_root'])/'ticket-grants'
        self.assertEqual(len(list(grants.glob('*.json'))),1)
        other=fixture.cohort.with_name('c002');other.mkdir()
        manifest=other/'manifest.json'
        manifest.write_text(json.dumps(dict(cohort_id='c002',jobs={'r001-j00000':None})))
        result=subprocess.run([sys.executable,str(MODULE),'prepare','--cohort',str(other),'--cohort-id','c002','--manifest',str(manifest),'--reserve-root',str(fixture.reserve_root),'--parent-pid',str(fixture.parent_pid),'--parent-start',fixture.parent_start,'--preferred','1','--minimum','1','--headroom','0'],env=fixture.env,capture_output=True,text=True,timeout=10)
        self.assertNotEqual(result.returncode,0,'second cohort overspent the first cohort plus reserved N2 floor')
        self.assertEqual(len(list(grants.glob('*.json'))),1)
        # A legacy v2 allocator has already debited 512 MiB provisionally, but
        # still owns a zero-block exact inode. Its minimum of 32 is not its
        # current liability and must not leak capacity to a new cohort.
        legacy=TicketFixture(self,1)
        (legacy.root/'free-kib').write_text(str(100*1024))
        ledger=Path('/tmp')/('rose-cloudbench-cleanup-admission-'+str(os.getuid()))/str(legacy.device)
        ledger.mkdir(parents=True,mode=0o700)
        pending=legacy.reserve_root/'legacy.reserve';pending.touch(mode=0o600)
        info=pending.stat()
        identifier='a'*64;member='standalone-'+identifier
        record=dict(group=identifier,job=member,pid=os.getpid(),birth=birth(os.getpid()),allocator_pid=os.getpid(),allocator_birth=birth(os.getpid()),path=str(pending),identity=[info.st_dev,info.st_ino],amount=512)
        state=dict(version=2,groups={identifier:dict(directory=None,parent_lock_identity=None,members=[member],consumed={member:dict(pid=os.getpid(),birth=birth(os.getpid()))},preferred=512,headroom=0,minimum=32)},inflight={'b'*64:record},failures={})
        state_path=ledger/'state.json';state_path.write_text(json.dumps(state));state_path.chmod(0o600)
        result=legacy.prepare()
        self.assertNotEqual(result.returncode,0,'legacy pending 512 MiB was reduced to its 32 MiB minimum')
        self.assertIn('insufficient physical cleanup cohort floors',result.stderr)
        self.assertEqual(pending.stat().st_blocks,0)
        self.assertEqual(json.loads(state_path.read_bytes()),state)

    def test_released_dead_generation_allows_exact_successor(self):
        fixture=TicketFixture(self,3)
        self.assert_ok(fixture.prepare())
        owner=fixture.owner();self.assert_ok(fixture.assign(0,owner))
        process,trace,reserve=fixture.claim(0,owner)
        stdout,stderr=process.communicate(timeout=10)
        self.assertEqual(process.returncode,0,stdout+stderr)
        stop_owned(owner)
        budget=json.loads((fixture.cohort/'cleanup-budget/budget.json').read_bytes())
        # A cold admission holds this lock across pending-block stats and df.
        # Physical shrink must wait; otherwise the same freed blocks can be
        # credited once in liability and again in freshly sampled free space.
        global_lock=(Path(budget['global_root'])/'admission.lock').open('r+')
        fcntl.flock(global_lock,fcntl.LOCK_EX)
        interrupted=subprocess.Popen([sys.executable,str(MODULE),'release',*fixture.base[2:],'--reserve',str(reserve)],env=dict(fixture.env,TICKET_RELEASE_CRASH=str(reserve)),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        fixture.children.append(interrupted)
        try:
            time.sleep(.15)
            self.assertIsNone(interrupted.poll())
            self.assertEqual(reserve.stat().st_blocks*512,MB,'release shrank pending blocks while a cold admission sampled capacity')
        finally:
            fcntl.flock(global_lock,fcntl.LOCK_UN);global_lock.close()
        stdout,stderr=interrupted.communicate(timeout=5)
        self.assertNotEqual(interrupted.returncode,0)
        self.assertTrue(reserve.exists())
        self.assertEqual(reserve.stat().st_blocks,0)
        self.assert_ok(fixture.command('release',['--reserve',reserve]))
        self.assertFalse(reserve.exists())
        successor=fixture.owner();self.assert_ok(fixture.assign(0,successor,generation=2))
        second,second_trace,_=fixture.claim(0,successor,generation=2)
        stdout,stderr=second.communicate(timeout=10)
        self.assertEqual(second.returncode,0,stdout+stderr)
        self.assertEqual(reserve.stat().st_blocks*512,MB)
        import hashlib
        key=hashlib.sha256(fixture.jobs[0].encode()).hexdigest()
        terminal=fixture.cohort/'cleanup-budget/terminal'/key[:2]/key
        receipt=json.loads((terminal/'g0001.released.json').read_bytes())
        self.assertTrue(receipt['physical_blocks_released'])
        self.assertTrue((terminal/'g0001.committed.json').exists())
        self.assertTrue((terminal/'g0002.committed.json').exists())
        stop_owned(successor)
        self.assert_ok(fixture.command('release',['--reserve',reserve]))
        # The campaign parent caches this exact module and retires in process.
        import runpy
        from types import SimpleNamespace
        module=runpy.run_path(str(MODULE))
        module['retire'](SimpleNamespace(cohort=str(fixture.cohort),cohort_id='c001'))
        self.assertTrue((fixture.cohort/'cleanup-budget/retired.json').exists())
        self.assertFalse((Path(budget['global_root'])/'ticket-grants'/(budget['global_budget_id']+'.json')).exists())
        self.assertTrue((terminal/'g0001.released.json').exists())
        self.assertTrue((terminal/'g0002.released.json').exists())

    def test_nested_slot_refuses_an_ordinary_owner_without_canary_ancestry(self):
        fixture=TicketFixture(self,3)
        self.assert_ok(fixture.prepare())
        owner=fixture.owner();self.assert_ok(fixture.assign(0,owner))
        result=fixture.command('claim',['--nested','--job',fixture.jobs[0],'--generation',1,'--owner-pid',owner.pid,'--owner-start',birth(owner.pid),'--reserve',fixture.reserve_root/'nested.reserve'])
        self.assertNotEqual(result.returncode,0)
        self.assertFalse((fixture.reserve_root/'nested.reserve').exists())


    def test_original_deadline_interrupts_physical_allocation_and_retains_claim(self):
        fixture=TicketFixture(self,3)
        self.assert_ok(fixture.prepare())
        owner=fixture.owner();self.assert_ok(fixture.assign(0,owner))
        start=time.monotonic()
        process,trace,reserve=fixture.claim(0,owner,'barrier',deadline=start+.15)
        stdout,stderr=process.communicate(timeout=2)
        self.assertNotEqual(process.returncode,0,stdout+stderr)
        self.assertLess(time.monotonic()-start,1.5)
        self.assertTrue(any(event['event']=='allocate'for event in rows(trace)))
        import hashlib
        key=hashlib.sha256(fixture.jobs[0].encode()).hexdigest()
        claim=fixture.cohort/'cleanup-budget/claims'/key[:2]/key/'g0001.json'
        self.assertTrue(claim.exists(),'deadline erased the ambiguous physical liability')
        self.assertTrue(reserve.exists())
        second,_,_=fixture.claim(0,owner)
        stdout,stderr=second.communicate(timeout=2)
        self.assertNotEqual(second.returncode,0,'deadline reset the same generation for another allocation')


    def test_canonical_nested_ancestry_reuses_one_released_slot(self):
        fixture=TicketFixture(self,3)
        canary=fixture.root/'canonical-canary.py'
        lock=fixture.root/'canary.lock'
        result_path=fixture.root/'canary-result.json'
        canary.write_text("""import fcntl,json,os,subprocess,sys
from pathlib import Path
lock=Path(sys.argv[2]);stream=lock.open('w');stream.write(str(os.getpid()));stream.flush();fcntl.flock(stream,fcntl.LOCK_EX)
boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
start='proc-start:'+boot+':'+Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]
module,cohort,reserve,result=sys.argv[3:]
common=['--cohort',cohort,'--cohort-id','c001']
codes=[]
foreign=[sys.executable,module,'claim',*common,'--nested','--job','r001-j00001','--generation','1','--owner-pid',str(os.getpid()),'--owner-start',start,'--reserve',reserve]
item=subprocess.run(foreign,capture_output=True,text=True)
codes.append(dict(action='foreign-origin',code=item.returncode,stderr=item.stderr))
assert item.returncode!=0 and not Path(reserve).exists()
for index in range(2):
 command=[sys.executable,module,'claim',*common,'--nested','--job','r001-j00000','--generation','1','--owner-pid',str(os.getpid()),'--owner-start',start,'--reserve',reserve]
 item=subprocess.run(command,capture_output=True,text=True);codes.append(dict(action='claim',code=item.returncode,stderr=item.stderr))
 item=subprocess.run([sys.executable,module,'release',*common,'--reserve',reserve],capture_output=True,text=True);codes.append(dict(action='release',code=item.returncode,stderr=item.stderr))
Path(result).write_text(json.dumps(codes))
sys.stdin.read()
""")
        self.assert_ok(fixture.prepare(['--canary-script',canary,'--canary-lock',lock]))
        from types import SimpleNamespace
        self.assert_ok(fixture.assign(0,SimpleNamespace(pid=os.getpid())))
        unrelated=fixture.owner();self.assert_ok(fixture.assign(1,unrelated))
        process=subprocess.Popen([sys.executable,str(canary),'--lock',str(lock),str(MODULE),str(fixture.cohort),str(fixture.reserve_root/'nested.reserve'),str(result_path)],env=fixture.env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        fixture.owners.append(process)
        end=time.monotonic()+5
        while not result_path.exists() and time.monotonic()<end:
            if process.poll()is not None:break
            time.sleep(.01)
        self.assertTrue(result_path.exists(),'actual canonical canary fixture failed to join its bounded CLI children')
        results=json.loads(result_path.read_bytes())
        self.assertNotEqual(results[0]['code'],0,results)
        self.assertEqual([item['code']for item in results[1:]],[0,0,0,0],results)
        import hashlib
        key=hashlib.sha256(b'__infra_canary__').hexdigest()
        terminal=fixture.cohort/'cleanup-budget/terminal'/key[:2]/key
        self.assertTrue((terminal/'g0001.released.json').exists())
        self.assertTrue((terminal/'g0002.released.json').exists())
        budget=json.loads((fixture.cohort/'cleanup-budget/budget.json').read_bytes())
        self.assertEqual(budget['job_count'],3,'nested canary expanded the sealed ordinary job budget')


    def test_nested_slot_recovers_after_a_dead_owner_left_no_claim(self):
        # A nested attempt can publish owners/current and then fail before its
        # claim (here: reserve outside the owned root). With no claim there is
        # no physical liability, so a later canary must get the next generation.
        fixture=TicketFixture(self,3)
        canary=fixture.root/'canonical-canary.py'
        lock=fixture.root/'canary.lock'
        canary.write_text("""import fcntl,json,os,subprocess,sys
from pathlib import Path
lock=Path(sys.argv[2]);stream=lock.open('w');stream.write(str(os.getpid()));stream.flush();fcntl.flock(stream,fcntl.LOCK_EX)
boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
start='proc-start:'+boot+':'+Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]
module,cohort,reserve,result=sys.argv[3:]
common=['--cohort',cohort,'--cohort-id','c001']
codes=[]
item=subprocess.run([sys.executable,module,'claim',*common,'--nested','--job','r001-j00000','--generation','1','--owner-pid',str(os.getpid()),'--owner-start',start,'--reserve',reserve],capture_output=True,text=True)
codes.append(dict(action='claim',code=item.returncode,stderr=item.stderr))
if item.returncode==0:
 item=subprocess.run([sys.executable,module,'release',*common,'--reserve',reserve],capture_output=True,text=True);codes.append(dict(action='release',code=item.returncode,stderr=item.stderr))
Path(result).write_text(json.dumps(codes))
""")
        self.assert_ok(fixture.prepare(['--canary-script',canary,'--canary-lock',lock]))
        from types import SimpleNamespace
        self.assert_ok(fixture.assign(0,SimpleNamespace(pid=os.getpid())))
        outside=fixture.root/'outside';outside.mkdir()
        outcomes=[]
        for index,reserve in enumerate((outside/'nested.reserve',fixture.reserve_root/'nested.reserve')):
            result_path=fixture.root/('canary-result-'+str(index)+'.json')
            process=subprocess.Popen([sys.executable,str(canary),'--lock',str(lock),str(MODULE),str(fixture.cohort),str(reserve),str(result_path)],env=fixture.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
            fixture.owners.append(process)
            stdout,stderr=process.communicate(timeout=15)
            self.assertEqual(process.returncode,0,stdout+stderr)
            outcomes.append(json.loads(result_path.read_bytes()))
        self.assertNotEqual(outcomes[0][0]['code'],0,outcomes)
        self.assertFalse((outside/'nested.reserve').exists())
        self.assertEqual([item['code']for item in outcomes[1]],[0,0],outcomes)
        import hashlib
        key=hashlib.sha256(b'__infra_canary__').hexdigest()
        root=fixture.cohort/'cleanup-budget'
        self.assertFalse((root/'claims'/key[:2]/key/'g0001.json').exists())
        self.assertTrue((root/'terminal'/key[:2]/key/'g0002.released.json').exists())


if __name__=='__main__':unittest.main()
