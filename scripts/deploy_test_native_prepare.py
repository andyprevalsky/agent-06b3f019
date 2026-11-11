"""Cleanup-only proof for a full-width campaign refused before ticket preparation."""
import copy
import hashlib
import os
from datetime import datetime
from pathlib import Path
import re
import runpy
import subprocess

REVIEWED_SOURCES = {
    'run-bench-campaign.py': 'f4ffbdc42c6b1b06b62fc55846b74a1f16bc88eacbec5f7a6476f6bfaca8990b',
    'cloudbench-cleanup-tickets.py': '29c2f6e4c71bf45a182f2beb59298e63f7a82e1e0bddd3956ac7d603a823c81b',
    'run-bench': 'd6a63399d3ae00ae83d469f06ad44870a57ad13a85c99703366137012fc1420e',
    'deploy_test_cloud.py': '6841691abdc6ba6a83cdeccf11053c65828b7cb863193fd5eb2a2902fb5c4d49',
}


# Reviewed complete producer combinations only; no per-file Cartesian acceptance.
REVIEWED_SOURCE_SETS = (REVIEWED_SOURCES, {
    **REVIEWED_SOURCES,
    'run-bench-campaign.py': '8fc428d19f3052b54daf785741f66291e6ac42adef8320be6bb18e2c9900c6f9',
    'cloudbench-cleanup-tickets.py': 'b67ac4790306e542a06b2ad607d88b9582c8173f2eecc37cdcffc3df991b4734',
}, {
    # PR1682 452e70ce: R59 admission diagnostics and typed completion boundaries; prepare path unchanged.
    'run-bench-campaign.py': '93adb28884d313ba4062d8297456daed96c3fbac1adb2240b1592db875b9319a',
    'cloudbench-cleanup-tickets.py': '6a629fb01e68427bc7b8f2998547ead01683f2d92498354f801d916687fa2fa2',
    'run-bench': 'e3b8c162354bfca92676b57a5317614c3d829f1611298026ec47f6f606a70f5b',
    'deploy_test_cloud.py': 'ae3bda6d0d866c21ab834ef285619b60fdce1924e9c0a705f8cc8a566810fb6f',
})


def grant_path(root, budget):
    reserve = root / '.git/cloudbench-fleet-ownership'
    info = reserve.lstat()
    from deploy_test_native_cleanup import need
    need(reserve.is_dir() and not reserve.is_symlink() and reserve.resolve() == reserve
         and info.st_uid == os.getuid() and not info.st_mode & 0o022, 'prepare reserve root identity')
    base = Path('/tmp') / ('rose-cloudbench-cleanup-admission-' + str(os.getuid()))
    for path in (base, base / str(info.st_dev), base / str(info.st_dev) / 'ticket-grants'):
        need(not path.is_symlink(), 'prepare global path symlink')
        if path.exists():
            value = path.lstat()
            need(path.is_dir() and path.resolve() == path and value.st_uid == os.getuid()
                 and not value.st_mode & 0o022, 'prepare global path identity')
    return base / str(info.st_dev) / 'ticket-grants' / (hashlib.sha256(str(budget).encode()).hexdigest() + '.json')


def validate_prepare(receipt, owner, proof, adapter, root, runs, cli_text, bound, document):
    from deploy_test_native_cleanup import KIND, finite, need, preallocation_processes
    from deploy_test_cloud import campaign_published
    need(proof.get('purpose') is None and not proof.get('recovered_runtime')
         and not proof.get('controller_log'), 'prepare cleanup only')
    head = receipt['source']['head']
    need(isinstance(head, str) and re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', head), 'prepare full source')
    originals = {name: subprocess.check_output(
        ['git', '--no-replace-objects', '-C', str(root), 'show', head + ':scripts/' + name])
        for name in REVIEWED_SOURCES}
    observed = {name: hashlib.sha256(raw).hexdigest() for name, raw in originals.items()}
    need(any(observed == reviewed for reviewed in REVIEWED_SOURCE_SETS), 'prepare producer changed')
    for name, original in originals.items():
        need(bound(root / 'scripts' / name, historical_head=head) == original, 'prepare producer changed')
    campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
    need(proof.get('campaign') == str(campaign) and str(campaign) in cli_text
         and owner['native_cleanup_reference']['native_directory'] == str(campaign)
         and adapter.get('fleet_directory') == str(campaign), 'prepare campaign root')
    # A prepare failure leaves cleanup incomplete, so no automatic rerun may exist.
    need('rerun' not in adapter and not (runs.parent / 'rerun').exists()
         and not (runs.parent / 'rerun').is_symlink(), 'prepare rerun absent')
    request = document(Path(receipt['log']).parent / 'request.json')
    summary = document(campaign / 'summary.json')
    checks, jobs = request['checks'], summary.get('jobs')
    # Historical NO_RETRY_CUSTODY cases are request skips that never dispatch; every
    # submitted check must stay UNVERIFIED with no execution credit.
    skips = request.get('skips') or {}
    custody = receipt.get('custody_skips') or {}
    need(isinstance(skips, dict) and skips == custody
         and all(isinstance(v, dict) and v.get('disposition') == 'NO_RETRY_CUSTODY' for v in skips.values())
         and (receipt.get('current_execution') or {}) == dict.fromkeys(skips, 'UNVERIFIED'), 'prepare custody skips')
    count = len(checks) if isinstance(checks, list) else 0
    need(isinstance(checks, list) and 1 <= count == len(set(checks)) <= 9999 and not set(checks) & set(skips)
         and receipt['cases'] == {**dict.fromkeys(skips, 'SKIP'), **dict.fromkeys(checks, 'UNVERIFIED')}
         and adapter['cases'] == dict.fromkeys(checks, 'UNVERIFIED')
         and adapter.get('complete') is False and adapter.get('cleanup_complete') is False, 'prepare unexecuted cases')
    need(summary.get('campaign_id') == campaign.name and summary.get('status') == 'failed'
         and summary.get('cleanup_ticket_failure') == 'prepare'
         and type(summary.get('peak_concurrency')) is int and summary['peak_concurrency'] == 0
         and all(type(summary.get(k)) is int and summary[k] == value for k, value in
                 [('runs', 1), ('retry_infra', 0), ('concurrency', count), ('task_count', count), ('total_jobs', count)])
         and not any(summary.get(k) for k in ('shared_inventory_failed', 'shared_transport_cleanup_pending',
                    'startup_cohorts', 'workspace_binding', 'e2e_timeout_exceeded'))
         and isinstance(jobs, list) and len(jobs) == count and all(isinstance(j, dict) for j in jobs), 'prepare terminal manifest')
    ids = {'r001-j%04d' % i for i in range(1, count + 1)}
    need({j.get('job_id') for j in jobs} == ids and {j.get('task') for j in jobs} == set(checks)
         and len({j.get('task') for j in jobs}) == count, 'prepare job inventory')
    for job in jobs:
        log = campaign / (job['job_id'] + '.log')
        need(job.get('status') == 'cancelled' and job.get('attempts') == []
             and all(type(job.get(k)) is int and job[k] == 1 for k in ('run', 'attempt'))
             and all(k in job and job[k] is None for k in ('controller_exit_code', 'started_at', 'finished_at', 'wall_clock_seconds'))
             and job.get('controller_pid') is None and job.get('log') == str(log)
             and not log.exists() and not log.is_symlink()
             and job.get('controller_command') == ['bash', str(root / 'scripts/run-bench'), job['task'], '--ref', head, '--foreground'],
             'prepare controller never dispatched')
    start, finish = (datetime.fromisoformat(summary[k]).timestamp() for k in ('started_at', 'finished_at'))
    need(finite(start) and finite(finish) and adapter['started_at'] <= start <= finish
         <= receipt['finished_at'] <= proof['confirmed_at'], 'prepare terminal clocks')
    def children(path, expected):
        need(path.is_dir() and not path.is_symlink() and path.resolve() == path
             and {p.name for p in path.iterdir()} == set(expected), 'prepare directory closure')
    children(runs, [])
    cohorts = campaign / 'cleanup-cohorts'; cohort = cohorts / 'c001'; budget = cohort / 'cleanup-budget'
    children(cohorts, ['parent.lock', 'c001']); children(cohort, ['manifest.json', 'ready', 'cleanup-budget'])
    children(cohort / 'ready', []); children(budget, ['prepare.lock'])
    need(bound(cohorts / 'parent.lock') == bound(budget / 'prepare.lock') == b'', 'prepare lock bytes')
    need(document(cohort / 'manifest.json') == {'cohort_id': 'c001', 'jobs': dict.fromkeys(sorted(ids))}, 'prepare cohort membership')
    cohort_rows = summary.get('cleanup_cohorts')
    need(cohort_rows == [dict(cohort_id='c001', status='queued', ready_count=0,
         expected_count=count, failed_count=0, released_count=0, released_at=None)]
         and all(type(cohort_rows[0][key]) is int for key in
                 ('ready_count', 'expected_count', 'failed_count', 'released_count')), 'prepare cohort state')
    grant = grant_path(root, budget)
    need(not grant.exists() and not grant.is_symlink(), 'prepare grant remains')
    supervision = preallocation_processes(root, runs, campaign, request, receipt, adapter, document, bound)
    need(supervision['orphaned_children'] is False and supervision['term_sent'] == []
         and supervision['kill_sent'] == [], 'prepare exact retirement')
    for name in ('hub-group.json', 'hub-group-publication-ack.private.json'):
        document(campaign / name)
    native = runpy.run_path(str(root / 'scripts/run-bench-campaign.py'))
    need(campaign_published(summary, campaign, adapter['started_at'], native), 'prepare terminal publication')
    return dict(kind=KIND, gate=receipt['gate'], token=receipt['token'], owner=copy.deepcopy(owner),
                worker_result_sha256=proof['worker_result_sha256'], proof=copy.deepcopy(proof),
                participants=[], native_audit_seals={}, retained_services=[], prepare_supervision=supervision,
                credit_granted=False)
