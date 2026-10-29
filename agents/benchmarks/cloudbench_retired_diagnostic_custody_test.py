"""Zero-credit retirement is distinct from a normal benchmark capture."""
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import socket
import subprocess
import sys
from unittest.mock import patch

import pytest

ROOT = Path(os.environ.get('ROSE_TEST_SOURCE_ROOT', Path(__file__).resolve().parents[2]))
HELPER = Path(os.environ.get('ROSE_RETIRED_HELPER', ROOT / 'scripts/cloudbench-retired-diagnostic-custody.py'))
M = runpy.run_path(str(HELPER))
OWNER, MID, VID, CLONE = 'a'*32, 'b'*14, 'vol_fixture1', 'cloudbench-fixture'
ROOT_ID, SID = '11111111-1111-4111-8111-111111111111', 'sess_fixture1'


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) if isinstance(value, (dict,list)) else value)


def fields(path, value):
    write(path, ''.join(str(k)+'='+str(v)+'\n' for k,v in value.items()))


def fixture(tmp):
    common=tmp/'.git';reg=common/'cloudbench-fleet-ownership'/OWNER;audit=common/'cloudbench-fleet-audits'/OWNER
    run=tmp/'.context/fleet/runs/failed-run';out=run/'fixture-task';diag=out/'remote-logs/failed-runtime-evidence'
    for folder in [reg/'clones',audit/'fresh',audit/'expected-fresh',audit/'by-machine-id',diag/'logs']:folder.mkdir(parents=True)
    meta=dict(version=2,app='fixture-app',fleet_owner_token=OWNER,host=socket.gethostname(),pid=999999999,pid_start='fixture-absent',run_id=run.name,workspace_root=tmp,runs_root=run.parent,audit_dir=audit,cleanup_policy='reap')
    fields(reg/'meta',meta);fields(audit/'meta',meta);write(reg/'runtime-evidence-unconfirmed','')
    fresh=dict(version=1,fleet_owner_token=OWNER,run_id=run.name,app='fixture-app',clone_name=CLONE,source='fresh-clone',source_machine_id='c'*14,machine_id=MID,volume_id=VID,disposition='destroyed-provider-retained')
    fields(audit/'fresh'/CLONE,fresh);fields(audit/'expected-fresh'/CLONE,dict(clone_name=CLONE,source_machine_id='c'*14));write(audit/'by-machine-id'/MID,CLONE+'\n')
    for n in ['owned-clones.ids','owned-clones.names']:write(audit/n,'')
    write(out/'.cid','clone '+MID+'\n');binding=dict(version=1,machine_id=MID,run_token=OWNER+'-0')
    write(out/'runtime-evidence.owner.json',binding);write(out/'runtime-evidence.pending',binding);write(out/'worker-clones.ids','')
    write(run/'_batch/benches.json',[dict(name='fixture-task',mode='REAL')]);write(run/'_batch/lifecycle.json',dict(version=1,status='failed',controller_exit_code=1,fleet_owner_token=OWNER,run_id=run.name))
    C=runpy.run_path(str(ROOT/'scripts/cloudbench_execution_provenance.py'));matrix=C['build_task_matrix'](['fixture-task=real']);config=C['build_config'](C['CONFIG_SCHEMA_VERSION'],['app=fixture-app','task_count=1','task_matrix_sha256='+matrix['sha256']])
    provenance=dict(schema_version=C['EXECUTION_SCHEMA_VERSION'],base_sha='5'*40,workspace_patch_sha256='none',controller_snapshot=dict(schema_version=C['SNAPSHOT_SCHEMA_VERSION'],sha256='c'*64),config=config)
    write(run/'execution-provenance.json',provenance);write(run/'execution-task-matrix.json',matrix)
    snapshot=dict(root_exists=True,root_deleted=True,tree_agent_ids=[ROOT_ID],unsealed_tree_agent_ids=[],browser_sessions=[dict(agent_id=ROOT_ID,provider='tilion',session_id=SID)],purchase_cleanup=[])
    receipts=[dict(provider='tilion',session_id=SID,status=204,response_sha256=hashlib.sha256(b'').hexdigest())]
    cleanup={k:copy.deepcopy(snapshot) for k in ['before','after','final','payment_snapshot']};cleanup.update(root_agent_id=ROOT_ID,errors=[],warnings=[],provider_receipts=receipts)
    logs=dict(cloud_cleanup_evidence=cleanup,cloud_provider_cleanup=dict(root_agent_id=ROOT_ID,root_deleted=True,tree_sealed=True,provider_receipts=receipts),cloud_payment_cleanup=dict(root_agent_id=ROOT_ID,purchases=[]))
    write(diag/'run.json',dict(execution_provenance=provenance,tasks=[dict(name='fixture-task',agent_id=ROOT_ID,status='FAILED',benchmark_status='INFRA_ERROR',execution_provenance=provenance,logs=logs)]))
    write(diag/'services.json',dict(status='stopped',env=dict(worker_processes=1)));write(diag/'stack.log','original stopped stack')
    write(diag/'logs/backend.log','[Server] Server started\n[HTTP] POST /api/agents -> 201\npath=/api/agents/'+ROOT_ID+'\nTilion request method=POST path=/v1/session status=200\nCreated Tilion browser session sessionId='+SID+'\n[Server] SIGTERM received, closing server...\n')
    write(diag/'logs/worker.log','original terminal worker');write(diag/('cloudbench-stack-cleanup-'+OWNER+'-0.status'),'state=failed\ntoken='+OWNER+'-0\n')
    manifest=dict(version=1,diagnostic_only=True,proof_credit=0,machine_id=MID,run_token=OWNER+'-0',stack_cleanup_state='failed',files={})
    refresh(diag,manifest)
    machine=dict(id=MID,name=CLONE,state='destroyed',instance_id='original-instance',config=dict(env=dict(CLOUDBENCH_RUN_TOKEN=OWNER+'-0',REF='5'*40),mounts=[dict(volume=VID)]))
    volume=dict(id=VID,state='pending_destroy',attached_machine_id=None,attached_alloc_id=None)
    return reg,common,out,diag,machine,volume


def refresh(diag, manifest=None):
    if manifest is None:manifest=json.loads((diag/'manifest.json').read_text())
    manifest['files']={str(f.relative_to(diag)):dict(bytes=f.stat().st_size,sha256=hashlib.sha256(f.read_bytes()).hexdigest()) for f in diag.rglob('*') if f.is_file() and f.name!='manifest.json'}
    write(diag/'manifest.json',manifest)



CUSTODY_FAULTS = ['unlisted-admitted-output', 'unlisted-allocation-marker',
                 'symlink-remote-logs', 'symlink-diagnostic', 'symlink-logs']


def custody_fault(tmp, out, diag, fault):
    if fault == 'unlisted-admitted-output':
        foreign = out.parent / 'unlisted-task'
        write(foreign / 'runtime-evidence.owner.json', dict(version=1, machine_id='f'*14, run_token=OWNER+'-1'))
        write(foreign / 'post-config-start.accepted', 'unresolved')
    elif fault == 'unlisted-allocation-marker':
        write(out.parent / 'unlisted-task/nested/.cid', 'clone '+'f'*14+'\n')
    else:
        target = {'symlink-remote-logs': out/'remote-logs',
                  'symlink-diagnostic': diag, 'symlink-logs': diag/'logs'}[fault]
        external = tmp / 'outside-retained-run'
        shutil.move(target, external)
        target.symlink_to(external, target_is_directory=True)


@pytest.mark.parametrize('fault', CUSTODY_FAULTS)
def test_whole_owner_custody_precedes_native_reads(tmp_path, fault):
    reg,common,out,diag,machine,volume=fixture(tmp_path)
    custody_fault(tmp_path, out, diag, fault)
    fd,birth=guarded(reg,common);calls=[]
    try:
        with pytest.raises((ValueError,AssertionError)):
            M['recover'](reg,common,lambda _:calls.append('machine'),lambda _:calls.append('volume'),fd,os.getpid(),birth)
        assert calls == []
        assert (reg/'runtime-evidence-unconfirmed').exists()
        assert not (out.parent/'_retired-diagnostic-custody/receipt.json').exists()
    finally:os.close(fd)


@pytest.mark.parametrize('fault', CUSTODY_FAULTS)
def test_whole_owner_custody_is_revalidated(tmp_path, fault):
    reg,common,out,diag,machine,volume=fixture(tmp_path)
    fd,birth=guarded(reg,common);calls=[]
    def native(_):
        calls.append('machine')
        if len(calls)==2:custody_fault(tmp_path, out, diag, fault)
        return machine
    try:
        with pytest.raises((ValueError,AssertionError)):
            M['recover'](reg,common,native,lambda _:volume,fd,os.getpid(),birth)
        assert calls == ['machine','machine']
        assert (reg/'runtime-evidence-unconfirmed').exists()
        assert not (out.parent/'_retired-diagnostic-custody/receipt.json').exists()
    finally:os.close(fd)



@pytest.mark.parametrize('fault', CUSTODY_FAULTS)
def test_whole_owner_rechecked_after_receipt_before_latch(tmp_path, fault, monkeypatch):
    reg,common,out,diag,machine,volume=fixture(tmp_path)
    fd,birth=guarded(reg,common);save=M['P']['save']
    def changed_after_save(path, value):
        save(path, value)
        custody_fault(tmp_path, out, diag, fault)
    monkeypatch.setitem(M['P'], 'save', changed_after_save)
    try:
        with pytest.raises((ValueError,AssertionError)):
            M['recover'](reg,common,lambda _:machine,lambda _:volume,fd,os.getpid(),birth)
        assert (reg/'runtime-evidence-unconfirmed').exists()
        assert not (out/'guest-shutdown.confirmed').exists()
        assert not (out/'remote-logs/runtime-evidence/manifest.json').exists()
    finally:os.close(fd)


def guarded(reg,common):
    directory=common/'cloudbench-fleet-recovery-locks';directory.mkdir(exist_ok=True)
    fd=os.open(directory/OWNER,os.O_RDWR|os.O_CREAT,0o600);fcntl.flock(fd,fcntl.LOCK_EX)
    if Path('/proc/self/stat').exists():
        birth='proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+Path('/proc/self/stat').read_text().split(') ',1)[1].split()[19]
    else:
        birth=' '.join(subprocess.check_output(['ps','-p',str(os.getpid()),'-o','lstart='],text=True).split())
    fields(reg/'recovery-lock/meta',dict(host=socket.gethostname(),pid=os.getpid(),pid_start=birth))
    return fd,birth


def test_retired_diagnostic_custody_preserves_missing_normal_proof(tmp_path):
    reg,common,out,diag,machine,volume=fixture(tmp_path);fd,birth=guarded(reg,common)
    try:
        receipt=M['recover'](reg,common,lambda _:machine,lambda _:volume,fd,os.getpid(),birth)
        assert receipt['proof_credit']==0 and receipt['normal_runtime_verified'] is False and receipt['guest_ack_observed'] is False
        assert all('/remote-logs/' not in path for path in receipt['small_originals_b64'])
        assert not (reg/'runtime-evidence-unconfirmed').exists()
        assert (out/'runtime-evidence.pending').exists() and not (out/'guest-shutdown.confirmed').exists()
        assert not (out/'remote-logs/runtime-evidence/manifest.json').exists()
        assert json.loads((diag/'manifest.json').read_text())['diagnostic_only'] is True
    finally:os.close(fd)


@pytest.mark.parametrize('fault',['owned','live','stopped','attached','foreign-root','child','missing-provider','foreign-native','source','malformed','tamper','guest-latch','normal-credit','second-allocation','unknown-create','partial-backend'])
def test_retired_diagnostic_custody_refuses_other_cases(tmp_path,fault):
    reg,common,out,diag,machine,volume=fixture(tmp_path);audit=common/'cloudbench-fleet-audits'/OWNER
    if fault=='owned':
        f=audit/'fresh'/CLONE;f.write_text(f.read_text().replace('destroyed-provider-retained','owned'))
    if fault in ('live','stopped'):machine['state']='started' if fault=='live' else 'stopped'
    if fault=='attached':volume['attached_machine_id']='foreign'
    if fault=='foreign-native':machine['id']='foreign'
    if fault=='source':machine['config']['env']['REF']='6'*40
    if fault=='child':write(out/'worker-clones.ids','d'*14+'\n')
    if fault=='guest-latch':write(reg/'guest-cleanup-unconfirmed','')
    if fault=='second-allocation':write(audit/'fresh/another','version=1\n')
    if fault in ('foreign-root','missing-provider','normal-credit'):
        d=json.loads((diag/'run.json').read_text());logs=d['tasks'][0]['logs']
        if fault=='foreign-root':logs['cloud_cleanup_evidence']['after']['tree_agent_ids']=['22222222-2222-4222-8222-222222222222']
        if fault=='missing-provider':logs['cloud_provider_cleanup']['provider_receipts']=[]
        if fault=='normal-credit':
            m=json.loads((diag/'manifest.json').read_text());m['proof_credit']=1;write(diag/'manifest.json',m)
        write(diag/'run.json',d);refresh(diag)
    if fault=='unknown-create':
        text=(diag/'logs/backend.log').read_text().replace('[Server] SIGTERM received, closing server...','Tilion request method=POST path=/v1/session status=200\n[Server] SIGTERM received, closing server...')
        write(diag/'logs/backend.log',text);refresh(diag)
    if fault=='partial-backend':
        write(diag/'logs/backend.log',(diag/'logs/backend.log').read_text().replace('[Server] Server started\n',''));refresh(diag)
    if fault=='tamper':write(diag/'logs/worker.log','changed after manifest')
    if fault=='malformed':write(diag/'manifest.json','{')
    fd,birth=guarded(reg,common)
    try:
        with pytest.raises((ValueError,AssertionError,KeyError,M['NotApplicable'],M['E']['CleanupEvidenceError'])):
            M['recover'](reg,common,lambda _:machine,lambda _:volume,fd,os.getpid(),birth)
        assert (reg/'runtime-evidence-unconfirmed').exists()
        assert not (out.parent/'_retired-diagnostic-custody/receipt.json').exists()
    finally:os.close(fd)


def test_recovery_lock_precedes_native_reads(tmp_path):
    reg,common,out,diag,machine,volume=fixture(tmp_path);calls=[]
    with pytest.raises((ValueError,OSError)):
        M['recover'](reg,common,lambda _:calls.append('read'),lambda _:calls.append('read'),-1,os.getpid(),'wrong')
    assert calls==[] and (reg/'runtime-evidence-unconfirmed').exists()


def extract(text, name):
    start=text.index(name+'() {');lines=[];delimiter=None
    import re
    for line in text[start:].splitlines(keepends=True):
        lines.append(line)
        if delimiter:
            if line.strip()==delimiter:delimiter=None
            continue
        match=re.search(r'<<["\']?([A-Za-z0-9_]+)["\']?',line)
        if match:delimiter=match.group(1)
        elif line=='}\n':return ''.join(lines)
    raise AssertionError('function terminator')


@pytest.mark.parametrize('fault', [None] + CUSTODY_FAULTS)
def test_actual_runtime_recovery_accepts_only_retired_diagnostic(tmp_path, fault):
    reg,common,out,diag,machine,volume=fixture(tmp_path)
    fd,_=guarded(reg,common)
    if fault is not None:custody_fault(tmp_path, out, diag, fault)
    native=tmp_path/'native.json';write(native,dict(machine=machine,volume=volume))
    driver=tmp_path/'offline_native.py'
    driver.write_text('''import json,runpy,socket,sys
from pathlib import Path
helper=sys.argv.pop(1);native=json.loads(Path(sys.argv.pop(1)).read_text())
def deny(*a,**k):raise AssertionError('network forbidden')
socket.socket.connect=deny;socket.create_connection=deny
m=runpy.run_path(helper)
class Native:
 def __init__(self,*a):pass
 def machine(self,mid):assert mid==native['machine']['id'];return native['machine']
 def volume(self,vid):assert vid==native['volume']['id'];return native['volume']
m['P']['B']['Fly']=Native;m['P']['B']['resolve_token']=lambda _: 'offline-not-a-credential'
m['main']()
''')
    fleet=Path(os.environ.get('ROSE_RETIRED_FLEET',ROOT/'scripts/run-bench-fleet'))
    text=fleet.read_text();parts=extract((ROOT/'scripts/lib/cloudbench-inventory.sh').read_text(),'registry_meta_value')+'\n'+'\n'.join(extract(text,n)for n in ['cloudbench_primary_runtime_evidence_prelaunch','cloudbench_validate_primary_runtime_evidence','fleet_recovery_confirm_runtime_evidence'])
    import shlex
    q=shlex.quote
    script=parts+'\n'+f'''
source {q(str(ROOT/'scripts/lib/cloudbench-env.sh'))}
FLEET_OWNER_PID_START="$(cloudbench_pid_start_time $$)"
printf 'host=%s\\npid=%s\\npid_start=%s\\n' "$(hostname)" "$$" "$FLEET_OWNER_PID_START" > {q(str(reg/'recovery-lock/meta'))}
python3() {{
 if [ "$1" = {q(str(HELPER))} ]; then shift; {q(sys.executable)} {q(str(driver))} {q(str(HELPER))} {q(str(native))} "$@"
 else {q(sys.executable)} "$@"; fi
}}
cloudbench_collect_remaining_runtime_evidence() {{ return 77; }}
fleet_recovery_confirm_runtime_evidence {q(str(reg))}
'''
    environment={**os.environ,'FLEET_AUDIT_ROOT':str(common/'cloudbench-fleet-audits'),'CLOUDBENCH_SCRIPT_SNAPSHOT':str(HELPER.parent),'GIT_COMMON_DIR':str(common),'REGISTRY_RECOVERY_GUARD_FD':str(fd)}
    try:
        bash='/opt/homebrew/bin/bash' if Path('/opt/homebrew/bin/bash').exists() else shutil.which('bash')
        result=subprocess.run([bash,'-c',script],env=environment,pass_fds=(fd,),capture_output=True,text=True,timeout=15)
        if fault is not None:
            assert result.returncode != 0,result.stdout+result.stderr
            assert (reg/'runtime-evidence-unconfirmed').exists()
            assert not (out.parent/'_retired-diagnostic-custody/receipt.json').exists()
            return
        assert result.returncode==0,result.stdout+result.stderr
        assert not (reg/'runtime-evidence-unconfirmed').exists()
        assert (out/'runtime-evidence.pending').exists() and not (out/'guest-shutdown.confirmed').exists()
    finally:os.close(fd)


@pytest.mark.parametrize('ordinary',['normal','ack','forensic'])
def test_existing_evidence_routes_are_not_replaced(tmp_path,ordinary):
    reg,common,out,diag,machine,volume=fixture(tmp_path)
    target={'normal':out/'remote-logs/runtime-evidence/manifest.json','ack':out/'guest-shutdown.confirmed','forensic':out.parent/'_forensic/manifest.json'}[ordinary]
    write(target,'existing ordinary evidence')
    with pytest.raises(M['NotApplicable']):M['plan'](reg,common)
    assert (reg/'runtime-evidence-unconfirmed').exists()
