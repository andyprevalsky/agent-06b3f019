#!/usr/bin/env python3
"""Return only a dead owner's fully verified staged probe cohort; no lifecycle calls."""
from pathlib import Path
import argparse,base64,fcntl,json,os,re,runpy,socket,stat,signal,time
HERE=Path(__file__).resolve().parent
P=runpy.run_path(str(HERE/'cloudbench-explicit-idle-preconfig.py'))
S=runpy.run_path(str(HERE/'cloudbench-staged-boot-return.py'))
H=S['H'];need,read,sha=P['need'],P['read'],P['sha'];fields,directory,save,sync=P['fields'],P['directory'],P['save'],P['sync']

def guard(registry, common, fd, pid, birth):
    path=common/'cloudbench-fleet-recovery-locks'/registry.name;directory(path.parent)
    a=os.fstat(fd);b=path.lstat()
    need(fd>2 and stat.S_ISREG(a.st_mode) and a.st_nlink==1 and (a.st_dev,a.st_ino)==(b.st_dev,b.st_ino),'canonical recovery mutex')
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    lock=fields(registry/'recovery-lock/meta')
    need(lock==dict(host=socket.gethostname(),pid=str(pid),pid_start=birth),'recovery owner binding')
    need(P['pid_birth_state'](str(pid),birth)=='live','recovery owner not live')

def plan(registry,common,source):
    registry=directory(Path(registry));common=directory(Path(common));meta=fields(registry/'meta');owner=registry.name
    need(re.fullmatch('[0-9a-f]{32}',owner) and meta.get('version')=='2' and meta.get('fleet_owner_token')==owner and meta.get('host')==socket.gethostname(),'original owner identity')
    need(P['pid_birth_state'](meta['pid'],meta['pid_start'])=='absent','original owner not dead')
    need(meta.get('cleanup_policy')=='reap','original owner retained')
    run=directory(Path(meta['runs_root'])/meta['run_id']);audit=directory(Path(meta['audit_dir']))
    need(audit==common/'cloudbench-fleet-audits'/owner and Path(meta['workspace_root'])==run.parent.parent.parent.parent,'original roots')
    am=fields(audit/'meta');need(all(am.get(k)==meta.get(k) for k in ('fleet_owner_token','app','run_id')),'original audit identity')
    lifecycle=json.loads(read(run/'_batch/lifecycle.json'))
    need(lifecycle.get('status')=='failed' and lifecycle.get('fleet_owner_token')==owner and lifecycle.get('run_id')==meta['run_id'] and type(lifecycle.get('controller_exit_code'))is int and lifecycle['controller_exit_code']!=0,'original failed terminal')
    for folder in (registry/'clones',audit/'fresh',audit/'expected-fresh',audit/'by-machine-id'):
        need(not list(directory(folder).iterdir()),'fresh allocation present')
    for name in ('owned-clones.ids','owned-clones.names'):need(read(audit/name)==b'','fresh ownership ledger')
    for name in ('runtime-evidence-unconfirmed','guest-cleanup-unconfirmed','cold-handoff-outgoing'):
        need(not os.path.lexists(registry/name),'unconfirmed or outgoing owner')
    contract=H['sibling']('cloudbench_execution_provenance.py');prov=contract['load_provenance'](run/'execution-provenance.json');matrix=contract['load_task_matrix'](run/'execution-task-matrix.json')
    need(not contract['validate_task_matrix_binding'](prov,matrix) and prov['base_sha']==source,'original task source')
    values=prov['config']['values'];need(values.get('boot_transport')=='staged' and values.get('infra_probe')=='1' and all(values.get(k)=='1'for k in ('boot_launch','primary_reuse_only','cold_primary_bootstrap')),'not staged probe cohort')
    tasks=json.loads(read(run/'_batch/benches.json'));need([{'name':t['name'],'world_model_mode':'simulate' if t['mode']=='SIM' else 'real'}for t in tasks]==matrix['tasks'],'original task catalog')
    pool={p.name:fields(p)for p in directory(audit/'pool').iterdir()};rows=[];seen=set();originals={}
    def retain(path):
        raw=read(path);originals[str(path)]=base64.b64encode(raw).decode();return raw
    for path in (registry/'meta',audit/'meta',run/'_batch/lifecycle.json',run/'execution-provenance.json',run/'execution-task-matrix.json',run/'_batch/benches.json'):retain(path)
    for task in tasks:
        out=directory(run/task['name']);parts=retain(out/'.cid').decode().split();need(len(parts)==2 and parts[0]=='pool','not borrowed probe');mid=parts[1]
        need(re.fullmatch('[0-9a-f]{14}',mid) and mid not in seen and mid in pool,'unmapped probe');seen.add(mid);row=pool[mid]
        need(all(row.get(k)==meta.get(k)for k in ('fleet_owner_token','app','run_id')) and row.get('source')=='borrowed-pool' and row.get('machine_id')==mid and row.get('disposition')=='claimed','original pool audit')
        claim=common/'cloudbench-pool-claims'/mid;cr=retain(claim);cf=fields(claim)
        need(all(cf.get(k)==meta.get(k)for k in ('fleet_owner_token','host','pid','pid_start')) and cf.get('cleanup_state')=='owned','original exact claim')
        receipt_path=out/'staged-boot/return.json';receipt=json.loads(retain(receipt_path));need(receipt.get('status')=='STOPPED_PROBE_VERIFIED' and receipt.get('real_task_credit')==receipt.get('historical_task_credit')==0,'original probe return missing')
        index=common/'cloudbench-staged-boot-returns'/(mid+'.json');retain(index)
        need(json.loads(read(index))['receipt']==H['descriptor'](receipt_path),'original return index')
        for key in ('before','after','volume','proof','shutdown'):
            need(H['descriptor'](receipt[key]['path'])==receipt[key],'original return evidence changed');retain(Path(receipt[key]['path']))
        for desc in receipt['probe_evidence'].values():
            need(H['descriptor'](desc['path'])==desc,'original probe evidence changed');retain(Path(desc['path']))
        ledger=Path(row['pool_ledger_file']);meta_file=Path(row['pool_meta_file'])
        need(ledger.parent==common/'cloudbench-pools' and mid in retain(ledger).decode().splitlines() and meta_file==Path(str(ledger)+'.deps') and sha(retain(meta_file))==row['pool_meta_sha256'],'original pool baseline')
        retain(audit/'pool'/mid)
        rows.append(dict(machine=mid,volume=row['volume_id'],output=str(out),claim=str(claim),claim_sha256=sha(cr),audit=str(audit/'pool'/mid)))
    need(seen==set(pool) and rows,'unmapped original audited cohort')
    return dict(schema='staged-probe-owner-recovery-v1',owner=owner,registry=str(registry),source_ref=source,rows=rows,originals=originals)

def recover(registry,common,source,native_read,volume_read,guard_fd,pid,birth):
    registry=Path(registry);common=Path(common);guard(registry,common,guard_fd,pid,birth);p=plan(registry,common,source)
    root=registry/'staged-probe-return-recovery';root.mkdir(mode=0o700);sync(registry);save(root/'intent.json',dict(owner=p['owner'],source_ref=source));locks=[]
    try:
        for row in sorted(p['rows'],key=lambda x:x['machine']):
            lock=common/'cloudbench-pool-claims/.locks'/(row['machine']+'.lock');directory(lock.parent);fd=os.open(lock,os.O_RDWR|os.O_NOFOLLOW);a=os.fstat(fd);b=lock.lstat();need(stat.S_ISREG(a.st_mode)and a.st_nlink==1 and(a.st_dev,a.st_ino)==(b.st_dev,b.st_ino),'exact Machine mutex');fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);locks.append(fd)
        need(plan(registry,common,source)==p,'originals changed');observations={}
        for row in p['rows']:
            mid=row['machine'];before=root/(mid+'.before.json');after=root/(mid+'.after.json');vol=root/(mid+'.volume.json')
            save(before,native_read(mid));save(vol,volume_read(row['volume']));save(after,native_read(mid))
            result=S['_verify'](row['output'],registry,common,source,mid,row['volume'],before,after,vol,expected_owner='absent')
            S['verify_existing_return'](result,common);observations[mid]=result
        save(root/'archive.json',dict(plan=p,fresh=observations,historical_task_credit=0,real_task_credit=0));need(plan(registry,common,source)==p,'originals changed after archive')
        for row in p['rows']:
            claim=Path(row['claim']);need(sha(read(claim))==row['claim_sha256'],'claim changed')
            updated=dict(fields(Path(row['audit'])),disposition='returned-stopped-claim-released');temp=Path(row['audit']+'.staged-recovery')
            raw=''.join(k+'='+v+'\n'for k,v in updated.items()).encode()
            fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb')as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
            os.replace(temp,row['audit']);sync(Path(row['audit']).parent)
            claim.unlink();sync(claim.parent);S['released'](row['output'],common,row['machine'])
            save(root/(row['machine']+'.returned.json'),dict(status='RETURNED_STOPPED_PROBE',claim_sha256=row['claim_sha256'],archive_sha256=sha(read(root/'archive.json'))))
        result=dict(status='RECOVERED_STOPPED_PROBES',owner=p['owner'],machines=[r['machine']for r in p['rows']],archive_sha256=sha(read(root/'archive.json')),historical_task_credit=0,real_task_credit=0);save(root/'complete.json',result);return result
    except BaseException as error:
        try:save(root/'pending.json',dict(status='PENDING_NO_RETRY',error_class=type(error).__name__))
        except Exception:pass
        raise
    finally:
        for fd in locks:os.close(fd)

def main():
    parser=argparse.ArgumentParser()
    for name in ('registry','common'):parser.add_argument('--'+name,type=Path,required=True)
    for name in ('source','recovery-pid','recovery-birth'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--guard-fd',type=int,required=True);a=parser.parse_args();app=fields(a.registry/'meta')['app'];deadline=time.monotonic()+180
    client=H['sibling']('cloudbench-campaign-machines.py');B=P['B']
    native=lambda mid:P['bounded_read'](lambda:json.loads(client['fetch'](app,20,mid)),deadline)
    volume=lambda vid:P['bounded_read'](lambda:B['Fly'](app,os.environ['FLY_API_TOKEN']).api('GET','/volumes/'+vid,timeout=20),deadline)
    previous=signal.getitimer(signal.ITIMER_REAL);handler=signal.getsignal(signal.SIGALRM);need(previous[1]==0,'periodic caller timer')
    def expired(*unused):raise P['RecoveryDeadline']('whole recovery180s expired')
    signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,min(180,previous[0])if previous[0]>0 else 180);start=time.monotonic()
    try:print(json.dumps(recover(a.registry,a.common,a.source,native,volume,a.guard_fd,int(a.recovery_pid),a.recovery_birth),sort_keys=True))
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,handler)
        if previous[0]>0:signal.setitimer(signal.ITIMER_REAL,max(.000001,previous[0]-(time.monotonic()-start)))
if __name__=='__main__':main()
