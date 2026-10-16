#!/usr/bin/env python3
"""Explicit no-config-update transport for an already claimed inert Machine.

The caller retains BOOT_LAUNCH evidence/cleanup semantics. Never falls back from
an attempted update, retries a dispatch, or grants runtime/pool success.
"""
from __future__ import annotations
import argparse,base64,hashlib,io,json,os,re,runpy,shlex,signal,stat,sys,tarfile,time
from pathlib import Path

def require(value,why):
    if not value: raise ValueError(why)
def canonical(value): return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def digest(raw): return hashlib.sha256(raw).hexdigest()
def save(path,value):
    raw=value if isinstance(value,bytes) else canonical(value)+b'\n'
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    sync(path.parent)
def sync(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)
def regular(path,maximum=16*1024*1024):
    path=Path(path);require(path.resolve(strict=True)==path,'linked source')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        a=os.fstat(fd);require(stat.S_ISREG(a.st_mode)and a.st_nlink==1 and a.st_size<=maximum,'unsafe source')
        data=b''
        while len(data)<a.st_size:
            part=os.read(fd,min(65536,a.st_size-len(data)));require(part,'short read');data+=part
        b=os.fstat(fd);require((a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns)==(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns),'source drift');return data
    finally:os.close(fd)

def prepare_probe_owner(output,app,machine,token,source_ref):
    """Record probe dispatch ownership without inventing runtime evidence."""
    output=Path(output);require(output.is_absolute()and output.resolve(strict=True)==output,'physical probe output')
    require(re.fullmatch('[0-9a-f]{14}',machine)and re.fullmatch('[A-Za-z0-9._-]+',token)and token not in ('.','..')and re.fullmatch('[0-9a-f]{40}',source_ref),'probe identity')
    require(not any(os.path.lexists(output/name)for name in ('runtime-evidence.owner.json','runtime-evidence.pending')),'probe cannot replace runtime evidence')
    value=dict(schema='cloudbench-staged-probe-owner-v1',app=app,machine_id=machine,run_token=token,source_ref=source_ref,infra_probe=True,runtime_success=False)
    save(output/'staged-probe.owner.json',value);return value

def native_binding(machine,volume,size,memory):
    require(machine['state']=='stopped'and machine['config'].get('init')=={'cmd':['sleep','infinity']}and machine['config'].get('env')in ({},None),'staged boot requires stopped inert empty-env source')
    c=machine['config'];require(c.get('restart')=={'policy':'no'}and c.get('auto_destroy',False)is False,'unsafe restart/autodestroy')
    mounts=c.get('mounts');require(isinstance(mounts,list)and len(mounts)==1 and mounts[0].get('path')=='/data','sole /data volume required')
    require(volume['id']==mounts[0]['volume']and volume['attached_machine_id']==machine['id']and volume['state']=='created','Volume association')
    match=re.fullmatch('(shared-cpu|performance)-([1-9][0-9]*)x',size)
    require(match is not None and memory.isdigit(),'explicit target shape required')
    runpy.run_path(str(Path(__file__).with_name('cloudbench-static-service-observation.py')))['validate_observation_services'](c)
    g=c['guest'];require(type(g.get('cpus'))is int and type(g.get('memory_mb'))is int,'invalid native shape');require((g.get('cpu_kind'),g.get('cpus'),g.get('memory_mb'))==('shared'if match[1]=='shared-cpu'else'performance',int(match[2]),int(memory)),'staged boot cannot resize')
    return mounts[0]['volume']

GUEST = r'''
import hashlib,io,json,os,signal,stat,subprocess,sys,tarfile,time
from pathlib import Path
def need(v,m):
 if not v:raise ValueError(m)
def sha(b):return hashlib.sha256(b).hexdigest()
def dump(p,v):
 raw=json.dumps(v,sort_keys=True,separators=(',',':')).encode()+b'\n'
 fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
 sync(p.parent)
def sync(p):
 fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def install(archive,expected,budget=20):
 need(type(budget)is int and 0<budget<=20,'guest deadline');signal.alarm(budget)
 need(os.geteuid()==0,'root guest required');p=Path(archive);fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb')as f:
  s=os.fstat(f.fileno());need(stat.S_ISREG(s.st_mode)and s.st_uid==0 and s.st_nlink==1 and s.st_size<=16777216,'unsafe archive');raw=f.read(16777217)
 need(sha(raw)==expected,'archive mismatch')
 with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz')as tar:
  members=tar.getmembers();need(len({x.name for x in members})==len(members)and len(members)<=12,'archive entries')
  need(all(x.isfile()and '/'not in x.name and x.size<=16777216 for x in members),'archive type/path')
  files={x.name:tar.extractfile(x).read()for x in members}
 request=json.loads(files.pop('request.json'));env=json.loads(files.pop('env.json'));files.pop('launch.py')
 need(request['machine']==os.environ.get('FLY_MACHINE_ID'),'guest Machine mismatch')
 need(env['CLOUDBENCH_RUN_TOKEN']==request['run_token']and env['REF']==request['source_ref']and env['CLOUDBENCH_BOOT']=='1','guest run identity')
 need(request.get('evidence_kind')in(None,'infra-probe')and (request.get('evidence_kind')=='infra-probe')==(env.get('CLOUDBENCH_INFRA_PROBE')=='1'),'probe payload mode')
 expected_files=request['files'];need(set(files)==set(expected_files),'unexpected payload')
 for n,b in files.items():need(sha(b)==expected_files[n]['sha256']and len(b)==expected_files[n]['bytes'],'file digest')
 # Same canonical all-UID probe used to admit the stopped source. It runs before
 # any rootfs helper replacement or dispatch, without relaxing process classes.
 probe=request['idle_probe'];r=subprocess.run([sys.executable,'-I','-S','-B','-c',probe],capture_output=True,timeout=15)
 need(r.returncode==0 and len(r.stdout)<=65536,'pre-dispatch guest not inert')
 observation=json.loads(r.stdout);need(observation['machine']==request['machine']and observation['nonce']==request['nonce']and observation['kind']=='exact-inert-quiescence-v1'and observation.get('unknown')==[]and bool(observation.get('inert_sleepers')),'idle probe identity')
 parent=Path('/tmp/cloudbench-staged-boot');parent.mkdir(mode=0o700,exist_ok=True);s=parent.lstat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==0 and not s.st_mode&0o077 and parent.resolve()==parent,'unsafe staged root')
 once=parent/request['run_token'];once.mkdir(mode=0o700);sync(parent)
 dump(once/'intent.json',dict(request_sha256=sha(json.dumps(request,sort_keys=True,separators=(',',':')).encode()),archive_sha256=expected,machine=request['machine'],run_token=request['run_token']))
 backup=once/'previous';backup.mkdir(mode=0o700);sync(once)
 for name,data in files.items():
  destination=Path('/')/name
  if destination.exists()or destination.is_symlink():
   s=destination.lstat();need(stat.S_ISREG(s.st_mode)and s.st_uid==0 and s.st_nlink==1 and s.st_size<=16777216,'unsafe existing root helper')
   original=destination.read_bytes();f=os.open(backup/name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
   with os.fdopen(f,'wb')as out:out.write(original);out.flush();os.fsync(out.fileno())
  temporary=once/(name+'.install');fd=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o644)
  with os.fdopen(fd,'wb')as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.replace(temporary,destination)
 sync(backup);sync(Path('/'));dump(once/'environment.private.json',env)
 # Intent is permanent before Popen. Any ambiguous result requires external
 # reconciliation; executing install again cannot dispatch a second driver.
 dump(once/'dispatch.intent.json',dict(machine=request['machine'],run_token=request['run_token'],epoch=time.time()))
 output=os.open(once/'supervisor.private.log',os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 try:child=subprocess.Popen(['bash','/cloudbench-boot.sh'],env=dict(os.environ,**env),stdin=subprocess.DEVNULL,stdout=output,stderr=output,start_new_session=True,close_fds=True)
 finally:os.close(output)
 birth=Path('/proc',str(child.pid),'stat').read_text().rsplit(') ',1)[1].split()[19]
 ack=dict(schema='cloudbench-staged-boot-launch-v1',app=request['app'],nonce=request['nonce'],machine=request['machine'],volume_id=request['volume_id'],instance_id=request['instance_id'],run_token=request['run_token'],source_ref=request['source_ref'],archive_sha256=expected,intent_sha256=sha(json.dumps(request,sort_keys=True,separators=(',',':')).encode()+b'\n'),config_sha256=request['config_sha256'],guest_once=str(once),supervisor_pid=child.pid,supervisor_birth=birth,dispatched=True,runtime_success=False)
 if request.get('evidence_kind')=='infra-probe':
  ack['evidence_kind']='infra-probe'
 dump(once/'launch.ack.json',ack);return ack
if __name__=='__main__':print(json.dumps(install(sys.argv[1],sys.argv[2],int(sys.argv[3])),sort_keys=True))
'''

def bundle(output,env,files,request):
    require(set(files)=={'cloudbench-boot.sh','cloudbench-status-server.py','cloudbench-boot-payload.py','cloudbench-boot-payload.json.gz'},'unexpected boot entrypoints')
    request=dict(request,files={n:dict(sha256=digest(b),bytes=len(b))for n,b in files.items()})
    members=dict(files,**{'request.json':canonical(request),'env.json':canonical(env),'launch.py':GUEST.encode()})
    with os.fdopen(os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb')as f:
        with tarfile.open(fileobj=f,mode='w:gz')as tar:
            for name,data in sorted(members.items()):
                i=tarfile.TarInfo(name);i.size=len(data);i.mode=0o600;i.uid=i.gid=0;tar.addfile(i,io.BytesIO(data))
        f.flush();os.fsync(f.fileno())
    sync(output.parent)
    require(output.stat().st_size<=16*1024*1024,'staged archive too large');return digest(regular(output)),request

class Deadline(Exception):pass
class Cancelled(Exception):pass

def launch(fly,output,machine,token,env,files,size,memory,idle_probe,*,ready_seconds=600,barrier=None,barrier_seconds=1800):
    require(type(ready_seconds)is int and 0<ready_seconds<=600,'readiness bound')
    require(re.fullmatch('[0-9a-f]{14}',machine)and re.fullmatch('[A-Za-z0-9._-]+',token)and token not in ('.','..'),'invalid staged identity')
    require(env.get('CLOUDBENCH_BOOT')=='1'and env.get('CLOUDBENCH_RUN_TOKEN')==token and re.fullmatch('[0-9a-f]{40}',env.get('REF','')),'exact boot identity required')
    is_probe=env.get('CLOUDBENCH_INFRA_PROBE','0')=='1'
    if is_probe:
        owner=json.loads(regular(output.parent/'staged-probe.owner.json'));require(owner==dict(schema='cloudbench-staged-probe-owner-v1',app=fly.app,machine_id=machine,run_token=token,source_ref=env['REF'],infra_probe=True,runtime_success=False),'typed probe owner required')
        require(not any(os.path.lexists(output.parent/name)for name in ('runtime-evidence.owner.json','runtime-evidence.pending')),'probe cannot impersonate runtime evidence')
    else:
        owner=json.loads(regular(output.parent/'runtime-evidence.owner.json'));require(owner==dict(version=1,machine_id=machine,run_token=token),'runtime evidence owner required')
        require(json.loads(regular(output.parent/'runtime-evidence.pending'))==owner,'matching pending evidence required')
    require(type(barrier_seconds)is int and 0<barrier_seconds<=1800,'config barrier bound')
    output.mkdir(mode=0o700);sync(output.parent)
    prior=signal.getitimer(signal.ITIMER_REAL);handler=signal.getsignal(signal.SIGALRM);require(prior==(0.0,0.0),'isolated staged transport required')
    start=time.monotonic();deadline=start+ready_seconds+60+(barrier_seconds if barrier else 0)
    def expired(*unused):raise Deadline('staged boot absolute deadline')
    def bound(seconds,fn):
        cap=min(seconds,deadline-time.monotonic());require(cap>0,'staged boot deadline');signal.setitimer(signal.ITIMER_REAL,cap);at=time.monotonic()
        try:
            value=fn(cap);require(time.monotonic()-at<cap,'late staged operation');return value
        finally:signal.setitimer(signal.ITIMER_REAL,0)
    def api(method,path,limit=20):return bound(limit,lambda cap:fly.api(method,path,timeout=cap))
    old_signals={sig:signal.getsignal(sig)for sig in (signal.SIGTERM,signal.SIGINT)}
    def cancelled(signum,frame):raise Cancelled('staged boot cancelled')
    for sig in old_signals:signal.signal(sig,cancelled)
    signal.signal(signal.SIGALRM,expired)
    try:
        before=api('GET','/machines/'+machine);require(before['id']==machine,'wrong Machine');volid=before['config']['mounts'][0]['volume'];volume=api('GET','/volumes/'+volid);after=api('GET','/machines/'+machine)
        require(before==after,'native pair drift');native_binding(before,volume,size,memory)
        save(output/'native-before.json',before);save(output/'volume-before.json',volume)
        request=dict(schema='cloudbench-staged-boot-request-v1',app=fly.app,machine=machine,volume_id=volid,instance_id=before['instance_id'],update_attempted=False,run_token=token,source_ref=env['REF'],nonce=os.urandom(16).hex(),config_sha256=digest(canonical(before['config'])))
        if is_probe:request['evidence_kind']='infra-probe'
        request['idle_probe']=idle_probe.replace('TARGET',repr(machine)).replace('NONCE',repr(request['nonce']))
        archive=output/'boot.tar.gz';archive_sha,request=bundle(archive,env,files,request);save(output/'intent.json',request);save(output/'payload.json',dict(archive_sha256=archive_sha,bytes=archive.stat().st_size))
        # Exactly one START, before staging and before any task process exists.
        save(output/'start.intent.json',dict(machine=machine,epoch=time.time()));save(output/'start.ack.json',api('POST','/machines/'+machine+'/start'))
        ready_deadline=min(deadline,time.monotonic()+ready_seconds)
        while True:
            remaining=ready_deadline-time.monotonic();require(remaining>0,'START readiness deadline')
            n=api('GET','/machines/'+machine,min(20,remaining));require(time.monotonic()<ready_deadline,'START readiness deadline');require(n['id']==machine and n['instance_id']==before['instance_id']and n['config']==before['config']and n['image_ref']==before['image_ref'],'native changed after START')
            if n['state']=='started':break
            require(n['state']in ('starting','stopped')and time.monotonic()<ready_deadline,'START did not become ready');time.sleep(min(1,max(0,ready_deadline-time.monotonic())))
        started_volume=api('GET','/volumes/'+volid);require(started_volume==volume,'Volume changed across START')
        save(output/'native-started.json',n);save(output/'volume-started.json',started_volume)
        probe_command='python3 -I -S -B -c '+shlex.quote(request['idle_probe']);require(len(probe_command.encode())<=7000,'idle probe command size')
        probe=bound(20,lambda cap:fly.machine_exec_json(max(1,int(cap)),machine,probe_command,max_command_bytes=7000,max_response_bytes=65536,validate_ack=lambda v:isinstance(v,dict)and v.get('machine')==machine and v.get('nonce')==request['nonce']and v.get('kind')=='exact-inert-quiescence-v1'and v.get('unknown')==[]and bool(v.get('inert_sleepers'))))
        save(output/'idle-before-stage.json',probe)
        remote='/tmp/cloudbench-staged-'+request['nonce']+'.tar.gz'
        rc,stdout,stderr=bound(30,lambda cap:fly.flyctl(max(1,int(cap)),'ssh','sftp','put','-a',fly.app,'--machine',machine,'-q','-m','0600',str(archive),remote))
        save(output/'sftp.private.json',dict(returncode=rc,stdout=stdout,stderr=stderr));require(rc==0,'staged SFTP failed; no retry')
        if barrier:
            barrier=Path(barrier);require(barrier.is_absolute()and barrier.resolve(strict=True)==barrier,'config barrier path')
            ready=barrier/'ready';ready.mkdir(exist_ok=True);save(ready/machine,dict(archive_sha256=archive_sha,run_token=token))
            barrier_deadline=min(deadline,time.monotonic()+barrier_seconds)
            while not (barrier/'release').is_file():
                require(time.monotonic()<barrier_deadline,'staged config barrier expired');time.sleep(.2)
            require(time.monotonic()<barrier_deadline,'staged config barrier expired')
        # Read only this exact archive; never shell-expand filenames or env.
        launch_cap=int(min(20,deadline-time.monotonic()));require(launch_cap>0,'launch budget exhausted')
        bootstrap="import hashlib,io,tarfile,os,stat,sys; p="+repr(remote)+"; f=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK); s=os.fstat(f); assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and s.st_size=="+str(archive.stat().st_size)+"; b=os.read(f,s.st_size+1); assert hashlib.sha256(b).hexdigest()=="+repr(archive_sha)+"; t=tarfile.open(fileobj=io.BytesIO(b),mode='r:gz'); c=t.extractfile('launch.py').read(); sys.argv=['staged-boot',p,"+repr(archive_sha)+","+repr(str(launch_cap))+"]; exec(compile(c,'bound-staged-boot','exec'))"
        command='python3 -I -S -B -c '+shlex.quote(bootstrap);require(len(command.encode())<=7000,'launch command limit')
        save(output/'dispatch.intent.json',dict(archive_sha256=archive_sha,machine=machine,run_token=token,epoch=time.time()))
        ack=bound(launch_cap,lambda cap:fly.machine_exec_json(max(1,int(cap)),machine,command,max_command_bytes=7000,max_response_bytes=65536,validate_ack=lambda v:isinstance(v,dict)and all(v.get(k)==request[k]for k in ('app','nonce','machine','volume_id','instance_id','run_token','source_ref','config_sha256'))and v.get('evidence_kind')==request.get('evidence_kind')and v.get('intent_sha256')==digest(regular(output/'intent.json')) and v.get('archive_sha256')==archive_sha and v.get('dispatched')is True and v.get('runtime_success')is False))
        save(output/'launch.ack.json',ack)
        terminal=dict(status='BOOT_DISPATCHED',intent_sha256=digest(regular(output/'intent.json')),launch_ack_sha256=digest(regular(output/'launch.ack.json')),runtime_success=False,update_attempted=False)
        if is_probe:terminal['evidence_kind']='infra-probe'
        save(output/'terminal.json',terminal);return ack
    except BaseException as error:
        for name in ('stdout','stderr'):
            partial=getattr(error,name,None)
            if isinstance(partial,bytes):save(output/('interrupted-'+name+'.private.bin'),partial)
        save(output/'terminal.json',dict(status='PENDING_NO_RETRY',error_class=type(error).__name__,update_attempted=False))
        raise
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,handler)
        for sig,old in old_signals.items():signal.signal(sig,old)

def main():
    p=argparse.ArgumentParser();p.add_argument('--machine',required=True);p.add_argument('--app',required=True);p.add_argument('--run-token',required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--vm-size');p.add_argument('--vm-memory');p.add_argument('--ready-seconds',type=int,default=600);p.add_argument('--prepare-probe-owner',action='store_true');p.add_argument('--source-ref');a=p.parse_args()
    if a.prepare_probe_owner:prepare_probe_owner(a.output,a.app,a.machine,a.run_token,a.source_ref or '');return
    require(a.vm_size is not None and a.vm_memory is not None,'explicit target shape required')
    values=sys.stdin.buffer.read(32*1024*1024).split(b'\0');require(values[-1]==b'','NUL argument input');args=[v.decode()for v in values[:-1]];require(len(args)%2==0,'argument pairs');env={};files={}
    for flag,value in zip(args[::2],args[1::2]):
        key,val=value.split('=',1)
        if flag=='--env':require(key not in env and re.fullmatch('[A-Z][A-Z0-9_]*',key),'duplicate env');env[key]=val
        elif flag=='--file-local':require(key.startswith('/')and '/'not in key[1:]and key[1:]not in files,'file path');files[key[1:]]=regular(Path(val).resolve())
        else:raise ValueError('unknown staged argument')
    client=runpy.run_path(str(Path(__file__).with_name('cloudbench-original-volume-capture.py')));fly=client['Fly'](a.app,os.environ['FLY_API_TOKEN'])
    launch(fly,a.output,a.machine,a.run_token,env,files,a.vm_size,a.vm_memory,client['BILLING_GUEST'],ready_seconds=a.ready_seconds,barrier=os.environ.get('CLOUDBENCH_BOOT_CONFIG_BARRIER')or None,barrier_seconds=int(os.environ.get('CLOUDBENCH_BOOT_CONFIG_BARRIER_WAIT_SECONDS','1800')))
if __name__=='__main__':main()
