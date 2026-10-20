#!/usr/bin/env python3
"""Release only an exact dead owner's never-staged fixed worker claim.
Primary outcomes, latches, runtime evidence and pool proofs are never rewritten.
"""
from pathlib import Path
import argparse,base64,fcntl,json,os,re,runpy,socket,stat
HERE=Path(__file__).resolve().parent
R=runpy.run_path(str(HERE/'cloudbench-staged-probe-recovery.py'))
P=R['P'];H=runpy.run_path(str(HERE/'cloudbench-fixed-native-worker.py'))
need,read,sha=P['need'],P['read'],P['sha'];directory,fields,save,sync=P['directory'],P['fields'],P['save'],P['sync']
MID='86549d6aed9358'
def plan(registry,common,source):
 registry=directory(Path(registry));common=directory(Path(common));meta=fields(registry/'meta');owner=registry.name
 need(re.fullmatch('[0-9a-f]{32}',owner) and meta.get('version')=='2' and meta.get('fleet_owner_token')==owner and meta.get('host')==socket.gethostname() and meta.get('cleanup_policy')=='reap','original owner identity')
 need(P['pid_birth_state'](meta['pid'],meta['pid_start'])=='absent','original owner not dead')
 run=directory(Path(meta['runs_root'])/meta['run_id']);need(Path(meta['workspace_root'])==run.parent.parent.parent.parent,'original run root')
 lifecycle=json.loads(read(run/'_batch/lifecycle.json'));need(lifecycle.get('status')=='failed' and lifecycle.get('fleet_owner_token')==owner and lifecycle.get('run_id')==meta['run_id'] and type(lifecycle.get('controller_exit_code'))is int and lifecycle['controller_exit_code']!=0,'original failed terminal required')
 need(not os.path.lexists(registry/'cold-handoff-outgoing'),'outgoing owner')
 contract=H['H']['sibling']('cloudbench_execution_provenance.py');prov=contract['load_provenance'](run/'execution-provenance.json');matrix=contract['load_task_matrix'](run/'execution-task-matrix.json')
 need(not contract['validate_task_matrix_binding'](prov,matrix) and prov['base_sha']==source,'original source binding')
 values=prov['config']['values'];need(values.get('boot_transport')=='staged' and values.get('worker_qualification_floor')=='2' and all(values.get(k)=='1'for k in ('boot_launch','primary_reuse_only','cold_primary_bootstrap')),'original staged worker qualification')
 need(len(matrix['tasks'])==1 and matrix['tasks'][0]['world_model_mode']=='real','one real qualification task')
 out=directory(run/matrix['tasks'][0]['name']);assignment_path=out/'worker-borrowed'/(MID+'.json');a=json.loads(read(assignment_path));originals={}
 def retain(path):
  raw=read(path);originals[str(path)]=base64.b64encode(raw).decode();return raw
 for path in (registry/'meta',run/'_batch/lifecycle.json',run/'execution-provenance.json',run/'execution-task-matrix.json',assignment_path):retain(path)
 need(re.fullmatch('[0-9a-f]{32}',a.get('claim_owner_token','')),'worker claim token')
 need(a.get('version')==1 and a.get('origin')=='explicit-user-idle-resource' and a.get('historical_task_credit')==0 and a.get('role')=='borrowed-worker' and a.get('machine_id')==MID and a.get('fleet_owner_token')==owner and a.get('run_token')==owner+'-0','original assignment')
 need(retain(out/'.cid').decode().split()==['pool',a['primary_machine_id']],'primary assignment')
 need(json.loads(retain(out/'runtime-evidence.owner.json'))==dict(version=1,machine_id=a['primary_machine_id'],run_token=owner+'-0'),'primary runtime owner')
 pid,birth=retain(out/'autoscaler.pid').decode().strip().split('|');need(P['pid_birth_state'](pid,birth)=='absent','autoscaler not joined')
 need(retain(out/'autoscaler.failed')==b'Existing worker admission is unresolved; ownership retained\n','original admission failure')
 log=retain(out/'autoscaler.log');need(b'resolve_fly_token failed (exit 127)'in log and b'cloudbench-explicit-idle-admission.py'in log,'original prestage failure missing')
 for name in ('worker-clones.ids','worker-ready.ids'):need(retain(out/name)==b'','worker tracked or ready')
 forbidden=[out/'worker-runtime-evidence'/MID]+[out/('worker-'+MID+suffix)for suffix in ('.launch-attempted','.stage.log','.ready','.pid')]+[out/'worker-borrowed'/(MID+suffix)for suffix in ('.returned.json','.released.json')]
 need(not any(os.path.lexists(p)for p in forbidden),'worker runtime or return present')
 attempt=directory(Path(a['admission']));need(attempt.parent==assignment_path.parent and attempt.name.startswith('.admit-'+MID+'.'),'original attempt path')
 need(sorted(p.name for p in assignment_path.parent.iterdir())==sorted([assignment_path.name,attempt.name]),'unexpected borrowed worker artifacts')
 need(sorted(p.name for p in attempt.iterdir())==['verified'] and retain(attempt/'verified')==b'','worker stage attempted')
 proof=Path(a['proof']);need(proof==common/'cloudbench-pool-reuse'/(MID+'.json'),'proof path');pv=json.loads(retain(proof));need(pv['machine_id']==MID and pv['volume_id']==a['volume_id'],'fixed proof identity')
 admission=H['H']['described'](pv['explicit_idle']['admission']);retain(Path(pv['explicit_idle']['admission']['path']));retain(Path(pv['explicit_idle']['completion_path']))
 ledger=Path(a['ledger']);need(ledger==Path(admission['consumer']['pool_ids_file']) and ledger.parent==common/'cloudbench-pools' and MID in retain(ledger).decode().splitlines(),'original ledger')
 baseline=Path(str(ledger)+'.deps');baseline_sha=sha(retain(baseline));claim=common/'cloudbench-pool-claims'/MID;raw=retain(claim)
 original=(f"host={meta['host']}\npid={meta['pid']}\npid_start={meta['pid_start']}\nfleet_owner_token={a['claim_owner_token']}\ncleanup_state=owned\nmachine_id={MID}\nvolume_id={a['volume_id']}\npool_ledger_file={ledger}\npool_meta_file={baseline}\npool_meta_sha256={baseline_sha}\n").encode()
 need(sha(original)==a['claim_sha256'],'original rich claim digest')
 stripped=(f"host={meta['host']}\npid={meta['pid']}\npid_start={meta['pid_start']}\nfleet_owner_token={a['claim_owner_token']}\ncleanup_state=unconfirmed\n").encode();need(raw in (original,stripped),'current claim not exact original or cleanup successor')
 state=common/'cloudbench-explicit-idle'/(MID+'.state.json');need((sha(retain(state))if os.path.lexists(state)else None)==a.get('previous_state_sha256'),'worker state generation changed')
 return dict(schema='unstaged-fixed-worker-recovery-v1',owner=owner,machine=MID,volume=a['volume_id'],source=source,claim=str(claim),claim_sha256=sha(raw),proof=str(proof),originals=originals,forbidden=[str(p)for p in forbidden],assignment=str(assignment_path))
def recover(registry,common,source,native_read,volume_read,guard_fd,pid,birth,checkpoint=lambda stage:None):
 registry=Path(registry);common=Path(common);R['guard'](registry,common,guard_fd,pid,birth);p=plan(registry,common,source)
 lock=common/'cloudbench-pool-claims/.locks'/(MID+'.lock');directory(lock.parent);fd=os.open(lock,os.O_RDWR|os.O_NOFOLLOW)
 try:
  a=os.fstat(fd);b=lock.lstat();need(stat.S_ISREG(a.st_mode)and a.st_nlink==1 and(a.st_dev,a.st_ino)==(b.st_dev,b.st_ino),'exact worker mutex');fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);need(plan(registry,common,source)==p,'originals changed')
  root=registry/('unstaged-worker-recovery-'+MID);root.mkdir(mode=0o700);sync(registry);save(root/'intent.json',dict(owner=p['owner'],machine=MID,source_ref=source))
  before=root/'before.json';after=root/'after.json';volume=root/'volume.json';save(before,native_read(MID));save(volume,volume_read(p['volume']));save(after,native_read(MID))
  H['verify_pool'](p['proof'],common,H['H']['descriptor'](before),H['H']['descriptor'](after),source,json.loads(read(volume)),role='worker')
  archive=dict(plan=p,before=H['H']['descriptor'](before),after=H['H']['descriptor'](after),volume=H['H']['descriptor'](volume),status='NOT_LAUNCHED',runtime_success=False,historical_task_credit=0,real_task_credit=0);save(root/'archive.json',archive);checkpoint('archived')
  need(plan(registry,common,source)==p,'originals changed after archive');R['guard'](registry,common,guard_fd,pid,birth);need(sha(read(p['claim']))==p['claim_sha256'],'claim changed')
  Path(p['claim']).unlink();sync(Path(p['claim']).parent)
  result=dict(status='RECOVERED_NOT_LAUNCHED',owner=p['owner'],machine=MID,archive_sha256=sha(read(root/'archive.json')),runtime_success=False,historical_task_credit=0,real_task_credit=0);save(root/'complete.json',result);return result
 except BaseException as error:
  if 'root' in locals() and root.exists():
   try:save(root/'pending.json',dict(status='PENDING_NO_RETRY',error_class=type(error).__name__))
   except Exception:pass
  raise
 finally:os.close(fd)
def main():
 parser=argparse.ArgumentParser()
 for n in ('registry','common'):parser.add_argument('--'+n,type=Path,required=True)
 for n in ('source','recovery-pid','recovery-birth'):parser.add_argument('--'+n,required=True)
 parser.add_argument('--guard-fd',type=int,required=True);a=parser.parse_args()
 # Reuse the existing bounded recovery driver, replacing only its recovery function.
 ns=R['main'].__globals__;ns['recover']=recover;R['main']()
if __name__=='__main__':main()
