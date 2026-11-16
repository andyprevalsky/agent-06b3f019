#!/usr/bin/env python3
"""Signal only expired, registered fleet owners; canonical export remains authoritative."""

import argparse
import ast
import base64
import gzip
import zlib
import json
import os
import runpy
import re
import stat
import types
import shlex
import subprocess
import time
from pathlib import Path
# A uv/python-build-standalone interpreter (agents/venv) can lack the pidfd
# wrappers although the Linux kernel provides them. Bind the same syscalls so
# exact-owner signals stay pinned to a pidfd and never fall back to a raw PID.
if not hasattr(os, "pidfd_open") or not hasattr(__import__("signal"), "pidfd_send_signal"):
    import ctypes as _pidfd_ctypes
    import signal as _pidfd_signal

    def _pidfd_syscall(number, *args):
        libc = _pidfd_ctypes.CDLL(None, use_errno=True)
        result = libc.syscall(_pidfd_ctypes.c_long(number), *args)
        if result < 0:
            error = _pidfd_ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        return result

    if not hasattr(os, "pidfd_open"):
        # Syscall numbers are shared by every Linux architecture (>= 5.1).
        os.pidfd_open = lambda pid, flags=0: _pidfd_syscall(434, _pidfd_ctypes.c_int(pid), _pidfd_ctypes.c_uint(flags))
    if not hasattr(_pidfd_signal, "pidfd_send_signal"):
        def _pidfd_send_signal(fd, sig, siginfo=None, flags=0):
            _pidfd_syscall(424, _pidfd_ctypes.c_int(fd), _pidfd_ctypes.c_int(int(sig)), None, _pidfd_ctypes.c_uint(flags))

        _pidfd_signal.pidfd_send_signal = _pidfd_send_signal

HERE = Path(__file__).resolve().parent
F = runpy.run_path(str(HERE / "cloudbench-controller-payload-finalization.py"))
B, R = F["B"], F["R"]
need, read, save, sha = (R[key] for key in ("need", "read", "save", "sha"))

GUEST = r"""
import hashlib,json,os,pwd,re,select,signal,socket,stat,subprocess,time
from pathlib import Path

def need(ok,message):
 if not ok:raise ValueError(message)
def digest(raw):return hashlib.sha256(raw).hexdigest()
def read(path,limit=16777216):
 p=Path(path);need(p.resolve(strict=True)==p,'physical evidence required')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb') as f:
  a=os.fstat(f.fileno());need(stat.S_ISREG(a.st_mode) and a.st_nlink==1,'regular evidence required')
  raw=f.read(limit+1);b=os.fstat(f.fileno())
  need(len(raw)<=limit and (a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)==(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns),'evidence changed')
  return raw
def obj(path):return json.loads(read(path))
def save(path,value):
 raw=(json.dumps(value,sort_keys=True,allow_nan=False)+'\n').encode()
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
 fd=os.open(Path(path).parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
def process(pid,owner_uid=None):
 need(type(pid)is int and pid>1,'unsafe PID')
 p=Path('/proc')/str(pid);fields=(p/'stat').read_text().rsplit(') ',1)[1].split()
 birth='proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+fields[19]
 argv=(p/'cmdline').read_bytes();cwd=os.readlink(p/'cwd')
 status=dict(line.split(':',1) for line in (p/'status').read_text().splitlines() if ':' in line)
 target=os.geteuid() if owner_uid is None else owner_uid
 need([int(x) for x in status['Uid'].split()]==[target]*4 and p.stat().st_uid==target,'process UID differs')
 mask=1<<(signal.SIGTERM-1)
 need(not int(status['SigIgn'].strip(),16)&mask and int(status['SigCgt'].strip(),16)&mask,'TERM is not caught or is ignored')
 need(fields[0] not in ('Z','X'),'owner already exited')
 return dict(pid=pid,uid=target,birth=birth,cwd=cwd,argv_sha256=digest(argv),argv=argv.rstrip(b'\0').split(b'\0'))
def metadata(path):
 raw=read(path);rows=raw.decode().splitlines();value={}
 for line in rows:
  key,sep,item=line.partition('=');need(sep and key not in value,'invalid registry meta');value[key]=item
 return value,digest(raw)
def owner(path,repo,common,pending,ref):
 meta,msha=metadata(path/'meta');token=path.name
 need(re.fullmatch('[0-9a-f]{32}',token) and meta['version']=='2' and meta['fleet_owner_token']==token and meta['cleanup_policy']=='retain','invalid registry owner')
 need(meta['host']==socket.gethostname() and meta['workspace_root']==str(repo) and meta['runs_root']==str(repo/'.context/fleet/runs') and meta['app']=='navi-whisper-lux-bench','foreign registry')
 pid=int(meta['pid']);uid=(path/'meta').stat().st_uid
 need(uid==repo.stat().st_uid==ROSE_UID and os.geteuid() in (0,uid),'registry/executor UID differs')
 p=process(pid,uid)
 need(p['birth']==meta['pid_start'] and pending.get(pid)==p['birth'] and p['cwd']==str(repo),'owner identity differs')
 argv=[os.fsdecode(a) for a in p.pop('argv')]
 # Only the registered fleet controller, never its monitor/helper children.
 need(any(re.fullmatch(r'/tmp/cloudbench-fleet-self\.[A-Za-z0-9]+',a) or a==str(repo/'scripts/run-bench-fleet') for a in argv),'not fleet controller argv')
 audit=Path(meta['audit_dir']);need(audit==common/'cloudbench-fleet-audits'/token and audit.resolve(strict=True)==audit,'audit namespace differs')
 run=meta['run_id'];need(re.fullmatch('[0-9]{8}-[0-9]{6}-[0-9]+',run) and run.endswith('-'+str(pid)),'run/PID mismatch')
 need(meta['owned_ids_file']==str(audit/'owned-clones.ids') and meta['owned_names_file']==str(audit/'owned-clones.names'),'owned files differ')
 need(argv[:2]==['bash',str(repo/'scripts/run-bench-fleet')] and len(argv)>2 and '--foreground' in argv and '--strict-barrier' in argv,'unsupported fleet invocation')
 task=argv[2];taskref='1387ae608e7cfb8e3f0a876daae92093f503b465'
 need('--ref' in argv and argv[argv.index('--ref')+1]==taskref,'task ref differs')
 need(FLEET_SHA==EXPECTED_FLEET_SHA,'fleet source differs')
 successor_path=repo/'.context/fleet/runs'/run/task/'archived-successor.json';successor_raw=read(successor_path);successor=json.loads(successor_raw)
 need(successor['controller_id']==os.environ['FLY_MACHINE_ID'] and successor['harness_ref']==ref and successor['task_ref']==taskref and successor['owner_token']==token and successor['run_id']==run and successor['task']==task and successor['ordinal']==0 and successor['campaign_total_jobs']==600 and successor['campaign_attempt']==1,'task successor differs')
 env=dict(item.split(b'=',1) for item in (Path('/proc')/str(pid)/'environ').read_bytes().split(b'\0') if b'=' in item)
 authority=json.loads(env[b'CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY']);seed=Path(os.fsdecode(env[b'CLOUDBENCH_CAMPAIGN_SEED_PROOF']))
 need(authority['source']['ref']==ref and str(seed.parent.parent.parent)==str(Path(authority['directory']).parent) and seed.name=='seed-proof.private.json' and re.fullmatch('c[0-9]{3}',seed.parent.name),'campaign source/cohort differs')
 cohort=json.loads(read(seed.parent/'manifest.json'));jobs=cohort['jobs'];need(cohort['cohort_id']==seed.parent.name and len(jobs)==600 and {int(k.split('-j')[1]) for k in jobs}==set(range(1,601)) and jobs[successor['campaign_job_id']]==pid,'campaign member differs')
 need(authority['owner']['parent_pid']==str(PARENT_PID),'campaign parent differs')
 manifest=path/'source-manifest.json';manifest_sha=None
 if 'source_manifest_sha256' in meta:
  manifest_sha=digest(read(manifest));need(manifest_sha==meta['source_manifest_sha256'],'source manifest differs')
 return dict(p,registry=str(path),meta_sha256=msha,source_manifest_sha256=manifest_sha,owner_token=token,run_id=run,source_ref=ref,successor_sha256=digest(successor_raw),fleet_source_sha256=FLEET_SHA,cohort_sha256=digest(read(seed.parent/'manifest.json')))

def prerequisites(v,repo=Path('/tmp/gate/repo'),custody=Path('/tmp/gate/controller-host-custody')):
 global PARENT_PID,FLEET_SHA,EXPECTED_FLEET_SHA,ROSE_UID
 os.chdir(repo)
 ROSE_UID=pwd.getpwnam('rose').pw_uid
 FLEET_SHA=digest(read(repo/'scripts/run-bench-fleet'));EXPECTED_FLEET_SHA=v['fleet_source_sha256'];need(FLEET_SHA==EXPECTED_FLEET_SHA,'fleet source differs')
 need(os.environ.get('FLY_MACHINE_ID')==v['machine'] and os.environ.get('GATE_REF')==v['source_ref'],'guest source/MID differs')
 need(time.time()>=v['deadline'],'original clock not expired')
 launch_raw=read(custody/'launch.json');launch=json.loads(launch_raw)
 pending=obj(custody/'pending.json')
 need(digest(launch_raw)==v['launch_sha256']==pending['record_sha256'] and pending['status']=='pending' and pending['reason']=='live controller writers','export is not pending for writers')
 need(launch['source_ref']==v['source_ref'] and launch['machine_id']==v['machine'],'launch source differs')
 driver=launch['driver_pid'];p=Path('/proc')/str(driver);fields=(p/'stat').read_text().rsplit(') ',1)[1].split()
 need('proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+fields[19]==launch['driver_birth'],'original export driver changed')
 joined=v['joined'];identity=joined['identity'];terminal=joined['terminal']
 need(identity['machine']==v['machine'] and identity['source_ref']==v['source_ref'] and identity['epoch']==v['epoch'] and terminal['parent_joined'] is True and terminal['supervisor_joined'] is True,'joined supervisor differs')
 parent=terminal['parent_pid'];PARENT_PID=parent;old=Path('/proc')/str(parent)
 if old.exists():
  fields=(old/'stat').read_text().rsplit(') ',1)[1].split()
  need(fields[0]=='Z','campaign parent remains live')
 command_raw=read(custody.parent/'controller-command.json');command=json.loads(command_raw);command_joined=obj(custody.parent/'controller-command.joined.json')
 need(command['machine_id']==v['machine'] and command['source_ref']==v['source_ref'] and command_joined['command_sha256']==digest(command_raw) and command_joined['driver_pid']==driver and command_joined['driver_birth']==launch['driver_birth'] and type(command_joined['exit_code'])is int,'command not joined by original driver')
 common=Path(launch['common_git']);need(common.resolve(strict=True)==common,'common Git alias')
 return repo,common,custody,pending

def execute(v):
 repo,common,custody,pending=prerequisites(v)
 journal=custody/'registered-orphan-drain';identity=v['identity_sha256'];action=v['action']
 if action=='observe':
  need(journal.is_dir(),'no drain invocation')
  intent=obj(journal/'intent.json');need(intent['identity_sha256']==identity,'foreign drain invocation')
  return dict(status='OBSERVED',intents=[p.name for p in journal.glob('term-*.json')],results=[obj(p) for p in journal.glob('result-*.json')],no_signal=True)
 if action=='plan':
  need(not journal.exists(),'drain invocation already exists; observe only')
  writers={r['pid']:r['birth'] for r in pending['writers']};targets=[];held=[]
  for path in sorted((common/'cloudbench-fleet-ownership').iterdir()):
   if not re.fullmatch('[0-9a-f]{32}',path.name):continue
   try:targets.append(owner(path,repo,common,writers,v['source_ref']))
   except (ValueError,KeyError,OSError) as e:held.append(dict(registry=path.name,reason=type(e).__name__))
  need(len({p['pid'] for p in targets})==len(targets),'duplicate owner PID')
  journal.mkdir(mode=0o700);save(journal/'intent.json',dict(identity_sha256=identity,guest_pid=os.getpid(),guest_birth=Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19],operator_ref=v['operator_ref']))
  plan=dict(targets=targets,held=held,launch_sha256=v['launch_sha256'],identity_sha256=identity)
  save(journal/'plan.json',plan)
  return dict(status='PLANNED',targets=len(targets),held=len(held),plan_sha256=digest(read(journal/'plan.json')))
 need(action=='signal','unknown drain action');plan=obj(journal/'plan.json')
 need(obj(journal/'intent.json')['identity_sha256']==identity==plan['identity_sha256'] and digest(read(journal/'plan.json'))==v['plan_sha256'],'drain plan differs')
 start=v['batch']*16;targets=plan['targets'][start:start+16];results=[]
 writers={r['pid']:r['birth'] for r in pending['writers']}
 for expected in targets:
  path=journal/('term-'+str(expected['pid'])+'.json')
  if path.exists():results.append(dict(pid=expected['pid'],state='INTENT_EXISTS_UNKNOWN_NO_REPLAY'));continue
  try:
   fd=pidfd_open(expected['pid'])
   try:
    current=owner(Path(expected['registry']),repo,common,writers,v['source_ref']);need(current==expected,'owner changed after plan')
    need(not select.select([fd],[],[],0)[0],'owner exited')
    save(path,dict(identity_sha256=identity,owner=expected,signal='SIGTERM'))
    executor_uid=os.geteuid()
    try:
     if executor_uid!=expected['uid']:os.seteuid(expected['uid'])
     need(os.geteuid()==expected['uid'],'signal executor UID differs')
     pidfd_send_signal(fd,signal.SIGTERM)
    finally:
     if os.geteuid()!=executor_uid:os.seteuid(executor_uid)
    result=dict(pid=expected['pid'],state='TERM_SENT_NOT_JOINED')
   finally:os.close(fd)
  except (ValueError,KeyError,OSError) as e:result=dict(pid=expected['pid'],state='UNKNOWN_INTENT_NO_REPLAY' if path.exists() else 'HELD',reason=type(e).__name__)
  save(journal/('result-'+str(expected['pid'])+'.json'),result);results.append(result)
 return dict(status='BATCH_FINISHED',results=results,no_export_or_cleanup_claim=True)
"""


AGENT = r"""
import base64,struct

def unix_dump():
 sock=socket.socket(socket.AF_NETLINK,socket.SOCK_RAW,4);sock.settimeout(3)
 request=struct.pack('=BBHIIIII',socket.AF_UNIX,0,0,0xffffffff,0,93,0xffffffff,0xffffffff)
 sock.send(struct.pack('=IHHII',16+len(request),20,0x301,77,0)+request)
 rows={};total=0
 try:
  while True:
   packet,ancillary,msgflags,sender=sock.recvmsg(1048576);need(sender[0]==0 and not msgflags&(socket.MSG_TRUNC|socket.MSG_CTRUNC),'truncated/nonkernel unix diagnostic');total+=len(packet);need(total<=8388608,'unix diagnostic bound')
   offset=0
   while offset+16<=len(packet):
    size,kind,flags,seq,pid=struct.unpack_from('=IHHII',packet,offset);need(seq==77 and not flags&0x10 and size>=16 and offset+size<=len(packet),'interrupted/mismatched/truncated unix diagnostic')
    body=packet[offset+16:offset+size];offset+=(size+3)&~3
    if kind==3:
     need(offset==len(packet) and len(body)>=4 and struct.unpack_from('=i',body)[0]==0,'incomplete unix diagnostic completion');return rows
    if kind==2:need(struct.unpack_from('=i',body)[0]==0,'unix diagnostic kernel error');continue
    family,typ,state,pad,inode,c1,c2=struct.unpack_from('=BBBBIII',body)
    need(family==socket.AF_UNIX and inode not in rows,'duplicate unix diagnostic')
    row={'inode':inode,'type':typ,'state':state};at=16
    while at+4<=len(body):
     length,key=struct.unpack_from('=HH',body,at);need(length>=4 and at+length<=len(body),'truncated unix attribute')
     raw=body[at+4:at+length];at+=(length+3)&~3;key&=0x3fff
     if key==0:row['name']=os.fsdecode(raw.rstrip(b'\0'))
     elif key in (2,7):row['peer' if key==2 else 'uid']=struct.unpack('=I',raw)[0]
     elif key==3:row['icons']=list(struct.unpack('='+str(len(raw)//4)+'I',raw))
     elif key==4:row['queues']=list(struct.unpack('=II',raw))
    need(at==len(body),'trailing unix diagnostic attributes');rows[inode]=row
   need(offset==len(packet),'trailing unix diagnostic datagram')
 finally:sock.close()

def process_socket_fds(path):
 sockets=[];count=0
 with os.scandir(path/'fd')as stream:
  for entry in stream:
   count+=1;link=os.readlink(entry.path);match=re.fullmatch(r'socket:\[([0-9]+)\]',link)
   if match:sockets.append((int(match.group(1)),entry.name))
 return sockets,count

def agent_capture(v,repo=Path('/tmp/gate/repo'),custody=Path('/tmp/gate/controller-host-custody'),proc=Path('/proc')):
 result={'schema':'normal-agent-custody-capture-v1','files':{},'missing':[],'errors':[],'machine':os.environ.get('FLY_MACHINE_ID'),'source_ref':os.environ.get('GATE_REF'),'collector_pid':os.getpid()};total=0
 def attempt(label,operation):
  try:return operation()
  except Exception as error:result['errors'].append({'phase':label,'error':type(error).__name__,'detail':str(error)[:500]});return None
 def artifact(path):
  nonlocal total
  path=Path(path)
  try:
   s=path.lstat()
   if stat.S_ISREG(s.st_mode):
    raw=read(path);total+=len(raw);need(total<=16777216,'agent custody bytes bound')
    result['files'][str(path)]={'sha256':digest(raw),'body_b64':base64.b64encode(raw).decode(),'uid':s.st_uid,'mode':s.st_mode,'nlink':s.st_nlink,'dev':s.st_dev,'ino':s.st_ino};return raw
   result['files'][str(path)]={'mode':s.st_mode,'uid':s.st_uid,'dev':s.st_dev,'ino':s.st_ino}
  except FileNotFoundError:result['missing'].append(str(path))
  except Exception as error:result['errors'].append({'phase':str(path),'error':type(error).__name__,'detail':str(error)[:500]})
  return None
 def identity(pid,environment=False):
  path=proc/str(pid);s=(path/'stat').read_text().rsplit(') ',1)[1].split();birth='proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+s[19]
  status=dict(line.split(':',1) for line in(path/'status').read_text().splitlines() if ':'in line)
  row={'pid':pid,'birth':birth,'ppid':int(s[1]),'state':s[0],'uid':[int(x)for x in status['Uid'].split()],'argv':[os.fsdecode(x)for x in(path/'cmdline').read_bytes().rstrip(b'\0').split(b'\0')],'cwd':str((path/'cwd').resolve(strict=True)),'exe':os.readlink(path/'exe'),'children':(path/'task'/str(pid)/'children').read_text().split()}
  if environment:
   env=dict(x.split(b'=',1)for x in(path/'environ').read_bytes().split(b'\0')if b'='in x)
   row['environment']={os.fsdecode(k):os.fsdecode(env[k])for k in env if k in (b'CLOUDBENCH_FLEET_OWNER_TOKEN',b'REVIEWED_OPERATOR_SOURCE_REF',b'REVIEWED_OPERATOR_ROOT',b'CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY',b'CLOUDBENCH_CAMPAIGN_SEED_PROOF')}
   row['fds']={p.name:os.readlink(p)for p in(path/'fd').iterdir()}
  need((path/'stat').read_text().rsplit(') ',1)[1].split()[19]==s[19],'process changed during census');return row
 launch_raw=artifact(custody/'launch.json');launch=json.loads(launch_raw)if launch_raw else None
 artifact(custody/'pending.json');artifact(custody.parent/'controller-command.json');artifact(custody.parent/'controller-command.joined.json')
 target=attempt('agent identity',lambda:identity(v['agent_pid'],True));result['agent']=target
 result['unix_before']=attempt('unix before',unix_dump)
 owners={};count=0;pids=sorted(p for p in proc.iterdir()if p.name.isdigit())
 if len(pids)>8192:result['errors'].append({'phase':'process census','error':'process bound exceeded'});return result
 for path in pids:
  try:
   sockets,scanned=process_socket_fds(path);count+=scanned
   if count>65536:result['errors'].append({'phase':'fd census','error':'fd bound exceeded'});break
   if sockets:
    rawstat=(path/'stat').read_text().rsplit(') ',1)[1].split();status=dict(line.split(':',1)for line in(path/'status').read_text().splitlines()if ':'in line)
    row={'pid':int(path.name),'birth':'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+rawstat[19],'state':rawstat[0],'uid':[int(x)for x in status['Uid'].split()],'socket_fds':[{'inode':ino,'fd':fd}for ino,fd in sockets]}
    try:row.update(identity(int(path.name)))
    except FileNotFoundError:row['optional_identity']='process cwd/exe disappeared after complete fd snapshot'
    owners[path.name]=row
  except FileNotFoundError:
   if path.exists():
    try:
     fields=(path/'stat').read_text().rsplit(') ',1)[1].split();closed=fields[0]in('Z','X')and not list((path/'fd').iterdir())
    except FileNotFoundError:closed=not path.exists()
    if not closed:result['errors'].append({'phase':'fd census','pid':path.name,'error':'live process fd/identity race'})
  except Exception as error:result['errors'].append({'phase':'fd census','pid':path.name,'error':type(error).__name__,'detail':str(error)[:500]})
 result['socket_owners']=owners;result['fd_count']=count;result['pid_count']=len(pids)
 result['unix_after']=attempt('unix after',unix_dump);result['agent_after']=attempt('agent after',lambda:identity(v['agent_pid'],True))
 if target:
  token=target['environment'].get('CLOUDBENCH_FLEET_OWNER_TOKEN','')
  if re.fullmatch('[0-9a-f]{32}',token)and launch:
   common=Path(launch['common_git']);registry=common/'cloudbench-fleet-ownership'/token;audit=common/'cloudbench-fleet-audits'/token
   for base in(registry,audit):
    for name in('meta','source-manifest.json','owned-clones.ids','owned-clones.names','provider-teardown-verified.epoch'):artifact(base/name)
   for base in(registry,audit):
    raw=result['files'].get(str(base/'meta'),{}).get('body_b64')
    if raw:
     fields=dict(line.split('=',1)for line in base64.b64decode(raw).decode().splitlines()if '='in line)
     run=fields.get('run_id','')
     if re.fullmatch('[0-9]{8}-[0-9]{6}-[0-9]+',run):
      runroot=repo/'.context/fleet/runs'/run
      for name in('source-manifest.json','run.json','teardown-ownership.json','parent-preflight.receipt.json'):artifact(runroot/name)
      result.setdefault('fleet_runs',[]).append({'run':run,'owner_pid':int(run.rsplit('-',1)[1]),'owner_current':attempt('fleet owner',lambda:identity(int(run.rsplit('-',1)[1])))if(proc/run.rsplit('-',1)[1]).exists()else None})
  artifact('/home/rose/.fly/flyctl.agent.lock');artifact('/home/rose/.fly/fly-agent.sock')
  for fd,path in target['fds'].items():
   if path.startswith('/home/rose/.fly/agent-logs/')and not path.endswith('(deleted)'):artifact(path)
  def binary():
   path=proc/str(v['agent_pid'])/'exe';before=path.stat();h=hashlib.sha256()
   with path.open('rb')as stream:
    for block in iter(lambda:stream.read(1048576),b''):h.update(block)
   after=path.stat();need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns),'agent executable changed')
   return dict(sha256=h.hexdigest(),dev=before.st_dev,ino=before.st_ino,size=before.st_size,uid=before.st_uid,mode=before.st_mode)
  result['binary']=attempt('binary',binary)
 result['complete']=not result['errors'];return result

def agent_capture_proof(c,v,uid=None):
 need(c.get('complete')is True and not c['errors'],'incomplete agent custody capture')
 need(c['machine']==v['machine']and c['source_ref']==v['source_ref'],'agent capture source differs')
 a=c['agent'];need(a==c['agent_after'],'agent changed during custody capture')
 uid=pwd.getpwnam('rose').pw_uid if uid is None else uid
 need(a['pid']==v['agent_pid']and a['birth']==v['agent_birth']and a['ppid']==1 and a['uid']==[uid]*4 and a['cwd']=='/tmp/gate/repo'and not a['children'],'agent identity differs')
 log=a['argv'][3]if len(a['argv'])==4 else''
 need(a['argv'][:3]==['/tmp/gate/bin/flyctl','agent','run']and re.fullmatch('/home/rose/.fly/agent-logs/[0-9]+[.]log',log)and a['exe']=='/tmp/gate/bin/flyctl','agent invocation differs')
 env=a['environment'];token=env.get('CLOUDBENCH_FLEET_OWNER_TOKEN','')
 need(re.fullmatch('[0-9a-f]{32}',token)and env.get('REVIEWED_OPERATOR_SOURCE_REF')==v['source_ref']and env.get('REVIEWED_OPERATOR_ROOT')=='/tmp/gate/repo','agent inherited owner differs')
 need(c['binary']['sha256']==v['binary_sha256'],'agent binary differs')
 before={int(k):row for k,row in c['unix_before'].items()};after={int(k):row for k,row in c['unix_after'].items()};need(before==after,'unix graph changed during custody capture')
 agent_inodes={int(m.group(1))for target in a['fds'].values()if(m:=re.fullmatch(r'socket:\[([0-9]+)\]',target))and int(m.group(1))in before}
 need(len(agent_inodes)==1,'agent has connected unix endpoints')
 inode=next(iter(agent_inodes));listener=before[inode]
 need(listener.get('name')=='/home/rose/.fly/fly-agent.sock'and listener['state']==10 and listener['type']==1 and listener.get('uid')==uid and listener.get('icons')==[]and listener.get('queues',[None])[0]==0,'agent listener has clients or unknown queue')
 need(all(not row.get('peer')in agent_inodes and not agent_inodes.intersection(row.get('icons',[]))for row in before.values()),'external unix peer remains')
 owners={int(pid)for pid,row in c['socket_owners'].items()if any(fd['inode']==inode for fd in row['socket_fds'])}
 need(owners=={a['pid']},'agent listener ownership incomplete')
 def evidence(path):
  f=c['files'][str(path)];raw=base64.b64decode(f['body_b64'],validate=True);need(digest(raw)==f['sha256']and f['nlink']==1 and not f['mode']&0o022,'agent evidence differs');return raw
 launch_raw=evidence(Path('/tmp/gate/controller-host-custody/launch.json'));launch=json.loads(launch_raw)
 need(digest(launch_raw)==v['launch_sha256']and launch['machine_id']==v['machine']and launch['source_ref']==v['source_ref'],'agent launch differs')
 common=Path(launch['common_git']);audit=common/'cloudbench-fleet-audits'/token
 need(all(c['files'][str(audit/name)]['uid']==uid for name in('meta','owned-clones.ids','owned-clones.names','provider-teardown-verified.epoch')),'foreign agent audit owner')
 meta_raw=evidence(audit/'meta');meta={}
 for line in meta_raw.decode().splitlines():
  key,sep,value=line.partition('=');need(sep and key not in meta,'duplicate agent audit metadata');meta[key]=value
 run=meta.get('run_id','')
 need(meta.get('version')=='1'and meta.get('fleet_owner_token')==token and meta.get('status')=='provider-teardown-verified'and meta.get('app')=='navi-whisper-lux-bench'and meta.get('workspace_root')=='/tmp/gate/repo'and re.fullmatch('[0-9]{8}-[0-9]{6}-[0-9]+',run),'agent fleet audit not closed')
 rows=[r for r in c.get('fleet_runs',[])if r['run']==run];need(rows and all(r['owner_current']is None for r in rows),'agent fleet owner remains live')
 sealed=int(evidence(audit/'provider-teardown-verified.epoch').decode().strip());need(v['epoch']<=sealed<=time.time(),'agent audit clock differs')
 for path in(audit/'owned-clones.ids',audit/'owned-clones.names'):evidence(path)
 if meta.get('source_manifest_sha256'):need(digest(evidence(audit/'source-manifest.json'))==meta['source_manifest_sha256'],'agent base source differs')
 for path in(Path(log),Path('/home/rose/.fly/flyctl.agent.lock')):
  raw=evidence(path);need(c['files'][str(path)]['uid']==uid and str(path)in a['fds'].values(),'agent log/lock custody differs')
 socket_file=c['files']['/home/rose/.fly/fly-agent.sock'];need(stat.S_ISSOCK(socket_file['mode'])and socket_file['uid']==uid,'agent socket custody differs')
 return dict(pid=a['pid'],birth=a['birth'],uid=uid,role='closed-fleet-default-agent',owner_token=token,run_id=run,owner_pid=int(run.rsplit('-',1)[1]),binary_sha256=c['binary']['sha256'],launch_sha256=v['launch_sha256'],listener_inode=inode,capture_sha256=digest(json.dumps(c,sort_keys=True).encode()))


def agent_cleanup_deadline(v):
 if 'cleanup_deadline_epoch'not in v:return v['deadline']
 cutoff=v['cleanup_deadline_epoch']
 need(v['epoch']==1792279176.5459259 and v['deadline']==v['epoch']+5400 and v.get('cleanup_hold_id')=='w986k6vhvhm3sftz2y0a0tambs8ghw4d' and type(cutoff)in(int,float)and 1792285350.425<=time.time()<cutoff<=1792286550.425,'cleanup-only window differs')
 return cutoff

def agent_closed_writer(v):
 import contextlib,io
 need(os.environ.get('FLY_MACHINE_ID')==v['machine']and os.environ.get('GATE_REF')==v['source_ref']and time.time()<agent_cleanup_deadline(v),'normal agent source/clock differs')
 identity_path=Path(v['identity_path']);need(identity_path.parent==Path('/tmp/gate/repo/.context')and identity_path.name.startswith('original600-supervisor.'),'normal supervisor path differs')
 raw=read(identity_path);identity=json.loads(raw);terminal=obj(identity_path.with_suffix('.terminal.json'))
 need(identity==v['joined']['identity']and digest(raw)==v['joined']['identity_sha256']and terminal==v['joined']['terminal']and terminal['supervisor_joined']is True and terminal['parent_joined']is True,'normal joined supervisor differs')
 for pid in(identity['pid'],terminal['parent_pid']):
  path=Path('/proc')/str(pid)
  if path.exists():need((path/'stat').read_text().rsplit(') ',1)[1].split()[0]=='Z','normal producer remains live')
 import ast
 source=subprocess.check_output(['git','-c','safe.directory=/tmp/gate/repo','--no-replace-objects','-C','/tmp/gate/repo','show',v['source_ref']+':scripts/cloudbench-resume-controller-export.py'])
 remote=next(ast.literal_eval(n.value)for n in ast.parse(source).body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='REMOTE'for t in n.targets));need(digest(remote.encode())==v['export_probe_sha256'],'normal writer probe source differs')
 scope={'__name__':'normal_agent_export_readonly'};exec(compile(remote,'bound-normal-export-readonly','exec'),scope)
 stdout,stderr=io.StringIO(),io.StringIO();os.chdir('/')
 try:
  with contextlib.redirect_stdout(stdout),contextlib.redirect_stderr(stderr):
   try:scope['main'](dict(v['export_probe'],action='check'))
   except SystemExit as error:need(error.code==75,'normal writer probe failed')
 finally:os.chdir('/tmp/gate/repo')
 result=json.loads(stdout.getvalue());writers=result.get('non_hub_writers')
 need(result['machine']==v['machine']and result['launch_sha256']==v['launch_sha256']and isinstance(writers,list)and len(writers)==1 and writers[0]['pid']==v['agent_pid']and writers[0]['birth']==v['agent_birth'],'normal agent is not sole canonical writer')
 return dict(result=result,stderr=stderr.getvalue())

def agent_execute(v,custody=Path('/tmp/gate/controller-host-custody')):
 os.chdir('/tmp/gate/repo');journal=custody/'registered-orphan-drain';action=v['action'];identity=v['identity_sha256']
 need('cleanup_deadline_epoch'not in v or action in('signal','observe'),'cleanup cannot create a new plan')
 if action=='observe':
  intent=obj(journal/'intent.json');need(intent['identity_sha256']==identity and intent['role']=='normal-agent','foreign normal agent invocation')
  return dict(status='OBSERVED',no_signal=True,results=[obj(p)for p in journal.glob('result-*.json')],no_exit_credit_from_receipts=True)
 need(action in('plan','signal'),'unknown normal agent action')
 if action=='plan':need(not journal.exists(),'normal agent invocation already consumed; observe only')
 else:
  need(v.get('batch')==0,'only one normal agent target')
  plan=obj(journal/'plan.json');need(plan['identity_sha256']==identity and digest(read(journal/'plan.json'))==v['plan_sha256'],'normal agent plan differs')
  if(journal/('term-'+str(v['agent_pid'])+'.json')).exists():return dict(status='INTENT_EXISTS_UNKNOWN_NO_REPLAY',no_signal=True)
 closed=agent_closed_writer(v);capture=agent_capture(v);proof=agent_capture_proof(capture,v)
 if action=='plan':
  journal.mkdir(mode=0o700);save(journal/'capture.private.json',capture);save(journal/'writer-check.private.json',closed)
  save(journal/'intent.json',dict(identity_sha256=identity,operator_ref=v['operator_ref'],launch_sha256=v['launch_sha256'],role='normal-agent',guest_pid=os.getpid()))
  save(journal/'plan.json',dict(identity_sha256=identity,launch_sha256=v['launch_sha256'],role='normal-agent',targets=[proof],held=[]))
  return dict(status='PLANNED',targets=1,held=0,plan_sha256=digest(read(journal/'plan.json')))
 expected=plan['targets'][0];need(all(proof.get(k)==value for k,value in expected.items()if k!='capture_sha256'),'normal agent changed since plan')
 fd=pidfd_open(proof['pid'])
 try:
  current=process(proof['pid'],proof['uid']);need(current['birth']==proof['birth']and current['cwd']=='/tmp/gate/repo'and not select.select([fd],[],[],0)[0],'normal agent process changed')
  save(journal/'pre-signal-capture.private.json',capture);save(journal/'pre-signal-writer-check.private.json',closed)
  save(journal/('term-'+str(proof['pid'])+'.json'),dict(identity_sha256=identity,owner=proof,signal='SIGTERM',role='normal-agent'))
  latest=unix_dump();before={int(k):value for k,value in capture['unix_after'].items()};inode=proof['listener_inode']
  current_sockets,_=process_socket_fds(Path('/proc')/str(proof['pid']))
  need(time.time()<agent_cleanup_deadline(v)and not(Path('/proc')/str(proof['owner_pid'])).exists()and latest.get(inode)==before[inode]and {ino for ino,_ in current_sockets if ino in latest}=={inode}and all(row.get('peer')!=inode and inode not in row.get('icons',[])for row in latest.values()),'normal agent client/clock changed before TERM')
  executor=os.geteuid()
  try:
   if executor!=proof['uid']:os.seteuid(proof['uid'])
   need(os.geteuid()==proof['uid']and time.time()<agent_cleanup_deadline(v),'normal agent signal UID/clock differs');pidfd_send_signal(fd,signal.SIGTERM)
  finally:
   if os.geteuid()!=executor:os.seteuid(executor)
  exited=bool(select.select([fd],[],[],2)[0]);result=dict(pid=proof['pid'],birth=proof['birth'],state='EXIT_OBSERVED'if exited else'TERM_SENT_NOT_JOINED',role='normal-agent',no_release_claim=True)
  save(journal/('result-'+str(proof['pid'])+'.json'),result);return dict(status='BATCH_FINISHED',results=[result],no_export_or_cleanup_claim=True)
 finally:os.close(fd)


old_execute=execute
def execute(v):
 if v.get('role')=='normal-agent':
  if v['action']=='capture':return agent_capture(v)
  return agent_execute(v)
 return old_execute(v)
"""
_export_tree = ast.parse((HERE / "cloudbench-controller-export.py").read_bytes())
_pidfd_source = next(
    ast.literal_eval(node.value)
    for node in _export_tree.body
    if isinstance(node, ast.Assign)
    and any(isinstance(target, ast.Name) and target.id == "PIDFD_SOURCE" for target in node.targets)
)
# The shared guest core (pidfd binding, custody reads, process identity and
# prerequisites) without the normal-agent capture path. Guests that only need
# the core, such as relay retirement, ship it alone so their exec body stays
# within the bounded 16 KiB Machine exec transport.
CORE_GUEST = _pidfd_source + "\n" + GUEST
GUEST = CORE_GUEST + AGENT


def command(payload):
    package = base64.b64encode(gzip.compress(json.dumps([GUEST, payload]).encode(), mtime=0)).decode()
    loader = "import base64,gzip,json,sys;s,v=json.loads(gzip.decompress(base64.b64decode(sys.argv[1])));exec(s);print(json.dumps(execute(v),sort_keys=True))"
    body = {
        "cmd": shlex.join(["python3", "-S", "-c", loader, package]),
        "timeout": 18,
        "machine": True,
    }
    need(len(json.dumps(body).encode()) <= 16384, "bounded drain exec body required")
    return body


def saved_command_matches(actual, expected, source, payload):
    need(isinstance(actual, dict) and set(actual) == set(expected), "saved command fields differ")
    need(
        actual["timeout"] == expected["timeout"] and actual["machine"] is expected["machine"],
        "saved command bounds differ",
    )
    need(isinstance(actual["cmd"], str) and len(json.dumps(actual).encode()) <= 16384, "saved command exceeds bound")
    argv, wanted = shlex.split(actual["cmd"]), shlex.split(expected["cmd"])
    need(len(argv) == len(wanted) and argv[:-1] == wanted[:-1], "saved command loader differs")
    packed = base64.b64decode(argv[-1], validate=True)
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    raw = decoder.decompress(packed, 256 * 1024 + 1)
    need(
        len(raw) <= 256 * 1024 and decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail,
        "saved command compression differs",
    )
    need(
        json.dumps(json.loads(raw), sort_keys=True) == json.dumps([source, payload], sort_keys=True),
        "saved command source or payload differs",
    )
    return True


def successful_agent_response(response, payload, action):
    need(
        response.get("exit_code") == 0 and response.get("exit_signal", 0) == 0,
        "drain exec uncertain; observe only",
    )
    result = json.loads(response["stdout"])
    stderr = response.get("stderr")
    if stderr not in (None, ""):
        need(
            payload.get("role") == "normal-agent"
            and action in ("plan", "signal")
            and isinstance(stderr, str)
            and re.fullmatch(r"EXPORT_PHASE REMOTE_ENTERED [0-9]+\n", stderr),
            "unknown drain exec diagnostic",
        )
        need(
            (
                action == "plan"
                and result.get("status") == "PLANNED"
                and result.get("targets") == 1
                and result.get("held") == 0
                and re.fullmatch("[0-9a-f]{64}", result.get("plan_sha256", ""))
            )
            or (
                action == "signal"
                and result.get("status") == "BATCH_FINISHED"
                and len(result.get("results", [])) == 1
                and result["results"][0].get("pid") == payload["agent_pid"]
            ),
            "diagnostic without positive bound result",
        )
    return result


def saved_positive_plan(args, export):
    root = args.run_directory.absolute() / "registered-orphan-drain"
    names = {"intent.json"} | {
        "wire-00000" + str(i) + suffix for i in (1, 2) for suffix in (".request.json", ".raw.json", ".decoded.json")
    }
    adopted = root / "result-adopted-plan.json"
    need(
        {p.name for p in root.iterdir()} in (names, names | {adopted.name}),
        "unknown saved plan namespace",
    )
    inputs = {str(root / name): sha(read(root / name)) for name in names}
    intent = F["obj"](root / "intent.json")
    payload, operator = intent["payload"], intent["operator"]
    old_ref = "30eb08e7ead85d03a44edf06cc557c8888ba4267"
    need(
        payload["identity_sha256"]
        == sha(
            json.dumps(
                {key: value for key, value in payload.items() if key != "identity_sha256"},
                sort_keys=True,
            ).encode()
        ),
        "saved plan identity differs",
    )
    need(
        payload["operator_ref"] == old_ref and payload["role"] == operator["role"] == "normal-agent",
        "unknown saved plan producer",
    )
    source_paths = [
        Path(path) for path in operator["source_pins"] if Path(path).name == "cloudbench-controller-orphan-drain.py"
    ]
    need(
        len(source_paths) == 1
        and sha(read(source_paths[0])) == "0690d2b29756e8ddcf81887f338d805296871b723fad4553cc3e138e38ed5263",
        "saved plan source differs",
    )
    for path, expected in operator["source_pins"].items():
        need(
            F["normalized"](B["fingerprint"](path)) == expected,
            "saved plan operator evidence changed",
        )
    expected_names = {
        "cloudbench-controller-orphan-drain.py",
        "cloudbench-controller-export.py",
        "cloudbench-resume-controller-export.py",
        "cloudbench-controller-payload-finalization.py",
        "cloudbench-original600-runner.py",
        "cloudbench-resume-controller-payload.py",
        "cloudbench-original-volume-capture.py",
    }
    need(
        # Historical saved plans embed the old guest and predate the shared
        # pidfd source. Keep that exact old source set valid for observation.
        set(operator["source_hashes"]) in (expected_names, expected_names - {"cloudbench-controller-export.py"}),
        "incomplete saved plan producer sources",
    )
    for name, expected in operator["source_hashes"].items():
        need(
            sha(
                subprocess.check_output(
                    [
                        "git",
                        "--no-replace-objects",
                        "-C",
                        str(HERE.parent),
                        "show",
                        old_ref + ":scripts/" + name,
                    ]
                )
            )
            == expected,
            "saved plan producer Git binding differs",
        )
    old = runpy.run_path(str(source_paths[0]))

    def recorded(i):
        stem = root / ("wire-00000" + str(i))
        request, wire, decoded = (
            F["obj"](Path(str(stem) + suffix)) for suffix in (".request.json", ".raw.json", ".decoded.json")
        )
        raw = base64.b64decode(wire["body_b64"], validate=True)
        need(
            wire["status"] == 200
            and wire["bytes"] == len(raw)
            and wire["sha256"] == sha(raw)
            and json.loads(raw) == decoded
            and wire["method"] == request["method"]
            and wire["path"] == request["path"],
            "saved plan raw response differs",
        )
        return request, decoded

    first, native = recorded(1)
    second, response = recorded(2)
    need(
        first == {"method": "GET", "path": "/machines/" + payload["machine"], "body": None}
        and set(second) == {"method", "path", "body"}
        and second["method"] == "POST"
        and second["path"] == "/machines/" + payload["machine"] + "/exec"
        and saved_command_matches(
            second["body"], old["command"](dict(payload, action="plan")), old["GUEST"], dict(payload, action="plan")
        ),
        "saved plan request differs",
    )
    plan = successful_agent_response(response, payload, "plan")
    need(
        response.get("stderr") and plan["status"] == "PLANNED" and plan["targets"] == 1 and plan["held"] == 0,
        "not a known diagnostic plan refusal",
    )
    state = export["normal_state"](
        args.config,
        args.config_sha256,
        args.run_directory.absolute(),
        **(
            {"cleanup_deadline_epoch": args.cleanup_deadline_epoch}
            if getattr(args, "cleanup_deadline_epoch", None) is not None
            else {}
        ),
    )
    need(
        payload["machine"] == state["machine_id"]
        and payload["source_ref"] == state["source_ref"]
        and payload["epoch"] == state["epoch"]
        and payload["deadline"] == state["deadline"]
        and all(native.get(k) == state["machine"].get(k) for k in ("id", "instance_id", "config", "name", "region")),
        "saved plan native binding differs",
    )
    record = F["obj"](args.run_directory / "export/launch.json")
    need(
        record == payload["export_probe"]["record"]
        and sha(read(args.run_directory / "export/launch.json")) == payload["launch_sha256"]
        and record["caller"]["pid"] == state["caller"]["gate_pid"]
        and record["caller"]["birth"] == state["caller"]["gate_birth"],
        "saved plan launch differs",
    )
    value = dict(
        state=state,
        config=str(args.config.absolute()),
        config_sha256=args.config_sha256,
        pins={path: B["fingerprint"](path) for path in inputs},
        binding={"launch_sha256": payload["launch_sha256"]},
        record=record,
        driver_sha256=payload["export_probe"]["driver_sha256"],
    )
    if adopted.exists():
        receipt = F["obj"](adopted)
        need(
            receipt
            == dict(
                plan,
                adopted_from_raw_sha256=inputs[str(root / "wire-000002.raw.json")],
                observed_under_operator_ref=args.operator_ref,
                prior_plan_operator_ref=old_ref,
            ),
            "foreign plan adoption receipt",
        )
    return dict(payload=payload, plan=plan, inputs=inputs, value=value)


def normal_agent_state(args):
    need(
        getattr(args, "cleanup_deadline_epoch", None) is None or getattr(args, "resume_planned", False),
        "cleanup window requires saved normal plan",
    )
    export = runpy.run_path(str(HERE / "cloudbench-resume-controller-export.py"))
    saved = saved_positive_plan(args, export) if getattr(args, "resume_planned", False) else None
    value = saved["value"] if saved else getattr(args, "_normal_export_value", None)
    if value is None:
        value = export["check"](
            args.config,
            args.config_sha256,
            args.run_directory,
            args.operator_ref,
            **(
                {"cleanup_deadline_epoch": args.cleanup_deadline_epoch}
                if getattr(args, "cleanup_deadline_epoch", None) is not None
                else {}
            ),
        )
    else:
        export["unchanged"](value)
    state = dict(value["state"])
    need(
        state["schema"] == "controller-normal-export-identities-v1",
        "normal agent requires normal owner proof",
    )
    capture_path = args.agent_custody.absolute()
    captured = F["obj"](capture_path)
    need(
        captured.get("complete") is True
        and not captured["errors"]
        and captured["machine"] == state["machine_id"]
        and captured["source_ref"] == state["source_ref"],
        "complete normal agent custody required",
    )
    agent = captured["agent"]
    need(
        agent == captured["agent_after"] and type(agent["pid"]) is int and agent["pid"] > 1,
        "captured agent identity differs",
    )
    out = Path(state["out"])
    probes = sorted(out.glob("supervisor-probe-[0-9][0-9][0-9][0-9][0-9][0-9].json"))
    need(probes, "normal supervisor observation missing")
    probe_path = getattr(args, "_normal_joined_path", probes[-1])
    joined = F["obj"](probe_path)
    identity, terminal = joined.get("identity", {}), joined.get("terminal", {})
    need(
        joined.get("state") == "JOINED"
        and identity.get("machine") == state["machine_id"]
        and identity.get("source_ref") == state["source_ref"]
        and identity.get("epoch") == state["epoch"]
        and joined["identity_sha256"] == sha((json.dumps(identity, sort_keys=True) + "\n").encode())
        and all(terminal.get(key) == item for key, item in identity.items())
        and terminal.get("parent_joined") is True
        and terminal.get("supervisor_joined") is True,
        "normal source-bound JOINED proof differs",
    )
    names = (
        "cloudbench-controller-orphan-drain.py",
        "cloudbench-controller-export.py",
        "cloudbench-resume-controller-export.py",
        "cloudbench-controller-payload-finalization.py",
        "cloudbench-original600-runner.py",
        "cloudbench-resume-controller-payload.py",
        "cloudbench-original-volume-capture.py",
    )
    hashes = {name: sha((HERE / name).read_bytes()) for name in names}
    pins = B["source_identity"](HERE.parent, args.operator_ref, hashes)
    pins.update({str(path): B["fingerprint"](path) for path in (capture_path, probe_path)})
    probe = {
        "machine": state["machine_id"],
        "source_ref": state["source_ref"],
        "launch_sha256": value["binding"]["launch_sha256"],
        "collector_sha256": value["record"]["collector_sha256"],
        "record": value["record"],
        "driver_sha256": value["driver_sha256"],
        "binding_sha256": sha(
            json.dumps(
                dict(
                    config_sha256=args.config_sha256,
                    launch_sha256=value["binding"]["launch_sha256"],
                ),
                sort_keys=True,
            ).encode()
        ),
    }
    state["_normal_export_value"] = value
    state["_normal_joined_path"] = probe_path
    state["_agent_payload"] = dict(
        role="normal-agent",
        agent_pid=agent["pid"],
        agent_birth=agent["birth"],
        binary_sha256=captured["binary"]["sha256"],
        identity_path=state["caller"]["identity_path"],
        export_probe=probe,
        export_probe_sha256=sha(export["REMOTE"].encode()),
    )
    state["_drain"] = dict(
        joined=joined,
        launch_sha256=value["binding"]["launch_sha256"],
        source_hashes=hashes,
        source_pins=pins,
        joined_files={str(probe_path): sha(read(probe_path))},
        joined_journal=str(out),
        initial_capture_path=str(capture_path),
        initial_capture_sha256=sha(read(capture_path)),
        role="normal-agent",
    )
    if saved:
        state["_saved_plan"] = saved
    payload = payload_for(args, state)
    function = next(
        node
        for node in ast.parse(GUEST).body
        if isinstance(node, ast.FunctionDef) and node.name == "agent_capture_proof"
    )
    compiled = compile(ast.Module(body=[function], type_ignores=[]), "source-bound-agent-proof", "exec")
    code = next(item for item in compiled.co_consts if isinstance(item, types.CodeType))
    namespace = dict(
        need=need,
        digest=sha,
        base64=base64,
        stat=stat,
        re=re,
        time=time,
        Path=Path,
        json=json,
    )
    validate = types.FunctionType(
        code,
        namespace,
        argdefs=(value["record"]["root_anchors"]["/tmp/gate/repo"]["uid"],),
    )
    validate(captured, payload)
    execution = {}
    if "cleanup_deadline_epoch" in state:
        execution = dict(
            cleanup_deadline_epoch=state["cleanup_deadline_epoch"],
            cleanup_hold_id=state["cleanup_hold_id"],
            execution_operator_ref=args.operator_ref,
        )
    command(dict(payload, action="plan", **execution))
    command(dict(payload, action="signal", batch=0, plan_sha256="0" * 64, **execution))
    return state


def local_state(args):
    if getattr(args, "normal_agent", False):
        return normal_agent_state(args)

    out = args.run_directory.absolute()
    state = F["obj"](out / "payload-finalizer.identities.private.json")
    roots = {
        str(Path(p).parent.parent)
        for p in state["pins"]
        if Path(p).name == "cloudbench-controller-payload-finalization.py"
    }
    need(len(roots) == 1, "ambiguous captured source")
    F["validate"](
        state,
        args.config,
        args.config_sha256,
        out,
        state["operator_ref"],
        Path(roots.pop()),
    )
    need(time.time() >= state["deadline"], "original clock has not expired")
    names = (
        "cloudbench-controller-orphan-drain.py",
        "cloudbench-controller-export.py",
        "cloudbench-controller-payload-finalization.py",
        "cloudbench-original600-runner.py",
        "cloudbench-resume-controller-payload.py",
        "cloudbench-original-volume-capture.py",
    )
    hashes = {n: sha((HERE / n).read_bytes()) for n in names}
    pins = B["source_identity"](HERE.parent, args.operator_ref, hashes)
    journal = args.joined_journal.absolute()
    need(
        journal.parent == out and journal.resolve(strict=True) == journal,
        "exact prior joined journal required",
    )
    files = {p.name: sha(read(p)) for p in journal.iterdir()}
    requests = {}
    probe = {
        "machine": state["machine_id"],
        "source_ref": state["source_ref"],
        "epoch": state["epoch"],
        "identity_path": state["caller"]["identity_path"],
        "action": "PROBE",
    }
    expected = {
        "cmd": R["exec_command"](R["REMOTE_CONTROL"], probe),
        "timeout": 20,
        "machine": True,
    }
    for name in files:
        if name.endswith(".request.json"):
            value = F["obj"](journal / name)
            need(
                value
                == {
                    "method": "GET",
                    "path": "/machines/" + state["machine_id"],
                    "body": None,
                }
                or value
                == {
                    "method": "POST",
                    "path": "/machines/" + state["machine_id"] + "/exec",
                    "body": expected,
                },
                "prior journal contains effects",
            )
            requests[name.removesuffix(".request.json")] = value
    joined = F["prior_joined_probe"](state, journal, requests, files)
    need(joined is not None, "positive joined proof required")
    pending_raw = read(args.pending)
    pending = json.loads(pending_raw)
    need(
        pending["status"] == "pending" and pending["reason"] == "live controller writers",
        "pending writers proof required",
    )
    state["_drain"] = {
        "joined": joined,
        "launch_sha256": pending["record_sha256"],
        "source_hashes": hashes,
        "source_pins": pins,
        "joined_files": files,
        "joined_journal": str(journal),
        "pending_path": str(args.pending.absolute()),
        "pending_sha256": sha(pending_raw),
    }
    return state


def payload_for(args, state):
    if state.get("_saved_plan"):
        return state["_saved_plan"]["payload"]
    payload = {
        "machine": state["machine_id"],
        "source_ref": state["source_ref"],
        "epoch": state["epoch"],
        "deadline": state["deadline"],
        "joined": state["_drain"]["joined"],
        "launch_sha256": state["_drain"]["launch_sha256"],
        "operator_ref": args.operator_ref,
    }
    payload["fleet_source_sha256"] = sha(
        subprocess.check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                state["source_root"],
                "show",
                state["source_ref"] + ":scripts/run-bench-fleet",
            ]
        )
    )
    payload.update(state.get("_agent_payload", {}))
    payload["identity_sha256"] = sha(json.dumps(payload, sort_keys=True).encode())
    return payload


def _run(args, state):
    if getattr(args, "normal_agent", False):
        args._normal_export_value = state["_normal_export_value"]
        args._normal_joined_path = state["_normal_joined_path"]
    out = Path(state["out"]) / (
        "registered-orphan-drain-plan-continuation" if state.get("_saved_plan") else "registered-orphan-drain"
    )
    payload = payload_for(args, state)
    if args.observe:
        need(out.is_dir(), "no existing drain invocation")
        original = F["obj"](out / "intent.json")
        need(original["payload"] == payload, "observation invocation differs")
        out = out / ("observe-" + str(time.time_ns()))
        out.mkdir(mode=0o700)
    else:
        out.mkdir(mode=0o700)
        save(
            out / "intent.json",
            {
                "payload": payload,
                "operator": state["_drain"],
                **(
                    {
                        "cleanup_deadline_epoch": state["cleanup_deadline_epoch"],
                        "cleanup_hold_id": state["cleanup_hold_id"],
                        "cleanup_only": True,
                    }
                    if "cleanup_deadline_epoch" in state
                    else {}
                ),
                **(
                    {
                        "continuation_operator_ref": args.operator_ref,
                        "prior_inputs": state["_saved_plan"]["inputs"],
                    }
                    if state.get("_saved_plan")
                    else {}
                ),
            },
        )
        if state.get("_saved_plan"):
            old = state["_saved_plan"]
            save(
                Path(state["out"]) / "registered-orphan-drain/result-adopted-plan.json",
                dict(
                    old["plan"],
                    adopted_from_raw_sha256=old["inputs"][
                        str(Path(state["out"]) / "registered-orphan-drain/wire-000002.raw.json")
                    ],
                    observed_under_operator_ref=args.operator_ref,
                    prior_plan_operator_ref=payload["operator_ref"],
                ),
            )
    api = F["RecordedAPI"](F["api_for"](state), state, out)

    def call(action, **extra):
        need(not state.get("_cancelled"), "normal agent operation cancelled")
        checked = local_state(args)
        need(checked["_drain"] == state["_drain"], "drain local evidence changed")
        value = dict(payload, action=action, **extra)
        if "cleanup_deadline_epoch" in state:
            value.update(
                cleanup_deadline_epoch=state["cleanup_deadline_epoch"],
                cleanup_hold_id=state["cleanup_hold_id"],
                execution_operator_ref=args.operator_ref,
            )
        body = command(value)
        base = "/machines/" + state["machine_id"]
        current = api.request("GET", base, timeout=18)
        need(
            all(current.get(k) == state["machine"].get(k) for k in ("id", "instance_id", "config", "name", "region")),
            "native controller changed",
        )
        need(not state.get("_cancelled"), "normal agent operation cancelled")
        response = api.request("POST", base + "/exec", body, timeout=18)
        need(
            not state.get("_cancelled"),
            "normal agent operation cancelled after owned transport",
        )
        result = successful_agent_response(response, payload, action)
        save(out / ("result-" + str(time.time_ns()) + ".json"), result)
        return result

    if args.observe:
        return call("observe")
    plan = state["_saved_plan"]["plan"] if state.get("_saved_plan") else call("plan")
    for batch in range((plan["targets"] + 15) // 16):
        call("signal", batch=batch, plan_sha256=plan["plan_sha256"])
    return {
        "status": "REGISTERED_AGENT_TERM_REQUESTED"
        if state.get("_agent_payload")
        else "REGISTERED_OWNER_TERMS_REQUESTED",
        "targets": plan["targets"],
        "no_release_claim": True,
    }


def run(args, state):
    if not getattr(args, "normal_agent", False):
        return _run(args, state)
    import signal

    cancelled, handlers = [], {}
    state["_cancelled"] = cancelled
    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            handlers[sig] = signal.signal(sig, lambda sig, _frame: cancelled.append(sig))
        result = _run(args, state)
        need(not cancelled, "normal agent operation cancelled")
        return result
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    modes = p.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--run", action="store_true")
    modes.add_argument("--observe", action="store_true")
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--config-sha256", required=True)
    p.add_argument("--run-directory", type=Path, required=True)
    p.add_argument("--operator-ref", required=True)
    p.add_argument("--normal-agent", action="store_true")
    p.add_argument("--resume-planned", action="store_true")
    p.add_argument("--cleanup-deadline-epoch", type=float)
    p.add_argument("--agent-custody", type=Path)
    p.add_argument("--joined-journal", type=Path)
    p.add_argument("--pending", type=Path)
    args = p.parse_args()
    need(
        (args.normal_agent and args.agent_custody is not None)
        or (
            not args.normal_agent
            and args.agent_custody is None
            and args.joined_journal is not None
            and args.pending is not None
        ),
        "exact normal agent or legacy drain arguments required",
    )
    need(
        not args.resume_planned or args.normal_agent,
        "saved plan requires normal agent mode",
    )
    os.umask(0o077)
    state = local_state(args)
    result = {"status": "CHECKED", "provider_calls": 0} if args.check else run(args, state)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
