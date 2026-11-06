"""Cleanup-only proof for joined controllers rejected before fleet admission."""
import copy
import hashlib
import json
import re
import runpy
import subprocess
from datetime import datetime
from pathlib import Path

SOURCES = ('scripts/run-bench-campaign.py', 'scripts/run-bench', 'scripts/run-bench-fleet',
           'scripts/lib/cloudbench-env.sh', 'scripts/cloudbench-shared-relay.py')
INVENTORY_SOURCES = ('scripts/cloudbench-campaign-inventory.sh', 'scripts/lib/cloudbench-inventory.sh',
                     'scripts/lib/cloudbench-env.sh', 'scripts/cloudbench-machine-readiness.py',
                     'scripts/cloudbench-campaign-machines.py')

# Reviewed pre-fleet failure boundary: future producer changes require a fresh
# proof review, even when they are committed and match the current checkout.
REVIEWED_SOURCES = {
    'scripts/run-bench-campaign.py': '2659729480ec12c10bac14ef264e01528b97b4efaf7b5f88cdcbf1054323c93a',
    'scripts/run-bench': 'd6a63399d3ae00ae83d469f06ad44870a57ad13a85c99703366137012fc1420e',
    'scripts/run-bench-fleet': 'db6ca7938e1ca359402f6cf678569cca8a5562a721ccf8dfd47a53db5f37b429',
    'scripts/lib/cloudbench-env.sh': 'fe203ad691d840b104c208d390d5185290971ac721c859f8c787a4969cabfa8c',
    'scripts/cloudbench-shared-relay.py': 'b78c08d85c41cc8ddf1af33a09f16e50f3ec9fd0026733330d1bab20ff8ee48c',
    'scripts/cloudbench-campaign-inventory.sh': 'e924d72f258bd5b2507348e5b53143aa4c2afa1c410cd63bdf495f27dfd2082d',
    'scripts/lib/cloudbench-inventory.sh': '01dc00ebba29ea4307f78774c3d8d73fd214c64f06fda1d00fc86df24c08b8e2',
    'scripts/cloudbench-machine-readiness.py': '5843e509a64380711147b140c346e81622a2f904b300d3af5a247415f5488797',
    'scripts/cloudbench-campaign-machines.py': 'e85eb826790c70e87b4d397467e01b2d1f9e805ce1efedb458edc16bff60353b',
}


def process_birth(pid):
    """Read one exact Linux process identity; permission/read errors fail closed."""
    from deploy_test_native_cleanup import need
    need(type(pid) is int and pid > 1, 'ref preflight process identity')
    try:
        row = Path('/proc', str(pid), 'stat').read_text().rsplit(') ', 1)[1].split()
        if row[0] in ('Z', 'X'):
            return None
        return 'proc-start:' + Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + row[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def retired(pid, stamp):
    from deploy_test_native_cleanup import need
    need(isinstance(stamp, str) and re.fullmatch(r'proc-start:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9]+', stamp),
         'ref preflight process birth missing')
    need(process_birth(pid) != stamp, 'ref preflight process still live')


def relay_retired(campaign, root, bound, document):
    from deploy_test_native_cleanup import finite, need
    live = Path(document(campaign / 'shared-relay-location.json')['directory'])
    archive = campaign / 'shared-relay'
    need(live.is_absolute() and live.parent == Path('/tmp') and live.name.startswith('cb-relay-')
         and live.resolve() == live and live.is_dir() and not live.is_symlink()
         and archive.is_dir() and not archive.is_symlink(), 'ref preflight relay directory')
    required = {'authority.private.json', 'ready.json', 'serve.once.json', 'bootstrap-owner.json',
                'broker-owner.json', 'broker.private.log', 'bootstrap.private.log'}
    allowed = required | {'app-metadata.private.json', 'fly-agent.sock.lock', 'fly-agent.sock.start.lock'}
    # No admitted route records or unsupported resources are allowed in this
    # pre-fleet shape. The stopped live directory must match its native archive.
    snapshots = []
    for directory in (archive, live):
        values = {}
        for path in directory.rglob('*'):
            need(not path.is_symlink(), 'ref preflight redirected relay member')
            if path.is_dir():
                need(path.name == 'leases' and not any(path.iterdir()), 'ref preflight admitted relay route')
                continue
            relative = str(path.relative_to(directory))
            need(path.is_file() and relative in allowed, 'ref preflight relay acquired resources')
            values[relative] = bound(path)
        need(required <= set(values), 'ref preflight relay lifecycle incomplete')
        snapshots.append(values)
    need(snapshots[0] == snapshots[1], 'ref preflight live/archive relay mismatch')
    auth = document(archive / 'authority.private.json')
    ready = document(archive / 'ready.json')
    once = document(archive / 'serve.once.json')
    broker = document(archive / 'broker-owner.json')
    bootstrap = document(archive / 'bootstrap-owner.json')
    digest = hashlib.sha256(snapshots[0]['authority.private.json']).hexdigest()
    need(auth.get('schema') == 'shared-relay-authority-v1'
         and auth.get('source_sha256') == hashlib.sha256(bound(root / 'scripts/cloudbench-shared-relay.py')).hexdigest()
         and auth.get('inventory_directory') == str(campaign / 'shared-inventory')
         and auth.get('agent_socket') == str(live / 'fly-agent.sock')
         and ready.get('socket') == str(live / 'control.sock') and finite(auth.get('deadline')),
         'ref preflight relay authority binding')
    need(all(value.get('pid') == broker.get('pid') and value.get('birth') == broker.get('birth')
             and value.get('authority_sha256') == digest for value in (ready, once)),
         'ref preflight broker readiness binding')
    parent = auth.get('parent_pid'), auth.get('parent_start')
    need(all((value.get('parent_pid'), value.get('parent_start')) == parent for value in (broker, bootstrap)),
         'ref preflight auxiliary parent binding')
    publisher = auth.get('inventory_owner')
    agent = ready.get('agent')
    need(isinstance(publisher, dict) and isinstance(agent, dict)
         and str(publisher.get('parent_pid')) == str(parent[0]) and publisher.get('parent_start') == parent[1]
         and publisher.get('app') == auth.get('app') and isinstance(publisher.get('token'), str)
         and publisher['token'] and str(publisher.get('pid', '')).isdigit(),
         'ref preflight inventory authority binding')
    identities = [parent, (broker.get('pid'), broker.get('birth')),
                  (bootstrap.get('pid'), bootstrap.get('birth')), (agent.get('pid'), agent.get('birth')),
                  (int(publisher['pid']), publisher.get('pid_start'))]
    for pid, stamp in identities:
        retired(pid, stamp)
    replies = []
    for line in snapshots[0]['broker.private.log'].decode().splitlines():
        try:
            replies.append(json.loads(line))
        except ValueError:
            continue
    need(sum(isinstance(reply, dict) and set(reply) == {'stopped'} and reply['stopped'] is True for reply in replies) == 1,
         'ref preflight positive broker shutdown missing')
    inventory = campaign / 'shared-inventory'
    need(bound(inventory / 'stop') == b'' and not (inventory / 'owner').exists(),
         'ref preflight inventory still owned')
    bound(inventory / 'publisher.private.log')
    return live, {pid for pid, _ in identities}


def validate_ref_preflight(receipt, owner, proof, adapter, root, runs, cli_text, bound, document):
    from deploy_test_cloud import campaign_published
    from deploy_test_native_cleanup import finite, need
    need(proof.get('purpose') is None, 'ref preflight proof supports cleanup only')
    identity = receipt.get('source')
    head = identity.get('head') if isinstance(identity, dict) else None
    need(isinstance(head, str) and re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', head),
         'ref preflight receipt head invalid')
    campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
    need(proof.get('campaign') == str(campaign) and not proof.get('controller_log')
         and owner['native_cleanup_reference']['native_directory'] == str(campaign)
         and str(campaign) in cli_text, 'ref preflight campaign binding')
    request = document(Path(receipt['log']).parent / 'request.json')
    summary = document(campaign / 'summary.json')
    checks, jobs = request.get('checks'), summary.get('jobs')
    need(isinstance(checks, list) and checks and len(set(checks)) == len(checks)
         and receipt.get('cases') == adapter.get('cases') and set(receipt['cases']) == set(checks)
         and all(value == 'UNVERIFIED' for value in receipt['cases'].values())
         and adapter.get('complete') is False and adapter.get('cleanup_complete') is False,
         'ref preflight wholly unverified execution required')
    need(all(type(summary.get(k)) is int for k in ('runs', 'retry_infra', 'task_count', 'total_jobs'))
         and summary.get('campaign_id') == campaign.name and summary.get('runs') == 1
         and summary.get('retry_infra') == 0 and summary.get('status') == 'failed'
         and summary.get('task_count') == summary.get('total_jobs') == len(checks)
         and isinstance(jobs, list) and len(jobs) == len(checks) and all(isinstance(j, dict) for j in jobs)
         and {j.get('task') for j in jobs} == set(checks)
         and type(summary.get('peak_concurrency')) is int and 1 <= summary['peak_concurrency'] <= len(checks)
         and not any(summary.get(k) for k in ('startup_cohorts', 'shared_transport_cleanup_pending',
                                             'cleanup_ticket_failure', 'shared_inventory_failed')),
         'ref preflight failed campaign inventory')
    canonical = Path(__file__).resolve().parents[1]
    need(proof.get('producer_source') == str(root / SOURCES[0]), 'ref preflight producer path')
    # Pin the exact producer, including the early-return branch before detach,
    # Fly setup, controller locks and fleet creation. A fatal string alone is not proof.
    for relative in set(SOURCES + INVENTORY_SOURCES):
        try:
            admitted = subprocess.check_output(['git', '-C', str(root), 'show', head + ':' + relative])
        except subprocess.SubprocessError:
            raise ValueError('ref preflight admitted producer source unavailable') from None
        need(hashlib.sha256(admitted).hexdigest() == REVIEWED_SOURCES[relative]
             and admitted == (canonical / relative).read_bytes(), 'ref preflight producer source changed')
        if relative in SOURCES:
            need(bound(root / relative) == admitted, 'ref preflight producer snapshot changed')
        if relative in INVENTORY_SOURCES:
            need(bound(campaign / 'shared-inventory/scripts' / Path(relative).name) == admitted,
                 'ref preflight inventory source changed')
    start, finish = (datetime.fromisoformat(summary[k]).timestamp() for k in ('started_at', 'finished_at'))
    need(finite(start) and finite(finish) and adapter['started_at'] <= start <= finish
         <= receipt['finished_at'] <= proof['confirmed_at'], 'ref preflight terminal clocks')
    marker = f'FATAL: requested benchmark commit {head} is not fetchable from origin and local patch shipping is disabled'
    job_ids, pids = set(), set()
    for job in jobs:
        job_id, pid = job.get('job_id'), job.get('controller_pid')
        need(isinstance(job_id, str) and re.fullmatch(r'r001-j[0-9]{4}', job_id) and job_id not in job_ids
             and type(pid) is int and pid > 1 and pid not in pids
             and all(type(job.get(k)) is int for k in ('run', 'attempt', 'controller_exit_code'))
             and job.get('run') == job.get('attempt') == 1 and job.get('attempts') == []
             and job.get('status') == 'failed' and job.get('controller_exit_code') == 1,
             'ref preflight terminal controller missing')
        began, ended = (datetime.fromisoformat(job[k]).timestamp() for k in ('started_at', 'finished_at'))
        need(start <= began <= ended <= finish, 'ref preflight controller clocks')
        log = campaign / (job_id + '.log')
        need(job.get('log') == str(log), 'ref preflight controller log binding')
        lines = bound(log).decode().splitlines()
        need(lines and lines.count(marker) == 1 and lines[-1] == marker
             and not any(str(root / 'scripts/run-bench') + ' monitor ' in line for line in lines),
             'ref preflight positive unallocated rejection missing')
        need(process_birth(pid) is None, 'ref preflight controller still live')
        job_ids.add(job_id); pids.add(pid)
    need(job_ids == {f'r001-j{i:04d}' for i in range(1, len(checks) + 1)},
         'ref preflight original job inventory')
    need(runs.is_dir() and not runs.is_symlink() and not any(runs.iterdir()),
         'ref preflight native run admitted')
    live, auxiliaries = relay_retired(campaign, root, bound, document)
    processes = subprocess.check_output(['ps', '-ax', '-o', 'pid=,pgid=,stat=,args='], text=True)
    for line in processes.splitlines():
        row = line.split(None, 3)
        if len(row) < 4 or row[2].startswith('Z'):
            continue
        need(int(row[0]) not in pids | auxiliaries and int(row[1]) not in pids | auxiliaries
             and not any(str(path) in row[3] for path in (campaign, runs, live)),
             'ref preflight controller or auxiliary process still active')
    for name in ('hub-group.json', 'hub-group-publication-ack.private.json'):
        document(campaign / name)
    native = runpy.run_path(str(canonical / 'scripts/run-bench-campaign.py'))
    need(campaign_published(summary, campaign, adapter['started_at'], native),
         'ref preflight publication missing')
    return {'kind': 'native-cloud-cleanup-v1', 'gate': receipt['gate'], 'token': receipt['token'],
            'owner': copy.deepcopy(owner), 'worker_result_sha256': proof['worker_result_sha256'],
            'proof': copy.deepcopy(proof), 'participants': [], 'native_audit_seals': {},
            'retained_services': [], 'credit_granted': False, 'preflight_no_allocation': True}
