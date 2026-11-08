"""Real campaign dispatch across a shared Git source/consumer boundary, offline."""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys

import pytest

from benchmarks.fixture_host_guard import FIXTURE_HOST_GUARD_SECONDS

ROOT = Path(os.environ.get('CLOUDBENCH_INVENTORY_ROOT_UNDER_TEST', Path(__file__).resolve().parents[2]))
# scripts/run-bench resolves every task launch's timeout through this script and its
# import closure in agents/benchmarks (catalog caps, floors and the history reader).
TIMEOUT_POLICY_SCRIPT = 'cloudbench-timeout-policy.py'
TIMEOUT_POLICY_MODULES = ('__init__.py', 'benchmark_tasks.py', 'fixtures.py', 'live_fixtures.py',
                          'polar_catalog.py', 'timeout_history.py')


def copy_timeout_policy(source):
    """Give a partial source checkout run-bench's timeout policy, without recorded history."""
    shutil.copyfile(ROOT / 'scripts' / TIMEOUT_POLICY_SCRIPT, source / 'scripts' / TIMEOUT_POLICY_SCRIPT)
    (source / 'agents/benchmarks').mkdir(parents=True, exist_ok=True)
    for module in TIMEOUT_POLICY_MODULES:
        shutil.copyfile(ROOT / 'agents/benchmarks' / module, source / 'agents/benchmarks' / module)


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL, text=True).strip()


@pytest.fixture
def bound_campaign(tmp_path):
    source = tmp_path / 'source'
    scripts = source / 'scripts'
    scripts.mkdir(parents=True)
    (source / 'agents/benchmarks').mkdir(parents=True)
    report = source / '.claude/shared/benchmark-report-format.txt'
    report.parent.mkdir(parents=True)
    shutil.copyfile(ROOT / '.claude/shared/benchmark-report-format.txt', report)
    for catalog in (ROOT / 'agents/benchmarks').glob('*.json'):
        shutil.copyfile(catalog, source / 'agents/benchmarks' / catalog.name)
    copy_timeout_policy(source)
    for name in ('run-bench', 'run-bench-campaign.py', 'cloudbench_catalog.py',
                 'cloudbench-production-only-tasks.py', 'cloudbench-campaign-seed.py',
                 'cloudbench-campaign-barrier.py', 'cloudbench-script-snapshot.py',
                 'cloudbench_execution_provenance.py', 'cloudbench-campaign-stop.py',
                 'cloudbench-shard-coordinator.py', 'cloudbench-provider-capacity.py',
                 'cloudbench-provider-limits.json', 'cloudbench-cleanup-tickets.py',
                 'cloudbench-infra-canary-preflight.py'):
        override = {'run-bench-campaign.py':'CLOUDBENCH_CAMPAIGN_UNDER_TEST','cloudbench-campaign-stop.py':'CLOUDBENCH_CAMPAIGN_STOP_UNDER_TEST'}.get(name)
        supplied = Path(os.environ[override]) if override and os.environ.get(override) else ROOT / 'scripts' / name
        shutil.copyfile(supplied, scripts / name)
    # The strict cohort's parent N2 preflight runs the committed canary entry;
    # this offline fixture has no provider, so its canary reports success.
    (scripts / 'run-fleet-infra-canary').write_text('#!/usr/bin/env bash\nexit 0\n')
    (scripts / 'run-fleet-infra-canary').chmod(0o755)
    # The old consumer entry must not be used as executable control code.
    (scripts / 'run-bench-fleet').write_text('#!/bin/bash\nexit 93\n')
    git(source, 'init', '-q')
    git(source, 'add', '.')
    git(source, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'consumer')
    task_ref = git(source, 'rev-parse', 'HEAD')
    workspace = tmp_path / 'consumer'
    git(source, 'worktree', 'add', '--detach', str(workspace), task_ref)
    (scripts / 'run-bench-fleet').write_text('''#!/bin/bash
set -eu
cd "$CLOUDBENCH_FLEET_ROOT"
exec python3 - "$@" <<'CHILD'
import json, os, subprocess, sys, time
from pathlib import Path
workspace=Path(os.environ['CLOUDBENCH_FLEET_ROOT']); job=os.environ['RUN_BENCH_CAMPAIGN_JOB_ID']; task=sys.argv[1]
assert Path.cwd()==workspace
assert os.environ['CLOUDBENCH_SCRIPT_SNAPSHOT_OWNER_MODE']=='borrow'
assert '--foreground' in sys.argv and '--reuse-pool-only' in sys.argv
assert sys.argv[sys.argv.index('--ref')+1]==os.environ['FIXTURE_TASK_REF']
fleet=workspace/'.context/fleet/runs'/job; (fleet/'_batch').mkdir(parents=True)
owner=job; audit=workspace/'.git-fixture/cloudbench-fleet-audits'/owner; audit.mkdir(parents=True)
record={'run_id':job,'tasks':[{'name':task,'status':'PASSED','passed':True,'lifecycle_stage':'released'}]}
(fleet/'_batch/run.json').write_text(json.dumps(record))
(fleet/'_batch/lifecycle.json').write_text(json.dumps({'run_id':job,'fleet_owner_token':owner,'workspace_root':str(workspace),'status':'verified','hub_publication_failed':False}))
meta=f'run_id={job}\\nfleet_owner_token={owner}\\nworkspace_root={workspace}\\nstatus=provider-teardown-verified\\n'
(audit/'meta').write_text(meta);(audit/'provider-teardown-verified.epoch').write_text(str(time.time()))
(fleet/'teardown-ownership.path').write_text(str(audit));(fleet/'teardown-ownership').mkdir()
for n in ('meta','provider-teardown-verified.epoch'):(fleet/'teardown-ownership'/n).write_bytes((audit/n).read_bytes())
print(f'{workspace}/scripts/run-bench monitor {fleet}',flush=True)
subprocess.run([sys.executable,os.environ['FIXTURE_BARRIER'],'--deadline',str(time.time()+60),'--controller-pid',str(os.getpid())],check=True)
CHILD
''')
    git(source, 'add', '.')
    git(source, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'control')
    source_ref = git(source, 'rev-parse', 'HEAD')
    snapshot = tmp_path / ('cloudbench-scripts.' + secrets.token_hex(16))
    snapshot.mkdir(mode=0o700)
    for name in ('run-bench-fleet', 'cloudbench-script-snapshot.py', 'cloudbench_execution_provenance.py'):
        shutil.copyfile(scripts / name, snapshot / name)
    fields=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()
    birth='proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+fields[19]
    subprocess.run([sys.executable,str(snapshot/'cloudbench-script-snapshot.py'),'initialize','--path',str(snapshot),'--temp-root',str(tmp_path),'--token',snapshot.name.split('.')[-1],'--pid',str(os.getpid()),'--pid-start',birth],check=True,capture_output=True)
    subprocess.run([sys.executable,str(snapshot/'cloudbench_execution_provenance.py'),'snapshot','--snapshot-dir',str(snapshot),'--output',str(snapshot/'cloudbench-controller-snapshot-manifest.json')],check=True,capture_output=True)
    env={k:v for k,v in os.environ.items() if not k.startswith(('CLOUDBENCH_', 'RUN_BENCH_', 'BENCHMARK_HUB_'))}
    env.update(CLOUDBENCH_FLEET_ROOT=str(workspace),CLOUDBENCH_SCRIPT_SNAPSHOT=str(snapshot),CLOUDBENCH_SCRIPT_SNAPSHOT_OWNER_MODE='borrow',CLOUDBENCH_PRESTACK_CONTROLLER_REF=source_ref,CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY='0',BENCHMARK_HUB_PARENT_RUN_ID='fixture',TMPDIR=str(tmp_path),FIXTURE_TASK_REF=task_ref,FIXTURE_BARRIER=str(scripts/'cloudbench-campaign-barrier.py'))
    return source,workspace,snapshot,source_ref,task_ref,env


def invoke(bound):
    source,workspace,snapshot,source_ref,task_ref,env=bound
    return subprocess.run(['bash',str(source/'scripts/run-bench'),'parallel-tool-calls','spawn-sub-agents','-k','2','--concurrency','4','--strict-barrier','--retry-infra','1','--timeout','1200','--e2e-timeout','5400','--reuse-pool-only','--cold-primary-bootstrap','--ref',task_ref],cwd=workspace,env=env,capture_output=True,text=True,timeout=FIXTURE_HOST_GUARD_SECONDS)


def test_campaign_workspace_real_cli_dispatch_and_release(bound_campaign):
    source,workspace,snapshot,source_ref,task_ref,env=bound_campaign
    result=invoke(bound_campaign)
    assert result.returncode==0,result.stdout+result.stderr
    summary=json.loads(next((workspace/'.context/benchmarks/campaigns').glob('*/summary.json')).read_text())
    assert summary['total_jobs']==summary['peak_concurrency']==4
    assert summary['startup_cohorts'][0]['released_count']==4
    assert all(j['resources_released'] and j['lifecycle_verified'] for j in summary['jobs'])
    assert summary['workspace_binding']['control_ref']==source_ref
    assert summary['workspace_binding']['task_ref']==task_ref
    assert not (source/'.context').exists()
    assert snapshot.exists()  # owner still holds it; campaign/children never delete it


@pytest.mark.parametrize('fault',('borrow','task-ref','control-ref','catalog','snapshot','owner','common'))
def test_campaign_workspace_refuses_before_child_dispatch(bound_campaign,fault):
    source,workspace,snapshot,source_ref,task_ref,env=bound_campaign
    if fault=='borrow':env.pop('CLOUDBENCH_SCRIPT_SNAPSHOT_OWNER_MODE')
    elif fault=='task-ref':git(workspace,'checkout','--detach',source_ref)
    elif fault=='control-ref':env['CLOUDBENCH_PRESTACK_CONTROLLER_REF']='0'*40
    elif fault=='catalog':
        path=workspace/'agents/benchmarks/tasks.json';path.write_bytes(path.read_bytes()+b'\n')
    elif fault=='snapshot':(snapshot/'run-bench-fleet').write_text('changed')
    elif fault=='owner':
        p=snapshot/'.cloudbench-script-snapshot-owner.json';v=json.loads(p.read_text());v['owner_pid_start']='wrong';p.write_text(json.dumps(v))
    elif fault=='common':
        foreign=workspace.parent/'foreign';subprocess.run(['git','clone','-q',str(source),str(foreign)],check=True);git(foreign,'checkout','--detach',task_ref);env['CLOUDBENCH_FLEET_ROOT']=str(foreign)
    result=invoke(bound_campaign)
    assert result.returncode!=0,result.stdout+result.stderr
    assert not (workspace/'.context').exists()
    assert not (source/'.context').exists()


def test_campaign_workspace_default_path_is_unchanged(tmp_path,monkeypatch):
    spec=importlib.util.spec_from_file_location('campaign_default',ROOT/'scripts/run-bench-campaign.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    monkeypatch.delenv('CLOUDBENCH_FLEET_ROOT',raising=False)
    if not hasattr(module,'campaign_workspace'):
        pytest.skip('unchanged base has no optional workspace binding')
    assert module.campaign_workspace(tmp_path,[])==(tmp_path,None)


def test_campaign_workspace_normal_cli_preserves_original600_shape(tmp_path):
    """Exercise the normal entry's argv translation, with no controller launch."""
    source=tmp_path/'source';scripts=source/'scripts';scripts.mkdir(parents=True)
    (source/'agents/benchmarks').mkdir(parents=True)
    report=source/'.claude/shared/benchmark-report-format.txt';report.parent.mkdir(parents=True)
    shutil.copyfile(ROOT/'.claude/shared/benchmark-report-format.txt',report)
    for name in ('run-bench','cloudbench_catalog.py','cloudbench-shard-coordinator.py'):
        shutil.copyfile(ROOT/'scripts'/name,scripts/name)
    for path in (ROOT/'agents/benchmarks').glob('*.json'):
        shutil.copyfile(path,source/'agents/benchmarks'/path.name)
    copy_timeout_policy(source)
    override=os.environ.get('CLOUDBENCH_ORIGINAL600_TASK_FILE_UNDER_TEST')
    if override:
        import hashlib
        raw=Path(override).read_bytes()
        assert hashlib.sha256(raw).hexdigest()=='660873a9e02c6c5682a98e9a00dd0133c394a16dcdefd726bcb0a8987f1b59f5'
        tasks=raw.decode().splitlines()
    else:
        spec=importlib.util.spec_from_file_location('fixture_catalog',ROOT/'scripts/cloudbench_catalog.py')
        catalog=importlib.util.module_from_spec(spec);spec.loader.exec_module(catalog)
        tasks=[row['name'] for row in catalog.load_unified_catalog(ROOT/'agents/benchmarks/tasks.json')][:200]
    assert len(tasks)==len(set(tasks))==200
    captured=tmp_path/'argv.json'
    (scripts/'run-bench-campaign.py').write_text("import os,sys,json;json.dump(sys.argv[1:],open(os.environ['FIXTURE_CAPTURE'],'w'))\n")
    argv=['bash',str(scripts/'run-bench'),'--stress-defaults','--strict-barrier','--concurrency','600','-k','3','--retry-infra','1','--timeout','1200','--e2e-timeout','5400','--e2e-started-at','1791410000','--reuse-pool-only','--cold-primary-bootstrap','--ref','5'*40,*tasks]
    # 600 simultaneous copies exceed one controller's bound. The strict route
    # refuses --stress-defaults before any launch.
    strict=subprocess.run(argv,env={**os.environ,'FIXTURE_CAPTURE':str(captured),'RUN_BENCH_SHARDED_ROUTE':'always'},capture_output=True,text=True,timeout=FIXTURE_HOST_GUARD_SECONDS)
    assert strict.returncode==2,strict.stdout+strict.stderr
    assert "600 simultaneous copies exceed one controller's" in strict.stdout+strict.stderr
    assert '--demo-cache/--stress-defaults are not sharded operator options' in strict.stderr
    assert not captured.exists()
    # Auto routing keeps the ordinary campaign for an option the operator
    # refuses, naming it in one warning, with the original600 argv shape.
    result=subprocess.run(argv,env={**os.environ,'FIXTURE_CAPTURE':str(captured)},capture_output=True,text=True,timeout=FIXTURE_HOST_GUARD_SECONDS)
    assert result.returncode==0,result.stdout+result.stderr
    assert result.stderr.count('--stress-defaults is not a sharded operator option; using campaign controllers')==1,result.stderr
    args=json.loads(captured.read_text())
    assert [v.removeprefix('--task=') for v in args if v.startswith('--task=')]==tasks
    assert all(v in args for v in ('--stress-defaults','--concurrency=600','--runs=3','--retry-infra=1','--e2e-timeout=5400','--e2e-started-at=1791410000','--forward-arg=--strict-barrier','--forward-arg=--timeout','--forward-arg=1200','--forward-arg=--reuse-pool-only','--forward-arg=--cold-primary-bootstrap','--forward-arg=--ref','--forward-arg='+'5'*40))
    assert '--forward-arg=--foreground' not in args


@pytest.mark.parametrize('failed,signals',((29,0),(30,1)))
def test_campaign_workspace_threshold_watcher_uses_consumer_and_control(bound_campaign,monkeypatch,failed,signals):
    """Actual supervisor loop reads consumer records and fences control source."""
    import hashlib
    import runpy
    from unittest.mock import patch
    from types import SimpleNamespace
    source,workspace,snapshot,source_ref,task_ref,env=bound_campaign
    for key,value in env.items():monkeypatch.setenv(key,value)
    monkeypatch.setenv('REVIEWED_OPERATOR_SOURCE_REF',source_ref)
    guard=runpy.run_path(str(source/'scripts/cloudbench-campaign-stop.py'))
    namespace=guard['main'].__globals__
    epoch=123.0;boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    digest=hashlib.sha256((float(epoch).hex()+':'+boot).encode()).hexdigest()[:24]
    campaign_id=f'campaign-qualified600-{digest}-{os.getpid()}'
    campaign=workspace/'.context/benchmarks/campaigns'/campaign_id
    (workspace/'.context/stress200-host').mkdir(parents=True)
    jobs=[{'job_id':f'j{i}','task':f'task{i}','attempts':[{'attempt':1,'status':'failed' if i<failed else 'passed','finished_at':'now','infra_failure':i<failed}]}for i in range(600)]
    summary={'campaign_id':campaign_id,'e2e_started_at_epoch':epoch,'total_jobs':600,'concurrency':600,'jobs':jobs}
    manifest={'cohort_id':'c001','e2e_deadline_monotonic':9999.0,'jobs':{j['job_id']:None for j in jobs}}
    class Parent:
        pid=12345
        done=False
        signals=[]
        def poll(self):return 0 if self.done else None
        def send_signal(self,sig):self.signals.append(sig)
        def wait(self):return 0
    parent=Parent();fences=[];iterations=[]
    def launch(args,**kw):
        assert kw['cwd']==source
        assert args==['bash','scripts/run-bench','--ref',task_ref]
        (campaign/'startup-cohorts/c001').mkdir(parents=True)
        (campaign/'summary.json').write_text(json.dumps(summary));(campaign/'startup-cohorts/c001/manifest.json').write_text(json.dumps(manifest))
        return parent
    def advance(_seconds):
        iterations.append(True)
        if len(iterations)==3:parent.done=True
    def fence(repo,_parent,_birth,ref,directory):
        assert repo==source and ref==source_ref and directory==campaign
        fences.append(True)
    actual_path=Path
    def paths(*args):return source if args==('/tmp/gate/repo',)else actual_path(*args)
    with patch.dict(namespace,Path=paths,birth=lambda _: 'fixture-birth',fence=fence,subprocess=SimpleNamespace(Popen=launch,check_output=subprocess.check_output)),patch.object(namespace['signal'],'signal'),patch.object(namespace['time'],'sleep',side_effect=advance),patch.object(namespace['sys'],'argv',['stop',str(epoch),'--watcher-scope','fresh','bash','scripts/run-bench','--ref',task_ref]):
        assert guard['main']()==0
    destination=workspace/'.context/stress200-host/fresh'
    assert len(parent.signals)==signals and fences
    assert (destination/'infra-threshold-parent-term.safe.json').exists()==bool(signals)
    receipt=json.loads((destination/'threshold-original-parent.private.json').read_text())
    assert receipt['workspace_binding']['workspace_root']==str(workspace)
    assert receipt['workspace_binding']['control_ref']==source_ref


def test_campaign_workspace_watcher_checks_bytes_before_import(bound_campaign,monkeypatch):
    import runpy
    source,workspace,snapshot,source_ref,task_ref,env=bound_campaign
    for key,value in env.items():monkeypatch.setenv(key,value)
    monkeypatch.setenv('REVIEWED_OPERATOR_SOURCE_REF',source_ref)
    marker=workspace/'substituted-code-ran'
    with (source/'scripts/run-bench-campaign.py').open('a')as stream:
        stream.write('\nPath('+repr(str(marker))+').write_text("untrusted")\n')
    guard=runpy.run_path(str(source/'scripts/cloudbench-campaign-stop.py'))
    monkeypatch.setattr(sys,'argv',['stop','123','--watcher-scope','new','bash','scripts/run-bench','--ref',task_ref])
    with pytest.raises(ValueError):guard['main']()
    assert not marker.exists()
    assert not (workspace/'.context').exists()
