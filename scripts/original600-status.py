#!/usr/bin/env python3
"""One bounded read-only status capture for an explicitly bound original600 run."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shlex
import subprocess
import time

HERE=Path(__file__).resolve().parent
RUNNER=runpy.run_path(str(HERE/'cloudbench-original600-runner.py'))
need,read,save,bounded=(RUNNER[k] for k in ('need','read','save','bounded'))

# This payload reads ONE exact supervisor-derived summary; it never walks the
# campaign directories, signals a process, writes a guest file or starts work.
REMOTE=r'''
import hashlib,json,os,stat,subprocess,sys,time
from pathlib import Path

def read_json(path):
    if path.parent.resolve(strict=True)!=path.parent:raise ValueError('unsafe status parent path')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size>16*1024*1024:
            raise ValueError('unsafe bounded status input')
        return json.loads(stream.read(info.st_size+1))

def project(summary):
    jobs=summary['jobs']
    if not isinstance(jobs,list) or type(summary.get('total_jobs')) is not int or summary['total_jobs']!=600 or len(jobs)!=600:
        raise ValueError('invalid original600 canonical jobs')
    statuses={};infra=set();unknown_infra=set();attempts=0;terminal=0;unknown_failures=0;unknown_attempts=0;seen=set()
    for job in jobs:
        ident=job['job_id']
        if not isinstance(ident,str) or ident in seen:raise ValueError('duplicate canonical job')
        seen.add(ident)
        status=job.get('status','UNKNOWN')
        if status not in ('queued','pending','running','passed','failed','cancelled'):status='UNKNOWN'
        statuses[status]=statuses.get(status,0)+1
        records=job.get('attempts',[])
        if not isinstance(records,list):raise ValueError('invalid canonical attempts')
        terminal_for_job=0
        for attempt in records:
            attempts+=1
            if attempt.get('infra_failure') is True:infra.add(ident)
            if attempt.get('status') in ('passed','failed') and attempt.get('finished_at'):
                terminal+=1;terminal_for_job+=1
                if type(attempt.get('infra_failure')) is not bool:
                    unknown_attempts+=1;unknown_infra.add(ident)
        if status=='failed' and not terminal_for_job:unknown_failures+=1
    value=dict(job_statuses=statuses,attempt_records=attempts,terminal_attempts=terminal,
               canonical_infra_affected_jobs=len(infra),failed_jobs_without_terminal_attempt=unknown_failures,
               terminal_attempt_records_with_unknown_infra=unknown_attempts,
               jobs_with_unknown_terminal_infra=len(unknown_infra-infra),
               observed_jobs=len(jobs),benchmark_success_inferred=False)
    for key in ('campaign_id','total_jobs','startup_cohorts','finished_at','started_at'):
        if key in summary:value[key]=summary[key]
    return value

def guest_status(payload,repo,boot_id):
    if os.environ.get('FLY_MACHINE_ID')!=payload['machine']:raise ValueError('guest Machine mismatch')
    actual=subprocess.check_output(['git','-c','safe.directory='+str(repo),'-C',str(repo),'rev-parse','HEAD'],text=True,timeout=3).strip()
    if actual!=payload['source_ref']:raise ValueError('guest source mismatch')
    identity_path=Path(payload['identity_path'])
    if str(identity_path.parent)!='/tmp/gate/repo/.context' or not identity_path.name.startswith('original600-supervisor.') or not identity_path.name.endswith('.json'):
        raise ValueError('unsafe exact supervisor path')
    base=dict(machine=payload['machine'],source_ref=payload['source_ref'],original_epoch=payload['epoch'],observed_epoch=time.time())
    try:identity=read_json(repo/'.context'/identity_path.name)
    except FileNotFoundError:return dict(base,status='SUPERVISOR_NOT_PUBLISHED')
    if identity.get('schema')!='original600-supervisor-identity-v1' or identity.get('machine')!=payload['machine'] or identity.get('source_ref')!=payload['source_ref'] or identity.get('epoch')!=payload['epoch']:
        raise ValueError('supervisor source/epoch/Machine mismatch')
    pid=identity['pid']
    if type(pid)is not int or pid<=1:raise ValueError('unsafe supervisor PID')
    namespace=hashlib.sha256((float(payload['epoch']).hex()+':'+boot_id).encode()).hexdigest()[:24]
    campaign='campaign-qualified600-'+namespace+'-'+str(pid)
    path=repo/'.context/benchmarks/campaigns'/campaign/'summary.json'
    try:summary=read_json(path)
    except FileNotFoundError:return dict(base,status='SUMMARY_NOT_PUBLISHED',campaign_id=campaign)
    if summary.get('campaign_id')!=campaign or summary.get('e2e_started_at_epoch')!=payload['epoch']:
        raise ValueError('canonical campaign/original epoch mismatch')
    return dict(base,status='SUMMARY',summary=project(summary))

if __name__=='__main__':
    payload=json.loads(base64.b64decode(sys.argv[1]))
    try:
        result=guest_status(payload,Path('/tmp/gate/repo'),Path('/proc/sys/kernel/random/boot_id').read_text().strip())
    except Exception as error:
        result=dict(status='UNKNOWN',machine=payload['machine'],source_ref=payload['source_ref'],
                    original_epoch=payload['epoch'],error=type(error).__name__)
    print(json.dumps(result,sort_keys=True,allow_nan=False))
'''


def obj(path):return json.loads(read(path))
def digest(data):return hashlib.sha256(data).hexdigest()


def bound_source(root,ref,name,expected):
    path=root/'scripts'/name
    raw=subprocess.check_output(['git','--no-replace-objects','-C',str(root),'show',ref+':scripts/'+name])
    need(digest(raw)==expected,'configured source digest changed: '+name)
    need(path.read_bytes()==raw,'selected source bytes changed: '+name)
    scope={'__name__':'original600_status_bound_source','__file__':str(path)}
    exec(compile(raw,str(path),'exec'),scope)
    return scope


def binding(run,config=None,agents_env=None):
    run=Path(run).absolute();need(run.resolve(strict=True)==run,'physical run directory required')
    config=Path(config).absolute() if config else run.parent/'config.private.json'
    cfg=obj(config);auth=obj(run/'authority.private.json')
    need(cfg.get('schema')=='original600-controller-runner-v1' and cfg.get('allowed') is True,'original run config required')
    ref=cfg['source_ref'];need(re.fullmatch('[0-9a-f]{40}',ref),'exact source ref required')
    need(auth['source_ref']==ref and auth['app']=='navi-whisper-lux-bench','authority/source mismatch')
    need(Path(auth['output_directory'])==run/'export','authority output directory mismatch')
    start=run.parent/'attempt-start.safe.json'
    if start.exists():
        recorded=obj(start)
        need(recorded['source_ref']==ref and recorded['config_sha256']==digest(read(config)),'original config receipt changed')
    terminal=run/'terminal.json'
    if terminal.exists():
        value=obj(terminal);need(value['source_ref']==ref,'terminal source mismatch')
        return dict(mode='LOCAL_TERMINAL',terminal=value,run_directory=str(run),source_ref=ref)
    identity_path=run/'controller.identity.json'
    if not identity_path.exists():return dict(mode='CONTROLLER_NOT_PUBLISHED',run_directory=str(run),source_ref=ref)
    identity=obj(identity_path);caller=obj(run/'caller.json')
    need(identity['source_ref']==caller['source_ref']==ref,'caller/controller source mismatch')
    authority_sha=digest(read(run/'authority.private.json'))
    sealed=obj(run/'export/disposable-controller.ownership.json')
    need(caller['authority_sha256']==identity.get('authority_sha256')==sealed.get('authority_sha256')==authority_sha,
         'caller/controller/sealed authority changed')
    need(sealed.get('schema')=='cloudbench-disposable-controller-ownership-v1'
         and identity['machine']==sealed['machine']['id']
         and isinstance(identity.get('instance'),str) and identity['instance']
         and identity['instance']==sealed['machine']['instance_id'],'sealed controller Machine/instance changed')
    need(caller['epoch']==cfg['started_at_epoch'],'original epoch mismatch')
    mid=identity['machine'];need(re.fullmatch('[0-9a-f]{14}',mid) and mid not in auth['protected_machines'],'protected/invalid controller')
    root=Path(cfg['source_root']);need(root.resolve(strict=True)==root,'physical source checkout required')
    credential=Path(agents_env).absolute() if agents_env else Path(auth['env_files']['agents']['path'])
    need(digest(read(credential))==auth['env_files']['agents']['sha256'],'selected complete agents input changed')
    return dict(mode='REMOTE',app=auth['app'],machine=mid,source_ref=ref,root=root,
                agents_env=credential,credential_sha256=auth['env_files']['agents']['sha256'],source_files=cfg['source_files'],
                payload=dict(machine=mid,source_ref=ref,epoch=caller['epoch'],identity_path=caller['identity_path']))


def observe(api,value):
    command=shlex.join(['python3','-S','-c',REMOTE,base64.b64encode(json.dumps(value['payload']).encode()).decode()])
    with bounded(25):
        response=api.api('POST','/machines/'+value['machine']+'/exec',dict(cmd=command,timeout=20,machine=True),timeout=20)
        need(isinstance(response,dict),'invalid native exec envelope')
        if response.get('exit_code',0)!=0 or response.get('exit_signal',0)!=0 or response.get('stderr') not in (None,''):
            return dict(status='TRANSPORT_UNKNOWN',machine=value['machine'],source_ref=value['source_ref'],original_epoch=value['payload']['epoch'])
        text=response.get('stdout');need(isinstance(text,str) and len(text.encode())<=1048576,'bounded status projection required')
        result=json.loads(text)
        need(result.get('machine')==value['machine'] and result.get('source_ref')==value['source_ref']
             and result.get('original_epoch')==value['payload']['epoch'],'guest observation identity mismatch')
        need(result.get('status') in ('SUPERVISOR_NOT_PUBLISHED','SUMMARY_NOT_PUBLISHED','SUMMARY','UNKNOWN'),'unknown status schema')
        return result


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run-dir',required=True,type=Path);p.add_argument('--config',type=Path)
    p.add_argument('--agents-env',type=Path);p.add_argument('--out-dir',type=Path)
    a=p.parse_args(argv);os.umask(0o077)
    with bounded(30):
        value=binding(a.run_dir,a.config,a.agents_env)
        if value['mode']!='REMOTE':
            print(json.dumps(dict(value,provider_calls=0,benchmark_success_inferred=False)));return 0
        output=(a.out_dir or a.run_dir).absolute()
        need(output.resolve(strict=True)==output and output.stat().st_uid==os.getuid() and not output.stat().st_mode&0o077,'private observation directory required')
        try:
            # Credential/session setup shares the same bounded observation clock.
            with bounded(25):
                parser=bound_source(value['root'],value['source_ref'],'run-original600-controller.py',value['source_files']['run-original600-controller.py'])
                client=bound_source(value['root'],value['source_ref'],'cloudbench-original-volume-capture.py',value['source_files']['cloudbench-original-volume-capture.py'])
                api=client['Fly'](value['app'],parser['token_from_agents'](read(value['agents_env'])))
                result=observe(api,value)
        except (Exception,RUNNER['Deadline']) as error:
            result=dict(status='TRANSPORT_UNKNOWN',machine=value['machine'],source_ref=value['source_ref'],original_epoch=value['payload']['epoch'],error=type(error).__name__)
        path=output/('original600-status-'+str(time.time_ns())+'.private.json')
        save(path,dict(observation=result,credential_source=str(value['agents_env']),credential_sha256=value['credential_sha256'],
                       source_ref=value['source_ref'],read_only_guest=True,no_signal=True,no_lifecycle_write=True))
    print(json.dumps(dict(result,saved=str(path),benchmark_success_inferred=False)))
    return 0 if result['status']!='TRANSPORT_UNKNOWN' else 1


if __name__=='__main__':raise SystemExit(main())
