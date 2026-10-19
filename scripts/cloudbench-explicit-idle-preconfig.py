#!/usr/bin/env python3
"""Recover only an exact dead owner's never-started explicit-idle pool cohort."""
from pathlib import Path
import argparse,base64,fcntl,hashlib,json,os,re,runpy,signal,socket,stat,time,subprocess
HERE=Path(__file__).resolve().parent
H=runpy.run_path(str(HERE/'cloudbench-explicit-idle-admission.py'))
B=runpy.run_path(str(HERE/'cloudbench-original-volume-capture.py'))
need=H['require'];read=H['read'];sha=H['sha'];canonical=H['canonical']
def pid_birth_state(pid,start):
    # Repository libraries are nested; the immutable fleet snapshot is flat.
    # Invoke the unchanged canonical shell predicate in either layout.
    library=HERE/'lib/cloudbench-env.sh'
    if not library.exists():library=HERE/'cloudbench-env.sh'
    read(library)
    result=subprocess.run(['bash','-c','source "$1" >/dev/null || exit; cloudbench_pid_birth_state "$2" "$3"',
                           'preconfig-owner',str(library),pid,start],capture_output=True,text=True,timeout=20)
    need(result.returncode==0,'canonical PID birth predicate failed')
    state=result.stdout.strip();need(state in {'live','absent','unknown'},'invalid PID birth state');return state
def fields(path):
    pairs=[line.split('=',1) for line in read(path,65536).decode().splitlines()]
    need(all(len(p)==2 for p in pairs),'field syntax');value=dict(pairs);need(len(value)==len(pairs),'duplicate field');return value

def directory(path):
    need(path.is_absolute() and path.resolve(strict=True)==path and path.is_dir(),'physical directory');return path

def save(path,value):
    raw=canonical(value)
    if path.exists():need(read(path)==raw,'existing recovery record differs');return
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    sync(path.parent)

def sync(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)

def plan(registry,common,source):
    registry=directory(Path(registry));common=directory(Path(common));owner=registry.name
    need(re.fullmatch('[0-9a-f]{32}',owner),'owner token');meta=fields(registry/'meta')
    need(meta.get('version')=='2' and meta.get('fleet_owner_token')==owner and meta.get('host')==socket.gethostname(),'owner identity')
    need(meta.get('cleanup_policy') in {'reap','retain'},'owner policy')
    need(pid_birth_state(meta['pid'],meta['pid_start'])=='absent','owner is not dead')
    run=directory(Path(meta['runs_root'])/meta['run_id'])
    # Audit root is recorded by the original owner, never inferred from a new run.
    audit=directory(Path(meta['audit_dir']));need(audit==common/'cloudbench-fleet-audits'/owner,'audit owner')
    am=fields(audit/'meta');need(all(am.get(k)==meta.get(k) for k in ('fleet_owner_token','app','run_id')),'audit identity')
    lifecycle=json.loads(read(run/'_batch/lifecycle.json'))
    need(lifecycle.get('status')=='failed' and lifecycle.get('fleet_owner_token')==owner and lifecycle.get('run_id')==meta['run_id'] and type(lifecycle.get('controller_exit_code')) is int and lifecycle['controller_exit_code']!=0,'owner not terminal failed')
    for folder in (registry/'clones',audit/'fresh',audit/'expected-fresh',audit/'by-machine-id'):
        need(not list(directory(folder).iterdir()),'fresh allocation present')
    for name in ('owned-clones.ids','owned-clones.names'):need(read(audit/name)==b'','fresh ownership ledger')
    for name in ('release',):need(not os.path.lexists(run/'.boot-config-barrier'/name),'boot barrier released/aborted')
    ready=directory(run/'.boot-config-barrier/ready');need(not list(ready.iterdir()),'configured guest present')
    contract=runpy.run_path(str(HERE/'cloudbench_execution_provenance.py'))
    prov=contract['load_provenance'](run/'execution-provenance.json');matrix=contract['load_task_matrix'](run/'execution-task-matrix.json')
    need(not contract['validate_task_matrix_binding'](prov,matrix),'task binding')
    need(prov['base_sha']==source,'source differs')
    values=prov['config']['values']
    need(all(values.get(k)=='1' for k in ('boot_launch','primary_reuse_only','cold_primary_bootstrap')),'original bootstrap flags')
    need(all(t['world_model_mode']=='real' for t in matrix['tasks']),'non-real cohort')
    tasks=json.loads(read(run/'_batch/benches.json'));need([{'name':x['name'],'world_model_mode':'simulate' if x['mode']=='SIM' else 'real'} for x in tasks]==matrix['tasks'],'catalog differs')
    pool={p.name:fields(p) for p in directory(audit/'pool').iterdir()};need(pool,'empty borrowed cohort')
    rows=[];seen=set(); originals={}
    def retain(path):
        raw=read(path);originals[str(path)]=base64.b64encode(raw).decode();return raw
    for path in (registry/'meta',audit/'meta',run/'_batch/lifecycle.json',run/'execution-provenance.json',run/'execution-task-matrix.json',run/'_batch/benches.json'):retain(path)
    for name in ('runtime-evidence-unconfirmed','guest-cleanup-unconfirmed'):
        path=registry/name
        if os.path.lexists(path):retain(path)
    for ordinal,task in enumerate(tasks):
        out=directory(run/task['name']);cid=out/'.cid'
        if not cid.exists():
            need(not any(os.path.lexists(out/n) for n in ('runtime-evidence.owner.json','runtime-evidence.pending','boot-config-unapplied')),'unmapped runtime');continue
        parts=retain(cid).decode().split();need(len(parts)==2 and parts[0]=='pool' and re.fullmatch('[0-9a-f]{14}',parts[1]),'not borrowed pool')
        mid=parts[1];need(mid not in seen and mid in pool,'duplicate/unmapped Machine');seen.add(mid);row=pool[mid]
        need(all(row.get(k)==meta.get(k) for k in ('fleet_owner_token','app','run_id')) and row.get('source')=='borrowed-pool' and row.get('machine_id')==mid and row.get('disposition')=='claimed','pool audit')
        claim=common/'cloudbench-pool-claims'/mid;cr=retain(claim);cf=fields(claim)
        need(all(cf.get(k)==meta.get(k) for k in ('fleet_owner_token','host','pid','pid_start')) and cf.get('cleanup_state') in {'owned','unconfirmed'},'claim owner')
        need(retain(out/'benchmark-child.finished').strip()==b'125' and retain(out/'boot-config-unapplied').strip()==mid.encode(),'not unapplied failure')
        need(retain(out/'autoscaler.completed-after-child')==b'' and retain(out/'desired-worker-count').strip()==b'0','worker controller not joined')
        if os.path.lexists(out/'worker-clones.ids'):need(retain(out/'worker-clones.ids')==b'','worker allocation')
        expected=dict(version=1,machine_id=mid,run_token=owner+'-'+str(ordinal))
        runtime_paths=[out/'runtime-evidence.owner.json',out/'runtime-evidence.pending']
        present=[os.path.lexists(path) for path in runtime_paths]
        need(present in ([False,False],[True,True]),'mixed runtime ownership')
        if all(present):
            need(all(json.loads(retain(path))==expected for path in runtime_paths),'runtime ownership')
        for name in ('post-config-start.accepted','cloudbench-run.json','worker-runtime-evidence','status-proxy.port','cloudbench-boot-start.log','guest-shutdown.confirmed'):
            need(not os.path.lexists(out/name),'possible guest start')
        retain(out/'cloudbench-boot-update.log');retain(audit/'pool'/mid)
        proof=common/'cloudbench-pool-reuse'/(mid+'.json');pv=json.loads(retain(proof));need('explicit_idle' in pv,'not explicit idle')
        cold=json.loads(retain(out/'cold-primary-bootstrap'))
        need(cold==dict(version=1,policy=H['current_policy'](proof),machine_id=mid,volume_id=row['volume_id'],source_ref=source,run_id=meta['run_id'],run_token=owner+'-'+str(ordinal),proof_sha256=sha(read(proof))),'original cold intent')
        retain(Path(pv['explicit_idle']['admission']['path']));retain(Path(pv['explicit_idle']['completion_path']))
        admission=H['described'](pv['explicit_idle']['admission']);need(admission['consumer']['source_ref']==source and admission['consumer']['pool_ids_file']==row['pool_ledger_file'],'admission source/ledger')
        ledger=Path(row['pool_ledger_file']);need(ledger.parent==common/'cloudbench-pools' and mid in retain(ledger).decode().splitlines(),'pool ledger')
        need(sha(retain(Path(row['pool_meta_file'])))==row['pool_meta_sha256'],'pool baseline')
        rows.append(dict(machine=mid,volume=row['volume_id'],output=str(out),claim=str(claim),claim_sha256=sha(cr),audit=str(audit/'pool'/mid),proof=str(proof)))
    need(seen==set(pool),'unmapped audited Machine')
    return dict(schema='explicit-idle-preconfig-recovery-v1',owner=owner,registry=str(registry),run=str(run),source_ref=source,rows=rows,originals=originals)

def recover(registry,common,source,native_read,volume_read,checkpoint=lambda stage:None):
    p=plan(registry,common,source);common=Path(common);registry=Path(registry)
    root=registry/'explicit-idle-preconfig-recovery';root.mkdir(mode=0o700);sync(registry)
    save(root/'intent.json',dict(owner=p['owner'],source_ref=source));locks=[]
    try:
        for row in sorted(p['rows'],key=lambda r:r['machine']):
            lock=common/'cloudbench-pool-claims/.locks'/(row['machine']+'.lock')
            directory(lock.parent)
            fd=os.open(lock,os.O_RDWR|os.O_NOFOLLOW);need(stat.S_ISREG(os.fstat(fd).st_mode),'claim mutex');fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);locks.append(fd)
        need(plan(registry,common,source)==p,'originals changed')
        observations={}
        for row in p['rows']:
            mid=row['machine'];before=root/(mid+'.before.json');after=root/(mid+'.after.json')
            save(before,native_read(mid));volume=volume_read(row['volume']);save(root/(mid+'.volume.json'),volume);save(after,native_read(mid))
            H['verify_pool'](row['proof'],common,H['descriptor'](before),H['descriptor'](after),source,volume)
            observations[mid]=dict(before=H['descriptor'](before),after=H['descriptor'](after),volume=H['descriptor'](root/(mid+'.volume.json')))
        archive=dict(p,observations=observations,historical_task_credit=0,status='VERIFIED_UNAPPLIED')
        save(root/'archive.json',archive);checkpoint('archived')
        need(plan(registry,common,source)==p,'originals changed after archive')
        for row in p['rows']:
            claim=Path(row['claim']);need(sha(read(claim))==row['claim_sha256'],'claim changed')
            old=fields(Path(row['audit']));updated=dict(old,disposition='returned-stopped-claim-released')
            temp=Path(row['audit']+'.preconfig-return')
            # Canonical field format matches fleet_audit_record_pool_machine.
            raw=''.join(k+'='+v+'\n' for k,v in updated.items()).encode()
            fd=os.open(str(temp)+'.fields',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
            os.replace(str(temp)+'.fields',row['audit']);sync(Path(row['audit']).parent)
            claim.unlink();sync(claim.parent)
            save(root/(row['machine']+'.returned.json'),dict(archive_sha256=sha(read(root/'archive.json')),claim_sha256=row['claim_sha256'],status='RETURNED_STOPPED'))
        checkpoint('returned')
        # Original runtime bytes are archived before retiring pending latches.
        for row in p['rows']:
            pending=Path(row['output'])/'runtime-evidence.pending'
            if pending.exists():pending.unlink();sync(pending.parent)
        for name in ('runtime-evidence-unconfirmed','guest-cleanup-unconfirmed'):
            path=registry/name
            if path.exists():path.unlink();sync(registry)
        result=dict(status='RECOVERED_STOPPED',owner=p['owner'],machines=[r['machine'] for r in p['rows']],archive_sha256=sha(read(root/'archive.json')),historical_task_credit=0)
        save(root/'complete.json',result);return result
    except BaseException as error:
        try:save(root/'pending.json',dict(status='PENDING_NO_RETRY',owner=p['owner'],error_class=type(error).__name__))
        except Exception:pass
        raise
    finally:
        for fd in locks:os.close(fd)

class RecoveryDeadline(BaseException):
    pass


def bounded_read(fn,deadline):
    previous=signal.getitimer(signal.ITIMER_REAL);handler=signal.getsignal(signal.SIGALRM)
    need(previous[1]==0,'periodic caller timer')
    start=time.monotonic();remaining=min(20,deadline-start)
    if remaining<=0:raise RecoveryDeadline('recovery deadline expired')
    if previous[0]>0:remaining=min(remaining,previous[0])
    def expired(*unused):raise RecoveryDeadline('bounded recovery read expired')
    signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,remaining)
    try:
        value=fn()
        if time.monotonic()>=start+remaining:raise RecoveryDeadline('late recovery read')
        return value
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,handler)
        if previous[0]>0:signal.setitimer(signal.ITIMER_REAL,max(.000001,previous[0]-(time.monotonic()-start)))


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--registry',type=Path,required=True);parser.add_argument('--common',type=Path,required=True);parser.add_argument('--source',required=True);args=parser.parse_args()
    # The invoking canonical exact-owner command holds its recovery mutex.
    app=fields(args.registry/'meta')['app'];deadline=time.monotonic()+180;client=runpy.run_path(str(HERE/'cloudbench-campaign-machines.py'))
    native=lambda mid:bounded_read(lambda:json.loads(client['fetch'](app,20,mid)),deadline)
    volume=lambda vid:bounded_read(lambda:B['Fly'](app,os.environ['FLY_API_TOKEN']).api('GET','/volumes/'+vid,timeout=20),deadline)
    previous=signal.getitimer(signal.ITIMER_REAL);handler=signal.getsignal(signal.SIGALRM)
    need(previous[1]==0,'periodic caller timer')
    def expired(*unused):raise RecoveryDeadline('whole recovery180s expired')
    signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,min(180,previous[0]) if previous[0]>0 else 180)
    start=time.monotonic()
    try:print(json.dumps(recover(args.registry,args.common,args.source,native,volume),sort_keys=True))
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,handler)
        if previous[0]>0:signal.setitimer(signal.ITIMER_REAL,max(.000001,previous[0]-(time.monotonic()-start)))
if __name__=='__main__':main()
