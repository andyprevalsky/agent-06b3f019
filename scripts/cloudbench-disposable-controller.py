#!/usr/bin/env python3
"""One explicitly admitted disposable controller; root caller retains teardown ownership."""
import argparse,base64,hashlib,json,os,random,re,signal,stat,subprocess,time
from contextlib import contextmanager
from pathlib import Path

class Deadline(Exception):pass

class VolumeNotFound(Exception):
    pass

# A received rate-limit/transient refusal of a GET had no provider effect, so the
# read alone is repeated; a received 429 on DELETE is likewise repeated. Other writes,
# transport loss and every other status stay terminal.
TRANSIENT_READ_STATUSES=frozenset({429,500,502,503,504})
READ_ATTEMPTS=6

def read_retry_delay(failures,status,limit):
    """Jittered 2->20 s backoff, only while the delay and one bounded read fit ``limit``."""
    if status not in TRANSIENT_READ_STATUSES or failures>=READ_ATTEMPTS:return None
    delay=random.uniform(.5,1)*min(20,2**failures)
    return delay if delay+20<limit else None

def action_budget(limit,reserve=25):
    """Seconds left for GET-only waiting inside the active whole-action deadline."""
    remaining=signal.getitimer(signal.ITIMER_REAL)[0]
    return min(limit,remaining-reserve)if remaining else limit

def released_volume(api,volume_id,end):
    """After an accepted DELETE, re-read only until Fly reports deletion or ``end``.

    Fly answers DELETE and then reports ``waiting_for_detach`` until the host
    detach completes; one immediate read is not a deletion decision."""
    while True:
        native=api('GET','/volumes/'+volume_id)
        need(native is None or native.get('id')==volume_id,'workspace identity changed during deletion')
        if native is None or native.get('state')in('pending_destroy','destroyed') or time.monotonic()+2>=end:return native
        time.sleep(2)

def need(value,message):
    if not value:raise ValueError(message)

def read(path):
    path=Path(path).absolute();need(path.resolve(strict=True)==path,'physical file required')
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as stream:
        info=os.fstat(stream.fileno());need(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode&0o077 and info.st_size<=16*1024*1024,'private owner file required')
        return stream.read(info.st_size+1)

def save(path,value):
    raw=(json.dumps(value,sort_keys=True)+'\n').encode()
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)

def birth(pid):
    need(type(pid)is int and pid>1,'invalid caller PID')
    if Path('/proc/self/stat').exists():
        value=Path(f'/proc/{pid}/stat').read_text().rsplit(') ',1)[1].split()
        need(value[0]!='Z','dead caller')
        return 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+value[19]
    return subprocess.check_output(['ps','-p',str(pid),'-o','lstart='],text=True,timeout=5).strip()

@contextmanager
def bounded(seconds,reconcile_timeout=False):
    old=signal.getitimer(signal.ITIMER_REAL);handler=signal.getsignal(signal.SIGALRM);start=time.monotonic()
    need(not old[1],'periodic alarm refused');seconds=min(seconds,old[0])if old[0]else seconds
    def expired(*unused):
        error=Deadline('controller action deadline')
        error.reconcile_timeout=reconcile_timeout and (not old[0] or time.monotonic()-start<old[0])
        raise error
    signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,seconds)
    try:yield;need(time.monotonic()-start<seconds,'late controller action')
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,handler)
        if old[0]:signal.setitimer(signal.ITIMER_REAL,max(.000001,old[0]-(time.monotonic()-start)))

def authority(path,root,fresh=True):
    raw=read(path);a=json.loads(raw)
    need(a.get('schema')=='cloudbench-disposable-controller-authority-v1' and a.get('allowed')is True and a.get('single_host')is True,'explicit single controller authority required')
    need(a['app']=='navi-whisper-lux-bench' and a['region']=='iad' and a['vm_size']=='performance-8x' and a['memory_mib']==32768 and a['workspace_size_gb']==256,'fixed controller profile required')
    need(Path(a['output_directory']).is_absolute() and Path(a['output_directory']).parent.resolve(strict=True)==Path(a['output_directory']).parent,'physical output parent required')
    need(type(a['org_machine_limit'])is int and 1<=a['org_machine_limit']<=1000,'measured organization Machine limit required')
    need(type(a.get('sibling_controller_slots',0))is int and 0<=a.get('sibling_controller_slots',0)<a['org_machine_limit'],'invalid sibling controller slots')
    need(type(a['verified_epoch'])in(int,float) and a['verified_epoch']<=time.time() and (not fresh or time.time()-a['verified_epoch']<=300),'stale creation authority')
    need(birth(a['cleanup_owner_pid'])==a['cleanup_owner_birth'],'external cleanup owner must remain live')
    need(isinstance(a['protected_machines'],list) and isinstance(a['protected_volumes'],list) and len(a['protected_machines'])>=4,'explicit protected cohort required')
    need(re.fullmatch('[0-9a-f]{40}',a['source_ref']),'exact source ref required')
    need(subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()==a['source_ref'],'controller source HEAD changed')
    for name in ('run-cloudbench-controller-gate','cloudbench-disposable-controller.py','cloudbench-controller-export.py'):
        expected=subprocess.check_output(['git','--no-replace-objects','-C',str(root),'show',a['source_ref']+':scripts/'+name])
        need((root/'scripts'/name).read_bytes()==expected,'controller source bytes changed: '+name)
    return a,hashlib.sha256(raw).hexdigest()

def file_sha(path):
    path=Path(path).absolute();need(path.resolve(strict=True)==path,'physical artifact required')
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb')as stream:
        before=os.fstat(stream.fileno());need(stat.S_ISREG(before.st_mode) and before.st_uid==os.getuid() and not before.st_mode&0o077,'private artifact required')
        h=hashlib.sha256()
        while block:=stream.read(1048576):h.update(block)
        after=os.fstat(stream.fileno());need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns),'artifact changed')
    return h.hexdigest()

def reserve(path,a,digest,driver,allow_new=True):
    marker=path.with_name(path.name+'.'+digest+'.once')
    value=dict(authority_sha256=digest,driver_pid=driver,driver_birth=birth(driver))
    if marker.exists():need(json.loads(read(marker))==value,'controller creation already reserved');return
    need(allow_new,'original creation reservation required')
    save(marker,value)

def env_files(a,directory):
    for key in ('agents','backend'):
        descriptor=a['env_files'][key];raw=read(descriptor['path'])
        need(hashlib.sha256(raw).hexdigest()==descriptor['sha256'],'current complete env changed: '+key)
        target=directory/('current-'+key+'.private.env')
        with os.fdopen(os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb')as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())

def admit(a,api,fresh=True):
    # Admission needs only identities. The full list carries every Machine's
    # config files (~200 KB each); with hundreds of sharded guests booting it
    # outran the action deadline and failed later controllers at startup.
    rows=api('GET','/machines?summary=true');need(isinstance(rows,list),'full current inventory required')
    need(not fresh or time.time()-a['verified_epoch']<=300,'stale creation authority')
    ids=[r['id']for r in rows];need(len(ids)==len(set(ids)),'duplicate Machine inventory')
    # K controllers admitted from one measured snapshot: each reserves room for
    # its K-1 siblings, and later siblings may observe the earlier ones.
    siblings=a.get('sibling_controller_slots',0)
    need(type(a['org_object_count'])is int and len(ids)<=a['org_object_count']+siblings and a['org_object_count']+1+siblings<=a['org_machine_limit'],'no measured organization room for one controller')
    proof=read(a['capacity_proof']['path']);need(hashlib.sha256(proof).hexdigest()==a['capacity_proof']['sha256'],'organization capacity proof changed')
    need(set(a['protected_machines'])<=set(ids),'protected inventory changed')
    return rows

def volume(a,path,api,read_pending=False,allow_absent=False):
    need(Path(path)==Path(a['output_directory'])/'workspace-volume.ownership.json','workspace outside exact authority directory')
    v=json.loads(read(path))
    need(v['schema']=='cloudbench-controller-workspace-ownership-v1' and v['app']==a['app'] and v['source_ref']==a['source_ref'] and v['size_gb']==256,'wrong workspace ownership')
    need(v['volume_id']not in a['protected_volumes'],'protected workspace Volume')
    end=time.monotonic()+180
    while True:
        try:
            native=api('GET','/volumes/'+v['volume_id'])
        except VolumeNotFound:
            need(read_pending,'workspace native observation absent')
            need(time.monotonic()<end,'workspace native observation pending')
            time.sleep(min(1,max(0,end-time.monotonic())))
            continue
        if native is None and allow_absent:
            return v,None
        need(isinstance(native,dict),'workspace native response must be an object')
        need(time.monotonic()<end,'late workspace native observation')
        break
    for key,expected in [('id',v['volume_id']),('name',v['name']),('region',a['region']),('size_gb',256),('encrypted',True)]:need(native.get(key)==expected,'workspace native mismatch: '+key)
    return v,native

def backup_off(a,path,directory,api):
    v,before=volume(a,path,api,read_pending=True);need(before.get('attached_machine_id')is None and before['state']=='created','new workspace must be detached and ready')
    need(type(before.get('auto_backup_enabled'))is bool,'unknown backup setting')
    if before['auto_backup_enabled']:
        save(directory/'workspace-backup.intent.json',dict(volume=v['volume_id'],auto_backup_enabled=False))
        api('PUT','/volumes/'+v['volume_id'],dict(auto_backup_enabled=False))
    unused,after=volume(a,path,api,read_pending=True)
    need(after.get('auto_backup_enabled')is False and after.get('attached_machine_id')is None,'workspace backup disable not verified')
    save(directory/'workspace-backup.verified.json',after)

def seal(a,auth_sha,path,directory,mid,name,image,api):
    v,before=volume(a,path,api);m=api('GET','/machines/'+mid)
    need(mid not in a['protected_machines'] and re.fullmatch('[0-9a-f]{8,32}',mid),'protected/invalid controller ID')
    need(m['id']==mid and m['name']==name and m['region']==a['region'] and m['config']['image']==image and '@sha256:'in image,'controller native identity mismatch')
    need(m['config']['guest']==dict(cpu_kind='performance',cpus=8,memory_mb=32768),'controller native shape mismatch')
    mounts=m['config']['mounts'];need(len(mounts)==1 and mounts[0]['volume']==v['volume_id'] and mounts[0]['path']=='/tmp/gate','controller workspace mount mismatch')
    need(before.get('attached_machine_id')==mid and before.get('auto_backup_enabled')is False,'controller workspace attachment/backup mismatch')
    record=dict(schema='cloudbench-disposable-controller-ownership-v1',authority_sha256=auth_sha,machine=m,volume=before,workspace_sha256=hashlib.sha256(read(path)).hexdigest())
    save(directory/'disposable-controller.ownership.json',record)

def cleanup(a,auth_sha,path,directory,api):
    record=json.loads(read(directory/'disposable-controller.ownership.json'))
    need(record['schema']=='cloudbench-disposable-controller-ownership-v1' and record['authority_sha256']==auth_sha and record['workspace_sha256']==hashlib.sha256(read(path)).hexdigest(),'controller ownership changed')
    exported=json.loads(read(directory/'disposable-export.verified.json'))
    need(exported['authority_sha256']==auth_sha and exported['machine_id']==record['machine']['id'],'verified export required before caller-owned disposal')
    for filename,digest in exported['files'].items():need(file_sha(directory/filename)==digest,'export originals changed')
    mid=record['machine']['id'];vid=record['volume']['id'];need(mid not in a['protected_machines'] and vid not in a['protected_volumes'],'protected resource')
    def once(kind,identifier):
        intent=directory/('disposable-delete-'+kind+'.intent.json')
        value=dict(authority_sha256=auth_sha,kind=kind,identifier=identifier)
        if intent.exists():need(json.loads(read(intent))==value,'wrong original deletion intent');return False
        save(intent,value);return True
    current=api('GET','/machines/'+mid)
    if current is not None:
        for key in ('id','instance_id','name','region','config'):need(current.get(key)==record['machine'].get(key),'controller native changed: '+key)
        if current.get('state')!='destroyed' and once('machine',mid):
            try:api('DELETE','/machines/'+mid+'?kill=true')
            except Deadline as error:
                if not getattr(error,'reconcile_timeout',False):raise
            except Exception:pass
    for unused in range(40):
        current=api('GET','/machines/'+mid)
        if current is None:break
        for key in ('id','instance_id','name','region','config'):need(current.get(key)==record['machine'].get(key),'controller identity changed during deletion')
        if current.get('state')=='destroyed':break
        time.sleep(1)
    else:raise ValueError('controller deletion pending; no repeat')
    native=api('GET','/volumes/'+vid)
    if native is None:
        save(directory/'disposable-controller.release.json',dict(machine_id=mid,volume_id=vid,volume_disposition='ABSENT',machine_deleted=True));return
    v,native=volume(a,path,api);need(native.get('attached_machine_id')is None,'workspace detach pending')
    if once('volume',vid):
        try:api('DELETE','/volumes/'+vid)
        except Deadline as error:
            if not getattr(error,'reconcile_timeout',False):raise
        except Exception:pass
    native=released_volume(api,vid,time.monotonic()+action_budget(180))
    if native is None or native.get('state')in('pending_destroy','destroyed'):
        save(directory/'disposable-controller.release.json',dict(machine_id=mid,volume_id=vid,volume_disposition='ABSENT'if native is None else native['state'],machine_deleted=True));return
    raise ValueError('workspace deletion pending; no repeat')

def cleanup_workspace(a,auth_sha,path,directory,api):
    """Only a provably detached allocation with no matching live Machine."""
    need(not (directory/'disposable-controller.ownership.json').exists(),'sealed host needs export cleanup')
    marker=directory/'disposable-delete-volume.intent.json'
    existing=json.loads(read(marker))if marker.exists()else None
    v,native=volume(a,path,api,allow_absent=existing is not None)
    value=dict(authority_sha256=auth_sha,kind='volume',identifier=v['volume_id'])
    if existing is not None:
        need(existing==value,'wrong Volume deletion intent')
    intent_path=directory/'machine-create.intent.json'
    if intent_path.exists():
        intent=json.loads(read(intent_path));need(intent['authority_sha256']==auth_sha and intent['workspace_sha256']==hashlib.sha256(read(path)).hexdigest(),'wrong Machine creation intent')
        # Identities only: full rows carry every Machine's config (~200 KB each), and a sharded
        # inventory outran the 20 s read before the Volume was released. Summary rows omit
        # config, so the mount check reads only the candidate Machines in full: a Machine that
        # mounts this Volume holds its attachment (or is the intended name).
        rows=api('GET','/machines?summary=true');need(isinstance(rows,list) and all(isinstance(m,dict)for m in rows),'complete inventory required')
        def mounts(m):return any(x.get('volume')==v['volume_id']for x in (m.get('config')or{}).get('mounts',[]))
        attached=(native or{}).get('attached_machine_id')
        candidates=[m['id']for m in rows if m.get('name')==intent['name'] or m.get('id')==attached]
        if attached is not None and attached not in candidates:candidates.append(attached)
        details=[api('GET','/machines/'+mid)for mid in candidates]
        need(all(m.get('name')!=intent['name'] and not mounts(m)for m in rows+[d for d in details if d is not None]),'Machine allocation exists or is ambiguous; seal/export required')
    if native is None:
        save(directory/'disposable-controller.release.json',dict(machine_id=None,volume_id=v['volume_id'],volume_disposition='ABSENT',no_live_machine_observed=True,command_history_verified=False));return
    need(native.get('attached_machine_id')is None and native.get('state')in('created','pending_destroy','destroyed'),'workspace not provably detached')
    marker=directory/'disposable-delete-volume.intent.json';value=dict(authority_sha256=auth_sha,kind='volume',identifier=v['volume_id'])
    if marker.exists():need(json.loads(read(marker))==value,'wrong Volume deletion intent')
    else:
        save(marker,value)
        try:api('DELETE','/volumes/'+v['volume_id'])
        except Deadline as error:
            if not getattr(error,'reconcile_timeout',False):raise
        except Exception:pass
    after=released_volume(api,v['volume_id'],time.monotonic()+action_budget(180))
    need(after is None or after.get('state')in('pending_destroy','destroyed'),'workspace deletion pending; GET-only reconciliation required')
    save(directory/'disposable-controller.release.json',dict(machine_id=None,volume_id=v['volume_id'],volume_disposition='ABSENT'if after is None else after['state'],no_live_machine_observed=True,command_history_verified=False))

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['admit','continue-allocation','reserve','env-files','backup-off','seal','export-ready','create-intent','cleanup-workspace','cleanup']);p.add_argument('--authority',required=True,type=Path);p.add_argument('--root',required=True,type=Path);p.add_argument('--directory',type=Path);p.add_argument('--workspace',type=Path);p.add_argument('--machine');p.add_argument('--name');p.add_argument('--image');p.add_argument('--driver-pid',type=int);args=p.parse_args()
    with bounded(180):
        a,digest=authority(args.authority,args.root,fresh=args.action in ('admit','reserve','env-files'))
        if args.directory is not None:need(args.directory==Path(a['output_directory']),'authority output directory changed')
        if args.action=='reserve':reserve(args.authority,a,digest,args.driver_pid);return
        if args.action=='env-files':env_files(a,args.directory);return
        if args.action=='create-intent':
            save(args.directory/'machine-create.intent.json',dict(authority_sha256=digest,name=args.name,image=args.image,workspace_sha256=hashlib.sha256(read(args.workspace)).hexdigest()));return
        if args.action=='export-ready':
            export_source=args.root/'scripts/cloudbench-controller-export.py'
            scope={'__file__':str(export_source),'__name__':'disposable_export','CHECKED_COLLECTOR_SHA256':hashlib.sha256(export_source.read_bytes()).hexdigest()}
            exec(compile(export_source.read_bytes(),str(export_source),'exec'),scope)
            from types import SimpleNamespace
            scope['verify'](SimpleNamespace(archive=args.directory/'originals.tar.gz',manifest=args.directory/'manifest.json',record=args.directory/'launch.json',caller=args.directory/'caller.json',ref=a['source_ref'],image=args.image,machine=args.machine,app=a['app']))
            save(args.directory/'disposable-export.verified.json',dict(authority_sha256=digest,machine_id=args.machine,files={name:file_sha(args.directory/name)for name in ('originals.tar.gz','manifest.json','launch.json','caller.json')}));return
        source=args.root/'scripts/cloudbench-original-volume-capture.py';expected=subprocess.check_output(['git','--no-replace-objects','-C',str(args.root),'show',a['source_ref']+':scripts/cloudbench-original-volume-capture.py']);need(source.read_bytes()==expected,'native transport source changed')
        scope={'__file__':str(source),'__name__':'disposable_controller_transport'};exec(compile(expected,str(source),'exec'),scope)
        client=scope['Fly'](a['app'],os.environ.get('FLY_API_TOKEN')or scope['resolve_token']({'workspace':str(args.root)}))
        observations=None
        if args.directory is not None:
            observations=args.directory/('native-'+args.action+'-'+str(time.monotonic_ns()))
            observations.mkdir(mode=0o700)
        sequence=0
        def read_limit():
            # Remaining whole-action time; a creation admission also stays
            # inside its measured authority's 300 s freshness window.
            limit=signal.getitimer(signal.ITIMER_REAL)[0]or float('inf')
            if args.action=='admit':limit=min(limit,a['verified_epoch']+300-time.time())
            return limit
        def api(method,path,body=None):
            failures=0
            while True:
                status=[]
                try:return attempt(method,path,body,status)
                except Exception as error:
                    delay=None
                    # A fully received 429 on DELETE is a refusal with no provider effect; without a
                    # retry the once-only deletion intent would block teardown forever. Transport loss,
                    # deadlines and 5xx stay terminal: those DELETEs may have been applied.
                    received=status[-1]if status else None
                    refused=(method=='GET' and received in TRANSIENT_READ_STATUSES)or(method=='DELETE' and received==429)
                    if refused and isinstance(error,scope['CaptureFailure']):
                        failures+=1;delay=read_retry_delay(failures,received,read_limit())
                    if delay is None:raise
                time.sleep(delay)
        def attempt(method,path,body,status):
            nonlocal sequence
            sequence+=1
            prefix=observations/('observation-%06d'%sequence)if observations is not None else None
            if prefix is not None:
                save(prefix.with_suffix('.request.json'),dict(method=method,path=path,body=body))
            def observed(observed_method,observed_path,code,payload):
                need(observed_method==method and observed_path==path,'native observation request changed')
                status.append(code)
                if prefix is not None:
                    save(prefix.with_suffix('.raw.json'),dict(method=method,path=path,status=code,body_base64=base64.b64encode(payload).decode(),body_sha256=hashlib.sha256(payload).hexdigest()))
            with bounded(20,reconcile_timeout=True):
                try:
                    value=client.api(method,path,body,timeout=20,observer=observed)
                    if method=='GET' and path.startswith('/volumes/'):
                        need(isinstance(value,dict),'native response must be an object')
                    return value
                except scope['NotFound']:
                    if method=='GET' and path.startswith('/volumes/') and args.action=='backup-off':
                        raise VolumeNotFound() from None
                    if method=='GET':return None
                    raise
        if args.action=='admit':admit(a,api)
        elif args.action=='continue-allocation':
            reserve(args.authority,a,digest,args.driver_pid,allow_new=False)
            unused,native=volume(a,args.workspace,api);need(native.get('attached_machine_id')is None and native.get('auto_backup_enabled')is False,'allocation not ready for one controller')
            admit(a,api,fresh=False)
        elif args.action=='backup-off':backup_off(a,args.workspace,args.directory,api)
        elif args.action=='cleanup-workspace':cleanup_workspace(a,digest,args.workspace,args.directory,api)
        elif args.action=='seal':seal(a,digest,args.workspace,args.directory,args.machine,args.name,args.image,api)
        else:cleanup(a,digest,args.workspace,args.directory,api)
if __name__=='__main__':main()
