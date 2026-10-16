#!/usr/bin/env python3
"""Explicit current-custody admission. No provider calls or historical task credit."""
from __future__ import annotations
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat
import subprocess
import sys
import time

SCHEMA = 'cloudbench-explicit-idle-admission-v1'
ORIGIN = 'explicit-user-idle-resource'


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read(path, limit=4 * 1024 * 1024):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, 'linked input')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit, 'unsafe input')
        raw = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    require(len(raw) == before.st_size and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'input changed')
    return raw


def descriptor(path):
    path = Path(path); raw = read(path); info = path.stat()
    return dict(path=str(path), sha256=sha(raw), bytes=len(raw), device=info.st_dev, inode=info.st_ino)


def described(value):
    require(isinstance(value, dict) and set(value) == {'path','sha256','bytes','device','inode'}, 'descriptor fields')
    require(descriptor(value['path']) == value, 'descriptor changed')
    return json.loads(read(value['path']))


def sibling(name):
    return runpy.run_path(str(Path(__file__).with_name(name)))


def billing_predicate():
    return sibling('cloudbench-original-volume-capture.py')['BILLING_GUEST']


def observe_processes(machine, nonce, deadline):
    # Execute the canonical current billing predicate byte-for-byte apart from
    # its existing explicit TARGET/NONCE bindings. Never change old archives.
    code=billing_predicate().replace('TARGET',repr(machine)).replace('NONCE',repr(nonce))
    remaining=deadline-time.monotonic()
    require(remaining>0,'observation deadline')
    return json.loads(subprocess.check_output([sys.executable,'-c',code],timeout=min(20,remaining)))


def observation(data, machine, instance, nonce):
    """Guest read-only collector; caller owns existing bounded START/STOP lifecycle."""
    base = sibling('cloudbench-startup-failure-archive.py')
    deadline=time.monotonic()+35
    data = Path(data); repo = data / 'repo'
    require(data == Path('/data'), 'noncanonical data root')
    def workspace():
        require(not repo.is_symlink(), 'linked workspace')
        if not repo.exists():
            return {'kind':'absent'}
        require(repo.is_dir(), 'workspace is not directory')
        if not any(repo.iterdir()):
            return {'kind':'empty', 'device':repo.stat().st_dev, 'inode':repo.stat().st_ino}
        require((repo / '.git').is_dir() and not (repo / '.git').is_symlink(), 'non-Git data needs retained-worktree preparation')
        def git(*args):
            remaining=deadline-time.monotonic();require(remaining>0,'workspace observation deadline')
            return subprocess.check_output(['git','-c','safe.directory='+str(repo),'-C',str(repo),*args], timeout=min(5,remaining))
        return dict(kind='existing-git', device=repo.stat().st_dev, inode=repo.stat().st_ino,
                    head=git('rev-parse','HEAD').decode().strip(), status_sha256=sha(git('status','--porcelain=v1','--untracked-files=all')))
    start = time.time(); first = observe_processes(machine,nonce,deadline); mount = base['current_cold_mount'](data)
    before = workspace(); deps = base['current_cold_dependencies'](); after = workspace()
    last = observe_processes(machine,nonce,deadline)
    require(before == after and mount == base['current_cold_mount'](data), 'workspace/mount changed')
    require({k:v for k,v in first.items() if k != 'observed_epoch'} ==
            {k:v for k,v in last.items() if k != 'observed_epoch'}, 'guest changed')
    return dict(schema='cloudbench-explicit-idle-observation-v1', origin=ORIGIN, machine_id=machine,
                native_instance=instance, admission_nonce=nonce, historical_task_credit=0,
                collector_sha256=sha(Path(__file__).read_bytes()), predicate_sha256=sha(billing_predicate().encode()),
                workspace=before, data_mount=mount, dependencies=deps, before=first, after=last,
                started_epoch=start, finished_epoch=time.time())


def native_pair(before, after, resource, reader=described):
    first, last = reader(before), reader(after)
    require(first == last, 'native pair differs')
    config = first.get('config', {})
    require(first.get('id') == resource['machine_id'] and first.get('name') == resource['name'] and first.get('state') == 'stopped'
            and first.get('instance_id') == resource['instance_id'], 'native identity/state')
    require(sha(canonical(config)) == resource['config_sha256'], 'native config')
    require(config.get('init') == {'cmd':['sleep','infinity']} and config.get('env') in (None, {}), 'not unchanged inert configuration')
    require(config.get('restart') == {'policy':'no'} and config.get('auto_destroy') in (None, False), 'unsafe lifecycle config')
    require(config.get('mounts') and len(config['mounts']) == 1 and config['mounts'][0].get('volume') == resource['volume_id']
            and config['mounts'][0].get('path') == '/data', 'native Volume')
    shape=resource['shape']
    require(set(shape)=={'cpu_kind','cpus','memory_mb'} and shape['cpu_kind'] in {'shared','performance'}
            and type(shape['cpus']) is int and shape['cpus']>0 and type(shape['memory_mb']) is int and shape['memory_mb']>0, 'invalid shape')
    require(config.get('guest') == shape, 'native shape')
    require(config.get('image','').rpartition('@')[2] == resource['image_digest'], 'configured image')
    require((first.get('image_ref') or {}).get('digest') == resource['image_digest'], 'native image')
    return first


def validate_request(request, reader=described):
    require(request['schema'] == 'cloudbench-explicit-idle-request-v1' and request['origin'] == ORIGIN
            and request['historical_task_credit'] == 0, 'admission origin')
    require(re.fullmatch('[0-9a-f]{32}', request['admission_nonce']), 'nonce')
    require(set(request['allowed_future_roles']) <= {'primary','worker'} and request['allowed_future_roles']
            and len(set(request['allowed_future_roles']))==len(request['allowed_future_roles']), 'future roles')
    resource = request['resource']; target = request['consumer']
    for key in ('controller_before','controller_after','workspace_ownership'):
        reader(request[key])
    require(re.fullmatch('[0-9a-f]{14}', resource['machine_id']) and re.fullmatch('vol_[A-Za-z0-9_-]+', resource['volume_id']), 'resource IDs')
    require(re.fullmatch('[0-9a-f]{64}', resource['config_sha256']) and re.fullmatch('sha256:[0-9a-f]{64}', resource['image_digest']), 'native digests')
    require(re.fullmatch('[0-9a-f]{40}', target['source_ref']), 'consumer ref')
    common = Path(target['common']); ledger = Path(target['pool_ids_file'])
    require(common.resolve(strict=True) == common and ledger.parent == common / 'cloudbench-pools'
            and ledger.name.endswith('.cold.ids') and target['pool_meta_file'] == str(ledger)+'.deps', 'canonical consumer pool')
    require(Path(target['workspace']).resolve(strict=True) == Path(target['workspace']), 'consumer workspace')
    for key in ('node','python'):
        require(re.fullmatch('[0-9a-f]{64}', target['dependencies'][key]), 'dependency digest')
    final = native_pair(request['native_before'], request['native_after'], resource, reader)
    volume = reader(request['volume'])
    require(volume['id'] == resource['volume_id'] and volume['attached_machine_id'] == resource['machine_id']
            and volume['state'] == 'created', 'attached Volume changed')
    protected = reader(request['protected_overlay'])
    require(resource['machine_id'] not in protected['machines'] and resource['volume_id'] not in protected['volumes'], 'protected resource')
    snap = request['preservation']; receipt = reader(snap['receipt']); available = reader(snap['available_read'])
    require(receipt['volume_id'] == resource['volume_id'] and receipt['snapshot_id'] == snap['snapshot_id']
            and receipt['machine_id']==resource['machine_id'] and receipt['source_instance']==resource['instance_id']
            and receipt['source_config_sha256']==resource['config_sha256'] and receipt['capture_state']=='stopped', 'snapshot receipt binding')
    require(available['volume_id'] == resource['volume_id'], 'snapshot GET binding')
    ready = sibling('cloudbench-select-snapshot.py')['available_snapshot'](available['snapshots'], snap['snapshot_id'])
    require(ready is not None and ready == receipt['available'], 'snapshot unavailable/changed')
    guest = reader(request['observation']); terminal = reader(request['observer_terminal'])
    require(guest['schema'] == 'cloudbench-explicit-idle-observation-v1' and guest['origin'] == ORIGIN
            and guest['machine_id'] == resource['machine_id'] and guest['native_instance'] == resource['instance_id']
            and guest['admission_nonce'] == request['admission_nonce'] and guest['historical_task_credit'] == 0, 'guest binding')
    require(re.fullmatch('[0-9a-f-]{36}',guest['before'].get('boot','')), 'guest boot identity')
    mounted=guest['data_mount']
    require(set(mounted)=={'device','inode','mount_device'} and type(mounted['device']) is int and mounted['device']>0
            and type(mounted['inode']) is int and mounted['inode']>0 and re.fullmatch('[0-9]+:[0-9]+',mounted['mount_device']), 'data mount identity')
    require(guest['collector_sha256'] == sha(Path(__file__).read_bytes())
            and guest['predicate_sha256'] == sha(billing_predicate().encode()), 'guest source')
    for side in ('before','after'):
        scan = guest[side]
        require(set(scan)=={'kind','machine','nonce','boot','unknown','inert_sleepers','idle_pinned_agents','idle_platform_hallpass','observed_epoch'}, 'guest scan fields')
        pids=set()
        for role in ('inert_sleepers','idle_pinned_agents','idle_platform_hallpass'):
            require(isinstance(scan[role],list),'guest role rows')
            for row in scan[role]:
                require(type(row.get('pid')) is int and row['pid']>0 and row['pid'] not in pids
                        and re.fullmatch('[0-9]+',row.get('birth','')), 'guest process birth')
                pids.add(row['pid'])
        require(len(scan['idle_platform_hallpass'])<=1,'guest platform duplicate')
        require(scan['kind'] == 'exact-inert-quiescence-v1' and scan['machine'] == resource['machine_id']
                and scan['nonce']==request['admission_nonce'] and scan['unknown'] == [] and scan['inert_sleepers'], 'guest quiescence')
    require({k:v for k,v in guest['before'].items() if k != 'observed_epoch'} ==
            {k:v for k,v in guest['after'].items() if k != 'observed_epoch'}, 'guest process identity changed')
    require(guest['dependencies'] == target['dependencies'], 'guest dependencies')
    require(receipt['verified_epoch'] <= guest['started_epoch'] <= guest['finished_epoch'] <= terminal['finished_epoch'], 'preservation/observation terminal order')
    require(terminal['status'] == 'OBSERVED_AND_STOPPED' and terminal['machine_id'] == resource['machine_id']
            and terminal['admission_nonce'] == request['admission_nonce'] and terminal['observation_sha256'] == request['observation']['sha256'], 'observer terminal')
    kind = guest['workspace']['kind']
    require((kind in ('absent','empty') and request['workspace_policy'] == 'real-empty-bootstrap-v1')
            or (kind == 'existing-git' and request['workspace_policy'] == 'existing-git-reset-v1'), 'workspace policy')
    return final


def authorize(authority_path, authority_sha, request, request_sha, custody_fd):
    require(os.geteuid() == 0, 'root authority required')
    path = Path(authority_path); raw = read(path); info = path.stat(); authority = json.loads(raw)
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and sha(raw) == authority_sha, 'authority custody')
    resource = request['resource']
    for key, expected in dict(schema='explicit-idle-authority-v1', app=resource['app'], machine_id=resource['machine_id'],
                              volume_id=resource['volume_id'], admission_nonce=request['admission_nonce'], request_sha256=request_sha,
                              sole_operator=True, old_actors_joined=True, historical_task_credit=0).items():
        require(authority.get(key) == expected, 'authority '+key)
    require(authority['protected_overlay'] == {k:request['protected_overlay'][k] for k in ('path','sha256')}, 'authority protected overlay')
    require(authority['coordinator_thread'] and set(authority['allowed_operations']) == {'observe','same-config-start','stop','publish-pool'}, 'authority operations')
    lock = Path(authority['custody_lock']); lock_info = lock.stat(); fd_info = os.fstat(custody_fd)
    require(lock.resolve(strict=True) == lock and stat.S_ISREG(lock_info.st_mode) and lock_info.st_uid == 0
            and stat.S_IMODE(lock_info.st_mode) == 0o600 and (lock_info.st_dev,lock_info.st_ino) == (fd_info.st_dev,fd_info.st_ino), 'custody descriptor')
    fcntl.flock(custody_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return descriptor(path)


def publish(request_path, request_sha, authority_path, authority_sha, custody_fd, *, checkpoint=lambda phase: None):
    raw = read(request_path); require(sha(raw) == request_sha, 'request changed'); request = json.loads(raw)
    require(raw==canonical(request),'request must use canonical JSON bytes')
    authority = authorize(authority_path, authority_sha, request, request_sha, custody_fd)
    native = validate_request(request); resource=request['resource']; target=request['consumer']; common=Path(target['common'])
    # The canonical CLI supplies its computed namespace, including any source-manifest suffix.
    for key, env in (('workspace','CLOUDBENCH_IDLE_WORKSPACE'),('common','CLOUDBENCH_IDLE_COMMON'),
                     ('pool_ids_file','CLOUDBENCH_IDLE_POOL_IDS'),('pool_meta_file','CLOUDBENCH_IDLE_POOL_META')):
        require(target[key] == os.environ.get(env), 'canonical consumer '+key)
    endpoint=sibling('cloudbench-startup-failure-archive.py')['capture_cold_handoff_target'](
        target['workspace'],target['common'],request['controller_before']['path'],request['controller_after']['path'],
        request['workspace_ownership']['path'],target['source_ref'],Path(target['pool_ids_file']).name)
    require(all(target[key]==value for key,value in endpoint.items()), 'actual consumer endpoint')
    base = sibling('cloudbench-startup-failure-archive.py'); claims=common/'cloudbench-pool-claims'; uid=common.stat().st_uid; gid=common.stat().st_gid
    def sync_directory(path):
        fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:os.fsync(fd)
        finally:os.close(fd)
    def directory(path):
        if not path.exists():
            path.mkdir(mode=0o700);os.chown(path,uid,gid)
            sync_directory(path);sync_directory(path.parent)
        info=path.lstat()
        require(path.resolve(strict=True)==path and stat.S_ISDIR(info.st_mode) and info.st_uid==uid
                and not stat.S_IMODE(info.st_mode)&0o022, 'unsafe output directory')
    directory(claims); directory(claims/'.locks')
    lock_path=claims/'.locks'/(resource['machine_id']+'.lock'); new_lock=not lock_path.exists()
    with os.fdopen(os.open(lock_path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600),'r+b') as lock:
        if new_lock:os.fchown(lock.fileno(),uid,gid)
        info=os.fstat(lock.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==uid,'unsafe pool lock inode')
        os.fsync(lock.fileno());sync_directory(lock_path.parent)
        fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        hold=claims/resource['machine_id']; require(not os.path.lexists(hold), 'resource already claimed')
        directory(common/'cloudbench-explicit-idle'); directory(common/'cloudbench-pool-reuse'); directory(common/'cloudbench-pools')
        admission=common/'cloudbench-explicit-idle'/(resource['machine_id']+'.json')
        proof_path=common/'cloudbench-pool-reuse'/(resource['machine_id']+'.json')
        completion=admission.with_suffix('.complete.json')
        require(not os.path.lexists(admission) and not os.path.lexists(proof_path), 'resource already admitted')
        def save(path,value):
            base['durable_handoff_json'](path,value);os.chown(path,uid,gid)
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
            try:os.fsync(fd)
            finally:os.close(fd)
            sync_directory(path.parent)
        save(hold,dict(schema=SCHEMA,origin=ORIGIN,admission_nonce=request['admission_nonce'],request_sha256=request_sha,status='PENDING'))
        checkpoint('claimed')
        ledger=Path(target['pool_ids_file']); meta=Path(target['pool_meta_file'])
        baseline=(target['dependencies']['node']+' '+target['dependencies']['python']+' cold-image-bootstrap\n').encode()
        with base['cold_handoff_ledger_lock'](Path(str(ledger)+'.lock')):
            if meta.exists():require(read(meta)==baseline,'pool baseline mismatch')
            else:
                with open(meta,'xb') as stream:stream.write(baseline);stream.flush();os.fsync(stream.fileno())
                os.chown(meta,uid,gid);meta.chmod(0o600)
                fd=os.open(meta,os.O_RDONLY|os.O_NOFOLLOW);os.fsync(fd);os.close(fd)
                sync_directory(meta.parent)
            ids=read(ledger).decode().splitlines() if ledger.exists() else []
            require(resource['machine_id'] not in ids,'duplicate pool credit')
            evidence={}
            def seal(value):
                if isinstance(value,dict):
                    if set(value)=={'path','sha256','bytes','device','inode'}:
                        described(value)
                        raw_evidence=read(value['path'])
                        require(sha(raw_evidence)==value['sha256'] and len(raw_evidence)==value['bytes'],'evidence changed during seal')
                        evidence[value['sha256']]=base64.b64encode(raw_evidence).decode()
                    else:
                        for child in value.values():seal(child)
                elif isinstance(value,list):
                    for child in value:seal(child)
            seal(request)
            result=dict(schema=SCHEMA,origin=ORIGIN,historical_task_credit=0,request=request,request_sha256=request_sha,
                        evidence=evidence,authority=authority,resource=resource,consumer=target,
                        workspace_policy=request['workspace_policy'],allowed_future_roles=request['allowed_future_roles'],status='VERIFIED')
            save(admission,result); checkpoint('attested')
            proof={key:resource[key] for key in ('app','machine_id','name','volume_id','instance_id','config_sha256','image_digest')};proof['version']=1
            proof['explicit_idle']=dict(admission=descriptor(admission),completion_path=str(completion),workspace_policy=request['workspace_policy'],allowed_future_roles=request['allowed_future_roles'])
            save(proof_path,proof); checkpoint('proved')
            tmp=ledger.with_name('.'+ledger.name+'.'+request['admission_nonce'])
            with open(tmp,'xb') as stream:stream.write(('\n'.join(ids+[resource['machine_id']])+'\n').encode());stream.flush();os.fsync(stream.fileno())
            os.chown(tmp,uid,gid);tmp.chmod(0o600)
            fd=os.open(tmp,os.O_RDONLY|os.O_NOFOLLOW);os.fsync(fd);os.close(fd)
            os.replace(tmp,ledger)
            fd=os.open(ledger.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);os.fsync(fd);os.close(fd)
            checkpoint('published')
            save(completion,dict(schema=SCHEMA,status='COMPLETE',admission_sha256=sha(read(admission)),
                                 proof_sha256=sha(read(proof_path)),request_sha256=request_sha,pool_ids_file=str(ledger)))
            checkpoint('completed')
        hold.unlink();fd=os.open(claims,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);os.fsync(fd);os.close(fd)
        return dict(result,status='COMPLETE')


def verify_pool(proof_path, common, before, after, expected_source, volume, role='primary'):
    proof=json.loads(read(proof_path)); extension=proof['explicit_idle']; admission=described(extension['admission'])
    require(admission['schema']==SCHEMA and admission['status']=='VERIFIED' and admission['origin']==ORIGIN
            and admission['historical_task_credit']==0 and role in admission['allowed_future_roles'], 'admission terminal/role')
    request=admission['request']
    require(sha(canonical(request))==admission['request_sha256'], 'sealed request digest')
    def sealed(descriptor):
        raw=base64.b64decode(admission['evidence'][descriptor['sha256']],validate=True)
        require(sha(raw)==descriptor['sha256'] and len(raw)==descriptor['bytes'],'sealed evidence')
        return json.loads(raw)
    validate_request(request,sealed)
    expected_complete=Path(common)/'cloudbench-explicit-idle'/(proof['machine_id']+'.complete.json')
    require(extension['completion_path']==str(expected_complete),'completion path')
    complete=json.loads(read(expected_complete))
    require(complete==dict(schema=SCHEMA,status='COMPLETE',admission_sha256=extension['admission']['sha256'],
                          proof_sha256=sha(read(proof_path)),request_sha256=admission['request_sha256'],
                          pool_ids_file=admission['consumer']['pool_ids_file']), 'publication incomplete')
    require(proof['machine_id'] in read(admission['consumer']['pool_ids_file']).decode().splitlines(),'pool publication missing')
    require(admission['consumer']['common']==str(Path(common).resolve(strict=True)) and admission['consumer']['source_ref']==expected_source
            and admission['consumer']['machine']==os.environ.get('FLY_MACHINE_ID'), 'consumer common/ref/Machine')
    require(extension['workspace_policy']==request['workspace_policy'] and extension['allowed_future_roles']==request['allowed_future_roles'], 'proof policy')
    native_pair(before,after,admission['resource'])
    require(volume['id']==proof['volume_id'] and volume['attached_machine_id']==proof['machine_id'] and volume['state']=='created','current Volume')
    require(all(proof[key]==admission['resource'][key] for key in ('app','machine_id','name','volume_id','instance_id','config_sha256','image_digest')),'proof identity')
    return proof


def main():
    parser=argparse.ArgumentParser(description=__doc__); sub=parser.add_subparsers(dest='action',required=True)
    admit=sub.add_parser('admit');admit.add_argument('--request',required=True);admit.add_argument('--sha256',required=True);admit.add_argument('--authority',required=True);admit.add_argument('--authority-sha256',required=True);admit.add_argument('--custody-fd',type=int,required=True)
    capture=sub.add_parser('observe');capture.add_argument('--machine',required=True);capture.add_argument('--instance',required=True);capture.add_argument('--nonce',required=True);capture.add_argument('--output',required=True)
    args=parser.parse_args()
    if args.action=='admit':result=publish(args.request,args.sha256,args.authority,args.authority_sha256,args.custody_fd)
    else:
        result=observation('/data',args.machine,args.instance,args.nonce)
        sibling('cloudbench-startup-failure-archive.py')['durable_handoff_json'](Path(args.output),result)
    print(json.dumps({'schema':result['schema'],'status':result.get('status','OBSERVED'),'machine_id':result.get('resource',{}).get('machine_id',result.get('machine_id'))},sort_keys=True))


if __name__=='__main__':main()
