"""Execution-only compatibility for the audited pre-dispatch campaign producer.

This is a current investigator/OS observation, never a retrospective producer seal.
Original cleanup remains unresolved. No provider calls or resource mutation.
"""
import copy
import hashlib
import os
from pathlib import Path
import re
import subprocess
import time

# This entire producer's pre-dispatch control flow was audited. New producer
# versions must use native checkpoints, not inherit this compatibility contract.
SOURCE = 'ce2742ae023ceab86a34d39bde2754a356f1cc4e'
PRODUCER = '2659729480ec12c10bac14ef264e01528b97b4efaf7b5f88cdcbf1054323c93a'
INVENTORY = {
    'cloudbench-campaign-inventory.sh': 'scripts/cloudbench-campaign-inventory.sh',
    'cloudbench-inventory.sh': 'scripts/lib/cloudbench-inventory.sh',
    'cloudbench-env.sh': 'scripts/lib/cloudbench-env.sh',
    'cloudbench-machine-readiness.py': 'scripts/cloudbench-machine-readiness.py',
    'cloudbench-campaign-machines.py': 'scripts/cloudbench-campaign-machines.py',
}


def observe(pids, scopes):
    """Read every live same-user process; unknown/inaccessible state blocks admission."""
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    own = os.getpid()
    ancestors = set()
    while own > 1 and own not in ancestors:
        ancestors.add(own)
        try:
            own = int(Path('/proc', str(own), 'stat').read_text().rsplit(') ', 1)[1].split()[1])
        except FileNotFoundError:
            break
    matched, unreadable = [], []
    uid = os.geteuid()
    def scoped(value):
        return any(value == scope or value.startswith(scope + '/') for scope in scopes)
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        if int(proc.name) in ancestors:
            if int(proc.name) in pids:
                matched.append(int(proc.name))
            continue  # Exempt only the observer lineage, never a declared native owner.
        try:
            if proc.stat().st_uid != uid:
                continue
            stat = (proc / 'stat').read_text().rsplit(') ', 1)[1].split()
            if stat[0] in ('Z', 'X'):
                continue
            args = (proc / 'cmdline').read_bytes().decode(errors='replace').split('\0')
            env = (proc / 'environ').read_bytes().decode(errors='replace').split('\0')
            values = args + [v.partition('=')[2] for v in env] + [os.readlink(proc / 'cwd').removesuffix(' (deleted)')]
            for fd in (proc / 'fd').iterdir():
                try:
                    values.append(os.readlink(fd).removesuffix(' (deleted)'))
                except FileNotFoundError:
                    pass
            if int(proc.name) in pids or int(stat[2]) in pids or any(scoped(v) for v in values):
                matched.append(int(proc.name))
        except (OSError, ValueError) as error:
            # /proc can disappear or become unreadable as a child is reaped.
            # Ignore only a positively absent/terminal task, not an unreadable live one.
            try:
                terminal = (proc / 'stat').read_text().rsplit(') ', 1)[1].split()[0] in ('Z', 'X')
            except FileNotFoundError:
                terminal = True
            except OSError:
                terminal = False
            if not terminal:
                unreadable.append({'pid': int(proc.name), 'error': type(error).__name__})
    return dict(schema='startup-current-os-v1', observed_at=time.time(), boot_id=boot,
                uid=uid, pids=sorted(pids), scopes=sorted(scopes), matched=sorted(matched),
                unreadable=unreadable, mutations=0, provider_calls=0)


def validate(receipt, owner, proof, adapter, request, runs, cli_text, document, bound, used):
    from deploy_test_native_cleanup import KIND, need
    from deploy_test_cloud import campaign_published
    import runpy
    root = Path(owner['worker_root'])
    campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
    need(proof.get('purpose') == 'isolated-validation' and proof.get('campaign') == str(campaign)
         and not proof.get('controller_log') and not proof.get('recovered_runtime')
         and owner['native_cleanup_reference']['native_directory'] == str(campaign), 'legacy isolation binding')
    need(receipt['source'].get('head') == SOURCE, 'unaudited legacy producer/source')
    frozen = subprocess.check_output(['git', '-C', str(root), 'show',
                                     receipt['source']['head'] + ':scripts/run-bench-campaign.py'])
    need(hashlib.sha256(frozen).hexdigest() == PRODUCER, 'unaudited legacy producer')
    # The audited producer catches this exact failure before its dispatch loop.
    # Later failures and generic empty summaries cannot enter this path.
    message = "Campaign inventory did not initialize; see private publisher log (FileNotFoundError: [Errno 2] No such file or directory: 'flyctl')"
    need(str(campaign) in cli_text and cli_text.splitlines().count(message) == 1
         and 'Campaign inventory: one parent-owned native feed for all cloud controllers; capacity and resource mutation checks remain live' in cli_text.splitlines(),
         'legacy native pre-dispatch trace missing')
    summary = document(campaign / 'summary.json')
    allowed = {'campaign_id','started_at','finished_at','status','runs','concurrency','task_count','total_jobs',
               'peak_concurrency','jobs','retry_infra','e2e_started_at_epoch','e2e_timeout_seconds',
               'e2e_timeout_exceeded','shared_inventory_failed','wall_clock_seconds','e2e_wall_clock_seconds'}
    checks, jobs = request['checks'], summary.get('jobs')
    need(set(summary) <= allowed and summary.get('status') == 'failed'
         and summary.get('shared_inventory_failed') is True and type(summary.get('peak_concurrency')) is int
         and summary['peak_concurrency'] == 0 and summary.get('runs') == 1 and summary.get('retry_infra') == 0
         and summary.get('campaign_id') == campaign.name and isinstance(jobs,list)
         and checks and len(set(checks)) == len(checks) and len(jobs) == len(checks)
         and summary.get('task_count') == summary.get('total_jobs') == len(checks), 'legacy native inventory')
    need(adapter.get('native_command') == ['bash','scripts/run-bench',*checks,'--runs','1',
             '--concurrency',str(summary.get('concurrency')),'--retry-infra','0','--ref',SOURCE]
         and isinstance(receipt.get('command'),list) and len(receipt['command']) == 2
         and receipt['command'][1] == str(root/'scripts/deploy_test_cloud.py'), 'legacy original adapter command')
    keys = {'index','job_id','task','run','status','controller_exit_code','started_at','finished_at',
            'wall_clock_seconds','controller_lock','log','attempt','attempts'}
    need(all(isinstance(j,dict) and set(j) == keys for j in jobs)
         and {j['task'] for j in jobs} == set(checks)
         and all(j['index'] == i and j['job_id'] == f'r001-j{i:04d}' and j['run'] == j['attempt'] == 1
                 and j['status'] == 'cancelled' and j['attempts'] == []
                 and j['controller_exit_code'] is j['started_at'] is j['finished_at'] is j['wall_clock_seconds'] is None
                 and j['log'] == str(campaign/(j['job_id']+'.log')) for i,j in enumerate(jobs,1)),
         'legacy dispatched/resource evidence')
    need(runs.is_dir() and not runs.is_symlink() and not any(runs.iterdir())
         and not any(campaign.glob('r001-*.log')) and not (campaign/'shared-relay').exists(), 'legacy participant closure')
    # Bind the *executed* original publisher inputs, not newly generated source.
    for name, relative in INVENTORY.items():
        actual = bound(campaign/'shared-inventory/scripts'/name)
        expected = subprocess.check_output(['git','-C',str(root),'show',receipt['source']['head']+':'+relative])
        need(actual == expected, 'legacy executed source mismatch')
    location = document(campaign/'shared-relay-location.json')
    need(set(location) == {'directory'} and isinstance(location['directory'],str), 'legacy relay location')
    relay = Path(location['directory'])
    need(relay.is_absolute() and relay.resolve() == relay and relay.is_dir() and not relay.is_symlink()
         and not any(relay.iterdir()), 'legacy relay startup ambiguity')
    # This snapshot is explicitly a later investigator observation of existing
    # native lock text. It must not be named or interpreted as a producer checkpoint.
    observation = document(Path(proof['investigator_observation']))
    need(set(observation) == {'schema','observed_at','peer_record','os'}
         and observation['schema'] == 'legacy-startup-investigation-v1'
         and type(observation['observed_at']) in (int,float)
         and receipt['finished_at'] <= observation['observed_at'] <= proof['confirmed_at'], 'legacy observation clock')
    match = re.fullmatch(r'pid=([0-9]+) campaign=' + re.escape(str(campaign)) + r'\n', observation['peer_record'])
    need(match is not None, 'legacy parent/campaign native record')
    parent = int(match[1])
    lock = bound(campaign/'shared-inventory/machines-refresh.lock').decode()
    rows = dict(line.split('=',1) for line in lock.splitlines())
    need(set(rows) == {'host','pid','pid_start','token'} and rows['host'] == os.uname().nodename
         and re.fullmatch(r'proc-start:[0-9a-f-]{36}:[0-9]+',rows['pid_start'])
         and rows['pid'].isdigit() and int(rows['pid']) > 1 and parent > 1, 'legacy native inventory identity')
    health_path=Path(proof['inventory_health'])
    need(health_path.name == 'health' and health_path.parent.parent == campaign/'shared-inventory/inventory'
         and health_path.parent.name.startswith('.generation-'), 'legacy publisher health location')
    health=dict(line.split('=',1) for line in bound(health_path).decode().splitlines())
    token=re.fullmatch(r'[0-9]+\.[0-9]+\.([0-9]+)\.[0-9]+',health.get('publisher_token',''))
    need(set(health) == {'publisher_token','valid_until','generation'} and token is not None
         and int(token[1]) > 1 and health['generation'] == health_path.parent.name,
         'legacy native publisher identity')
    scopes = [str(campaign),str(runs),str(relay),health['publisher_token']]
    pids = {parent,int(rows['pid']),int(token[1])}
    os_record = observation['os']
    current = observe(pids,scopes)
    need(os_record.get('boot_id') == current['boot_id'] == rows['pid_start'].split(':')[1]
         and os_record.get('schema') == current['schema'] and os_record.get('uid') == current['uid']
         and os_record.get('pids') == current['pids'] and os_record.get('scopes') == current['scopes']
         and receipt['finished_at'] <= os_record.get('observed_at',0) <= proof['confirmed_at']
         and os_record.get('matched') == current['matched'] == []
         and os_record.get('unreadable') == current['unreadable'] == []
         and os_record.get('mutations') == os_record.get('provider_calls') == 0, 'legacy current execution unproven: ' + repr(dict(record=os_record, current=current)))
    from datetime import datetime
    start,finish=(datetime.fromisoformat(summary[k]).timestamp() for k in ('started_at','finished_at'))
    need(adapter['started_at'] <= start <= finish <= receipt['finished_at']
         and adapter.get('complete') is False and adapter.get('cleanup_complete') is False
         and adapter.get('native_exit') == receipt.get('native_exit') == 1
         and adapter.get('cases') == receipt.get('cases') == dict.fromkeys(checks,'UNVERIFIED'), 'legacy original outcomes')
    for name in ('hub-group.json','hub-group-publication-ack.private.json'):
        document(campaign/name)
    native=runpy.run_path(str(Path(__file__).with_name('run-bench-campaign.py')))
    need(campaign_published(summary,campaign,adapter['started_at'],native), 'legacy publication closure')
    need(used == set(proof['files']), 'legacy proof file closure')
    need(isinstance(proof.get('validation_source'),dict) and set(proof['validation_source']) == {'head','digest'},
         'legacy new validation source')
    return dict(kind=KIND,gate=receipt['gate'],token=receipt['token'],owner=copy.deepcopy(owner),
        worker_result_sha256=proof['worker_result_sha256'],proof=copy.deepcopy(proof),participants=[],native_audit_seals={},
        retained_services=[dict(path=str(campaign),disposition='unresolved-original-startup-obligation'),
                           dict(path=str(relay),disposition='unresolved-original-startup-obligation')],
        purpose='isolated-validation',validation_source=proof['validation_source'],excluded_resources={},
        obligations_preserved=True,cleanup_complete=False,credit_granted=False)
