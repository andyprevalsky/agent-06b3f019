#!/usr/bin/env python3
"""External owner of one original600 disposable controller. No gate/VM kill on cancellation."""
import argparse,base64,errno,gzip,hashlib,json,math,os,re,secrets,shlex,signal,stat,subprocess,sys,tempfile,time
from contextlib import contextmanager
from pathlib import Path
TASK_REF='1387ae608e7cfb8e3f0a876daae92093f503b465'
TASK_NAMES_SHA='660873a9e02c6c5682a98e9a00dd0133c394a16dcdefd726bcb0a8987f1b59f5'
APP='navi-whisper-lux-bench'
# The warm donor. Its dependency snapshot is never pinned here: each run binds
# the snapshot named by the producer's `run-bench-cloud --refresh-deps` proof
# (<git-common>/cloudbench-warm-deps.<donor>.fp), staged with the config's
# sha-bound remote files. The operator preflight proves that snapshot exists,
# is complete, is the donor's recorded dependency proof and outlives the run.
WARM_MACHINE_NAME='cloudbench-warm-t10-ord-85a7e2c'
WARM_MACHINE_ID='8ed16dc75ee958'
WARM_VOLUME_NAME='cloudbench_t10_ord_85a7e2c'
WARM_REGION='ord'
WARM_DEPS_RELATIVE='.git/cloudbench-warm-deps.'+WARM_MACHINE_NAME+'.fp'
WARM_INVENTORY_RELATIVE='.git/cloudbench-warm-snapshot-inventory.'+WARM_MACHINE_NAME+'.json'
class Deadline(BaseException):pass

def need(v,m):
 if not v:raise ValueError(m)
def sha(b):return hashlib.sha256(b).hexdigest()
def read(p):
 p=Path(p).absolute();need(p.resolve(strict=True)==p,'physical private input required')
 with os.fdopen(os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb')as f:
  s=os.fstat(f.fileno());need(stat.S_ISREG(s.st_mode)and s.st_uid==os.geteuid()and not s.st_mode&0o077 and s.st_nlink==1 and s.st_size<16*1024*1024,'private current-owner file required');return f.read(s.st_size+1)
def save(p,v):
 raw=(json.dumps(v,sort_keys=True,allow_nan=False)+'\n').encode();fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
 fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
def birth(pid):
 need(type(pid)is int and pid>1,'positive non-init PID required')
 v=Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split();need(v[0]!='Z','zombie owner')
 return 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+v[19]
def encode_remote_file(item,data):
 need(sha(data)==item['sha256'] and len(data)<16*1024*1024,'remote metadata source changed')
 return dict(relative_path=item['relative_path'],sha256=item['sha256'],encoding='gzip-base64',data=base64.b64encode(gzip.compress(data,mtime=0)).decode())
@contextmanager
def bounded(seconds):
 old=signal.getitimer(signal.ITIMER_REAL);handler=signal.getsignal(signal.SIGALRM);start=time.monotonic();need(old[1]==0,'periodic alarm refused');seconds=min(seconds,old[0])if old[0]else seconds
 def expire(*unused):raise Deadline('external controller I/O deadline')
 signal.signal(signal.SIGALRM,expire);signal.setitimer(signal.ITIMER_REAL,seconds)
 try:yield;need(time.monotonic()-start<seconds,'late I/O response')
 finally:
  signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,handler)
  if old[0]:signal.setitimer(signal.ITIMER_REAL,max(.000001,old[0]-(time.monotonic()-start)))

SHARD_FIELDS={'index','count','tasks','tasks_sha256','task_indexes','runs','group_run_id','group_total','group_started_at'}
# Optional bound shard fields. Absent means the original600 values, so an
# original-manifest shard with default timeouts keeps its exact historical bytes.
SHARD_OPTIONAL={'infra_threshold','manifest_sha256','task_timeout','e2e_timeout','task_ref'}
DEFAULT_TASK_TIMEOUT=1200
# Default operator deadline. A shard's host TERM fence is epoch plus its bound
# --e2e-timeout (RUN_DEADLINE when absent); setup transfers keep this bound.
RUN_DEADLINE=5400
# The e2e clock starts at admission, but a copy's execution window starts only after
# the strict start barrier releases and its grade lands after that window. A bound
# default e2e covers three separate allowances (Eval Suite stage targets).
# Explicit shorter e2e retains task+post windows and spends only its remainder on startup:
# Admission to barrier release: canary/preflight through full release (720) plus fleet
# readiness (900). Polar batch 1 (2026-10-20) measured 1350.6 s.
STARTUP_ALLOWANCE=720+900
# One copy's work outside its own window after release: agent creation, backstop pause,
# terminal evidence and judge. Bounded by the single-copy canary create-to-release target
# (720); Polar batch 1 r003-j0054 measured 704 s from release to rc beyond its 7200 s window.
COPY_TAIL_ALLOWANCE=720
# Evidence and full native release after the last execution (480 target).
RELEASE_ALLOWANCE=480
POST_TASK_ALLOWANCE=COPY_TAIL_ALLOWANCE+RELEASE_ALLOWANCE
E2E_ALLOWANCE=STARTUP_ALLOWANCE+POST_TASK_ALLOWANCE
# Longest per-task execution window the sharded operator accepts (2 hours). A
# bound --e2e-timeout may extend the operator deadline up to this plus the allowances.
MAX_TASK_TIMEOUT=7200
MAX_RUN_DEADLINE=MAX_TASK_TIMEOUT+E2E_ALLOWANCE
# The host gate watchdog outlives the shard's TERM fence by the original 7200-5400 s
# cleanup margin, so the runner's own TERM and cleanup always run first.
GATE_WATCHDOG_MARGIN=1800
def gate_watchdog_seconds(e2e_timeout):
 """CLOUDBENCH_GATE_TIMEOUT_S for a shard whose host TERM fence is epoch+e2e_timeout."""
 return max(RUN_DEADLINE+GATE_WATCHDOG_MARGIN,e2e_timeout+GATE_WATCHDOG_MARGIN)
def default_e2e_timeout(task_timeout):
 """The operator deadline, widened so a full task window still gets graded and released."""
 return max(RUN_DEADLINE,task_timeout+E2E_ALLOWANCE)if type(task_timeout)is int else RUN_DEADLINE
TASK_TIMEOUT_REFUSAL=('--task-timeout must be 60..%d seconds (%d hours; run-bench --timeout): ask the user to choose a lower execution timeout '
 'or to change the CLI setting MAX_TASK_TIMEOUT in scripts/cloudbench-original600-runner.py')%(MAX_TASK_TIMEOUT,MAX_TASK_TIMEOUT//3600)
def manifest_sha(tasks):return sha(('\n'.join(tasks)+'\n').encode())
def warm_deps_proof(raw):
 """The producer's one-line dependency proof: node/python fingerprints, epoch and snapshot."""
 fields=raw.decode('ascii','replace').split() if isinstance(raw,bytes) else []
 need(len(fields)==4 and all(re.fullmatch('[0-9a-f]{64}',value) for value in fields[:2]) and re.fullmatch('[1-9][0-9]*',fields[2]) and re.fullmatch('vs_[A-Za-z0-9]+',fields[3]),
      'warm dependency proof is not one producer proof line')
 return dict(node=fields[0],python=fields[1],epoch=int(fields[2]),snapshot=fields[3])
def pin_warm_snapshot(remote_env,staged):
 """Pin the snapshot the staged, operator-preflighted producer proof names; never a constant."""
 need(WARM_DEPS_RELATIVE in staged,'authentic staged warm dependency proof required')
 snapshot=warm_deps_proof(staged[WARM_DEPS_RELATIVE])['snapshot']
 need(remote_env.get('CLOUDBENCH_SNAPSHOT_ID',snapshot)==snapshot,'original warm/launch option changed: CLOUDBENCH_SNAPSHOT_ID')
 remote_env['CLOUDBENCH_SNAPSHOT_ID']=snapshot
 return snapshot
def shard_task_ref(shard):
 """The guest task source: the shard's bound pushed task_ref, or the historical pin when absent."""
 if shard is None or 'task_ref' not in shard:return TASK_REF
 ref=shard['task_ref'];need(isinstance(ref,str) and re.fullmatch('[0-9a-f]{40}',ref) and ref!=TASK_REF,'invalid bound task ref (the historical pin is encoded by absence)')
 return ref
# Fresh-only placement moves every fresh REAL Volume to the target region. The
# fleet refuses it for any snapshot-backed task: a catalog simulate (native WMH)
# task always boots from the warm donor snapshot in WARM_REGION.
FRESH_ONLY_PLACEMENT=dict(CLOUDBENCH_FRESH_TARGET_REGION='iad',CLOUDBENCH_FRESH_VOLUME_UNIQUE_ZONE='false')
def shard_simulate_tasks(root,shard):
 """The shard's catalog simulate tasks at its bound task ref, as the fleet reads its catalog modes."""
 if shard is None:return []
 ref=shard_task_ref(shard)
 with tempfile.TemporaryDirectory(prefix='shard-modes-') as scratch:
  for name in ('tasks.json','polar_tasks.json'):
   Path(scratch,name).write_bytes(subprocess.check_output(['git','--no-replace-objects','-C',str(root),'show',ref+':agents/benchmarks/'+name]))
  sys.path.insert(0,str(Path(root)/'scripts'))
  try:from cloudbench_catalog import get_task_metadata;rows=get_task_metadata(Path(scratch,'tasks.json'),shard['tasks'])
  finally:sys.path.remove(str(Path(root)/'scripts'))
 return [row['name'] for row in rows if str(row.get('world_model_mode') or '').lower()=='simulate']
def shard_placement_env(root,shard):
 """Fresh-only placement unless the shard has a snapshot-backed simulate task (ordinary fleet placement)."""
 return {} if shard_simulate_tasks(root,shard) else dict(FRESH_ONLY_PLACEMENT)
def campaign_timeouts(task_timeout=DEFAULT_TASK_TIMEOUT,e2e_timeout=RUN_DEADLINE):
 """The bound per-task execution window and whole-campaign budget, in seconds."""
 need(type(task_timeout)is int and 60<=task_timeout<=MAX_TASK_TIMEOUT,TASK_TIMEOUT_REFUSAL)
 need(type(e2e_timeout)is int and task_timeout+POST_TASK_ALLOWANCE<e2e_timeout<=MAX_RUN_DEADLINE,'--e2e-timeout must cover the task timeout plus %ds grading/release and positive startup time, and fit the %ds operator deadline'%(POST_TASK_ALLOWANCE,MAX_RUN_DEADLINE))
 return task_timeout,e2e_timeout
def startup_deadline_epoch(epoch,task_timeout,e2e_timeout):
 """Latest barrier release preserving the entire task and post-task windows."""
 campaign_timeouts(task_timeout,e2e_timeout)
 return epoch+e2e_timeout-task_timeout-POST_TASK_ALLOWANCE
def shard_timeouts(shard):
 # One canonical encoding: a bound field is present only when it differs from the original value.
 need(shard.get('task_timeout')!=DEFAULT_TASK_TIMEOUT and shard.get('e2e_timeout')!=RUN_DEADLINE,'default timeouts are encoded by absence')
 return campaign_timeouts(shard.get('task_timeout',DEFAULT_TASK_TIMEOUT),shard.get('e2e_timeout',RUN_DEADLINE))
def shard_manifest(shard,manifest):
 """The shard's bound ordered manifest: an explicit sha, or the pinned original when absent."""
 bound=shard.get('manifest_sha256',TASK_NAMES_SHA)
 need(isinstance(bound,str) and re.fullmatch('[0-9a-f]{64}',bound) and ('manifest_sha256' not in shard or bound!=TASK_NAMES_SHA),'invalid bound manifest hash')
 need(isinstance(manifest,list) and manifest and all(isinstance(t,str) and t for t in manifest) and len(set(manifest))==len(manifest) and manifest_sha(manifest)==bound,
      'bound ordered task manifest required' if 'manifest_sha256' in shard else 'original ordered task manifest required')
 return bound
def group_infra_threshold(shard):
 """Explicit bound threshold, else 5% of the group's scheduled total (the supervisor's own stop)."""
 return shard.get('infra_threshold',-(-shard['group_total']//20)) if isinstance(shard.get('group_total'),int) else shard.get('infra_threshold',30)
def shard_shape(shard):
 """Self-consistent shard fields; returns the shard's logical job count."""
 need(isinstance(shard,dict) and SHARD_FIELDS<=set(shard)<=SHARD_FIELDS|SHARD_OPTIONAL,'exact shard fields required')
 index,count,runs,names=shard['index'],shard['count'],shard['runs'],shard['tasks']
 need(all(type(x)is int for x in (index,count,runs)) and 0<=index<count and runs>=1,'invalid shard index/count/runs')
 need(isinstance(names,list) and names and all(isinstance(t,str) and t for t in names) and len(set(names))==len(names),'distinct shard tasks required')
 need(shard['tasks_sha256']==sha(('\n'.join(names)+'\n').encode()),'shard task hash changed')
 indexes=shard['task_indexes'];need(isinstance(indexes,list) and len(indexes)==len(names) and all(type(i)is int and i>=0 for i in indexes) and len(set(indexes))==len(indexes),'distinct task indexes for every shard task required')
 need(isinstance(shard['group_run_id'],str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}',shard['group_run_id']),'invalid shared group id')
 need(type(shard['group_total'])is int and shard['group_total']>=len(names)*runs and shard['group_total']%runs==0,'group total must cover its shard in whole runs')
 # Campaign job IDs are r{run}-j{(run-1)*width+index+1}; indexes beyond the group width would collide.
 need(all(i<shard['group_total']//runs for i in indexes),'task index outside the group width')
 started=shard['group_started_at'];need(type(started)in(int,float) and math.isfinite(started) and started>0,'invalid shared group start')
 threshold=group_infra_threshold(shard);need(type(threshold)is int and threshold>=1,'invalid infrastructure threshold')
 shard_timeouts(shard);shard_task_ref(shard)
 return len(names)*runs
def validate_shard(shard,manifest):
 """A shard is an ordered subset of its bound manifest (the pinned original when unbound)."""
 jobs=shard_shape(shard);shard_manifest(shard,manifest);indexes=shard['task_indexes']
 # Job IDs stay the single-controller r{run}-j{global index}, so each task carries its manifest index.
 need(all(i<len(manifest) and manifest[i]==t for i,t in zip(indexes,shard['tasks'])) and indexes==sorted(indexes),'shard tasks must be an ordered subset of the bound manifest at their indexes')
 need(shard['group_total']<=len(manifest)*shard['runs'],'group total exceeds the bound manifest')
 return jobs
def campaign_argv(tasks,epoch,shard=None):
 if shard is None:
  need(len(tasks)==len(set(tasks))==200 and sha(('\n'.join(tasks)+'\n').encode())==TASK_NAMES_SHA,'original ordered task manifest required')
  return ['bash','scripts/run-bench','--stress-defaults','--strict-barrier','--concurrency','600','-k','3','--retry-infra','1','--timeout','1200','--e2e-timeout','5400','--e2e-started-at',str(epoch),'--ref',TASK_REF,*tasks]
 # --stress-defaults admits only the complete 200-task k3 profile; a shard
 # instead carries the operator's global limits in shard_env.
 jobs=validate_shard(shard,tasks);task_timeout,e2e_timeout=shard_timeouts(shard)
 return ['bash','scripts/run-bench','--strict-barrier','--concurrency',str(jobs),'-k',str(shard['runs']),'--retry-infra','1','--timeout',str(task_timeout),'--e2e-timeout',str(e2e_timeout),'--e2e-started-at',str(epoch),'--ref',shard_task_ref(shard),*shard['tasks']]
def shard_env(remote_env,shard,identity_name):
 """Legacy (no shard) returns remote_env unchanged; a shard adds only its bound campaign controls."""
 if shard is None:return remote_env
 env=dict(remote_env);need(re.fullmatch(r'original600-supervisor\.[0-9a-f]{24}\.json',identity_name),'exact supervisor identity name required')
 for key in ('CLOUDBENCH_APP_MACHINE_CEILING','CLOUDBENCH_SHARED_CPU_GOVERNOR'):
  need(isinstance(env.get(key),str) and re.fullmatch('[1-9][0-9]{0,5}',env[key]),'explicit operator limit required without stress defaults: '+key)
 controls=dict(CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION='1',RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER='/tmp/gate/repo/.context/'+identity_name[:-len('.json')]+'.barrier',
               RUN_BENCH_CAMPAIGN_TASK_INDEXES=','.join(map(str,shard['task_indexes'])),RUN_BENCH_CAMPAIGN_GROUP_TOTAL=str(shard['group_total']),
               RUN_BENCH_CAMPAIGN_GROUP_STARTED_AT=str(shard['group_started_at']),BENCHMARK_HUB_GROUP_RUN_ID=shard['group_run_id'])
 for key,value in controls.items():need(env.get(key,value)==value,'shard campaign control changed: '+key);env[key]=value
 return env

# Stage bound inputs, publish this PID/birth, then exec the canonical supervisor.
# Its owned-parent finally writes the terminal receipt after campaign join.
REMOTE_LAUNCH=r'''
import base64,hashlib,io,json,os,stat,subprocess,sys,gzip,time
from pathlib import Path
p=Path(sys.argv[1]);assert p==Path('/tmp/controller-launch-payload.json.gz') and p.resolve(strict=True)==p
with os.fdopen(os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
 s=os.fstat(f.fileno());assert stat.S_ISREG(s.st_mode) and 0<s.st_size<256*1024
 raw=f.read(s.st_size+1);assert len(raw)==s.st_size and hashlib.sha256(raw).hexdigest()==sys.argv[2]
with gzip.GzipFile(fileobj=io.BytesIO(raw)) as f:payload=f.read(16*1024*1024)
assert len(payload)<16*1024*1024 and hashlib.sha256(payload).hexdigest()==sys.argv[3]
v=json.loads(payload);root=Path('/tmp/gate/repo')
assert subprocess.check_output(['git','-c','safe.directory=/tmp/gate/repo','-C',str(root),'rev-parse','HEAD'],text=True).strip()==v['source_ref']
script=root/'scripts/cloudbench-original600-supervisor.py';assert hashlib.sha256(script.read_bytes()).hexdigest()==v['supervisor_sha256']
def save(p,raw):
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
 fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
def birth(pid):
 a=Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split();assert a[0]!='Z'
 return 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+a[19]
identity=root/'.context'/v['identity_name'];identity.parent.mkdir(exist_ok=True)
def decode_remote_file(item):
 if item.get('encoding')=='external-gzip':
  path=Path(item['transfer_path']);assert path==Path('/tmp/controller-sidecar-'+item['transfer_sha256']+'.gz')
  assert 0<item['transfer_bytes']<16*1024*1024
  while True:
   assert time.time()<v['epoch']+5400,'original payload transfer deadline expired'
   try:
    assert path.resolve(strict=True)==path
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb')as source:
     before=os.fstat(source.fileno());assert stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_uid==os.geteuid() and not before.st_mode&0o077
     assert before.st_size==item['transfer_bytes'];raw=source.read(before.st_size+1);after=os.fstat(source.fileno())
     stable=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
     assert stable(before)==stable(after)==stable(path.lstat()) and len(raw)==before.st_size and hashlib.sha256(raw).hexdigest()==item['transfer_sha256']
    break
   except (FileNotFoundError,PermissionError):time.sleep(min(.2,max(0,v['epoch']+5400-time.time())))
 elif item.get('encoding','base64')in('base64','gzip-base64'):raw=base64.b64decode(item['data'],validate=True)
 else:raise ValueError('unsupported remote file encoding')
 if item.get('encoding')in('gzip-base64','external-gzip'):
  with gzip.GzipFile(fileobj=io.BytesIO(raw)) as f:raw=f.read(16*1024*1024)
 assert len(raw)<16*1024*1024 and hashlib.sha256(raw).hexdigest()==item['sha256']
 return raw
for item in v['remote_files']:
 relative=item['relative_path'];assert relative.startswith('.git/cloudbench-')and '/'not in relative[len('.git/'):]
 path=root/relative;assert path.parent.resolve()==root/'.git'
 raw=decode_remote_file(item)
 save(path,raw)
policy=v.get('infra_early_stop','enabled');assert policy in ('enabled','disabled')
assert v['remote_env'].get('CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP','enabled')==policy
tasks=identity.with_suffix('.tasks.json');save(tasks,(json.dumps(v['tasks'],sort_keys=True)+'\n').encode());env=dict(os.environ,**v['remote_env']);env.update(REVIEWED_OPERATOR_ROOT=str(root),REVIEWED_OPERATOR_SOURCE_REF=v['source_ref'],REVIEWED_OPERATOR_TASKS=str(tasks),REVIEWED_OPERATOR_TASKS_SHA256=hashlib.sha256(tasks.read_bytes()).hexdigest(),REVIEWED_OPERATOR_IDENTITY_PATH=str(identity),CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP=policy)
shard=v.get('shard')
if shard is not None:
 # The external barrier exists before the identity becomes visible to REMOTE_CONTROL.
 barrier=identity.with_suffix('.barrier');assert v['remote_env']['RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER']==str(barrier)
 barrier.mkdir(mode=0o700);fd=os.open(identity.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
 bound=identity.with_suffix('.shard.json');save(bound,(json.dumps(shard,sort_keys=True)+'\n').encode())
 env.update(REVIEWED_OPERATOR_SHARD=str(bound),REVIEWED_OPERATOR_SHARD_SHA256=hashlib.sha256(bound.read_bytes()).hexdigest())
row=dict(schema='original600-supervisor-identity-v1',pid=os.getpid(),birth=birth(os.getpid()),machine=os.environ['FLY_MACHINE_ID'],source_ref=v['source_ref'],epoch=v['epoch'],infra_early_stop=policy)
assert row['pid']>1;save(identity,(json.dumps(row,sort_keys=True)+'\n').encode());print('ORIGINAL600_SUPERVISOR '+json.dumps(row),flush=True)
os.chdir(root);os.execve(sys.executable,[sys.executable,str(script),str(v['epoch']),*v['campaign_argv']],env)
'''
REMOTE_SIDECAR=r'''
import base64,fcntl,gzip,hashlib,io,json,os,pwd,re,stat,sys,tempfile,time
from pathlib import Path
def receive(v,root=Path('/tmp')):
 assert os.environ['FLY_MACHINE_ID']==v['machine'] and os.environ['GATE_REF']==v['source_ref']
 def read(path,limit,uid,private=True):
  assert path.resolve(strict=True)==path
  with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb')as stream:
   before=os.fstat(stream.fileno());assert stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_uid in uid and not before.st_mode&(0o077 if private else 0o022) and before.st_size<=limit
   stable=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
   raw=stream.read(before.st_size+1);assert stable(before)==stable(os.fstat(stream.fileno()))==stable(path.lstat()) and len(raw)==before.st_size
   return raw
 envelope=read(root/'controller-launch-payload.json.gz',256*1024,{0,pwd.getpwnam('rose').pw_uid},False)
 assert hashlib.sha256(envelope).hexdigest()==v['envelope_sha256']
 with gzip.GzipFile(fileobj=io.BytesIO(envelope))as stream:decoded=stream.read(16*1024*1024)
 assert len(decoded)<16*1024*1024
 manifest=json.loads(decoded);assert manifest['source_ref']==v['source_ref']
 assert time.time()<manifest['epoch']+5400,'original sidecar deadline expired'
 digest=v['sha256'];assert re.fullmatch('[0-9a-f]{64}',digest)
 entries=[x for x in manifest['remote_files'] if x.get('encoding')=='external-gzip' and x.get('transfer_sha256')==digest]
 assert entries and all(x['transfer_path']=='/tmp/controller-sidecar-'+digest+'.gz' and x['transfer_bytes']==entries[0]['transfer_bytes'] for x in entries)
 size=entries[0]['transfer_bytes'];assert type(size)is int and 0<size<16*1024*1024
 count=(size+32767)//32768;directory=root/('controller-sidecar-'+digest)
 if v['action'] in ('observe-chunk','observe-fragment'):
  index=v['index'];assert type(index)is int and 0<=index<count
  target=directory/('%05d'%index);length=min(32768,size-index*32768);state='CHUNK'
  if v['action']=='observe-fragment':
   offset=v['offset'];assert type(offset)is int and offset%2048==0 and 0<=offset<length
   target=directory/('fragments-%05d'%index)/('%05d'%offset);length=min(2048,length-offset);state='FRAGMENT'
  try:raw=read(target,32768,{os.geteuid()})
  except FileNotFoundError:return dict(state='ABSENT')
  assert len(raw)==length and hashlib.sha256(raw).hexdigest()==v['chunk_sha256']
  result=dict(state=state,index=index,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
  if state=='FRAGMENT':result['offset']=v['offset']
  return result
 if v['action']=='observe-ready':
  try:raw=read(root/('controller-sidecar-'+digest+'.gz'),size,{pwd.getpwnam('rose').pw_uid})
  except FileNotFoundError:return dict(state='ABSENT')
  assert len(raw)==size and hashlib.sha256(raw).hexdigest()==digest
  return dict(state='READY',bytes=size,sha256=digest)
 try:directory.mkdir(mode=0o700)
 except FileExistsError:pass
 s=directory.lstat();assert directory.resolve(strict=True)==directory and stat.S_ISDIR(s.st_mode) and s.st_uid==os.geteuid() and not s.st_mode&0o077
 def save(path,raw):
  assert time.time()<manifest['epoch']+5400,'original sidecar deadline expired'
  try:fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  except FileExistsError:assert read(path,len(raw),{os.geteuid()})==raw;return
  with os.fdopen(fd,'wb')as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
  fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
 if v['action']in('chunk','fragment','assemble'):
  index=v['index'];assert type(index)is int and 0<=index<count
  length=min(32768,size-index*32768);target=directory/('%05d'%index)
  fragments=directory/('fragments-%05d'%index)
  if v['action']=='fragment':
   offset=v['offset'];assert type(offset)is int and offset%2048==0 and 0<=offset<length
   try:fragments.mkdir(mode=0o700)
   except FileExistsError:pass
   s=fragments.lstat();assert fragments.resolve(strict=True)==fragments and stat.S_ISDIR(s.st_mode) and s.st_uid==os.geteuid() and not s.st_mode&0o077
   raw=base64.b64decode(v['data'],validate=True);assert len(raw)==min(2048,length-offset)
   target=fragments/('%05d'%offset)
  elif v['action']=='assemble':
   raw=b''.join(read(fragments/('%05d'%offset),2048,{os.geteuid()}) for offset in range(0,length,2048))
   assert len(raw)==length and hashlib.sha256(raw).hexdigest()==v['chunk_sha256']
  else:raw=base64.b64decode(v['data'],validate=True);assert len(raw)==length
  save(target,raw)
  result=dict(state='FRAGMENT' if v['action']=='fragment' else 'CHUNK',index=index,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
  if v['action']=='fragment':result['offset']=v['offset']
  return result
 assert v['action']=='commit'
 raw=b''.join(read(directory/('%05d'%i),32768,{os.geteuid()}) for i in range(count))
 assert len(raw)==size and hashlib.sha256(raw).hexdigest()==digest
 destination=root/('controller-sidecar-'+digest+'.gz');user=pwd.getpwnam('rose')
 lock=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
 try:
  fcntl.flock(lock,fcntl.LOCK_EX)
  if os.path.lexists(destination):assert read(destination,size,{user.pw_uid})==raw
  else:
   fd,name=tempfile.mkstemp(prefix='.controller-sidecar-',dir=root);temporary=Path(name)
   try:
    with os.fdopen(fd,'wb')as stream:stream.write(raw);stream.flush();os.fchown(stream.fileno(),user.pw_uid,user.pw_gid);os.fsync(stream.fileno())
    assert time.time()<manifest['epoch']+5400,'original sidecar deadline expired'
    os.rename(temporary,destination)
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
   finally:
    if temporary.exists():temporary.unlink()
 finally:os.close(lock)
 return dict(state='READY',bytes=size,sha256=digest)
'''
REMOTE_CONTROL=r'''
import base64,hashlib,json,os,signal,sys
from pathlib import Path
v=json.loads(base64.b64decode(sys.argv[1]));p=Path(v['identity_path']);assert p.is_absolute()and p.name.startswith('original600-supervisor.')and p.name.endswith('.json')
if not p.exists():print(json.dumps(dict(state='NOT_PUBLISHED')));raise SystemExit(0)
assert p.resolve()==p
raw=p.read_bytes();j=json.loads(raw);assert j['schema']=='original600-supervisor-identity-v1'
assert j['machine']==os.environ['FLY_MACHINE_ID']==v['machine']and j['source_ref']==v['source_ref']and j['epoch']==v['epoch']
pid=j['pid'];assert type(pid)is int and pid>1
try:
 s=Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()
 actual='proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+s[19]
 assert actual==j['birth'],'PID birth changed'
 live=s[0]!='Z'
except FileNotFoundError:live=False
if live:
 cmd=Path('/proc',str(pid),'cmdline').read_bytes();assert b'cloudbench-original600-supervisor.py' in cmd
 if v['action']=='TERM':
  assert hashlib.sha256(raw).hexdigest()==v['identity_sha256'],'supervisor receipt changed'
  os.kill(pid,signal.SIGTERM)
 result=dict(state='TERM_SENT'if v['action']=='TERM'else'LIVE',identity=j,identity_sha256=hashlib.sha256(raw).hexdigest())
else:
 terminal=p.with_suffix('.terminal.json')
 if terminal.exists():
  t=json.loads(terminal.read_bytes());assert all(t[k]==j[k]for k in j)and t['supervisor_joined']is True
  result=dict(state='JOINED',identity=j,terminal=t,identity_sha256=hashlib.sha256(raw).hexdigest())
 else:result=dict(state='ABSENT_UNCONFIRMED',identity=j)
if v['action']!='TERM':
 # Sharded launches only (REMOTE_LAUNCH created the barrier): the campaign's external
 # barrier and supervisor infra count. Legacy ACKs stay unchanged; a missing or
 # unreadable file never hides the supervisor state above.
 import ctypes,datetime,errno,re,stat,tempfile
 barrier=p.with_suffix('.barrier')
 def observed(path):
  try:
   with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb')as f:
    s=os.fstat(f.fileno());assert stat.S_ISREG(s.st_mode) and s.st_size<16384
    value=json.loads(f.read(16384));assert isinstance(value,dict);return value
  except FileNotFoundError:return None
  except (OSError,ValueError,AssertionError):result.setdefault('observation_errors',[]).append(path.name);return None
 if barrier.is_dir() and not barrier.is_symlink():result.update(barrier=observed(barrier/'ready.json'),infra=observed(p.with_suffix('.infra.json')))
 def decide(kind):
  # One exclusive, complete decision file per barrier; same release_id is idempotent.
  rid,reason=v['release_id'],v['reason']
  assert isinstance(rid,str) and re.fullmatch('[0-9a-f]{16,64}',rid) and isinstance(reason,str) and len(reason)<=1024,'invalid barrier decision'
  info=barrier.lstat();assert stat.S_ISDIR(info.st_mode) and not info.st_mode&0o077,'exact private barrier directory required'
  name=kind+'.json';other=barrier/('abort.json' if kind=='release' else 'release.json')
  def existing(path):
   try:
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb')as f:return json.loads(f.read(16384))
   except FileNotFoundError:return None
  def outcome(record):
   if record.get('release_id')==rid:return dict(state='RELEASED' if kind=='release' else 'ABORTED',record=record)
   return dict(state='REFUSED',reason='different '+kind+' id exists',record=record)
  conflict=existing(other)
  if conflict is not None:return dict(state='REFUSED',reason='conflicting barrier decision exists',record=conflict)
  found=existing(barrier/name)
  if found is not None:return outcome(found)
  record=dict(schema='campaign-external-barrier-'+kind+'-v1',release_id=rid)
  if kind=='release':record['released_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
  else:record['reason']=reason
  fd,temporary=tempfile.mkstemp(prefix='.'+name+'.',dir=barrier)
  try:
   with os.fdopen(fd,'wb')as f:
    f.write((json.dumps(record,sort_keys=True)+'\n').encode());f.flush();os.fchown(f.fileno(),info.st_uid,info.st_gid);os.fsync(f.fileno())
   # RENAME_NOREPLACE publishes complete bytes, one link, never overwriting.
   if ctypes.CDLL(None,use_errno=True).renameat2(-100,os.fsencode(temporary),-100,os.fsencode(barrier/name),1)!=0:
    error=ctypes.get_errno();assert error==errno.EEXIST,os.strerror(error);return outcome(existing(barrier/name))
  finally:
   if os.path.lexists(temporary):os.unlink(temporary)
  fd=os.open(barrier,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
  return outcome(record)
 if v['action']in('RELEASE','ABORT') and result['state']=='LIVE':result.update(decide(v['action'].lower()))
print(json.dumps(result))
'''
ACK_STATES=dict(PROBE={'NOT_PUBLISHED','LIVE','TERM_SENT','JOINED','ABSENT_UNCONFIRMED'},TERM={'NOT_PUBLISHED','LIVE','TERM_SENT','JOINED','ABSENT_UNCONFIRMED'},
                RELEASE={'NOT_PUBLISHED','JOINED','ABSENT_UNCONFIRMED','RELEASED','REFUSED'},ABORT={'NOT_PUBLISHED','JOINED','ABSENT_UNCONFIRMED','ABORTED','REFUSED'})
def exec_command(script,payload):return shlex.join(['python3','-c',script,base64.b64encode(json.dumps(payload,sort_keys=True).encode()).decode()])
def machine_control(api,mid,payload):
 need(re.fullmatch('[0-9a-f]{14}',mid),'exact Machine required');need(payload['action']in ACK_STATES,'invalid supervisor action')
 with bounded(20):
  response=api.api('POST','/machines/'+mid+'/exec',dict(cmd=exec_command(REMOTE_CONTROL,payload),timeout=20,machine=True),timeout=20)
  need(isinstance(response,dict)and response.get('exit_code',0)==0 and response.get('exit_signal',0)==0 and response.get('stderr')in(None,''),'exact supervisor exec failed')
  raw=response.get('stdout');need(isinstance(raw,str)and len(raw.encode())<65536,'bounded supervisor ACK');v=json.loads(raw);need(isinstance(v,dict) and v.get('state')in ACK_STATES[payload['action']],'invalid supervisor ACK');return v

def request_term(api,mid,payload,identity,out):
 need(identity.get('state')=='LIVE'and type(identity['identity']['pid'])is int and identity['identity']['pid']>1,'only exact live supervisor may be signalled')
 intent=out/'supervisor-term.intent.json'
 if intent.exists():return None # ambiguous signal never replayed
 request=dict(payload,action='TERM',identity_sha256=identity['identity_sha256'])
 save(intent,dict(machine=mid,pid=identity['identity']['pid'],birth=identity['identity']['birth'],identity_sha256=identity['identity_sha256'],signal='SIGTERM',path=payload['identity_path']))
 try:
  ack=machine_control(api,mid,request);save(out/'supervisor-term.ack.json',ack);return ack
 except BaseException as e:
  save(out/'supervisor-term.pending.json',dict(error=type(e).__name__,ambiguous=True,no_signal_retry=True));return None

def supervisor_settled(probe,probed_after_join=False):
 # The launcher publishes its identity and execs the supervisor under the PID the gate
 # joins, and a verified export saw no live controller writer. An identity still absent
 # when probed after that join can never appear: the startup ended before a supervisor.
 return probe.get('state')=='JOINED' or(probe.get('state')=='NOT_PUBLISHED' and probed_after_join is True)
def cleanup_ready(gate_joined,probe,verified_export,probed_after_join=False):return gate_joined and supervisor_settled(probe,probed_after_join) and verified_export
def cleanup_mode(gate_joined,has_ownership,has_workspace,probe,verified_export,probed_after_join=False):
 if not gate_joined:return None
 if not has_ownership and has_workspace:return 'cleanup-workspace'
 if has_ownership and cleanup_ready(True,probe,verified_export,probed_after_join):return 'cleanup'
 return None


def reconciled_release(out,export,authority,mid,action,gate_joined,probe,probed_after_join=False):
 """Consume an exact canonical release without rewriting the first helper result."""
 need(gate_joined,'gate must be joined before release')
 intent=json.loads(read(out/'cleanup-call.intent.json'))
 need(intent['action']==action and intent['machine']==mid and intent['gate_joined']is True,'original cleanup invocation changed')
 workspace=export/'workspace-volume.ownership.json';workspace_raw=read(workspace);v=json.loads(workspace_raw)
 r=json.loads(read(export/'disposable-controller.release.json'))
 need(r['volume_id']==v['volume_id'] and r['volume_disposition']in('ABSENT','pending_destroy','destroyed'),'wrong original workspace release')
 if action=='cleanup':
  settled=intent['supervisor_joined']is True or(intent.get('supervisor_state')=='NOT_PUBLISHED' and intent.get('probed_after_join')is True)
  need(cleanup_ready(True,probe,(export/'disposable-export.verified.json').exists(),probed_after_join) and settled,'settled supervisor and verified export required')
  auth_sha=sha(read(authority));record=json.loads(read(export/'disposable-controller.ownership.json'))
  need(record['authority_sha256']==auth_sha and record['workspace_sha256']==sha(workspace_raw) and record['machine']['id']==mid and record['volume']['id']==v['volume_id'],'original controller ownership changed')
  raw=read(export/'disposable-export.verified.json');verified=json.loads(raw)
  need(sha(raw)==intent['export_verified_file'] and verified['authority_sha256']==auth_sha and verified['machine_id']==mid,'original verified export changed')
  need(r['machine_id']==mid and r['machine_deleted']is True,'wrong externally reconciled release')
 else:
  need(action=='cleanup-workspace' and r['machine_id']is None and r['no_live_machine_observed']is True and r['command_history_verified']is False,'wrong partial external release')
 return r

# The gate writes these only before any custody, workspace-volume or Machine intent.
PREALLOCATION_REASONS=frozenset({'github-token-missing','controller-admission-refused'})
def preallocation_terminal(joined,gate_code,gate_pid,ref,export,receipt):
 # Directory/intent absence alone NEVER proves no allocation was attempted.
 # Only the exact gate's explicit early-failure receipt can end this owner.
 if not joined or gate_code!=1 or os.path.lexists(export) or not Path(receipt).exists():return None
 try:
  value=json.loads(read(receipt))
  need(isinstance(value,dict) and value.get('reason')in PREALLOCATION_REASONS and value==dict(schema='original600-gate-preallocation-failure-v1',reason=value['reason'],
       source_ref=ref,gate_pid=gate_pid,allocation_attempted=False),'unbound early gate failure')
 except (OSError,ValueError,KeyError):return None
 return dict(status='FAILED_BEFORE_PROVIDER_DISPATCH',reason=value['reason'],gate_exit_code=gate_code,
             source_ref=ref,allocation_attempted=False,no_provider_cleanup_required=True,
             benchmark_success_inferred=False,receipt_sha256=sha(read(receipt)))


def validate_source_members(root,ref,pins):
 required={'run-cloudbench-controller-gate','cloudbench-disposable-controller.py','cloudbench-controller-export.py','cloudbench-original-volume-capture.py','cloudbench-original600-supervisor.py'}
 need(required<=set(pins),'complete control source pins required')
 explicit={'cloudbench-fetch-ref.sh','lib/cloudbench-archived-reuse.sh','run-bench-cloud','run-bench-fleet'}
 for name,digest in pins.items():
  need(isinstance(name,str) and (name in explicit or ('/'not in name and name.endswith(('.py','gate')))) and '\\'not in name and name not in ('.','..'),'invalid source member')
  path=Path(root)/'scripts'/name
  need(path.resolve(strict=True)==path.absolute(),'physical source member required')
  data=path.read_bytes();need(sha(data)==digest and data==subprocess.check_output(['git','--no-replace-objects','-C',str(root),'show',ref+':scripts/'+name]),'source bytes changed: '+name)


def launch_handoff(out,remote):
 raw=(json.dumps(remote,sort_keys=True,allow_nan=False)+'\n').encode();need(len(raw)<16*1024*1024,'launch payload exceeds bounded decoded size')
 packed=gzip.compress(raw,mtime=0)
 if len(packed)>=256*1024:
  remote=dict(remote);files=[];sidecars=[]
  for item in remote['remote_files']:
   data=base64.b64decode(item['data'],validate=True)
   if item.get('encoding','base64')=='base64':data=gzip.compress(data,mtime=0)
   else:need(item['encoding']=='gzip-base64','unsupported source encoding')
   need(0<len(data)<16*1024*1024,'bounded sidecar required');digest=sha(data)
   path=out/('controller-sidecar-'+digest+'.private.gz')
   if path.exists():need(read(path)==data,'sidecar bytes changed')
   else:
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb')as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
   files.append(dict(relative_path=item['relative_path'],sha256=item['sha256'],encoding='external-gzip',transfer_sha256=digest,transfer_bytes=len(data),transfer_path='/tmp/controller-sidecar-'+digest+'.gz'))
   if not any(row['sha256']==digest for row in sidecars):sidecars.append(dict(path=str(path),sha256=digest,bytes=len(data)))
  remote['remote_files']=files;raw=(json.dumps(remote,sort_keys=True,allow_nan=False)+'\n').encode();packed=gzip.compress(raw,mtime=0)
  need(len(packed)<256*1024,'sidecar descriptor exceeds bounded config transport')
  save(out/'controller-sidecars.private.json',sidecars)
 need(len(packed)<256*1024,'compressed launch payload too large for config transport')
 path=out/'controller-launch-payload.private.json.gz'
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as f:f.write(packed);f.flush();os.fsync(f.fileno())
 fd=os.open(out,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
 digest=sha(read(path))
 return path,digest,['python3','-c',REMOTE_LAUNCH,'/tmp/controller-launch-payload.json.gz',digest,sha(raw)]

def sidecar_command(payload):
 bundle=gzip.compress(json.dumps([REMOTE_SIDECAR,payload],sort_keys=True).encode(),mtime=0)
 loader="import base64 as b,gzip,json,sys;s,p=json.loads(gzip.decompress(b.b64decode(sys.argv[1])));__name__='x';exec(s);print(json.dumps(receive(p)))"
 return shlex.join(['python3','-c',loader,base64.b64encode(bundle).decode()])

def transfer_sidecars(api,mid,record,out,envelope_sha,deadline,cancelled=lambda:False,*,journal=None):
 path=out/'controller-sidecars.private.json'
 if not path.exists():return
 descriptor=json.loads(read(path));journal=journal or out/'payload-transfer';journal.mkdir(mode=0o700);sequence=[0]
 def active():
  if cancelled():raise Deadline('payload transfer cancelled')
  need(time.time()<deadline,'original payload transfer deadline expired')
 def wire(method,url,body=None,kind='request'):
  active();sequence[0]+=1;prefix='%04d-%s'%(sequence[0],kind)
  if method=='POST':need(len(json.dumps(body).encode())<=6200,'bounded payload JSON request required')
  save(journal/(prefix+'.request.json'),dict(method=method,path=url,body=body))
  def observer(observed_method,observed_path,status,data):
   need(observed_method==method and observed_path==url,'unexpected payload wire response')
   save(journal/(prefix+'.wire.json'),dict(method=method,path=url,status=status,body_b64=base64.b64encode(data).decode(),sha256=sha(data)))
  with bounded(min(20,deadline-time.time())):
   response=api.api(method,url,body,timeout=max(1,int(min(20,deadline-time.time()))),observer=observer)
  save(journal/(prefix+'.response.json'),response);active();return response
 def current():
  while True:
   try:native=wire('GET','/machines/'+mid,kind='identity')
   except Deadline:
    # This request only reads identity. Preserve its interrupted receipt and
    # reobserve under the unchanged original deadline; never replay an exec.
    active();save(journal/f'{sequence[0]:04d}-read-pending.json',{'error':'Deadline','read_only':True,'original_deadline':deadline})
    time.sleep(min(.2,max(0,deadline-time.time())));continue
   need(native['id']==mid and native['instance_id']==record['instance_id'] and native['config']==record['config'],'payload target incarnation changed')
   if native.get('state')=='started':return
   need(native.get('state')in('created','starting'),'payload target is not starting')
   active();time.sleep(min(.2,max(0,deadline-time.time())))
 def send(request,label,expected):
  active();current()
  command=sidecar_command(request);need(len(json.dumps(dict(cmd=command,timeout=20,machine=True)).encode())<=6200,'bounded payload JSON request required')
  save(journal/(label+'.intent.json'),dict(machine=mid,instance=record['instance_id'],request_sha256=sha(command.encode()),expected=expected))
  try:
   response=wire('POST','/machines/'+mid+'/exec',dict(cmd=command,timeout=max(1,int(min(20,deadline-time.time()))),machine=True),kind='write')
   save(journal/(label+'.response.json'),response)
   need(response.get('exit_code',0)==0 and response.get('exit_signal',0)==0 and response.get('stderr')in(None,''),'payload receiver failed')
   need(json.loads(response['stdout'])==expected,'payload acknowledgement differs')
  except BaseException as error:
   save(journal/(label+'.pending.json'),dict(error=type(error).__name__,no_blind_retry=True))
   # A missing ACK never repeats a write. One exact read can instead prove
   # that the original operation durably produced its complete expected bytes.
   observe={k:v for k,v in request.items() if k!='data'}
   observe['action']='observe-fragment' if request['action']=='fragment' else ('observe-chunk' if request['action'] in ('chunk','assemble') else 'observe-ready')
   if request['action']in('chunk','assemble','fragment'):observe['chunk_sha256']=expected['sha256']
   active();current()
   response=wire('POST','/machines/'+mid+'/exec',dict(cmd=sidecar_command(observe),timeout=max(1,int(min(20,deadline-time.time()))),machine=True),kind='observe')
   save(journal/(label+'.observation.json'),response)
   need(response.get('exit_code',0)==0 and response.get('exit_signal',0)==0 and response.get('stderr')in(None,'') and json.loads(response['stdout'])==expected,'payload transfer remains unknown')
   save(journal/(label+'.reconciled.json'),expected)
 def exists(request,expected):
  current();command=sidecar_command(request)
  response=wire('POST','/machines/'+mid+'/exec',dict(cmd=command,timeout=max(1,int(min(20,deadline-time.time()))),machine=True),kind='observe-existing')
  need(response.get('exit_code',0)==0 and response.get('exit_signal',0)==0 and response.get('stderr')in(None,''),'payload observation failed')
  value=json.loads(response['stdout']);need(value==expected or value==dict(state='ABSENT'),'payload observation differs');return value==expected
 for item in descriptor:
  data=read(item['path']);need(len(data)==item['bytes'] and sha(data)==item['sha256'],'sidecar bytes changed')
  base=dict(machine=mid,source_ref=record['config']['env']['GATE_REF'],envelope_sha256=envelope_sha,sha256=item['sha256'])
  if exists(dict(base,action='observe-ready'),dict(state='READY',bytes=len(data),sha256=item['sha256'])):continue
  for index,start in enumerate(range(0,len(data),32768)):
   chunk=data[start:start+32768]
   expected=dict(state='CHUNK',index=index,bytes=len(chunk),sha256=sha(chunk))
   if exists(dict(base,action='observe-chunk',index=index,chunk_sha256=sha(chunk)),expected):continue
   for offset in range(0,len(chunk),2048):
    fragment=chunk[offset:offset+2048];wanted=dict(state='FRAGMENT',index=index,offset=offset,bytes=len(fragment),sha256=sha(fragment))
    if exists(dict(base,action='observe-fragment',index=index,offset=offset,chunk_sha256=sha(fragment)),wanted):continue
    send(dict(base,action='fragment',index=index,offset=offset,data=base64.b64encode(fragment).decode()),item['sha256']+'-%05d-%05d'%(index,offset),wanted)
   send(dict(base,action='assemble',index=index,chunk_sha256=sha(chunk)),item['sha256']+'-%05d'%index,expected)
  send(dict(base,action='commit'),item['sha256']+'-commit',dict(state='READY',bytes=len(data),sha256=item['sha256']))
 current();save(journal/'complete.json',dict(machine=mid,instance=record['instance_id'],envelope_sha256=envelope_sha,sidecars=descriptor))


def host_gate(root,v):
 path=Path(__file__).absolute().with_name('run-cloudbench-controller-gate')
 if path==root/'scripts/run-cloudbench-controller-gate':return path
 provenance=v.get('host_operator_provenance',{})
 ref=provenance.get('host_operator_source_ref','')
 need(re.fullmatch('[0-9a-f]{40}',ref),'separate host gate source required')
 need(path.resolve(strict=True)==path,'physical host gate required')
 host_root=path.parent.parent
 need(subprocess.check_output(['git','-C',str(host_root),'rev-parse','HEAD'],text=True).strip()==ref,'host gate HEAD changed')
 raw=path.read_bytes()
 need(sha(raw)==provenance.get('host_gate_sha256') and raw==subprocess.check_output(['git','--no-replace-objects','-C',str(host_root),'show',ref+':scripts/run-cloudbench-controller-gate']),'host gate bytes changed')
 return path


def spawn_gate(command,root,env,stream,out,config_path,config_sha,authority):
 try:return subprocess.Popen(command,cwd=root,env=env,stdout=stream,stderr=subprocess.STDOUT)
 except OSError as error:
  # Popen reports exec failure only after joining its failed child; no gate ran.
  if error.errno==errno.E2BIG:
   save(out/'gate-start-failure.json',dict(schema='original600-host-popen-failure-v1',errno=error.errno,
        reason='argument-list-too-long',gate_created=False,config_path=str(config_path),config_sha256=config_sha,
        output_directory=str(out),authority_sha256=sha(read(authority)),
        host_runner_sha256=sha(Path(__file__).read_bytes()),owner_pid=os.getpid(),owner_birth=birth(os.getpid())))
  raise


def replace_json(path,value):
 """Atomically replace a private status file; readers never see partial bytes."""
 raw=(json.dumps(value,sort_keys=True,allow_nan=False)+'\n').encode();fd,temporary=tempfile.mkstemp(prefix='.'+path.name+'.',dir=path.parent)
 try:
  with os.fdopen(fd,'wb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
  os.replace(temporary,path)
 finally:
  if os.path.lexists(temporary):os.unlink(temporary)
 fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)

def shard_status(out,probe,mid):
 replace_json(out/'shard-status.json',dict(schema='original600-shard-status-v1',state=probe.get('state'),barrier=probe.get('barrier'),
              infra=probe.get('infra'),observed_at=time.time(),machine=mid))

def global_decision(path):
 """The coordinator's {release_id, reason}; None while absent or still being published."""
 try:value=json.loads(read(path))
 except (OSError,ValueError):return None
 if not(isinstance(value,dict) and set(value)=={'release_id','reason'} and isinstance(value['release_id'],str)
        and re.fullmatch('[0-9a-f]{16,64}',value['release_id']) and isinstance(value['reason'],str) and len(value['reason'])<=1024):return None
 return value

def deliver_global(api,mid,base,out,probe,delivery,stopping):
 """Deliver a coordinator barrier decision by idempotent exec until ACK or supervisor JOINED.
 Never signals the supervisor, gate or VM; a stopping owner releases no new work."""
 for kind,action,acked in (('release','RELEASE','RELEASED'),('abort','ABORT','ABORTED')):
  request=out/('global-'+kind+'.json');ack=out/('global-'+kind+'.ack.json');refused=out/('global-'+kind+'.refused.json');undelivered=out/('global-'+kind+'.undelivered.json')
  if not request.exists() or any(path.exists() for path in (ack,refused,undelivered)) or(kind=='release'and stopping):continue
  decision=global_decision(request)
  if decision is None:continue
  if probe.get('state')=='JOINED':save(undelivered,dict(decision,supervisor_state='JOINED',observed_at=time.time()));continue
  if time.monotonic()<delivery.get(kind,0):continue
  delivery[kind]=time.monotonic()+2;attempts=delivery[kind+'_attempts']=delivery.get(kind+'_attempts',0)+1
  try:result=machine_control(api,mid,dict(base,action=action,**decision))
  except (Exception,Deadline) as error:
   replace_json(out/('global-'+kind+'.pending.json'),dict(decision,attempts=attempts,error=type(error).__name__,observed_at=time.time(),retry=True));continue
  if result['state']==acked and result.get('record',{}).get('release_id')==decision['release_id']:save(ack,dict(result,release_id=decision['release_id'],attempts=attempts,delivered_at=time.time()))
  elif result['state']in(acked,'REFUSED'):save(refused,dict(result,release_id=decision['release_id'],attempts=attempts,observed_at=time.time()))
  elif result['state']=='JOINED':save(undelivered,dict(decision,supervisor_state='JOINED',attempts=attempts,observed_at=time.time()))
  else:replace_json(out/('global-'+kind+'.pending.json'),dict(decision,attempts=attempts,supervisor_state=result['state'],observed_at=time.time(),retry=True))

def run(config_path,config_sha,out,*,github_token=None):
 os.umask(0o077);raw=read(config_path);need(sha(raw)==config_sha,'root config bytes changed');v=json.loads(raw)
 need(v['schema']=='original600-controller-runner-v1'and v['allowed']is True,'explicit root operation config required')
 policy = v.get('infra_early_stop', 'enabled')
 need(policy in ('enabled', 'disabled'), 'invalid infrastructure early-stop policy')
 root=Path(v['source_root']).resolve(strict=True);ref=v['source_ref'];need(re.fullmatch('[0-9a-f]{40}',ref or''),'UNBOUND final source')
 need(subprocess.check_output(['git','--no-replace-objects','-C',str(root),'rev-parse','HEAD'],text=True).strip()==ref,'source HEAD mismatch')
 validate_source_members(root,ref,v['source_files'])
 tasks=json.loads(read(v['tasks_path']));epoch=v['started_at_epoch'];need(type(epoch)in(int,float)and epoch>0 and time.time()<epoch+MAX_RUN_DEADLINE,'original new attempt clock expired')
 shard=v.get('shard');argv=campaign_argv(tasks,epoch,shard);deadline_s=RUN_DEADLINE if shard is None else shard_timeouts(shard)[1];shard_env(dict(v.get('remote_env',{})),shard,'original600-supervisor.'+'0'*24+'.json') # refuse before any output
 authority_template=json.loads(read(v['authority_template']));need(authority_template['allowed']is True and authority_template['source_ref']==ref,'root authority must match final source')
 out=Path(out).absolute();out.mkdir(mode=0o700);need(out.resolve()==out,'physical new output')
 if v.get('host_operator_provenance'):save(out/'host-operator-provenance.json',v['host_operator_provenance'])
 auth=dict(authority_template,cleanup_owner_pid=os.getpid(),cleanup_owner_birth=birth(os.getpid()),output_directory=str(out/'export'));authority=out/'authority.private.json';save(authority,auth)
 fixed_env=dict(CLOUDBENCH_WARM_MACHINE_NAME=WARM_MACHINE_NAME,CLOUDBENCH_WARM_VOLUME_NAME=WARM_VOLUME_NAME,CLOUDBENCH_REGION='ord',**shard_placement_env(root,shard),CLOUDBENCH_WARM_DEPS_AUTOREFRESH='0',CLOUDBENCH_SKIP_LOCAL_PATCH='1',CLOUDBENCH_BOOT_TRANSPORT='config',CLOUDBENCH_BOOT_LAUNCH='1')
 remote_env=dict(v.get('remote_env',{}))
 need(remote_env.get('CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP',policy)==policy,'infrastructure early-stop policy differs')
 remote_env['CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP']=policy
 for key,value in fixed_env.items():need(remote_env.get(key,value)==value,'original warm/launch option changed: '+key);remote_env[key]=value
 for key in set(FRESH_ONLY_PLACEMENT)-set(fixed_env):need(key not in remote_env,'fresh-only placement refused for a simulate shard: '+key)
 files=[];staged={}
 for item in v['remote_files']:
  need(re.fullmatch(r'\.git/cloudbench-[A-Za-z0-9_.-]+',item['relative_path']),'only bound benchmark Git metadata may be staged')
  data=read(item['source_path']);need(sha(data)==item['sha256'],'remote metadata source changed')
  staged[item['relative_path']]=data
  files.append(encode_remote_file(item,data))
 pin_warm_snapshot(remote_env,staged)
 snapshot_name=WARM_INVENTORY_RELATIVE
 snapshot=next((i for i in files if i['relative_path']==snapshot_name),None);need(snapshot is not None,'authentic selected warm snapshot inventory required')
 remote_env['CLOUDBENCH_WARM_SNAPSHOT_INVENTORY_FILE']='/tmp/gate/repo/'+snapshot_name;remote_env['CLOUDBENCH_WARM_SNAPSHOT_INVENTORY_SHA256']=snapshot['sha256']
 identity_name='original600-supervisor.'+secrets.token_hex(12)+'.json';remote_env=shard_env(remote_env,shard,identity_name)
 remote=dict(source_ref=ref,supervisor_sha256=v['source_files']['cloudbench-original600-supervisor.py'],identity_name=identity_name,tasks=tasks,epoch=epoch,campaign_argv=argv,remote_env=remote_env,remote_files=files,infra_early_stop=policy)
 if shard is not None:remote['shard']=shard
 try:payload,payload_sha,remote_command=launch_handoff(out,remote)
 except ValueError as error:
  if str(error)in('compressed launch payload too large for config transport','launch payload exceeds bounded decoded size'):
   save(out/'launch-payload-failure.json',dict(schema='original600-host-payload-failure-v1',reason=str(error),gate_created=False,
        source_ref=ref,config_path=str(config_path),config_sha256=config_sha,output_directory=str(out),
        host_runner_sha256=sha(Path(__file__).read_bytes()),owner_pid=os.getpid(),owner_birth=birth(os.getpid())))
  raise
 export=out/'export';log=out/'gate.private.log';command=['bash',str(host_gate(root,v)),'--disposable-controller',str(authority),'--',*remote_command]
 env=dict(os.environ,**v.get('gate_env',{}))
 if github_token is not None:
  need(isinstance(github_token,str)and re.fullmatch(r'[A-Za-z0-9_./+=:\-]+',github_token),'invalid owned gate GitHub credential')
  env['GITHUB_TOKEN']=github_token
 env['CLOUDBENCH_GATE_NO_EFFECT_RECEIPT']=str(out/'gate.preallocation-failure.json')
 env.update(CLOUDBENCH_GATE_ROOT_DIR=str(root),CLOUDBENCH_GATE_PAYLOAD_FILE=str(payload),CLOUDBENCH_GATE_PAYLOAD_SHA256=payload_sha)
 env.update(CLOUDBENCH_GATE_REF=ref,CLOUDBENCH_GATE_EXPORT_DIR=str(export),CLOUDBENCH_GATE_RETAIN_HOST='1',CLOUDBENCH_GATE_EXPORT_HOST='1',CLOUDBENCH_GATE_VM_SIZE='performance-8x',CLOUDBENCH_GATE_VM_MEMORY='32768',CLOUDBENCH_GATE_WORKSPACE_VOLUME_SIZE_GB='256')
 need(int(env.get('CLOUDBENCH_GATE_TIMEOUT_S','0'))>=gate_watchdog_seconds(deadline_s),'explicit host watchdog must outlive the TERM fence plus benchmark cleanup')
 capture=root/'scripts/cloudbench-original-volume-capture.py';scope={'__file__':str(capture),'__name__':'bound_external_controller'};exec(compile(capture.read_bytes(),str(capture),'exec'),scope)
 token=scope['resolve_token']({'workspace':str(root)});api=scope['Fly'](APP,token)
 stop=[False];old_handlers={s:signal.getsignal(s)for s in(signal.SIGTERM,signal.SIGINT)}
 def cancel(*unused):stop[0]=True # never forward to gate process or VM
 for s in old_handlers:signal.signal(s,cancel)
 stream=log.open('xb')
 try:gate=spawn_gate(command,root,env,stream,out,config_path,config_sha,authority)
 except BaseException:
  stream.close()
  for number,handler in old_handlers.items():signal.signal(number,handler)
  raise
 mid=None;probe={};probed_after_join=False;attempt=0;cleanup=None;cleanup_action=None;last_error=None;next_probe=0;delivery={}
 try:
  save(out/'caller.json',dict(pid=os.getpid(),birth=birth(os.getpid()),gate_pid=gate.pid,gate_birth=birth(gate.pid),source_ref=ref,task_ref=shard_task_ref(shard),epoch=epoch,deadline=epoch+deadline_s,identity_path='/tmp/gate/repo/.context/'+identity_name,authority_sha256=sha(authority.read_bytes())))
  while True:
   joined=gate.poll()is not None
   if joined:
    gate.wait();stream.close()
    early=preallocation_terminal(True,gate.returncode,gate.pid,ref,export,out/'gate.preallocation-failure.json')
    if early is not None:
     save(out/'terminal.json',dict(early,started_at_epoch=epoch,original_deadline=epoch+deadline_s))
     return gate.returncode
   ownership=export/'disposable-controller.ownership.json'
   if mid is None and ownership.exists():
    record=json.loads(read(ownership));need(record['authority_sha256']==sha(authority.read_bytes()),'wrong controller ownership');mid=record['machine']['id'];need(mid not in auth['protected_machines'],'protected controller ID')
    save(out/'controller.identity.json',dict(machine=mid,instance=record['machine']['instance_id'],source_ref=ref,authority_sha256=sha(authority.read_bytes())))
    if 'cloudbench-controller-bulk-transfer.py' in v['source_files']:
     import runpy
     bulk_path=Path(__file__).with_name('cloudbench-controller-bulk-transfer.py')
     need(sha(bulk_path.read_bytes())==v['source_files'][bulk_path.name],'bulk helper source changed')
     runpy.run_path(str(bulk_path))['transfer'](api,mid,record['machine'],out,payload_sha,epoch+deadline_s,lambda:stop[0],runtime=globals(),source_sha256=v['source_files'][bulk_path.name])
    else:
     need(v.get('host_operator_provenance') and v['source_files']['cloudbench-original600-runner.py']!=sha(Path(__file__).read_bytes()),'fragment transfer requires explicit historical workload compatibility')
     transfer_sidecars(api,mid,record['machine'],out,payload_sha,epoch+deadline_s,lambda:stop[0])
   if cleanup is None and mid and time.monotonic()>=next_probe:
    payload=dict(machine=mid,source_ref=ref,epoch=epoch,identity_path='/tmp/gate/repo/.context/'+identity_name,action='PROBE')
    try:
     probe=machine_control(api,mid,payload);probed_after_join=joined;save(out/('supervisor-probe-%06d.json'%attempt),probe);attempt+=1
     if(stop[0]or time.time()>=epoch+deadline_s)and probe['state']=='LIVE':request_term(api,mid,payload,probe,out)
     if shard is not None:shard_status(out,probe,mid)
    except BaseException as e:
     last_error=type(e).__name__
     save(out/('supervisor-read-pending-%06d.json'%attempt),dict(error=last_error,no_gate_signal=True));attempt+=1
    next_probe=time.monotonic()+5
   if shard is not None and cleanup is None and mid:
    try:deliver_global(api,mid,dict(machine=mid,source_ref=ref,epoch=epoch,identity_path='/tmp/gate/repo/.context/'+identity_name),out,probe,delivery,stop[0]or time.time()>=epoch+deadline_s)
    except (Exception,Deadline) as e:last_error=type(e).__name__ # retried next loop; never a cleanup or signal decision
   verified=export/'disposable-export.verified.json'
   mode=cleanup_mode(joined,ownership.exists(),(export/'workspace-volume.ownership.json').exists(),probe,verified.exists(),probed_after_join)
   if mode is not None and cleanup is None:
    cleanup_action=mode
    save(out/'cleanup-call.intent.json',dict(machine=mid,action=mode,gate_joined=True,supervisor_joined=probe.get('state')=='JOINED',supervisor_state=probe.get('state'),probed_after_join=probed_after_join,export_verified_file=sha(read(verified))if verified.exists()else None))
    args=[sys.executable,str(root/'scripts/cloudbench-disposable-controller.py'),mode,'--authority',str(authority),'--root',str(root),'--directory',str(export),'--workspace',str(export/'workspace-volume.ownership.json')]
    with log.open('ab')as cleanup_log:cleanup=subprocess.Popen(args,cwd=root,env=env,stdout=cleanup_log,stderr=subprocess.STDOUT)
   release=export/'disposable-controller.release.json'
   if cleanup is not None and cleanup.poll()is not None:
    code=cleanup.wait()
    if release.exists():
     r=reconciled_release(out,export,authority,mid,cleanup_action,joined,probe,probed_after_join)
     status='FAILED_STARTUP_WORKSPACE_RELEASED'if cleanup_action!='cleanup'else'CONTROLLER_RELEASE_VERIFIED'if probe.get('state')=='JOINED'else'FAILED_BEFORE_SUPERVISOR_RELEASED'
     result=dict(status=status,supervisor_state=probe.get('state'),gate_exit_code=gate.returncode,controller_cleanup_exit_code=code,externally_reconciled_after_helper_failure=code!=0,machine=mid,source_ref=ref,started_at_epoch=epoch,original_deadline=epoch+deadline_s,release=r,benchmark_success_inferred=False)
     save(out/'terminal.json',result);return gate.returncode
    if not(out/'cleanup.pending.json').exists():save(out/'cleanup.pending.json',dict(status='PENDING_EXTERNAL_OWNER_LIVE',helper_exit_code=code,no_cleanup_retry=True))
   if joined and not cleanup_ready(True,probe,verified.exists(),probed_after_join)and not(out/'gate.pending.json').exists():
    save(out/'gate.pending.json',dict(status='PENDING_EXTERNAL_OWNER_LIVE',gate_exit_code=gate.returncode,supervisor_state=probe.get('state'),export_verified=verified.exists(),no_host_destroy=True))
   # A failed export/provider action cannot authorize killing an active writer.
   # Remain the live cleanup authority; root can reconcile originals while observing this process.
   time.sleep(.25)
 except BaseException as e:
  # Keep the external cleanup authority alive after local I/O/validation failure.
  # Do not terminate the gate or delete a VM whose writer/export state is unknown.
  try:print(json.dumps(dict(status='PENDING_EXTERNAL_OWNER_LIVE',error=type(e).__name__,gate_pid=gate.pid,no_gate_or_vm_kill=True)),flush=True)
  except BaseException:pass
  while True:
   if gate.poll() is not None:
    early=preallocation_terminal(True,gate.returncode,gate.pid,ref,export,out/'gate.preallocation-failure.json')
    if early is not None:
     save(out/'terminal.json',dict(early,started_at_epoch=epoch,original_deadline=epoch+deadline_s))
     return gate.wait()
   if mid is None:
    try:
     candidate=export/'disposable-controller.ownership.json'
     if candidate.exists():
      record=json.loads(read(candidate));need(record['authority_sha256']==sha(authority.read_bytes()),'wrong late controller ownership');newmid=record['machine']['id'];need(newmid not in auth['protected_machines'],'protected controller ID');mid=newmid
    except BaseException:pass
   if cleanup is None and mid and (stop[0] or time.time()>=epoch+deadline_s):
    try:
     payload=dict(machine=mid,source_ref=ref,epoch=epoch,identity_path='/tmp/gate/repo/.context/'+identity_name,action='PROBE')
     current=machine_control(api,mid,payload)
     if current['state']=='LIVE':request_term(api,mid,payload,current,out)
    except BaseException:pass
   # Root may complete a failed export/reconciliation while this authority stays live.
   release=export/'disposable-controller.release.json'
   if gate.poll()is not None and release.exists():
    try:
     action=cleanup_action or json.loads(read(out/'cleanup-call.intent.json'))['action']
     reconciled_release(out,export,authority,mid,action,True,probe,probed_after_join)
     return gate.wait()
    except BaseException:pass
   time.sleep(1)

 finally:
  for s,h in old_handlers.items():signal.signal(s,h)
  if not stream.closed:stream.close()
  # Intentionally no terminate/kill gate, VM, process group or unrelated PID here.

def owner_gone(pid,expected):
 """True only when the recorded PID no longer names the recorded process (absent, reused or zombie)."""
 try:return birth(pid)!=expected
 except (OSError,ValueError):return True

def adoption_binding(out):
 """The exact dead owner of a live sharded output: its authority, controller and supervisor path.

 Refuses unless the recorded runner and its gate are both gone and no terminal exists. The
 adopter never becomes the cleanup owner; cleanup stays with the dead-owner release route."""
 out=Path(out).absolute();need(out.is_dir() and out.resolve()==out,'physical original runner output required')
 need(not(out/'terminal.json').exists(),'runner already terminal; nothing to adopt')
 caller=json.loads(read(out/'caller.json'));auth_raw=read(out/'authority.private.json');auth=json.loads(auth_raw)
 need(caller.get('authority_sha256')==sha(auth_raw),'original authority changed')
 identity=json.loads(read(out/'controller.identity.json'));mid=identity.get('machine')
 need(identity.get('authority_sha256')==sha(auth_raw) and identity.get('source_ref')==caller.get('source_ref'),'original controller identity changed')
 need(isinstance(mid,str) and re.fullmatch('[0-9a-f]{14}',mid) and mid not in auth.get('protected_machines',[]),'protected/invalid controller ID')
 path=caller.get('identity_path');need(isinstance(path,str) and Path(path).is_absolute() and Path(path).name.startswith('original600-supervisor.'),'original supervisor identity path required')
 need(type(caller.get('deadline'))in(int,float) and math.isfinite(caller['deadline']),'original deadline required')
 need(owner_gone(caller['pid'],caller['birth']),'original runner owner still live')
 need(owner_gone(caller['gate_pid'],caller['gate_birth']),'original gate still live')
 return dict(out=out,caller=caller,machine=mid,base=dict(machine=mid,source_ref=caller['source_ref'],epoch=caller['epoch'],identity_path=path))

def next_probe_index(out):
 numbers=[int(p.name.rsplit('-',1)[1][:6])for p in out.glob('supervisor-*-[0-9][0-9][0-9][0-9][0-9][0-9].json')]
 return max(numbers,default=-1)+1

def owner_stop(out):
 """The coordinator's durable stop decision (threshold or explicit operator stop), or None."""
 try:value=json.loads(read(out/'owner-stop.json'))
 except (OSError,ValueError):return None
 return value if isinstance(value,dict) and isinstance(value.get('reason'),str) and value['reason'] else None

def controller_lock(mid,lock_dir=None):
 """One adopter per controller on this host, whatever output path names it."""
 import fcntl
 base=Path(lock_dir) if lock_dir else Path.home()/'.cache/original600-adopt'
 base.mkdir(mode=0o700,parents=True,exist_ok=True);info=base.lstat()
 need(stat.S_ISDIR(info.st_mode) and info.st_uid==os.geteuid() and not info.st_mode&0o077,'private adoption lock directory required')
 fd=os.open(base/(mid+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:os.close(fd);raise ValueError('another adopter owns this controller')
 return fd

def adopt_live(out,*,api,probe_interval=5.0,lock_dir=None):
 """Re-adopt observation and stop authority for a live shard whose host runner died.

 Same exact-owner controls as run(): PROBE, shard-status.json for the coordinator and
 scorecard, coordinator barrier delivery, and one never-replayed supervisor TERM. Only a
 durable owner-stop.json from the coordinator (threshold or explicit operator stop) or the
 original deadline stops the supervisor. A signal to this process (a host or service restart)
 only detaches: exit 75 without any supervisor TERM, so the run stays adoptable. Never signals
 a gate, VM or process group and never runs cleanup; returns 0 once the supervisor joined."""
 import fcntl
 bound=adoption_binding(out);out,caller,mid,base=bound['out'],bound['caller'],bound['machine'],bound['base']
 controller=controller_lock(mid,lock_dir)
 lock=os.open(out/'adoption.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:os.close(lock);os.close(controller);raise ValueError('another adopter owns this output')
 number=1
 while(out/('adoption-%02d.json'%number)).exists():number+=1
 receipt=out/('adoption-%02d.json'%number)
 save(receipt,dict(schema='original600-runner-adoption-v1',adopter_pid=os.getpid(),adopter_birth=birth(os.getpid()),machine=mid,
                   original_owner_pid=caller['pid'],original_owner_birth=caller['birth'],original_gate_pid=caller['gate_pid'],
                   original_gate_birth=caller['gate_birth'],identity_path=base['identity_path'],original_deadline=caller['deadline'],
                   adopted_at=time.time(),cleanup_owner=False))
 detach=[None];old={s:signal.getsignal(s)for s in(signal.SIGTERM,signal.SIGINT,signal.SIGHUP)}
 def detached(number,frame):detach[0]=detach[0] or signal.Signals(number).name # never a campaign stop
 for s in old:signal.signal(s,detached)
 attempt=next_probe_index(out);probe={};delivery={};next_probe=0
 try:
  print(json.dumps(dict(status='ADOPTED_LIVE_SHARD',machine=mid,receipt=str(receipt))),flush=True)
  while True:
   if detach[0]:
    save(receipt.with_name(receipt.stem+'.detached.json'),dict(signal=detach[0],supervisor_state=probe.get('state'),observed_at=time.time(),
         supervisor_term_requested=(out/'supervisor-term.intent.json').exists(),benchmark_success_inferred=False))
    print(json.dumps(dict(status='ADOPTER_DETACHED',machine=mid,signal=detach[0])),flush=True)
    return 75
   late=time.time()>=caller['deadline'];stopping=late or owner_stop(out) is not None
   if time.monotonic()>=next_probe:
    payload=dict(base,action='PROBE')
    try:
     probe=machine_control(api,mid,payload);save(out/('supervisor-probe-%06d.json'%attempt),probe);attempt+=1
     if stopping and probe['state']=='LIVE' and not detach[0]:request_term(api,mid,payload,probe,out)
     shard_status(out,probe,mid)
    except (Exception,Deadline) as e:
     save(out/('supervisor-read-pending-%06d.json'%attempt),dict(error=type(e).__name__,no_gate_signal=True,adopter=receipt.name));attempt+=1
    next_probe=time.monotonic()+probe_interval
   state=probe.get('state')
   if state in('JOINED','ABSENT_UNCONFIRMED')or(state=='NOT_PUBLISHED'and stopping):
    save(receipt.with_name(receipt.stem+'.terminal.json'),dict(supervisor_state=state,owner_stop=owner_stop(out),deadline_passed=late,
         observed_at=time.time(),next_step='dead-owner export and release (docs/original600-operator-cli.md)',benchmark_success_inferred=False))
    print(json.dumps(dict(status='ADOPTED_SUPERVISOR_SETTLED',machine=mid,supervisor_state=state,
                          next_step='cloudbench-resume-controller-export.py --dead-owner')),flush=True)
    return 0
   try:deliver_global(api,mid,base,out,probe,delivery,stopping)
   except (Exception,Deadline):pass # retried next loop; never a cleanup or signal decision
   time.sleep(.25)
 finally:
  for s,h in old.items():signal.signal(s,h)
  os.close(lock);os.close(controller)

def adopt_cli(out,workspace):
 capture=Path(__file__).absolute().with_name('cloudbench-original-volume-capture.py')
 scope={'__file__':str(capture),'__name__':'bound_external_controller'};exec(compile(capture.read_bytes(),str(capture),'exec'),scope)
 adoption_binding(out) # refuse locally before any credential read
 return adopt_live(out,api=scope['Fly'](APP,scope['resolve_token']({'workspace':str(workspace)})))

def self_test():
 import tempfile,unittest
 class Tests(unittest.TestCase):
  def test_pid1_refused(self):
   with self.assertRaises(ValueError):birth(1)
  def test_active_writer_blocks_cleanup(self):self.assertFalse(cleanup_ready(True,{'state':'LIVE'},True))
  def test_partial_workspace_cleanup_waits_gate_join(self):
   self.assertIsNone(cleanup_mode(False,False,True,{},False));self.assertEqual(cleanup_mode(True,False,True,{},False),'cleanup-workspace');self.assertIsNone(cleanup_mode(True,True,True,{'state':'LIVE'},False))
  def test_preallocation_receipt_accepts_only_typed_no_effect_reasons(self):
   with tempfile.TemporaryDirectory()as d:
    out=Path(d);receipt=out/'gate.preallocation-failure.json';export=out/'export';ref='a'*40
    for reason,accepted in [('github-token-missing',True),('controller-admission-refused',True),('workspace-volume-create-failed',False),('',False)]:
     receipt.unlink(missing_ok=True);save(receipt,dict(schema='original600-gate-preallocation-failure-v1',reason=reason,source_ref=ref,gate_pid=4242,allocation_attempted=False))
     value=preallocation_terminal(True,1,4242,ref,export,receipt)
     with self.subTest(reason=reason):
      if accepted:self.assertEqual((value['status'],value['reason'],value['allocation_attempted']),('FAILED_BEFORE_PROVIDER_DISPATCH',reason,False))
      else:self.assertIsNone(value)
    receipt.unlink();save(receipt,dict(schema='original600-gate-preallocation-failure-v1',reason='controller-admission-refused',source_ref=ref,gate_pid=4242,allocation_attempted=True))
    self.assertIsNone(preallocation_terminal(True,1,4242,ref,export,receipt))
  def test_export_and_join_required(self):
   self.assertFalse(cleanup_ready(False,{'state':'JOINED'},True));self.assertFalse(cleanup_ready(True,{'state':'JOINED'},False));self.assertTrue(cleanup_ready(True,{'state':'JOINED'},True))
  def test_real_exact_supervisor_term_and_join(self):
   with tempfile.TemporaryDirectory()as d:
    out=Path(d);mid='1234567890abcd';pidfile=out/'original600-supervisor.fixture.json';done=out/'done'
    child=subprocess.Popen([sys.executable,'-c',"import signal,time,sys;from pathlib import Path;signal.signal(signal.SIGTERM,lambda *a:(Path(sys.argv[1]).write_text('cleanup'),sys.exit(7)));print('ready',flush=True);time.sleep(60)",str(done),'cloudbench-original600-supervisor.py'],stdout=subprocess.PIPE,text=True)
    self.assertEqual(child.stdout.readline().strip(),'ready')
    try:
     row=dict(schema='original600-supervisor-identity-v1',pid=child.pid,birth=birth(child.pid),machine=mid,source_ref='a'*40,epoch=1);save(pidfile,row)
     class FakeAPI:
      def api(self,method,path,body,timeout):
       assert method=='POST'and path=='/machines/'+mid+'/exec';p=subprocess.run(shlex.split(body['cmd']),capture_output=True,text=True,env=dict(os.environ,FLY_MACHINE_ID=mid),timeout=5);return dict(stdout=p.stdout,stderr=p.stderr,exit_code=p.returncode)
     payload=dict(machine=mid,source_ref='a'*40,epoch=1,identity_path=str(pidfile),action='PROBE');api=FakeAPI();probe=machine_control(api,mid,payload);self.assertEqual(probe['state'],'LIVE')
     request_term(api,mid,payload,probe,out);self.assertEqual(child.wait(timeout=5),7);self.assertEqual(done.read_text(),'cleanup');self.assertIsNone(request_term(api,mid,payload,probe,out))
    finally:
     if child.poll()is None:child.terminate();child.wait(timeout=5)
     child.stdout.close()
  def test_ambiguous_signal_never_replayed(self):
   with tempfile.TemporaryDirectory()as d:
    class API:
     def __init__(self):self.calls=0
     def api(self,*a,**k):self.calls+=1;raise TimeoutError()
    api=API();out=Path(d);probe=dict(state='LIVE',identity=dict(pid=os.getpid(),birth=birth(os.getpid())),identity_sha256='a'*64);payload=dict(identity_path='/tmp/original600-supervisor.x.json')
    request_term(api,'1234567890abcd',payload,probe,out);request_term(api,'1234567890abcd',payload,probe,out);self.assertEqual(api.calls,1)
  def test_bad_identity_birth_refuses_signal(self):
   with tempfile.TemporaryDirectory()as d:
    p=Path(d)/'original600-supervisor.fixture.json';save(p,dict(schema='original600-supervisor-identity-v1',pid=os.getpid(),birth='wrong',machine='1234567890abcd',source_ref='a'*40,epoch=1))
    command=exec_command(REMOTE_CONTROL,dict(identity_path=str(p),machine='1234567890abcd',source_ref='a'*40,epoch=1,action='TERM',identity_sha256=sha(p.read_bytes())))
    result=subprocess.run(shlex.split(command),env=dict(os.environ,FLY_MACHINE_ID='1234567890abcd'),capture_output=True);self.assertNotEqual(result.returncode,0)
  def manifest(self):return json.loads((Path(__file__).absolute().parent/'tests/fixtures/original600-tasks.json').read_bytes())
  def shard(self,manifest,**changes):
   names=[manifest[3],manifest[10],manifest[199]]
   value=dict(index=0,count=20,tasks=names,tasks_sha256=sha(('\n'.join(names)+'\n').encode()),task_indexes=[3,10,199],runs=3,group_run_id='campaign-group-fixture',group_total=600,group_started_at=1792287011.18)
   value.update(changes);return value
  def test_legacy_argv_and_env_byte_identical_without_shard(self):
   tasks=self.manifest();epoch=1792287011.18
   legacy=['bash','scripts/run-bench','--stress-defaults','--strict-barrier','--concurrency','600','-k','3','--retry-infra','1','--timeout','1200','--e2e-timeout','5400','--e2e-started-at',str(epoch),'--ref',TASK_REF,*tasks]
   self.assertEqual(json.dumps(campaign_argv(tasks,epoch)),json.dumps(legacy));self.assertEqual(json.dumps(campaign_argv(tasks,epoch,None)),json.dumps(legacy))
   env=dict(CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP='enabled',CLOUDBENCH_REGION='ord');before=json.dumps(env,sort_keys=True)
   self.assertIs(shard_env(env,None,'original600-supervisor.'+'a'*24+'.json'),env);self.assertEqual(json.dumps(env,sort_keys=True),before)
  def test_shard_argv_env_and_validation(self):
   tasks=self.manifest();epoch=1792287011.18;shard=self.shard(tasks);argv=campaign_argv(tasks,epoch,shard)
   legacy=campaign_argv(tasks,epoch);expected=[x for x in legacy[:-200] if x!='--stress-defaults'];expected[expected.index('--concurrency')+1]='9'
   self.assertEqual(argv,expected+shard['tasks']);self.assertNotIn('--stress-defaults',argv);self.assertEqual(argv[argv.index('-k')+1],'3')
   self.assertEqual(campaign_argv(tasks,epoch,self.shard(tasks,runs=1,group_total=200))[3:7],['--concurrency','3','-k','1'])
   name='original600-supervisor.'+'b'*24+'.json';base=dict(CLOUDBENCH_APP_MACHINE_CEILING='138',CLOUDBENCH_SHARED_CPU_GOVERNOR='300',CLOUDBENCH_REGION='ord')
   env=shard_env(base,shard,name)
   self.assertEqual({k:v for k,v in env.items() if k not in base},dict(CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION='1',RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER='/tmp/gate/repo/.context/original600-supervisor.'+'b'*24+'.barrier',
                    RUN_BENCH_CAMPAIGN_TASK_INDEXES='3,10,199',RUN_BENCH_CAMPAIGN_GROUP_TOTAL='600',RUN_BENCH_CAMPAIGN_GROUP_STARTED_AT='1792287011.18',BENCHMARK_HUB_GROUP_RUN_ID='campaign-group-fixture'))
   self.assertNotIn('RUN_BENCH_CAMPAIGN_TASK_INDEXES',base)
   for missing in ('CLOUDBENCH_APP_MACHINE_CEILING','CLOUDBENCH_SHARED_CPU_GOVERNOR'):
    with self.assertRaisesRegex(ValueError,'explicit operator limit'):shard_env({k:v for k,v in base.items() if k!=missing},shard,name)
   with self.assertRaisesRegex(ValueError,'shard campaign control changed'):shard_env(dict(base,RUN_BENCH_CAMPAIGN_TASK_INDEXES='3,10'),shard,name)
   with self.assertRaisesRegex(ValueError,'shard campaign control changed'):shard_env(dict(base,CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION='0'),shard,name)
   reordered=[tasks[10],tasks[3]]
   for bad in [dict(tasks=reordered,tasks_sha256=sha(('\n'.join(reordered)+'\n').encode()),task_indexes=[10,3]),dict(tasks=['foreign'],tasks_sha256=sha(b'foreign\n'),task_indexes=[0]),dict(tasks_sha256='0'*64),
               dict(runs=0),dict(runs=True),dict(index=20),dict(task_indexes=[3,11,199]),dict(task_indexes=[3,10]),dict(task_indexes=[3,10,True]),dict(task_indexes=[3,10,200]),
               dict(task_indexes=[3,3,199]),dict(task_indexes=None),dict(job_prefix='s00-'),dict(group_total=8),dict(group_total=601),dict(group_total=598),dict(group_total=300),
               dict(group_run_id='bad id'),dict(group_started_at=float('nan')),dict(infra_threshold=0),dict(unexpected=1)]:
    with self.subTest(bad=bad),self.assertRaises(ValueError):campaign_argv(tasks,epoch,self.shard(tasks,**bad))
   self.assertEqual(validate_shard(self.shard(tasks,index=7,infra_threshold=5),tasks),9)
  def test_bound_manifest_shard_argv_carries_its_hash_and_timeouts(self):
   # Any ordered manifest of distinct names: the shard binds its sha; the original pins stay for the unbound path.
   tasks=['polar-fixture-%02d'%i for i in range(70)];epoch=1792287011.18;names=tasks[1::3]
   shard=dict(index=1,count=3,tasks=names,tasks_sha256=sha(('\n'.join(names)+'\n').encode()),task_indexes=list(range(1,70,3)),runs=1,
              group_run_id='original600-fixture',group_total=70,group_started_at=epoch,manifest_sha256=manifest_sha(tasks),task_timeout=480)
   argv=campaign_argv(tasks,epoch,shard)
   self.assertEqual(argv,['bash','scripts/run-bench','--strict-barrier','--concurrency','23','-k','1','--retry-infra','1','--timeout','480','--e2e-timeout','5400',
                          '--e2e-started-at',str(epoch),'--ref',TASK_REF,*names])
   self.assertEqual(campaign_argv(tasks,epoch,dict(shard,e2e_timeout=3300))[9:13],['--timeout','480','--e2e-timeout','3300'])
   self.assertEqual(validate_shard(shard,tasks),23)
   with self.assertRaisesRegex(ValueError,'original ordered task manifest required'):campaign_argv(tasks,epoch)
   other=list(reversed(tasks));unbound={k:v for k,v in shard.items() if k!='manifest_sha256'}
   for manifest,value,message in [(tasks,unbound,'original ordered task manifest required'),(other,shard,'bound ordered task manifest required'),
                                  (tasks+[tasks[0]],dict(shard,manifest_sha256=manifest_sha(tasks+[tasks[0]])),'bound ordered task manifest required'),
                                  (self.manifest(),dict(shard,manifest_sha256=TASK_NAMES_SHA),'invalid bound manifest hash'),(tasks,dict(shard,manifest_sha256='A'*64),'invalid bound manifest hash'),
                                  (tasks,dict(shard,task_timeout=1200),'encoded by absence'),(tasks,dict(shard,e2e_timeout=5400),'encoded by absence'),
                                  (tasks,dict(shard,task_timeout=59),'task-timeout'),(tasks,dict(shard,task_timeout=7201),'task-timeout'),(tasks,dict(shard,task_timeout=480.0),'task-timeout'),
                                  (tasks,dict(shard,task_timeout=True),'task-timeout'),(tasks,dict(shard,e2e_timeout=1680),'e2e-timeout'),(tasks,dict(shard,e2e_timeout=10021),'e2e-timeout'),(tasks,dict(shard,task_timeout=7200,e2e_timeout=8400),'e2e-timeout must cover'),(tasks,dict(shard,task_timeout=7201,e2e_timeout=9300),'ask the user'),
                                  (tasks,dict(shard,group_total=71),'group total exceeds the bound manifest'),(tasks,dict(shard,task_indexes=list(range(2,70,3))),'ordered subset of the bound manifest')]:
    with self.subTest(message=message,value={k:value[k] for k in SHARD_OPTIONAL&set(value)}),self.assertRaisesRegex(ValueError,message):campaign_argv(manifest,epoch,value)
   self.assertEqual(campaign_timeouts(),(1200,5400));self.assertEqual(campaign_timeouts(2580,5400),(2580,5400));self.assertEqual(campaign_timeouts(7200,10020),(7200,10020))
   self.assertEqual([default_e2e_timeout(t)for t in(480,1200,2580,3300,7200)],[5400,5400,5400,6120,10020]);self.assertEqual(gate_watchdog_seconds(10020),11820);self.assertEqual(gate_watchdog_seconds(5400),7200)
   # The original-manifest shard encodes neither field: its bytes and argv are the historical ones.
   original=self.shard(self.manifest());self.assertFalse(SHARD_OPTIONAL&set(original))
   self.assertEqual(campaign_argv(self.manifest(),epoch,original)[9:13],['--timeout','1200','--e2e-timeout','5400'])
  def test_remote_launch_stages_private_barrier_and_bound_shard(self):
   tasks=self.manifest();shard=self.shard(tasks)
   with tempfile.TemporaryDirectory()as d:
    root=Path(d);(root/'scripts').mkdir();script=root/'scripts/cloudbench-original600-supervisor.py'
    script.write_text("import json,os,sys\nfrom pathlib import Path\np=Path(os.environ['REVIEWED_OPERATOR_IDENTITY_PATH'])\n(p.parent/'handoff.json').write_text(json.dumps(dict(env={k:v for k,v in os.environ.items() if k.startswith(('REVIEWED_OPERATOR_SHARD','RUN_BENCH_CAMPAIGN_','BENCHMARK_HUB_'))},argv=sys.argv[1:])))\n")
    git=lambda *a:subprocess.check_output(['git','-C',str(root),'-c','user.name=fixture','-c','user.email=fixture@example.invalid',*a],text=True)
    git('init','-q');git('add','.');git('commit','-qm','fixture');ref=git('rev-parse','HEAD').strip();epoch=time.time();name='original600-supervisor.'+'c'*24+'.json'
    env=shard_env(dict(CLOUDBENCH_APP_MACHINE_CEILING='138',CLOUDBENCH_SHARED_CPU_GOVERNOR='300'),shard,name);argv=campaign_argv(tasks,epoch,shard)
    env['RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER']=str(root/'.context'/(name[:-5]+'.barrier'))
    remote=dict(source_ref=ref,supervisor_sha256=sha(script.read_bytes()),epoch=epoch,identity_name=name,tasks=tasks,campaign_argv=argv,remote_files=[],remote_env=env,infra_early_stop='enabled',shard=shard)
    path,digest,command=launch_handoff(root,remote)
    command[2]=command[2].replace("Path('/tmp/controller-launch-payload.json.gz')",'Path('+repr(str(path))+')').replace("root=Path('/tmp/gate/repo')",'root=Path('+repr(str(root))+')');command[3]=str(path)
    result=subprocess.run(command,capture_output=True,text=True,timeout=10,env=dict(os.environ,FLY_MACHINE_ID='1'*14));self.assertEqual(result.returncode,0,result.stderr)
    identity=root/'.context'/name;barrier=identity.with_suffix('.barrier');handoff=json.loads((root/'.context/handoff.json').read_text())
    self.assertTrue(barrier.is_dir());self.assertEqual(barrier.stat().st_mode&0o777,0o700);self.assertEqual(list(barrier.iterdir()),[])
    self.assertEqual(json.loads(identity.with_suffix('.shard.json').read_bytes()),shard);self.assertEqual(handoff['argv'],[str(epoch),*argv])
    self.assertEqual(handoff['env']['REVIEWED_OPERATOR_SHARD_SHA256'],sha(identity.with_suffix('.shard.json').read_bytes()))
    self.assertEqual({k:handoff['env'][k] for k in ('RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER','RUN_BENCH_CAMPAIGN_TASK_INDEXES','RUN_BENCH_CAMPAIGN_GROUP_TOTAL','BENCHMARK_HUB_GROUP_RUN_ID')},
                     dict(RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER=str(barrier),RUN_BENCH_CAMPAIGN_TASK_INDEXES='3,10,199',RUN_BENCH_CAMPAIGN_GROUP_TOTAL='600',BENCHMARK_HUB_GROUP_RUN_ID='campaign-group-fixture'))
  class Supervisor:
   """A live fixture whose cmdline names the supervisor, with an exact identity receipt."""
   def __init__(self,directory,mid,sharded=True):
    self.done=directory/'done';self.process=subprocess.Popen([sys.executable,'-c',"import signal,time,sys;from pathlib import Path;signal.signal(signal.SIGTERM,lambda *a:(Path(sys.argv[1]).write_text('cleanup'),sys.exit(7)));print('ready',flush=True);time.sleep(60)",str(self.done),'cloudbench-original600-supervisor.py'],stdout=subprocess.PIPE,text=True)
    assert self.process.stdout.readline().strip()=='ready'
    self.identity=directory/'original600-supervisor.fixture.json';self.row=dict(schema='original600-supervisor-identity-v1',pid=self.process.pid,birth=birth(self.process.pid),machine=mid,source_ref='a'*40,epoch=1)
    save(self.identity,self.row);self.barrier=self.identity.with_suffix('.barrier')
    if sharded:self.barrier.mkdir(mode=0o700)
   def close(self):
    if self.process.poll()is None:self.process.terminate();self.process.wait(timeout=5)
    self.process.stdout.close()
  class ExecAPI:
   def __init__(self,mid):self.mid=mid;self.calls=[];self.fail=0
   def api(self,method,path,body,timeout):
    assert method=='POST'and path=='/machines/'+self.mid+'/exec';self.calls.append(json.loads(base64.b64decode(shlex.split(body['cmd'])[3])))
    if self.fail:self.fail-=1;raise TimeoutError('fixture transport loss')
    p=subprocess.run(shlex.split(body['cmd']),capture_output=True,text=True,env=dict(os.environ,FLY_MACHINE_ID=self.mid),timeout=10);return dict(stdout=p.stdout,stderr=p.stderr,exit_code=p.returncode)
  def test_release_abort_idempotent_through_real_remote_control(self):
   with tempfile.TemporaryDirectory()as d:
    mid='1234567890abcd';api=self.ExecAPI(mid);first=self.Supervisor(Path(d),mid);(Path(d)/'second').mkdir();second=self.Supervisor(Path(d)/'second',mid)
    try:
     ready=dict(schema='campaign-external-barrier-ready-v1',cohort_id='c001',status='ready',ready_count=9,failed_count=0,expected_count=9,survivor_count=9,updated_at='2026-10-18T00:00:00+00:00')
     (first.barrier/'ready.json').write_text(json.dumps(ready));save(first.identity.with_suffix('.infra.json'),dict(schema='original600-shard-infra-v1',infra_true=1,unique_jobs=9,observed_at=2.0))
     base=lambda sup:dict(machine=mid,source_ref='a'*40,epoch=1,identity_path=str(sup.identity))
     probe=machine_control(api,mid,dict(base(first),action='PROBE'));self.assertEqual((probe['state'],probe['barrier'],probe['infra']['infra_true']),('LIVE',ready,1))
     self.assertEqual((machine_control(api,mid,dict(base(second),action='PROBE'))['barrier'],machine_control(api,mid,dict(base(second),action='PROBE'))['infra']),(None,None))
     rid='0123456789abcdef'*2;release=dict(base(first),action='RELEASE',release_id=rid,reason='all shards ready')
     ack=machine_control(api,mid,release);self.assertEqual(ack['state'],'RELEASED');record=json.loads((first.barrier/'release.json').read_text())
     self.assertEqual(record,ack['record']);self.assertEqual((record['schema'],record['release_id']),('campaign-external-barrier-release-v1',rid));self.assertIn('released_at',record)
     info=(first.barrier/'release.json').stat();self.assertEqual((info.st_mode&0o777,info.st_nlink),(0o600,1));self.assertEqual(sorted(x.name for x in first.barrier.iterdir()),['ready.json','release.json'])
     self.assertEqual(machine_control(api,mid,release),dict(ack,barrier=ready,infra=probe['infra']));self.assertEqual(json.loads((first.barrier/'release.json').read_text()),record)
     self.assertEqual(machine_control(api,mid,dict(release,release_id='f'*32))['state'],'REFUSED');self.assertEqual(machine_control(api,mid,dict(release,action='ABORT'))['state'],'REFUSED')
     self.assertFalse((first.barrier/'abort.json').exists());self.assertIsNone(first.process.poll())
     abort=dict(base(second),action='ABORT',release_id=rid,reason='shard s03 failed before release')
     self.assertEqual(machine_control(api,mid,abort)['state'],'ABORTED');self.assertEqual(machine_control(api,mid,abort)['state'],'ABORTED')
     self.assertEqual(json.loads((second.barrier/'abort.json').read_text()),dict(schema='campaign-external-barrier-abort-v1',release_id=rid,reason='shard s03 failed before release'))
     self.assertEqual(machine_control(api,mid,dict(abort,action='RELEASE'))['state'],'REFUSED');self.assertFalse((second.barrier/'release.json').exists())
     with self.assertRaises(ValueError):machine_control(api,mid,dict(abort,release_id='not-hex'))
     (first.barrier/'ready.json').write_text('{"partial');probe=machine_control(api,mid,dict(base(first),action='PROBE'))
     self.assertEqual((probe['state'],probe['barrier'],probe['observation_errors']),('LIVE',None,['ready.json']))
     second.process.terminate();second.process.wait(timeout=5);save(second.identity.with_suffix('.terminal.json'),dict(second.row,supervisor_joined=True))
     joined=machine_control(api,mid,dict(abort,release_id='e'*32));self.assertEqual(joined['state'],'JOINED');self.assertEqual(json.loads((second.barrier/'abort.json').read_text())['release_id'],rid)
     with self.assertRaises(ValueError):machine_control(api,mid,dict(base(first),action='KILL'))
     (Path(d)/'legacy').mkdir();legacy=self.Supervisor(Path(d)/'legacy',mid,sharded=False)
     try:
      probe=machine_control(api,mid,dict(base(legacy),action='PROBE'));self.assertEqual(set(probe),{'state','identity','identity_sha256'},'legacy ACK unchanged')
      with self.assertRaises(ValueError):machine_control(api,mid,dict(base(legacy),action='RELEASE',release_id=rid,reason='no barrier'))
      self.assertFalse(legacy.barrier.exists())
     finally:legacy.close()
    finally:first.close();second.close()
  def test_shard_status_and_global_delivery_with_fake_api(self):
   with tempfile.TemporaryDirectory()as d:
    root=Path(d);mid='1234567890abcd';api=self.ExecAPI(mid);sup=self.Supervisor(root,mid);out=root/'out';out.mkdir(mode=0o700)
    try:
     base=dict(machine=mid,source_ref='a'*40,epoch=1,identity_path=str(sup.identity));ready=dict(schema='campaign-external-barrier-ready-v1',status='ready')
     (sup.barrier/'ready.json').write_text(json.dumps(ready));probe=machine_control(api,mid,dict(base,action='PROBE'));shard_status(out,probe,mid)
     status=json.loads(read(out/'shard-status.json'));self.assertEqual({k:status[k] for k in ('schema','state','barrier','infra','machine')},dict(schema='original600-shard-status-v1',state='LIVE',barrier=ready,infra=None,machine=mid))
     shard_status(out,dict(probe,barrier=None),mid);self.assertIsNone(json.loads(read(out/'shard-status.json'))['barrier']);self.assertEqual([x.name for x in out.iterdir()],['shard-status.json'])
     progress=dict(combos=[['running',None,None,3],['passed','PASSED',False,2]],jobs=5,terminal_attempts=2,infra_attempts=0,reasons=[['AGENT FAIL','Timeout after 480s',1]])
     save(sup.identity.with_suffix('.infra.json'),dict(schema='original600-shard-infra-v1',infra_true=0,unique_jobs=5,observed_at=3.0,progress=progress))
     shard_status(out,machine_control(api,mid,dict(base,action='PROBE')),mid)
     self.assertEqual(json.loads(read(out/'shard-status.json'))['infra']['progress'],progress,'live scorecard counters reach shard-status.json')
     delivery={};calls=len(api.calls);deliver_global(api,mid,base,out,probe,delivery,False);self.assertEqual(len(api.calls),calls)
     (out/'global-release.json').write_text('{"release_id":');(out/'global-release.json').chmod(0o600);deliver_global(api,mid,base,out,probe,delivery,False);self.assertEqual(len(api.calls),calls)
     rid='a'*32;(out/'global-release.json').write_text(json.dumps(dict(release_id=rid,reason='all 20 shards ready')))
     deliver_global(api,mid,base,out,probe,delivery,True);self.assertEqual(len(api.calls),calls,'a stopping owner releases no new work')
     api.fail=1;deliver_global(api,mid,base,out,probe,delivery,False);self.assertEqual(json.loads(read(out/'global-release.pending.json'))['error'],'TimeoutError')
     deliver_global(api,mid,base,out,probe,delivery,False);self.assertEqual(len(api.calls),calls+1,'retry waits for the bounded spacing')
     delivery['release']=0;deliver_global(api,mid,base,out,probe,delivery,False);ack=json.loads(read(out/'global-release.ack.json'))
     self.assertEqual((ack['state'],ack['release_id'],ack['attempts']),('RELEASED',rid,2));self.assertEqual(json.loads((sup.barrier/'release.json').read_text())['release_id'],rid)
     calls=len(api.calls);delivery['release']=0;deliver_global(api,mid,base,out,probe,delivery,False);self.assertEqual(len(api.calls),calls,'ACK ends delivery')
     (out/'global-abort.json').write_text(json.dumps(dict(release_id='b'*32,reason='late failure')));(out/'global-abort.json').chmod(0o600)
     deliver_global(api,mid,base,out,probe,delivery,True);self.assertEqual(json.loads(read(out/'global-abort.refused.json'))['state'],'REFUSED')
     self.assertFalse((sup.barrier/'abort.json').exists());self.assertIsNone(sup.process.poll(),'release/abort never signal the supervisor')
     (out/'global-abort.refused.json').unlink();calls=len(api.calls);deliver_global(api,mid,base,out,dict(state='JOINED'),delivery,False)
     self.assertEqual(len(api.calls),calls);self.assertEqual(json.loads(read(out/'global-abort.undelivered.json'))['supervisor_state'],'JOINED')
    finally:sup.close()
 suite=unittest.defaultTestLoader.loadTestsFromTestCase(Tests);result=unittest.TextTestRunner().run(suite);return 0 if result.wasSuccessful()else 1
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--self-test',action='store_true');p.add_argument('--config',type=Path);p.add_argument('--config-sha256');p.add_argument('--output',type=Path)
 p.add_argument('--adopt-live',type=Path,help='re-adopt observation/stop authority for a live shard output whose runner and gate died')
 p.add_argument('--workspace',type=Path,default=Path(__file__).absolute().parents[1],help='checkout whose env files resolve the Fly credential')
 args=p.parse_args()
 if args.self_test:raise SystemExit(self_test())
 if args.adopt_live:raise SystemExit(adopt_cli(args.adopt_live,args.workspace))
 need(args.config and args.config_sha256 and args.output,'explicit root config/hash/new output required');raise SystemExit(run(args.config,args.config_sha256,args.output))
