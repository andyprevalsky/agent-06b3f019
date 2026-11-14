#!/usr/bin/env python3
"""Sealed-cohort cleanup budgets; constant-size keyed admission per physical job.

Global accounting and O(N) membership work occur only on prepare/retire or a
standalone controller's cold admission, never on the selected-job claim path.
"""
from __future__ import annotations
import argparse
from contextlib import contextmanager
import errno
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time

MB = 1048576
NESTED = '__infra_canary__'
PARENT_PREFLIGHT = '__campaign_preflight__'

class Deadline(Exception): pass

@contextmanager
def until(deadline):
    previous=signal.getitimer(signal.ITIMER_REAL);handler=signal.getsignal(signal.SIGALRM)
    need(not previous[1], 'periodic cleanup alarm unsupported')
    started=time.monotonic()
    if previous[0]:deadline=min(deadline,started+previous[0])
    def expired(*unused):raise Deadline('original cleanup admission deadline exhausted')
    signal.signal(signal.SIGALRM,expired)
    signal.setitimer(signal.ITIMER_REAL,max(.000001,deadline-time.monotonic()))
    try:
        need(time.monotonic()<deadline,'original cleanup admission deadline exhausted')
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,handler)
        if previous[0]:signal.setitimer(signal.ITIMER_REAL,max(.000001,previous[0]-(time.monotonic()-started)))

def need(value, message):
    if not value: raise ValueError(message)

def birth(pid):
    try:
        if Path('/proc/self/stat').exists():
            fields=Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()
            return 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+fields[19]
        return ' '.join(subprocess.check_output(['ps','-p',str(pid),'-o','lstart='],env={**os.environ,'TZ':'UTC'},text=True).split())
    except (FileNotFoundError,ProcessLookupError): return ''
    except subprocess.CalledProcessError as exc:
        if exc.returncode==1:return ''
        raise

def physical(path, directory=False):
    path=Path(path)
    info=path.lstat()
    need((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) and info.st_uid==os.getuid() and not info.st_mode&0o022,'unsafe cleanup ticket path: '+str(path))
    need(path.resolve(strict=True)==path.absolute(),'linked cleanup ticket path')
    return info

def mkdir(path):
    path=Path(path);path.mkdir(mode=0o700,parents=True,exist_ok=True);physical(path,True)

def read(path, limit=1048576):
    physical(path)
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as stream:
        info=os.fstat(stream.fileno());need(info.st_size<=limit,'oversized cleanup record')
        raw=stream.read(limit+1)
    need(len(raw)<=limit,'oversized cleanup record')
    return json.loads(raw)

def sync_dir(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)

def write(path, value, replace=False):
    path=Path(path);mkdir(path.parent)
    raw=(json.dumps(value,sort_keys=True)+'\n').encode()
    temporary=path.with_name('.'+path.name+'.'+str(os.getpid())+'.'+str(time.time_ns())) if replace else path
    with os.fdopen(os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as stream:
        stream.write(raw);stream.flush();os.fsync(stream.fileno())
    if replace:os.replace(temporary,path)
    sync_dir(path.parent)

def digest(value):return hashlib.sha256((json.dumps(value,sort_keys=True)+'\n').encode()).hexdigest()
def key(job):return hashlib.sha256(job.encode()).hexdigest()
def keyed(base,kind,job):
    token=key(job);return base/kind/token[:2]/(token+'.json')
def generation(base,kind,job,number,suffix=''):
    token=key(job);return base/kind/token[:2]/token/('g%04d'%number+suffix+'.json')

def base_for(cohort):return Path(cohort).absolute()/'cleanup-budget'

@contextmanager
def lock(path, mode=fcntl.LOCK_EX, create=True):
    if create:mkdir(Path(path).parent)
    fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW|(os.O_CREAT if create else 0),0o600)
    try:
        physical(path);fcntl.flock(fd,mode);yield fd
    finally:os.close(fd)

def held(path, identity):
    info=physical(path);need([info.st_dev,info.st_ino]==identity,'cleanup parent lock inode changed')
    with lock(path,fcntl.LOCK_EX|fcntl.LOCK_NB,False):return False

def parent_active(budget):
    if birth(budget['parent_pid'])!=budget['parent_start']:return False
    try:return held(Path(budget['cohort']).parent/'parent.lock',budget['parent_lock_identity'])
    except BlockingIOError:return True

def validate_budget(base):
    value=read(base/'budget.json')
    need(value.get('schema')=='cloudbench-cleanup-ticket-budget-v1' and base==base_for(value['cohort']),'foreign cleanup budget')
    ready=read(base/'ready.json');need(ready=={'budget_sha256':digest(value)},'cleanup tickets not fully prepared')
    return value

def free_bytes(path):
    # Same native df contract as fleet reserve, rounded downward.
    output=subprocess.check_output(['bash','-c','df -Pk "$1"','ticket',str(path)],text=True)
    return int(output.splitlines()[-1].split()[3])*1024

def global_root(reserve_root):
    info=physical(reserve_root,True)
    root=Path('/tmp')/('rose-cloudbench-cleanup-admission-'+str(os.getuid()))/str(info.st_dev)
    mkdir(root);return root,info.st_dev

def cold_grant_liability(root):
    """Cold cross-cohort only. Stat exact claims before caller samples df."""
    total=0
    folder=root/'ticket-grants'
    if not folder.exists():return 0
    physical(folder,True)
    for path in folder.glob('*.json'):
        grant=read(path);base=Path(grant['base']);budget=read(base/'budget.json')
        need(grant=={'base':str(base),'budget_sha256':digest(budget)},'changed cleanup cohort grant')
        remaining=(budget['job_count']+1)*budget['amount']*MB
        credit=0
        for current in (base/'current').glob('*/*.json'):
            owner=read(current);job=owner['job'];number=owner['generation']
            claim_path=generation(base,'claims',job,number)
            if not claim_path.exists():continue
            claim=read(claim_path)
            need(claim['budget_sha256']==digest(budget) and claim['job']==job,'foreign cleanup claim')
            try:observed=physical(Path(claim['reserve']))
            except FileNotFoundError:continue
            if [observed.st_dev,observed.st_ino]==claim['identity']:
                credit+=min(budget['amount']*MB,max(0,observed.st_blocks*512))
        total+=max(0,remaining-credit)+(budget['job_count']+1)*budget['headroom']*MB
    return total

def legacy_owner_absent(owner):
    """Release working headroom only for a valid, positively absent owner."""
    need(isinstance(owner,dict) and set(owner)=={'pid','birth'}
         and type(owner['pid']) is int and owner['pid']>1
         and isinstance(owner['birth'],str), 'invalid legacy cleanup owner')
    stamp=owner['birth']
    if stamp.startswith('proc-start:'):
        need(re.fullmatch(r'proc-start:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9]+',stamp),
             'invalid legacy cleanup owner birth')
    else:
        need(re.fullmatch(r'(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}',stamp), 'invalid legacy cleanup owner birth')
        try:time.strptime(stamp,'%a %b %d %H:%M:%S %Y')
        except ValueError:raise ValueError('invalid legacy cleanup owner birth') from None
    try:
        if birth(owner['pid']):return False  # Live or reused PID retains its floor.
        try:os.kill(owner['pid'], 0)
        except ProcessLookupError:pass
        except OSError:return False
        if Path('/proc/self/stat').exists():
            try:Path('/proc',str(owner['pid'])).stat()
            except (FileNotFoundError,ProcessLookupError):return True
            return False
        observed=subprocess.run(['ps','-p',str(owner['pid']),'-o','lstart='],env={**os.environ,'TZ':'UTC'},capture_output=True,text=True)
        return observed.returncode==1 and not observed.stdout and not observed.stderr
    except (OSError,ValueError,subprocess.SubprocessError):return False

def legacy_liability(root):
    path=root/'state.json'
    if not path.exists():return 0
    state=read(path);need(state.get('version') in (1,2),'unknown legacy cleanup accounting')
    # Consumed owners already occupy native free space; pending members still
    # need their minimum. Unknown liveness never releases declared headroom.
    total=0
    for identifier,group in state['groups'].items():
        peers=len(group['members'])
        # Physical or unknown allocator debt is independent of an owner's birth.
        if group['directory'] is None and not any(record.get('group')==identifier for record in state.get('inflight',{}).values()):
            need(set(group)=={'directory','parent_lock_identity','members','consumed','preferred','minimum','headroom'}
                 and group['parent_lock_identity'] is None and isinstance(group['members'],list)
                 and group['members']==['standalone-'+identifier] and isinstance(group['consumed'],dict)
                 and set(group['consumed'])<=set(group['members']), 'invalid legacy standalone cleanup group')
            peers-=sum(legacy_owner_absent(owner) for owner in group['consumed'].values())
        total+=(peers*group['headroom']+(len(group['members'])-len(group['consumed']))*group['minimum'])*MB
    for group in state['groups'].values():
        if group['directory'] is not None:
            total+=(group['headroom']+group['minimum'])*MB
    for record in state.get('inflight',{}).values():
        amount=record['amount']*MB
        try:info=physical(Path(record['path']))
        except FileNotFoundError:total+=amount;continue
        if [info.st_dev,info.st_ino]!=record['identity']:total+=amount;continue
        total+=max(0,amount-max(0,info.st_blocks*512))
    return total

def retire_legacy_standalone_accounting(root):
    """Caller holds admission.lock; retire only positively dead, nondebited rows.

    No reserve file or provider resource is touched. A live or uncertain PID,
    including a reused PID, conservatively retains its existing accounting.
    """
    path=root/'state.json'
    if not path.exists():return
    state=read(path)
    expected={'version','groups'} if state.get('version')==1 else {'version','groups','inflight','failures'}
    if type(state.get('version')) is not int or state['version'] not in (1,2) or set(state)!=expected:return
    groups=state.get('groups');inflight=state.get('inflight',{})
    if type(groups) is not dict or type(inflight) is not dict:return
    # Even an unrelated or malformed debit may describe an unresolved writer.
    if inflight:return
    changed=False
    for identifier,group in list(groups.items()):
        if type(identifier) is not str or not re.fullmatch('[0-9a-f]{64}',identifier):continue
        if type(group) is not dict or set(group)!={'directory','parent_lock_identity','members','consumed','preferred','minimum','headroom'}:continue
        member='standalone-'+identifier
        if group['directory'] is not None or group['parent_lock_identity'] is not None:continue
        if group['members']!=[member] or type(group['consumed']) is not dict or set(group['consumed'])!={member}:continue
        if any(type(group[name]) is not int for name in ('preferred','minimum','headroom')):continue
        if not 1<=group['minimum']<=group['preferred']<=4096 or not 0<=group['headroom']<=16384:continue
        owner=group['consumed'][member]
        if type(owner) is not dict or set(owner)!={'pid','birth'}:continue
        if type(owner['pid']) is not int or owner['pid']<=1 or type(owner['birth']) is not str or not owner['birth']:continue
        try:
            if legacy_owner_absent(owner):
                del groups[identifier];changed=True
        except (OSError, ValueError):
            pass
    if changed:write(path,state,replace=True)


def prepare(args):
    cohort=Path(args.cohort).absolute();base=base_for(cohort);physical(cohort,True)
    need(args.parent_pid>1 and birth(args.parent_pid)==args.parent_start,'cleanup parent identity changed')
    need(1<=args.minimum<=args.preferred<=4096 and 0<=args.headroom<=16384,'invalid cleanup ticket policy')
    mkdir(base)
    with lock(base/'prepare.lock'):
        if (base/'ready.json').exists():
            budget=validate_budget(base)
            need((budget['parent_pid'],budget['parent_start'],budget['preferred'],budget['minimum'],budget['headroom'])==(args.parent_pid,args.parent_start,args.preferred,args.minimum,args.headroom),'cleanup ticket policy changed')
            return budget
        # Only cohort initialization reads the full immutable member set.
        manifest=read(Path(args.manifest).absolute(),16777216);jobs=manifest['jobs']
        need(manifest['cohort_id']==args.cohort_id and isinstance(jobs,dict) and jobs,'invalid cleanup cohort membership')
        need(all(re.fullmatch(r'r[0-9]+-j[0-9]+',job) for job in jobs),'invalid cleanup member')
        parent=physical(cohort.parent/'parent.lock')
        parent_identity=[parent.st_dev,parent.st_ino]
        try:need(not held(cohort.parent/'parent.lock',parent_identity),'cleanup parent lock not held')
        except BlockingIOError:pass
        reserve_root=Path(args.reserve_root).absolute();mkdir(reserve_root)
        root,device=global_root(reserve_root);grant_id=hashlib.sha256(str(base).encode()).hexdigest()
        with lock(root/'admission.lock'):
            grant_path=root/'ticket-grants'/(grant_id+'.json')
            if grant_path.exists():
                budget=read(base/'budget.json')
                need(read(grant_path)=={'base':str(base),'budget_sha256':digest(budget)},'changed incomplete cleanup grant')
            else:
                retire_legacy_standalone_accounting(root)
                liability=cold_grant_liability(root)+legacy_liability(root)
                slots=len(jobs)+1
                available=free_bytes(reserve_root)-liability-slots*args.headroom*MB
                need(available>=slots*args.minimum*MB,'insufficient physical cleanup cohort floors')
                amount=min(args.preferred,available//(slots*MB))
                budget=dict(schema='cloudbench-cleanup-ticket-budget-v1',cohort=str(cohort),cohort_id=args.cohort_id,parent_pid=args.parent_pid,parent_start=args.parent_start,parent_lock_identity=parent_identity,device=device,reserve_root=str(reserve_root),preferred=args.preferred,minimum=args.minimum,headroom=args.headroom,amount=amount,job_count=len(jobs),members_sha256=digest(sorted(jobs)),global_root=str(root),global_budget_id=grant_id,deadline=manifest.get('e2e_deadline_monotonic',args.deadline),canary_script=args.canary_script or '',canary_sha256=hashlib.sha256(Path(args.canary_script).read_bytes()).hexdigest() if args.canary_script else '',canary_lock=args.canary_lock or '',canary_source_ref=getattr(args,'canary_source_ref',None) or '',canary_ticket_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),canary_runner_sha256=hashlib.sha256((Path(args.canary_script).parent/'run-fleet-infra-canary').read_bytes()).hexdigest() if args.canary_script and (Path(args.canary_script).parent/'run-fleet-infra-canary').is_file() else '')
                write(base/'budget.json',budget)
                write(grant_path,dict(base=str(base),budget_sha256=digest(budget)))
        # The durable grant covers the complete cohort while tickets are minted;
        # expensive per-member fsync never holds the global accounting lock.
        for job in [*jobs,NESTED]:
            value=dict(job=job,budget_sha256=digest(budget),amount=budget['amount'],cohort_id=args.cohort_id)
            path=keyed(base,'members',job)
            if path.exists():need(read(path)==value,'cleanup member ticket changed')
            else:write(path,value)
        for name in ('owners','claims','terminal','current','locks'):mkdir(base/name)
        with lock(base/'scope.lock'):pass
        write(base/'ready.json',dict(budget_sha256=digest(budget)))
        return budget

def selected(base,job):
    budget=validate_budget(base);member=read(keyed(base,'members',job))
    need(member==dict(job=job,budget_sha256=digest(budget),amount=budget['amount'],cohort_id=budget['cohort_id']),'cleanup member changed')
    return budget,member

def owner_record(args,budget):
    need(args.owner_pid>1 and birth(args.owner_pid)==args.owner_start,'cleanup owner identity changed')
    need(type(args.generation) is int and args.generation>=1,'invalid cleanup generation')
    return dict(job=args.job,generation=args.generation,owner_pid=args.owner_pid,owner_start=args.owner_start,budget_sha256=digest(budget))

def assign(args):
    base=base_for(args.cohort)
    with lock(base/'scope.lock',fcntl.LOCK_SH,False),lock(keyed(base,'locks',args.job)):
        budget,_=selected(base,args.job)
        need(parent_active(budget) and not (base/'closing.json').exists(),'cleanup cohort closed')
        need(os.getppid()==budget['parent_pid'] or os.getpid()==budget['parent_pid'],'only exact campaign parent assigns cleanup owner')
        owner=owner_record(args,budget);current=keyed(base,'current',args.job)
        if current.exists():
            prior=read(current)
            need(args.generation==prior['generation']+1,'cleanup generation already assigned')
            need(not birth(prior['owner_pid']) or birth(prior['owner_pid'])!=prior['owner_start'],'previous cleanup owner still live')
            oldclaim=generation(base,'claims',args.job,prior['generation'])
            if oldclaim.exists():
                released=read(generation(base,'terminal',args.job,prior['generation'],'.released'))
                need(released['owner']==prior and released['physical_blocks_released'] is True,'previous physical cleanup unconfirmed')
        else:need(args.generation==1,'first cleanup generation must be one')
        write(generation(base,'owners',args.job,args.generation),owner)
        write(current,owner,True)
        return owner

def nested_identity(budget, owner_pid, origin):
    script=budget['canary_script'];path=Path(budget['canary_lock'])
    need(script and str(path),'missing canonical nested cleanup binding')
    need(origin['budget_sha256']==digest(budget) and birth(origin['owner_pid'])==origin['owner_start'], 'nested origin owner changed')
    current=owner_pid;seen=set();canonical=False
    while current>1 and current not in seen:
        seen.add(current)
        if current==origin['owner_pid']:
            need(canonical,'nested controller lacks canonical canary ancestor')
            return
        fields=Path('/proc',str(current),'stat').read_text().rsplit(') ',1)[1].split()
        argv=Path('/proc',str(current),'cmdline').read_bytes().split(b'\0')
        script_index = 2 if len(argv)>2 and argv[1] == b'-S' else 1
        if len(argv)>script_index and Path(argv[script_index].decode()).name==Path(script).name and b'--lock' in argv:
            actual_script=Path(argv[script_index].decode());physical(actual_script)
            need(hashlib.sha256(actual_script.read_bytes()).hexdigest()==budget['canary_sha256'],'nested canary source changed')
            index=argv.index(b'--lock');need(argv[index+1].decode()==str(path),'foreign nested transaction')
            info=physical(path);need(path.read_text().strip()==str(current),'nested lock PID changed')
            try:need(not held(path,[info.st_dev,info.st_ino]),'nested transaction not held')
            except BlockingIOError:canonical=True
        current=int(fields[1])
    raise ValueError('not the canonical nested canary ancestry')

def retry_allocate(fd,size,deadline):
    for attempt in range(8):
        try:
            if hasattr(os,'posix_fallocate'):os.posix_fallocate(fd,0,size)
            else:raise OSError(errno.ENOTSUP,'native allocation unavailable')
            os.fsync(fd);info=os.fstat(fd)
            need(info.st_size==size and info.st_blocks*512>=size,'physical cleanup blocks missing')
            return
        except OSError as exc:
            if exc.errno in (errno.ENOSYS,errno.EOPNOTSUPP,errno.ENOTSUP):
                # Preserve held FD lock if an interrupted Python leaves dd alive.
                target='/dev/fd/'+str(fd)
                subprocess.run(['dd','if=/dev/zero','of='+target,'bs=1048576','count='+str(size//MB),'conv=notrunc,fsync'],check=True,pass_fds=(fd,),stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=max(.001,deadline-time.monotonic()))
                os.fsync(fd);info=os.fstat(fd);need(info.st_size==size and info.st_blocks*512>=size,'physical cleanup blocks missing');return
            if exc.errno not in (errno.EINTR,errno.EAGAIN,errno.EBUSY) or attempt==7:raise
            delay=min(.05*2**attempt,1)
            need(time.monotonic()+delay<deadline,'cleanup allocation original deadline exhausted')
            time.sleep(delay)

def claim(args):
    with until(args.deadline or time.monotonic()+30):
        return claim_inner(args)


def claim_inner(args):
    base=base_for(args.cohort)
    job=NESTED if args.nested else args.job
    if not args.nested:
        waiting_until=min(time.monotonic()+30,args.deadline or math.inf)
        owner_path=generation(base,'owners',job,args.generation)
        while not owner_path.exists():
            need(time.monotonic()<waiting_until,'parent did not publish cleanup owner assignment')
            time.sleep(.02)
    with lock(base/'scope.lock',fcntl.LOCK_SH,False),lock(keyed(base,'locks',job)):
        budget,_=selected(base,job)
        if budget['deadline']:
            remaining=budget['deadline']-time.monotonic()
            need(remaining>0,'original cleanup campaign deadline exhausted')
            armed=signal.getitimer(signal.ITIMER_REAL)[0]
            signal.setitimer(signal.ITIMER_REAL,min(armed,remaining))
        need(parent_active(budget) and not (base/'closing.json').exists(),'cleanup cohort parent retired')
        if args.nested:
            if args.job == PARENT_PREFLIGHT:
                need(args.generation == 1 and re.fullmatch('[0-9a-f]{40}', budget.get('canary_source_ref', '')), 'invalid parent preflight origin')
                origin = {'owner_pid': budget['parent_pid'], 'owner_start': budget['parent_start'], 'budget_sha256': digest(budget)}
            else:
                origin=read(generation(base,'owners',args.job,args.generation))
                need(read(keyed(base,'current',args.job))==origin,'nested origin assignment changed')
            nested_identity(budget,args.owner_pid,origin);args.job=job;args.generation=1
            record=owner_record(args,budget);current=keyed(base,'current',job)
            if current.exists():
                prior=read(current)
                # One shared N2 slot; never grant a duplicate unknown generation.
                # As in assign(), a release receipt is owed only by an existing claim;
                # an unclaimed generation needs its exact prior owner retired.
                if generation(base,'claims',job,prior['generation']).exists():
                    need(read(generation(base,'terminal',job,prior['generation'],'.released'))['physical_blocks_released'] is True,'nested cleanup slot still occupied')
                else:
                    need(not birth(prior['owner_pid']) or birth(prior['owner_pid'])!=prior['owner_start'],'nested cleanup slot still occupied')
                args.generation=prior['generation']+1;record=owner_record(args,budget)
            write(generation(base,'owners',job,args.generation),record);write(current,record,True)
        owner=read(generation(base,'owners',job,args.generation));need(owner==owner_record(args,budget) and read(keyed(base,'current',job))==owner,'cleanup assignment changed')
        reserve=Path(args.reserve).absolute();physical(reserve.parent,True)
        need(reserve.is_relative_to(Path(budget['reserve_root'])),'cleanup reserve outside owned cohort root')
        need(reserve.parent.stat().st_dev==budget['device'],'cleanup reserve filesystem changed')
        claim_path=generation(base,'claims',job,args.generation)
        need(not claim_path.exists(),'cleanup ticket already claimed; reconcile original generation')
        sidecar=Path(str(reserve)+'.ticket.json')
        if sidecar.exists():
            prior_binding=read(sidecar)
            need(prior_binding['base']==str(base) and prior_binding['job']==job and prior_binding['generation']<args.generation,'cleanup sidecar belongs to another claim')
            old_record=read(generation(base,'claims',job,prior_binding['generation']))
            released=read(generation(base,'terminal',job,prior_binding['generation'],'.released'))
            need(prior_binding['claim_sha256']==digest(old_record) and released['claim_sha256']==digest(old_record) and released['physical_blocks_released'] is True,'old cleanup sidecar release unconfirmed')
            sidecar.unlink();sync_dir(sidecar.parent)
        fd=os.open(reserve,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);info=os.fstat(fd)
            record=dict(job=job,generation=args.generation,owner_pid=args.owner_pid,owner_start=args.owner_start,allocator_pid=os.getpid(),allocator_start=birth(os.getpid()),reserve=str(reserve),identity=[info.st_dev,info.st_ino],amount=budget['amount'],budget_sha256=digest(budget))
            write(claim_path,record)
            write(Path(str(reserve)+'.ticket.json'),dict(base=str(base),job=job,generation=args.generation,claim_sha256=digest(record)))
            deadline=min(time.monotonic()+30,budget['deadline'] or math.inf,args.deadline or math.inf)
            try:
                need(time.monotonic()<deadline,'original cleanup deadline exhausted')
                retry_allocate(fd,budget['amount']*MB,deadline)
                need(birth(args.owner_pid)==args.owner_start and parent_active(budget),'cleanup owner/parent retired during allocation')
                observed=physical(reserve);need([observed.st_dev,observed.st_ino]==record['identity'],'cleanup allocation inode changed')
                write(generation(base,'terminal',job,args.generation,'.committed'),dict(owner=owner,claim_sha256=digest(record),physical_blocks_verified=True))
            except BaseException as exc:
                if isinstance(exc,Deadline):raise
                failed=generation(base,'terminal',job,args.generation,'.failed')
                if not failed.exists():write(failed,dict(owner=owner,claim_sha256=digest(record),error=type(exc).__name__,physical_release_verified=False))
                raise
        finally:os.close(fd)
    return budget['amount']

def release(args):
    reserve=Path(args.reserve).absolute();sidecar=Path(str(reserve)+'.ticket.json');binding=read(sidecar);base=Path(binding['base']);job=binding['job'];number=binding['generation']
    with lock(base/'scope.lock',fcntl.LOCK_SH,False),lock(keyed(base,'locks',job)):
        budget,_=selected(base,job);record=read(generation(base,'claims',job,number));owner=read(generation(base,'owners',job,number))
        need(binding['claim_sha256']==digest(record) and record['reserve']==str(reserve),'cleanup release binding changed')
        need(os.getppid()==owner['owner_pid'] and birth(owner['owner_pid'])==owner['owner_start'] or birth(record['allocator_pid'])!=record['allocator_start'] and birth(owner['owner_pid'])!=owner['owner_start'],'cleanup release owner still live or foreign')
        receipt=generation(base,'terminal',job,number,'.released')
        already_released=None
        if receipt.exists():
            already_released=read(receipt)
            need(already_released==dict(owner=owner,claim_sha256=digest(record),physical_blocks_released=True,identity=record['identity']),'cleanup release incomplete')
            if not reserve.exists():return
        fd=os.open(reserve,os.O_RDWR|os.O_NOFOLLOW)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);info=os.fstat(fd)
            need([info.st_dev,info.st_ino]==record['identity'],'cleanup release inode changed')
            # Serialize only shrink accounting with cold stat-before-df grant
            # admission. Growing physical allocation remains fully parallel.
            with lock(Path(budget['global_root'])/'admission.lock'):
                if already_released:
                    need(info.st_size==0 and info.st_blocks==0,'released cleanup inode gained blocks')
                else:
                    os.ftruncate(fd,0);os.fsync(fd);need(os.fstat(fd).st_blocks==0,'cleanup blocks not released')
                    write(receipt,dict(owner=owner,claim_sha256=digest(record),physical_blocks_released=True,identity=record['identity']))
                current=physical(reserve);need([current.st_dev,current.st_ino]==record['identity'],'cleanup release path changed')
                reserve.unlink();sync_dir(reserve.parent)
        finally:os.close(fd)

def retire(args):
    base=base_for(args.cohort)
    with lock(base/'scope.lock',fcntl.LOCK_EX|fcntl.LOCK_NB,False):
        budget=validate_budget(base)
        need(birth(budget['parent_pid'])!=budget['parent_start'] or (os.getpid()==budget['parent_pid'] or os.getppid()==budget['parent_pid']) and birth(budget['parent_pid'])==budget['parent_start'],'foreign cleanup cohort retirement')
        if not (base/'closing.json').exists():write(base/'closing.json',dict(parent_pid=budget['parent_pid'],parent_start=budget['parent_start'],no_more_assignments=True))
        for current in (base/'current').glob('*/*.json'):
            owner=read(current)
            need(birth(owner['owner_pid'])!=owner['owner_start'],'cleanup owner still live')
            claim_path=generation(base,'claims',owner['job'],owner['generation'])
            if claim_path.exists():
                record=read(claim_path)
                need(birth(record['allocator_pid'])!=record['allocator_start'],'cleanup allocator still live')
                need(read(generation(base,'terminal',owner['job'],owner['generation'],'.released'))['physical_blocks_released'] is True,'cleanup physical release unknown')
        root=Path(budget['global_root'])
        with lock(root/'admission.lock'):
            grant=root/'ticket-grants'/(budget['global_budget_id']+'.json')
            need(read(grant)==dict(base=str(base),budget_sha256=digest(budget)),'cleanup grant changed')
            write(base/'retired.json',dict(budget_sha256=digest(budget),all_assigned_owners_retired=True))
            grant.unlink();sync_dir(grant.parent)

def parse(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['prepare','assign','claim','release','retire'])
    for name in ('cohort','cohort-id','manifest','reserve-root','job','reserve','parent-start','owner-start','canary-script','canary-lock','canary-source-ref'):parser.add_argument('--'+name)
    for name in ('parent-pid','owner-pid','generation'):parser.add_argument('--'+name,type=int)
    for name,default in [('preferred',512),('minimum',32),('headroom',256)]:parser.add_argument('--'+name,type=int,default=default)
    parser.add_argument('--deadline',type=float);parser.add_argument('--nested',action='store_true');return parser.parse_args(argv)

def main():
    args=parse()
    result=globals()[args.action](args)
    if args.action=='claim':print(result)
    elif result is not None:print(json.dumps(result,sort_keys=True))

if __name__=='__main__':main()
