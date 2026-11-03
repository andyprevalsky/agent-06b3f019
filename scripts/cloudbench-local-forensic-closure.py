#!/usr/bin/env python3
"""GET-only physical observation for a dead local disposable owner; no ACK/release."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import socket
import stat
import subprocess
import time

HERE=Path(__file__).resolve().parent
F=runpy.run_path(str(HERE/'cloudbench-forensic-resource-closure.py'))
C=runpy.run_path(str(HERE/'cloudbench-original-volume-capture.py'))
need=F['need']
SCHEMA='cloudbench-local-forensic-observation-v1'


def physical(path, directory=False):
    path=Path(path).absolute()
    info=path.lstat()
    need(path.resolve(strict=True)==path and not path.is_symlink()
         and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
         and info.st_uid==os.getuid(), 'unsafe local custody path')
    return path


def read(path, maximum=1048576):
    path=physical(path)
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        before=os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=maximum,'unsafe local custody file')
        data=os.read(fd,before.st_size+1)
        after=os.fstat(fd);current=path.lstat()
        identity=lambda st:(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)
        need(len(data)==before.st_size and identity(before)==identity(after)==identity(current),'local custody file changed')
        return data
    finally:os.close(fd)


def prepare(registry, source):
    registry=physical(registry,True);owner=registry.name
    need(re.fullmatch('[0-9a-f]{32}',owner) and re.fullmatch('[0-9a-f]{40}',source),'exact owner/source required')
    meta=F['S']['fields'](read(registry/'meta'))
    root=physical(meta['workspace_root'],True)
    common_raw=subprocess.check_output(['git','-C',str(root),'rev-parse','--git-common-dir'],text=True).strip()
    common=physical(root/common_raw if not Path(common_raw).is_absolute() else common_raw,True)
    need(registry==common/'cloudbench-fleet-ownership'/owner,'foreign ownership namespace')
    subprocess.check_call(['git','-C',str(root),'cat-file','-e',source+'^{commit}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    observer_source=subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()
    need(meta.get('host')==socket.gethostname() and C['pid_birth_state'](meta.get('pid',''),meta.get('pid_start',''))=='absent','owner is not proven dead on this host')
    audit=physical(meta['audit_dir'],True);run=physical(Path(meta['runs_root'])/meta['run_id'],True)
    need(audit==common/'cloudbench-fleet-audits'/owner and Path(meta['runs_root'])==root/'.context/fleet/runs','foreign audit/run namespace')
    need(not os.path.lexists(registry/'recovery-lock') and not os.path.lexists(registry/'cold-handoff-outgoing'),'active recovery/handoff custody')
    files={};membership={};selected={}
    for name in ('cloudbench-local-forensic-closure.py','cloudbench-forensic-resource-closure.py','cloudbench-archived-owner-stop.py','cloudbench-original-volume-capture.py'):
        path=HERE/name;files[str(path)]=F['sha'](read(path))
    for base in (registry,audit,common/'cloudbench-native-effect-fences'/owner):
        base=physical(base,True)
        membership[str(base)]=[]
        for path in sorted(base.rglob('*')):
            physical(path,path.is_dir())
            relative=str(path.relative_to(base));membership[str(base)].append(relative)
            if path.is_file():
                payload=read(path);files[str(path)]=F['sha'](payload)
                key='git-common/'+str(path.relative_to(common));selected[key]=payload
    def record(path):
        data=read(path);files[str(path)]=F['sha'](data);return json.loads(data)
    lifecycle=record(run/'_batch/lifecycle.json')
    need(lifecycle.get('status')=='failed' and lifecycle.get('fleet_owner_token')==owner
         and lifecycle.get('run_id')==meta['run_id'] and type(lifecycle.get('controller_exit_code')) is int
         and lifecycle['controller_exit_code']!=0 and lifecycle.get('audit_sha256')=='','original failed lifecycle required')
    provenance=record(run/'execution-provenance.json')
    stale=provenance.get('config',{}).get('values',{}).get('inventory_max_stale_seconds')
    need(isinstance(stale,str) and stale.isdigit() and 0<int(stale)<=600,'invalid original inventory freshness bound')
    need(provenance.get('base_sha')==source and provenance.get('workspace_patch_sha256')=='none','original source differs')
    tasks=record(run/'_batch/benches.json')
    matrix=record(run/'execution-task-matrix.json')
    need(isinstance(tasks,list) and tasks and all(isinstance(t,dict) and isinstance(t.get('name'),str) for t in tasks),'invalid original tasks')
    names=[t['name'] for t in tasks]
    need(len(names)==len(set(names)) and all(re.fullmatch('[A-Za-z0-9_-]+',n) for n in names),'invalid original task names')
    need([t['name'] for t in matrix['tasks']]==names,'original task matrix differs')
    cleanup=record(run/'_batch/disposable-cleanup.json')
    need(not os.path.lexists(audit/'provider-teardown-verified.epoch') and not os.path.lexists(run/'teardown-ownership'),'original owner already sealed')
    sources={F['S']['fields'](value)['source_machine_id'] for name,value in selected.items() if '/expected-fresh/' in name}
    need(bool(sources) and all(re.fullmatch('[0-9a-f]{14}',v) for v in sources),'missing original source identity')
    template=dict(app=meta['app'],controller=meta['host'],protected_machines=sorted(sources),protected_volumes=[])
    bound=F['_disposable_bindings'](template,selected,owner,cleanup)
    known={row['machine'] for row in bound['resources']}
    for name in names:
        path=run/name/'.cid';data=read(path);files[str(path)]=F['sha'](data)
        cid=data.decode().split()
        need(len(cid)==2 and cid[0]=='clone' and cid[1] in known,'unbound original task Machine')
    need(all(row['machine_identity'] and row['volume_identity'] for row in bound['resources']),'original resource incarnation proof required')
    # Full typed original tuples, not a caller-provided current inventory.
    return dict(schema='cloudbench-local-forensic-plan-v1',registry=str(registry),source_ref=source,observer_source=observer_source,
                owner=owner,run_id=meta['run_id'],app=meta['app'],resources=bound['resources'],inputs=files,
                membership=membership,max_age_seconds=int(stale),historical_cleanup=cleanup,historical_policy=meta['cleanup_policy'],
                original_lifecycle=lifecycle)


@contextmanager
def custody(registry):
    registry=physical(registry,True)
    guards=registry.parent.parent/'cloudbench-fleet-recovery-locks'
    guards.mkdir(mode=0o700,exist_ok=True);physical(guards,True)
    path=guards/registry.name
    fd=os.open(path,os.O_CREAT|os.O_RDONLY|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==os.getuid(),'unsafe recovery guard')
        fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
        now=path.lstat();need((now.st_dev,now.st_ino)==(info.st_dev,info.st_ino),'recovery guard replaced')
        yield
    finally:os.close(fd)


def _observe(registry, source, api, output, publication):
    with custody(registry):
        plan=prepare(registry,source)
        collection_started=time.time()
        wire=[F['_authority'](api,plan['app'])];terminal=[]
        for row in plan['resources']:
            for subject in (dict(kind='machines',id=row['machine'],terminal_delete=True,identity=row['machine_identity']),
                            dict(kind='volumes',id=row['volume'],terminal_delete=True,identity=row['volume_identity'],original_machine=row['machine'])):
                result=F['_observe_terminal'](api,subject,output);terminal.append(result);wire.append(result['wire'])
        need(prepare(registry,source)==plan,'original custody changed during observation')
        need(0<=time.time()-collection_started<=plan['max_age_seconds'],'collection exceeded original freshness bound')
        receipt=dict(schema=SCHEMA,plan=plan,wire=wire,observed_at=collection_started,provider_base=api.base,
                     physical_resources_terminal=True,physical_resources_absent=all(r['disposition']=='ABSENT' for r in terminal),
                     runtime_sealed=False,claims_released=False,guest_cleanup_confirmed=False,
                     original_release_epoch=None,benchmark_success_inferred=False)
        return F['_append'](output,'local-forensic-observation-',receipt,publication=publication)



def observe(registry, source, api, output):
    publication=F['Publication']()
    try:
        with F['S']['until'](time.monotonic()+300):
            result=_observe(registry,source,api,output,publication)
    except BaseException:
        F['rollback_publication'](publication)
        raise
    F['commit_publication'](publication)
    return result


def verify(receipt):
    receipt=physical(receipt);need(not receipt.stat().st_mode & 0o077,'private observation required');encoded=read(receipt,64*1048576);value=json.loads(encoded)
    need(receipt.name=='local-forensic-observation-'+F['sha'](encoded)+'.json' and value.get('schema')==SCHEMA,'receipt identity differs')
    plan=value['plan']
    with custody(Path(plan['registry'])):
        need(prepare(Path(plan['registry']),plan['source_ref'])==plan,'original custody changed')
        age=value.get('observed_at')
        need(type(age) in (int,float) and 0<=time.time()-age<=plan['max_age_seconds'],'stale/future observation')
        wire=value['wire'];need(len(wire)==1+2*len(plan['resources']),'incomplete original scope')
        app=wire[0]
        need(set(app)=={'method','path','status','body_b64'} and app['method']=='GET' and app['path']=='' and app['status']==200 and F['_body'](app).get('name')==plan['app'],'app authority differs')
        expected=[]
        for row in plan['resources']:
            expected.extend((dict(kind='machines',id=row['machine'],terminal_delete=True,identity=row['machine_identity']),
                             dict(kind='volumes',id=row['volume'],terminal_delete=True,identity=row['volume_identity'],original_machine=row['machine'])))
        terminal=[F['_terminal'](item,subject) for item,subject in zip(wire[1:],expected)]
        need(value.get('provider_base')=='https://api.machines.dev' and value.get('physical_resources_terminal') is True,'provider/scope differs')
        need(type(value.get('physical_resources_absent')) is bool and value['physical_resources_absent']==all(r['disposition']=='ABSENT' for r in terminal),'absence claim differs')
        need(all(value.get(k) is False for k in ('runtime_sealed','claims_released','guest_cleanup_confirmed','benchmark_success_inferred')) and value.get('original_release_epoch') is None,'historical credit forbidden')
    return dict(status='HISTORICAL_NATIVE_OWNERSHIP_PHYSICALLY_TERMINAL',owner=plan['owner'],resources=len(expected),
                claims_released=False,guest_cleanup_confirmed=False,external_provider_readiness='UNMEASURED')

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--registry',type=Path);p.add_argument('--source')
    p.add_argument('--out-dir',type=Path);p.add_argument('--execute',action='store_true');p.add_argument('--verify-receipt',type=Path)
    p.add_argument('--agents-env',type=Path)
    args=p.parse_args();os.umask(0o077)
    if args.verify_receipt:
        need(not args.execute and not args.registry and not args.source and not args.out_dir and not args.agents_env,'mixed verification authority')
        print(json.dumps(verify(args.verify_receipt)));return
    need(args.registry is not None and args.source is not None,'registry and original source required')
    with custody(args.registry):plan=prepare(args.registry,args.source)
    if not args.execute:
        print(json.dumps(dict(status='PLANNED_ONLY',owner=plan['owner'],resources=len(plan['resources'])*2,provider_calls=0)));return
    need(args.agents_env is not None,'explicit complete credential file required')
    operator=runpy.run_path(str(HERE/'run-original600-controller.py'))
    api=C['Fly'](plan['app'],operator['token_from_agents'](read(args.agents_env)))
    need(args.out_dir is not None,'private output directory required')
    receipt=observe(args.registry,args.source,api,args.out_dir)
    print(json.dumps(dict(status='LOCAL_PHYSICAL_TERMINAL_OBSERVED',receipt=str(receipt),claims_released=False)))

if __name__=='__main__':main()
