"""Launch-only reconciliation for the identified non-strict relay startup failure.

Strict-start campaigns with startup cohorts remain outside this proof shape.
"""
import copy
import hashlib
from datetime import datetime
from pathlib import Path
import re
import runpy
import subprocess


def validate_prelaunch(receipt, owner, proof, adapter, root, runs, cli_text, bound, document):
    from deploy_test_native_cleanup import need, fields
    from deploy_test_cloud import campaign_published
    campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
    need(proof.get('campaign') == str(campaign) and not proof.get('controller_log')
         and owner['native_cleanup_reference']['native_directory'] == str(campaign), 'prelaunch campaign binding')
    request = document(Path(receipt['log']).parent / 'request.json')
    summary = document(campaign / 'summary.json')
    jobs, checks = summary.get('jobs'), request.get('checks')
    need(receipt.get('cases') == adapter.get('cases')
         and set(receipt.get('cases', {})) == set(checks or [])
         and all(value == 'UNVERIFIED' for value in receipt['cases'].values())
         and adapter.get('complete') is False and adapter.get('cleanup_complete') is False,
         'prelaunch must preserve wholly unverified execution')
    need(isinstance(checks, list) and checks and len(set(checks)) == len(checks)
         and isinstance(jobs, list) and len(jobs) == len(checks)
         and all(isinstance(j, dict) for j in jobs)
         and {j.get('task') for j in jobs} == set(checks)
         and summary.get('campaign_id') == campaign.name and summary.get('runs') == 1
         and summary.get('retry_infra') == 0 and summary.get('status') == 'failed'
         and summary.get('task_count') == summary.get('total_jobs') == len(checks)
         and type(summary.get('peak_concurrency')) is int and summary['peak_concurrency'] == 0
         and summary.get('shared_inventory_failed') is True, 'prelaunch failed inventory inventory')
    need(len({j.get('job_id') for j in jobs}) == len(jobs)
         and all({'started_at', 'controller_exit_code', 'attempts'} <= set(j)
                 and re.fullmatch(r'r001-j[0-9]{4}', j.get('job_id', ''))
                 and j.get('run') == j.get('attempt') == 1 and j.get('attempts') == []
                 and j.get('status') == 'cancelled' and j.get('started_at') is None
                 and j.get('controller_pid') is None and j.get('controller_exit_code') is None
                 and j.get('log') == str(campaign / (j['job_id'] + '.log')) for j in jobs),
         'prelaunch jobs must never have started')
    start, finish = (datetime.fromisoformat(summary[k]).timestamp() for k in ('started_at', 'finished_at'))
    need(adapter['started_at'] <= start <= finish <= receipt['finished_at'] <= proof['confirmed_at'],
         'prelaunch terminal clocks')
    need(not any(summary.get(k) for k in ('startup_cohorts', 'shared_inventory', 'shared_transport_cleanup_pending',
                                         'cleanup_ticket_failure', 'e2e_timeout_exceeded')),
         'prelaunch shared resource state')
    marker = "Campaign inventory did not initialize; see private publisher log (FileNotFoundError: [Errno 2] No such file or directory: 'flyctl')"
    need(marker in cli_text and 'Campaign inventory: one parent-owned native feed for all cloud controllers;' in cli_text
         and str(campaign / 'summary.json') in cli_text, 'positive prelaunch relay failure required')
    # Pin the producer branch: the failing flyctl metadata read precedes relay/native process creation.
    source = Path(proof.get('producer_source', ''))
    producer = bound(source)
    canonical_root = Path(__file__).resolve().parents[1]
    need(producer == (canonical_root / 'scripts/run-bench-campaign.py').read_bytes()
         and producer == subprocess.check_output(['git', '-C', str(root), 'show',
                                                  receipt['source']['head'] + ':scripts/run-bench-campaign.py']),
         'prelaunch producer source differs from reviewed source')
    inventory = campaign / 'shared-inventory'
    for name, relative in (
        ('cloudbench-campaign-inventory.sh', 'scripts/cloudbench-campaign-inventory.sh'),
        ('cloudbench-inventory.sh', 'scripts/lib/cloudbench-inventory.sh'),
        ('cloudbench-env.sh', 'scripts/lib/cloudbench-env.sh'),
        ('cloudbench-machine-readiness.py', 'scripts/cloudbench-machine-readiness.py'),
        ('cloudbench-campaign-machines.py', 'scripts/cloudbench-campaign-machines.py')):
        need(bound(inventory / 'scripts' / name) == (canonical_root / relative).read_bytes(),
             'prelaunch inventory source changed')
    need(bound(inventory / 'stop') == b'', 'prelaunch publisher stop missing')
    lock = fields(bound(inventory / 'machines-refresh.lock'))
    pid = int(lock.get('pid', '0'))
    need(pid > 1 and lock.get('pid_start', '').startswith('proc-start:')
         and lock.get('token', '').startswith(str(pid) + '.'), 'publisher birth evidence missing')
    bound(inventory / 'publisher.private.log')
    relay = Path(document(campaign / 'shared-relay-location.json').get('directory', ''))
    need(relay.is_absolute() and relay.parent == Path('/tmp') and relay.name.startswith('cb-relay-')
         and relay.resolve() == relay and relay.is_dir() and not relay.is_symlink()
         and not list(relay.iterdir()), 'prelaunch relay acquired resources')
    need(runs.is_dir() and not runs.is_symlink() and not list(runs.iterdir())
         and not list(campaign.glob('r001-j*.log')) and not (inventory / 'owner').exists(),
         'prelaunch native admission or retained publisher exists')
    processes = subprocess.check_output(['ps', '-ax', '-o', 'pid=,pgid=,stat=,args='], text=True)
    for line in processes.splitlines():
        row = line.split(None, 3)
        if len(row) < 4 or row[2].startswith('Z'):
            continue
        need(int(row[0]) != pid and int(row[1]) != pid
             and not any(str(path) in row[3] for path in (campaign, runs, relay)),
             'prelaunch publisher/controller/service still active')
    for name in ('hub-group.json', 'hub-group-publication-ack.private.json'):
        document(campaign / name)
    native = runpy.run_path(str(canonical_root / 'scripts/run-bench-campaign.py'))
    need(campaign_published(summary, campaign, adapter['started_at'], native),
         'prelaunch publication or publisher cleanup missing')
    return {'kind': 'native-cloud-cleanup-v1', 'gate': receipt['gate'], 'token': receipt['token'],
            'owner': copy.deepcopy(owner), 'worker_result_sha256': hashlib.sha256(Path(receipt['worker_result']).read_bytes()).hexdigest(),
            'proof': copy.deepcopy(proof), 'participants': [], 'native_audit_seals': {},
            'retained_services': [], 'credit_granted': False, 'prelaunch_no_allocation': True}
