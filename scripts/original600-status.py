#!/usr/bin/env python3
"""One bounded read-only status capture for an explicitly bound original600 run."""
import argparse
import base64
import gzip
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

# This payload reads one exact summary and its explicitly named job logs. It
# never walks directories, signals a process, writes a guest file or starts work.
REMOTE=r'''
import ast,base64,hashlib,json,os,re,stat,subprocess,sys,time
from pathlib import Path

ORIGINAL_TASK_REF='1387ae608e7cfb8e3f0a876daae92093f503b465'

def read_json(path):
    if path.parent.resolve(strict=True)!=path.parent:raise ValueError('unsafe status parent path')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size>16*1024*1024:
            raise ValueError('unsafe bounded status input')
        return json.loads(stream.read(info.st_size+1))

def evidence_bytes(path,limit,budget):
    if path.parent.resolve(strict=True)!=path.parent:raise ValueError('unsafe evidence parent')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        before=os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>limit or before.st_size>budget[0]:
            raise ValueError('unsafe or oversized evidence')
        budget[0]-=before.st_size
        raw=stream.read(before.st_size+1)
        after=os.fstat(stream.fileno())
        identity=lambda value:(value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
        if len(raw)!=before.st_size or identity(before)!=identity(after) or identity(after)!=identity(path.lstat()):
            raise ValueError('changing evidence')
        return raw

def fleet_meta_hash(repo,owner,pid,fleet_id,payload,budget,reader):
    path=repo/'.git/cloudbench-fleet-ownership'/owner/'meta'
    if not os.path.lexists(path):return None
    raw=reader(path,65536,budget)
    pairs=[line.split('=',1) for line in raw.decode().splitlines()]
    if any(len(pair)!=2 for pair in pairs):raise ValueError('invalid fleet meta')
    meta=dict(pairs)
    if len(meta)!=len(pairs) or any(meta.get(k)!=v for k,v in dict(version='2',
        app='navi-whisper-lux-bench',host=payload['machine'],pid=str(pid),
        fleet_owner_token=owner,run_id=fleet_id,workspace_root=str(repo)).items()):
        raise ValueError('fleet meta does not belong to job')
    return hashlib.sha256(raw).hexdigest()

def environment_failure(body,job,ident,pid,campaign,member_ids,budget,reader):
    # The prepublication error also covers user cancellation and deadline
    # expiry, so its text alone is deliberately not classified as infra.
    markers=('ValueError: environment-check identity changed while waiting\n',)
    for marker in markers:
        failure=body.find(marker)
        if failure<0:continue
        trace=body[:failure]
        if ('Traceback (most recent call last):\n' not in trace
            or not re.search(r'^  File "/tmp/cloudbench-scripts\.[0-9a-f]{32}/cloudbench-campaign-env\.py", line [0-9]+, in check$',trace,re.M)
            or '❌ Cloud benchmark environment is not ready; no benchmark machine was started.\n' not in body[failure+len(marker):]):
            continue
        cohort_id=job.get('startup_cohort','')
        if not isinstance(cohort_id,str) or not re.fullmatch(r'c[0-9]{3}',cohort_id):raise ValueError('invalid startup cohort')
        raw=reader(campaign/'startup-cohorts'/cohort_id/'manifest.json',65536,budget)
        cohort=json.loads(raw)
        if (not isinstance(cohort,dict) or cohort.get('cohort_id')!=cohort_id
            or not isinstance(cohort.get('jobs'),dict) or set(cohort['jobs'])!=member_ids
            or type(cohort['jobs'].get(ident))is not int or cohort['jobs'][ident]!=pid):
            raise ValueError('startup cohort does not own job process')
        return dict(reason='shared_environment_identity_changed',cohort_manifest_sha256=hashlib.sha256(raw).hexdigest())
    return None

def reuse_failure(body):
    markers=(('ValueError: late inactive native version observation\n','archived_reuse_inactive_observation_deadline'),
             ('<run_path>.ObservationDeadline: inactive native observation deadline\n','archived_reuse_inactive_observation_deadline'),
             ('<run_path>.NativeWireDeadline: native lease wire deadline\n','archived_reuse_direct_lease_deadline'))
    found=[(body.find(marker),marker,reason) for marker,reason in markers if marker in body]
    timed=re.search(r"^subprocess\.TimeoutExpired: Command (.+) timed out after ([0-9.]+) seconds$",body,re.M)
    if timed:found.append((timed.start(),timed[0]+'\n','archived_reuse_lease_wire_deadline'))
    if not found:return None
    failure,marker,reason=min(found)
    trace=body[:failure]
    claim=re.search(r'^  File "/tmp/cloudbench-scripts\.([0-9a-f]{32})/cloudbench-archived-machine-reuse\.py", line [0-9]+, in claim_native$',trace,re.M)
    if not claim or 'Traceback (most recent call last):\n' not in trace:return None
    def frame(name):
        return re.search(r'^  File "/tmp/cloudbench-scripts\.'+claim[1]+r'/cloudbench-archived-reuse-effects\.py", line [0-9]+, in '+name+'$',trace,re.M)
    if reason=='archived_reuse_direct_lease_deadline':
        argv=None
        if (not all(frame(name) for name in ('lease','_lease_wire')) or frame('wait_inactive')
            or not (frame('_native_window') or frame('wire') and frame('expire'))):return None
    elif reason=='archived_reuse_lease_wire_deadline':
        if not all(frame(name) for name in ('lease','wire','_run_wire')) or frame('wait_inactive'):return None
        command=timed[1]
        if not (command.startswith("'[") and command.endswith("]'")):return None
        argv=ast.literal_eval(command[1:-1])
        if (not isinstance(argv,list) or len(argv)!=5 or argv[1]!='-S' or argv[3]!='wire'
            or argv[2]!='/tmp/cloudbench-scripts.'+claim[1]+'/cloudbench-archived-machine-reuse.py'
            or not 20<float(timed[2])<=25):return None
    else:
        argv=None
        if not frame('wait_inactive'):return None
        if marker.startswith('<run_path>') and not all(frame(name) for name in ('observe_inactive','request','wire','expire')):return None
    return dict(reason=reason,after=body[failure+len(marker):],wire_argv=argv)

def lease_wire_binding(argv,task_dir,repo,proof,budget,reader):
    directory=Path(argv[4])
    if (argv[0]!=str(repo/'agents/venv/bin/python3') or directory.parent!=task_dir/'archived-reuse-wire'
        or not re.fullmatch('[0-9a-f]{32}',directory.name)):raise ValueError('foreign lease wire process')
    mid=proof.get('machine_id');marker=proof['native_marker']
    if (not isinstance(mid,str) or not re.fullmatch('[0-9a-f]{14}',mid) or marker.get('machine_id')!=mid
        or not re.fullmatch('[0-9a-f]{32}',proof.get('claim_id','')) or marker.get('claim_id')!=proof['claim_id']):
        raise ValueError('wire target lacks exact claim binding')
    raw=reader(directory/'request.json',65536,budget);request=json.loads(raw)
    started=reader(directory/'transport-start.json',65536,budget);transport=json.loads(started)
    if (request!={'app':'navi-whisper-lux-bench','method':'POST','path':'/machines/'+mid+'/lease',
                 'body':{'ttl':180,'description':'archived same-volume successor'},'timeout':20,'headers':{}}
        or transport.get('direct') is not False or type(transport.get('monotonic_ns'))is not int
        or transport['monotonic_ns']<=0):raise ValueError('foreign lease wire request')
    return dict(lease_wire_request_sha256=hashlib.sha256(raw).hexdigest(),
                lease_wire_transport_sha256=hashlib.sha256(started).hexdigest(),native_lease_outcome='unknown')

def startup_evidence(summary,repo,campaign,payload,reader=evidence_bytes):
    budget=[16*1024*1024];proofs=[];unavailable=set();inspected=0
    member_ids={job['job_id'] for job in summary['jobs']}
    for job in summary['jobs']:
        ident=job['job_id'];task=job.get('task')
        candidates=[job]+list(reversed(job.get('attempts',[])))
        visited=set()
        for attempt in candidates:
            name=attempt.get('log')
            if name is None:continue
            try:
                number=attempt.get('attempt',1);pid=attempt.get('controller_pid')
                if pid is None and attempt.get('started_at') is None and attempt.get('status') in ('queued','pending'):
                    continue
                if (not re.fullmatch(r'r[0-9]{3}-j[0-9]{4}',ident) or type(number)is not int or number<1
                    or type(pid)is not int or pid<=1 or not isinstance(task,str)
                    or not re.fullmatch(r'[A-Za-z0-9_.-]{1,200}',task)):
                    raise ValueError('invalid job evidence identity')
                expected=campaign/(ident+('' if number==1 else '.attempt-'+str(number))+'.log')
                if name!=str(expected):raise ValueError('job log path changed')
                key=(name,pid)
                if key in visited:continue
                visited.add(key)
                raw=reader(expected,256*1024,budget);text=raw.decode();inspected+=1
                # Direct, bound startup failures only. Generic/cascaded canary
                # errors and arbitrary copied diagnostic text do not qualify.
                marker='ValueError: late inactive native version observation\n'
                if (marker not in text and 'ValueError: environment-check identity' not in text
                    and '<run_path>.ObservationDeadline: inactive native observation deadline' not in text
                    and '<run_path>.NativeWireDeadline: native lease wire deadline' not in text
                    and 'subprocess.TimeoutExpired: Command ' not in text):continue
                headers=list(re.finditer(r'^\s*'+re.escape(str(repo/'scripts/run-bench'))+r' monitor ('+
                    re.escape(str(repo/'.context/fleet/runs'))+r'/([0-9]{8}-[0-9]{6}-[0-9]+))\n'
                    r'\s*owner: ([0-9a-f]{32}); private controller diagnostics stay in this run directory\.$',text,re.M))
                if len(headers)!=1:raise ValueError('ambiguous fleet monitor binding')
                header=headers[0];body=text[header.end():];fleet_id=header[2];owner=header[3]
                if not fleet_id.endswith('-'+str(pid)):raise ValueError('fleet process identity differs')
                env_failure=environment_failure(body,job,ident,pid,campaign,member_ids,budget,reader)
                if env_failure is not None:
                    meta_sha=fleet_meta_hash(repo,owner,pid,fleet_id,payload,budget,reader)
                    proofs.append(dict(job_id=ident,task=task,attempt=number,controller_pid=pid,
                        fleet_owner_token=owner,run_id=fleet_id,log_path=str(expected.relative_to(repo)),
                        log_sha256=hashlib.sha256(raw).hexdigest(),meta_sha256=meta_sha,
                        source_ref=payload['source_ref'],original_epoch=payload['epoch'],**env_failure))
                    unavailable.discard(ident)
                    break
                failure=reuse_failure(body)
                if failure is None:continue
                skipped='❌ ['+task+'] provisioning failed (no machine) — skipping\n'
                after=failure['after']
                if skipped not in after or '❌ no benches launched (all clones failed).\n' not in after.split(skipped,1)[1]:continue
                task_dir=repo/'.context/fleet/runs'/fleet_id/task
                successor_raw=reader(task_dir/'archived-successor.json',65536,budget)
                exclusion_raw=reader(task_dir/'archived-reuse-journal/source-exclusion.json',65536,budget)
                successor=json.loads(successor_raw);exclusion=json.loads(exclusion_raw)
                if not isinstance(successor,dict) or not isinstance(exclusion,dict):raise ValueError('invalid source binding')
                proof=exclusion.get('proof',{})
                if not isinstance(proof,dict) or not isinstance(proof.get('native_marker'),dict):raise ValueError('invalid claim binding')
                expected_successor=dict(controller_id=payload['machine'],harness_ref=payload['source_ref'],
                    owner_token=owner,run_id=fleet_id,task=task,campaign_job_id=ident,
                    campaign_total_jobs=payload.get('campaign_total_jobs',600),campaign_attempt=number)
                if (any(successor.get(k)!=v for k,v in expected_successor.items())
                    or any(type(successor.get(k))is not int for k in ('ordinal','campaign_total_jobs','campaign_attempt'))
                    or successor.get('ordinal')!=0 or successor.get('task_ref')!=ORIGINAL_TASK_REF
                    or proof.get('schema')!='cloudbench-archived-reuse-v1' or proof.get('successor')!=successor
                    or proof.get('native_marker',{}).get('successor')!=successor):
                    raise ValueError('source exclusion does not belong to job')
                wire=(lease_wire_binding(failure['wire_argv'],task_dir,repo,proof,budget,reader)
                      if failure['wire_argv'] is not None else
                      {'native_lease_outcome':'unknown'} if failure['reason']=='archived_reuse_direct_lease_deadline' else {})
                meta_sha=fleet_meta_hash(repo,owner,pid,fleet_id,payload,budget,reader)
                proofs.append(dict(job_id=ident,task=task,attempt=number,controller_pid=pid,
                    fleet_owner_token=owner,run_id=fleet_id,log_path=str(expected.relative_to(repo)),
                    log_sha256=hashlib.sha256(raw).hexdigest(),meta_sha256=meta_sha,
                    successor_sha256=hashlib.sha256(successor_raw).hexdigest(),
                    source_exclusion_sha256=hashlib.sha256(exclusion_raw).hexdigest(),
                    source_ref=payload['source_ref'],original_epoch=payload['epoch'],
                    reason=failure['reason'],**wire))
                unavailable.discard(ident)
                break
            except (OSError,ValueError,TypeError,KeyError,UnicodeError,SyntaxError):unavailable.add(ident)
    return dict(proofs=proofs,unavailable_jobs=len(unavailable),inspected_logs=inspected,bytes_read=16*1024*1024-budget[0])

def shard_job_ids(payload):
    """A bound shard's exact group-wide IDs r{run}-j{(run-1)*width+index+1}; None without a shard."""
    if 'task_indexes' not in payload:return None
    width=payload['campaign_total_jobs']//payload['runs']
    return {'r%03d-j%04d'%(run,(run-1)*width+index+1) for run in range(1,payload['runs']+1) for index in payload['task_indexes']}

def project(summary,startup=None,infra_early_stop="enabled",total=600,threshold=30,job_ids=None):
    if infra_early_stop not in ("enabled","disabled"):raise ValueError("invalid infrastructure early-stop policy")
    if type(total) is not int or total<1 or type(threshold) is not int or threshold<1:raise ValueError('invalid bound totals')
    jobs=summary['jobs']
    if not isinstance(jobs,list) or type(summary.get('total_jobs')) is not int or summary['total_jobs']!=total or len(jobs)!=total:
        raise ValueError('invalid original600 canonical jobs')
    if job_ids is not None and {job.get('job_id') for job in jobs}!=job_ids:
        raise ValueError('invalid shard canonical job identities')
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
    value.update(infra_early_stop=infra_early_stop,infra_stop_threshold=threshold,infra_threshold_breached=len(infra)>=threshold,infra_stop_required=infra_early_stop=='enabled' and len(infra)>=threshold)
    for key in ('campaign_id','total_jobs','startup_cohorts','finished_at','started_at'):
        if key in summary:value[key]=summary[key]
    if startup is not None:
        roots={proof['job_id'] for proof in startup['proofs']}
        value.update(startup_evidence_schema='original600-startup-failure-v1',
                     original_startup_infra_affected_jobs=len(roots),
                     combined_infra_affected_jobs=len(infra|roots),infra_stop_threshold=threshold,
                     infra_threshold_breached=len(infra|roots)>=threshold,infra_stop_required=infra_early_stop=='enabled' and len(infra|roots)>=threshold,
                     original_startup_failure_evidence=startup['proofs'],
                     startup_evidence_unavailable_jobs=startup['unavailable_jobs'],
                     startup_evidence_inspected_logs=startup['inspected_logs'],
                     startup_evidence_bytes_read=startup['bytes_read'])
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
    policy=payload.get('infra_early_stop','enabled')
    if policy not in ('enabled','disabled') or identity.get('infra_early_stop','enabled')!=policy:raise ValueError('supervisor infrastructure early-stop policy mismatch')
    pid=identity['pid']
    if type(pid)is not int or pid<=1:raise ValueError('unsafe supervisor PID')
    namespace=hashlib.sha256((float(payload['epoch']).hex()+':'+boot_id).encode()).hexdigest()[:24]
    campaign='campaign-qualified600-'+namespace+'-'+str(pid)
    path=repo/'.context/benchmarks/campaigns'/campaign/'summary.json'
    try:summary=read_json(path)
    except FileNotFoundError:return dict(base,status='SUMMARY_NOT_PUBLISHED',campaign_id=campaign)
    if summary.get('campaign_id')!=campaign or summary.get('e2e_started_at_epoch')!=payload['epoch']:
        raise ValueError('canonical campaign/original epoch mismatch')
    # Validate the canonical shape before using any job-selected evidence paths.
    bound=dict(total=payload.get('total_jobs',600),threshold=payload.get('infra_stop_threshold',30),job_ids=shard_job_ids(payload))
    project(summary,infra_early_stop=policy,**bound)
    startup=startup_evidence(summary,repo,path.parent,payload)
    return dict(base,status='SUMMARY',summary=project(summary,startup,policy,**bound))

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


def config_receipt(run,config,cfg,recorded):
    """Follow the recorded host continuation without changing workload identity."""
    current_sha=digest(read(config))
    need(recorded['source_ref']==cfg['source_ref'],'original source receipt changed')
    if recorded['config_sha256']==current_sha:return
    provenance=cfg.get('host_operator_provenance',{})
    original_path=Path(provenance.get('original_config_path',''))
    need(original_path==run.parent/'config.private.json','original config path changed')
    raw=read(original_path);original=json.loads(raw)
    need(digest(raw)==recorded['config_sha256']==provenance.get('original_config_sha256'),'original config receipt changed')
    need(original.get('source_ref')==cfg['source_ref']==provenance.get('workload_source_ref')
         and original.get('started_at_epoch')==cfg['started_at_epoch']==provenance.get('original_started_at_epoch'),'original workload/clock changed')
    permitted={'authority_template','host_operator_provenance'}
    need({k:v for k,v in cfg.items() if k not in permitted}=={k:v for k,v in original.items() if k not in permitted},'continuation changed workload config')
    need(obj(run/'host-operator-provenance.json')==provenance,'saved continuation provenance changed')
    failure=provenance.get('prelaunch_failure')
    if failure:
        prior=Path(failure['prior_output'])
        need(prior.parent==run.parent and prior!=run and failure['successor_output']==str(run),'continuation output changed')
        pointer=obj(prior/'host-launch-successor.json')
        need(pointer.get('schema')=='original600-host-launch-successor-v1'
             and pointer.get('evidence')==failure and pointer.get('config_path')==str(config)
             and pointer.get('config_sha256')==current_sha
             and pointer.get('original_started_at_epoch')==cfg['started_at_epoch']
             and pointer.get('host_operator_source_ref')==provenance.get('host_operator_source_ref'),'continuation successor receipt changed')


def binding(run,config=None,agents_env=None):
    run=Path(run).absolute();need(run.resolve(strict=True)==run,'physical run directory required')
    config=Path(config).absolute() if config else run.parent/'config.private.json'
    cfg=obj(config);auth=obj(run/'authority.private.json')
    need(cfg.get('schema')=='original600-controller-runner-v1' and cfg.get('allowed') is True,'original run config required')
    policy = cfg.get('infra_early_stop', 'enabled')
    need(policy in ('enabled', 'disabled'), 'invalid infrastructure early-stop policy')
    ref=cfg['source_ref'];need(re.fullmatch('[0-9a-f]{40}',ref),'exact source ref required')
    need(auth['source_ref']==ref and auth['app']=='navi-whisper-lux-bench','authority/source mismatch')
    need(Path(auth['output_directory'])==run/'export','authority output directory mismatch')
    start=run.parent/'attempt-start.safe.json'
    if start.exists():
        recorded=obj(start)
        config_receipt(run,config,cfg,recorded)
    terminal=run/'terminal.json'
    if terminal.exists():
        value=obj(terminal);need(value['source_ref']==ref,'terminal source mismatch')
        return dict(mode='LOCAL_TERMINAL',terminal=value,run_directory=str(run),source_ref=ref,infra_early_stop=policy)
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
    payload=dict(machine=mid,source_ref=ref,epoch=caller['epoch'],identity_path=caller['identity_path'],infra_early_stop=policy)
    if cfg.get('shard') is not None:
        # Totals come from the bound shard config; absent shard keeps the original 600/30 payload.
        shard=cfg['shard']
        payload.update(total_jobs=RUNNER['shard_shape'](shard),campaign_total_jobs=shard['group_total'],infra_stop_threshold=RUNNER['group_infra_threshold'](shard),
                       task_indexes=shard['task_indexes'],runs=shard['runs'])
    return dict(mode='REMOTE',app=auth['app'],machine=mid,source_ref=ref,root=root,
                agents_env=credential,credential_sha256=auth['env_files']['agents']['sha256'],source_files=cfg['source_files'],
                payload=payload)


def status_command(payload):
    encoded=base64.b64encode(json.dumps(payload).encode()).decode()
    package=base64.b64encode(gzip.compress(json.dumps([REMOTE,encoded]).encode(),mtime=0)).decode()
    loader="import base64,gzip,json,sys;source,payload=json.loads(gzip.decompress(base64.b64decode(sys.argv[1])));sys.argv=['original600-status',payload];exec(compile(source,'<original600-status>','exec'),{'__name__':'__main__'})"
    return shlex.join(['python3','-S','-c',loader,package])


def observation_request(value):
    body={'cmd':status_command(value['payload']),'timeout':20,'machine':True}
    need(len(json.dumps(body).encode())<=16384,'status exec exceeds bounded JSON transport')
    return {'method':'POST','path':'/machines/'+value['machine']+'/exec','body':body,'http_timeout':20,'absolute_timeout':25,'outer_timeout':30,'machine':value['machine'],'source_ref':value['source_ref'],'original_epoch':value['payload']['epoch']}


def failure_details(error, secrets=()):
    """Retain the actual exception privately, redacting known credentials."""
    message=str(error)
    for secret in secrets:
        if isinstance(secret,str) and secret:
            message=message.replace(secret,'<redacted>')
    return {'error_type':type(error).__name__,'error_module':type(error).__module__,'message':message[:16384],'message_truncated':len(message)>16384}


def capture_state(journal):
    """A pathname alone never proves a complete raw capture."""
    path=Path(journal)/'wire.json'
    present=path.exists()
    complete=False
    if present:
        try:
            wire=obj(path);request=obj(Path(journal)/'request.json')
            raw=base64.b64decode(wire['body_b64'],validate=True)
            complete=(wire['sha256']==digest(raw) and wire['method']==request['method']
                      and wire['path']==request['path'] and type(wire['status']) is int
                      and type(wire['monotonic_ns']) is int)
        except (OSError,ValueError,TypeError,KeyError):pass
    return {'response_observed':complete,'wire_artifact_present':present,
            'wire_capture_incomplete':present and not complete}


def observe(api,value,journal=None):
    request=observation_request(value);body=request['body']
    observer=None
    if journal is not None:
        journal=Path(journal)
        request_path=journal/'request.json'
        if request_path.exists():need(obj(request_path)==request,'status request journal differs')
        else:save(request_path,request)
        def observer(method,path,status,raw):
            need(method==request['method'] and path==request['path'],'status raw response identity differs')
            save(journal/'wire.json',{'method':method,'path':path,'status':status,'body_b64':base64.b64encode(raw).decode(),'sha256':digest(raw),'monotonic_ns':time.monotonic_ns(),'at_ns':time.time_ns()})
    with bounded(25):
        response=api.api('POST','/machines/'+value['machine']+'/exec',body,timeout=20,**({'observer':observer} if journal is not None else {}))
        if journal is not None:save(journal/'response.json',response)
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
        journal=output/('original600-status-wire-'+str(time.time_ns()))
        journal.mkdir(mode=0o700)
        fd=os.open(output,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
        save(journal/'request.json',observation_request(value))
        token=None;api=None;failure=None
        try:
            # Credential/session setup shares the same bounded observation clock.
            with bounded(25):
                parser=bound_source(value['root'],value['source_ref'],'run-original600-controller.py',value['source_files']['run-original600-controller.py'])
                client=bound_source(value['root'],value['source_ref'],'cloudbench-original-volume-capture.py',value['source_files']['cloudbench-original-volume-capture.py'])
                token=parser['token_from_agents'](read(value['agents_env']))
                api=client['Fly'](value['app'],token)
                result=observe(api,value,journal)
        except (Exception,RUNNER['Deadline']) as error:
            failure=failure_details(error,(token,getattr(api,'authorization',None)))
            result=dict(status='TRANSPORT_UNKNOWN',machine=value['machine'],source_ref=value['source_ref'],original_epoch=value['payload']['epoch'],error=type(error).__name__)
        capture=capture_state(journal)
        if failure is None and result['status']=='TRANSPORT_UNKNOWN':
            failure={'error_type':'NativeExecFailure','message':'native exec returned an unsuccessful envelope'}
        if failure is not None:save(journal/'failure.json',dict(failure,**capture,no_retry=True))
        save(journal/'complete.json',dict(capture,status=result['status'],request_sha256=digest(read(journal/'request.json')),
             decoded_response_artifact_present=(journal/'response.json').exists(),failed=failure is not None,no_retry=True,no_fabricated_response=True))
        result=dict(result,journal=str(journal))
        path=output/('original600-status-'+str(time.time_ns())+'.private.json')
        save(path,dict(observation=result,credential_source=str(value['agents_env']),credential_sha256=value['credential_sha256'],
                       source_ref=value['source_ref'],read_only_guest=True,no_signal=True,no_lifecycle_write=True))
    print(json.dumps(dict(result,saved=str(path),benchmark_success_inferred=False)))
    return 0 if result['status']!='TRANSPORT_UNKNOWN' else 1


if __name__=='__main__':raise SystemExit(main())
