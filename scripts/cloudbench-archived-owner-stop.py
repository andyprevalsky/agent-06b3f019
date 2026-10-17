#!/usr/bin/env python3
"""Stop only archived exact-owned guests after their disposable controller joined.

Default prepares an immutable plan from supplied evidence; --execute sends at
most one stop per identity. Never deletes, edits config, detaches volumes,
releases ownership, or certifies benchmark/guest/provider-session cleanup.
"""
import argparse
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import re
import runpy
import stat
import tarfile
import time

HERE = Path(__file__).resolve().parent
BASE = runpy.run_path(str(HERE/'cloudbench-stop-all.py'))
need, save, until, call, same_machine = (BASE[k] for k in ('need','save','until','call','same_machine'))


def raw(path, limit=16*1024*1024):
    path=Path(path).absolute()
    need(path.resolve(strict=True)==path, 'physical input required')
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
        s=os.fstat(f.fileno())
        need(stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and not s.st_mode&0o077 and s.st_size<=limit,
             'private regular current-owner input required')
        data=f.read(limit+1)
    need(len(data)<=limit,'oversized input')
    return data


def sha(data): return hashlib.sha256(data).hexdigest()
def obj(path): return json.loads(raw(path))
def digest_file(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1048576),b''): h.update(block)
    return h.hexdigest()

def fields(data):
    pairs=[line.split('=',1) for line in data.decode().splitlines()]
    need(all(len(p)==2 for p in pairs),'invalid ownership fields')
    value=dict(pairs);need(len(value)==len(pairs),'duplicate ownership fields')
    return value


def prepare(run, inventory_path):
    run=Path(run).absolute(); export=run/'export'
    terminal=obj(run/'terminal.json'); intent=obj(run/'cleanup-call.intent.json')
    authority=obj(run/'authority.private.json'); verified=obj(export/'disposable-export.verified.json')
    manifest=obj(export/'manifest.json'); record=obj(export/'launch.json')
    app=record['app']; host=record['machine_id']
    need(app=='navi-whisper-lux-bench' and record['host']==host,'original app/controller mismatch')
    need(terminal['status']=='CONTROLLER_RELEASE_VERIFIED' and terminal['machine']==host
         and terminal['source_ref']==record['source_ref'] and terminal['release']['machine_deleted'] is True,
         'joined released original controller required')
    need(intent['gate_joined'] is True and intent['supervisor_joined'] is True and intent['machine']==host
         and intent['export_verified_file']==sha(raw(export/'disposable-export.verified.json')),'joined export receipt mismatch')
    need(verified['machine_id']==host and verified['authority_sha256']==sha(raw(run/'authority.private.json')),
         'export authority mismatch')
    need(authority['app']==app and authority['source_ref']==record['source_ref'],'source authority mismatch')
    protected=set(authority['protected_machines']); protected_volumes=set(authority['protected_volumes'])
    need(len(protected)>=4 and host not in protected,'explicit protected cohort required')
    need(manifest['version']==1 and manifest['resource_release_verified'] is False and manifest['record']==record,
         'original archive manifest mismatch')
    for name,digest in verified['files'].items():
        need(name in ('caller.json','launch.json','manifest.json','originals.tar.gz'),'unexpected export receipt key')
        need(digest_file(export/name)==digest,'verified export artifact changed')
    need(set(verified['files'])=={'caller.json','launch.json','manifest.json','originals.tar.gz'},'incomplete export receipt')
    need(digest_file(export/'originals.tar.gz')==manifest['archive_sha256'],'archive digest mismatch')
    selected={}; seen=set(); joined=False
    # Never extract paths from the archive; read only hash-bound regular records.
    with tarfile.open(export/'originals.tar.gz','r:gz') as archive:
        for member in archive:
            need(member.name not in seen and not member.name.startswith('/') and '..' not in Path(member.name).parts,
                 'unsafe archive membership')
            seen.add(member.name)
            wanted=(re.fullmatch(r'git-common/cloudbench-fleet-ownership/[0-9a-f]{32}/(?:meta|clones/[^/]+)',member.name)
                    or member.name.startswith('context/original600-supervisor.') and member.name.endswith('.terminal.json'))
            if not wanted: continue
            expected=manifest['files'].get(member.name,{})
            need(member.isfile() and member.size<=1048576 and expected.get('kind')=='file'
                 and expected.get('bytes')==member.size,'unsafe archived ownership record')
            data=archive.extractfile(member).read(1048577)
            need(sha(data)==expected['sha256'],'archived ownership bytes changed')
            if '/cloudbench-fleet-ownership/' in member.name:
                selected[member.name]=fields(data)
            else:
                proof=json.loads(data)
                need(proof['machine']==host and proof['source_ref']==record['source_ref']
                     and proof['supervisor_joined'] is True and proof['parent_joined'] is True,
                     'archived original supervisor not joined')
                joined=True
    need(joined and seen==set(manifest['files']),'archive membership/join proof incomplete')
    owned={}; skipped=0
    for name,row in selected.items():
        match=re.fullmatch(r'(git-common/cloudbench-fleet-ownership/([0-9a-f]{32}))/clones/([^/]+)',name)
        if not match: continue
        meta=selected.get(match[1]+'/meta',{})
        need(meta.get('host')==host and meta.get('app')==app and meta.get('fleet_owner_token')==match[2],
             'archived registry host/app/token mismatch')
        need(meta.get('cleanup_policy') in ('retain','reap'),'unknown archived cleanup policy')
        if not row.get('id'):
            skipped+=1; continue  # Unsealed create intent is never a target.
        need(set(row)=={'name','id','volume_id'} and row['name']==match[3]
             and re.fullmatch('[0-9a-f]{8,32}',row['id']) and row['volume_id'].startswith('vol_'),
             'unsafe sealed clone identity')
        need(row['id'] not in protected and row['volume_id'] not in protected_volumes,'protected archived resource')
        need(row['id'] not in owned,'duplicate archived machine identity')
        owned[row['id']]=dict(row,owner_token=match[2],archive_path=name)
    native=BASE['inventory'](json.loads(raw(inventory_path,256*1024*1024))); targets=[]
    for machine in native:
        mid=machine['id']
        if mid in protected: continue
        need(mid in owned,'unowned nonprotected native Machine; refusing whole plan')
        row=owned[mid]; config=machine.get('config')
        need(machine.get('name')==row['name'] and isinstance(machine.get('instance_id'),str)
             and bool(machine['instance_id']) and isinstance(machine.get('created_at'),str)
             and bool(machine['created_at']) and isinstance(config,dict),'native identity/config incomplete')
        need([v.get('volume') for v in config.get('mounts',[])]==[row['volume_id']], 'native owned volume mismatch')
        targets.append(dict(machine=machine,ownership=row))
    need(protected<={m['id'] for m in native},'protected native cohort missing')
    paths=[run/'terminal.json',run/'cleanup-call.intent.json',run/'authority.private.json',
           export/'disposable-export.verified.json',export/'manifest.json',export/'launch.json',export/'originals.tar.gz',Path(inventory_path).absolute()]
    return dict(schema='cloudbench-archived-owner-stop-plan-v1',app=app,controller=host,
                source_ref=record['source_ref'],protected_machines=sorted(protected),
                protected_volumes=sorted(protected_volumes),inputs={str(p):digest_file(p) for p in paths},
                targets=targets,unsealed_intents_skipped=skipped,no_delete=True,no_volume_change=True,
                no_claim_release=True,benchmark_success_inferred=False)


def reconcile(api,row,out,end):
    # Resume is observation ONLY, even if the previous POST response was lost.
    current=call(api,'GET','/machines/'+row['id'],end)
    same_machine(row,current)
    return dict(machine=row['id'],status='STOPPED_CONFIRMED' if current.get('state')=='stopped' else 'PENDING',
                stop_attempted=(out/'stop-intent.json').exists(),observation_only=True)


def stop_owned(api,row,output,end):
    mid=row['id']; out=output/mid
    try:
        with until(end):
            if out.exists(): return reconcile(api,row,out,end)
            current=call(api,'GET','/machines/'+mid,end)
            same_machine(row,current)
            need(current.get('created_at')==row['created_at'],'Machine creation identity changed')
            save(output/(mid+'.exact-before.json'),current)
            if current.get('state')=='stopped':
                out.mkdir(mode=0o700)
                value=dict(machine=mid,status='STOPPED_CONFIRMED',stop_attempted=False)
                save(out/'terminal.json',value); return value
            need(current.get('state') in BASE['ACTIVE'],'native Machine not stoppable')
            BASE['stop_one'](api,current,out,end)
            return json.loads(raw(out/'terminal.json'))
    except Exception as error:
        return dict(machine=mid,status='PENDING',error=type(error).__name__)


def execute(api,plan,output,seconds=300,workers=16):
    need(60<=seconds<=1800 and 1<=workers<=16,'invalid bounded stop limits')
    need(plan.get('schema')=='cloudbench-archived-owner-stop-plan-v1','wrong plan')
    for path,digest in plan['inputs'].items(): need(digest_file(path)==digest,'original plan input changed')
    protected=set(plan['protected_machines'])
    rows=[t['machine'] for t in plan['targets']]
    need(len({r['id'] for r in rows})==len(rows) and not protected&{r['id'] for r in rows},'protected/duplicate target')
    end=time.monotonic()+seconds; children=[]; pending=list(rows); context=multiprocessing.get_context('fork')
    try:
        with until(end):
            while pending or children:
                for child in list(children):
                    if not child.is_alive(): child.join(); children.remove(child)
                while pending and len(children)<workers and time.monotonic()<end-20:
                    row=pending.pop(0)
                    child=context.Process(target=stop_owned,args=(api,row,output,min(end-20,time.monotonic()+65)))
                    child.start(); children.append(child)
                if not children: break
                time.sleep(.02)
            # One final app read is safe on this outside operator; never fan
            # out another serial247-call phase beyond the original deadline.
            final={}; final_error=None
            try:
                with until(end-1):
                    final={r['id']:r for r in BASE['inventory'](call(api,'GET','/machines',end-1))}
            except Exception as error:
                final_error=type(error).__name__
            results=[]
            for row in rows:
                value=dict(machine=row['id'],status='PENDING',error=final_error or 'unverified final identity')
                try:
                    current=final[row['id']]
                    same_machine(row,current)
                    need(current.get('created_at')==row['created_at'],'final creation identity changed')
                    need(current.get('state')=='stopped','final state not stopped')
                    value=dict(machine=row['id'],status='STOPPED_CONFIRMED',
                               stop_attempted=(output/row['id']/'stop-intent.json').exists())
                except Exception:
                    pass
                results.append(value)
            summary=dict(schema='cloudbench-archived-owner-stop-observation-v1',results=results,
                         all_owned_stopped=all(v['status']=='STOPPED_CONFIRMED' for v in results),
                         no_delete=True,volumes_retained=True,claims_released=False,benchmark_success_inferred=False)
            save(output/('observation-'+str(time.time_ns())+'.json'),summary)
            return summary
    finally:
        for child in children: child.join()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run-dir',type=Path,required=True);p.add_argument('--inventory',type=Path,required=True)
    p.add_argument('--out-dir',type=Path,required=True);p.add_argument('--execute',action='store_true')
    p.add_argument('--agents-env',type=Path);p.add_argument('--timeout',type=int,default=300)
    p.add_argument('--workers',type=int,default=16);a=p.parse_args();os.umask(0o077)
    output=a.out_dir.absolute();need(output.parent.resolve(strict=True)==output.parent,'physical output parent required')
    plan=prepare(a.run_dir,a.inventory)
    if output.exists():
        need(output.is_dir() and not output.is_symlink() and output.stat().st_uid==os.getuid()
             and not output.stat().st_mode&0o077,'private output directory required')
        need(json.loads(raw(output/'plan.json',256*1024*1024))==plan,'existing exact plan changed')
    else: output.mkdir(mode=0o700);save(output/'plan.json',plan)
    if not a.execute:
        print(json.dumps(dict(status='PLANNED_NOT_STOPPED',targets=len(plan['targets']),provider_calls=0)));return 0
    need(a.agents_env is not None,'explicit complete agents env required')
    operator=runpy.run_path(str(HERE/'run-original600-controller.py'))
    helper=runpy.run_path(str(HERE/'cloudbench-original-volume-capture.py'))
    with until(time.monotonic()+a.timeout):
        api=helper['Fly'](plan['app'],operator['token_from_agents'](raw(a.agents_env)))
        result=execute(api,plan,output,a.timeout,a.workers)
    print(json.dumps(dict(all_owned_stopped=result['all_owned_stopped'],targets=len(result['results']),
                         volumes_retained=True,claims_released=False)))
    return 0 if result['all_owned_stopped'] else 1


if __name__=='__main__': raise SystemExit(main())
