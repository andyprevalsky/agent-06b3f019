"""Cleanup-only proof for a full-width campaign refused before ticket preparation."""
import copy
import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
import re
import runpy
import subprocess

SOURCE_ROOT = Path(__file__).resolve().parents[1]


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
})


CURRENT_PREPARE_SOURCE = '7b68f4f7cde6a8cd1c4edfcbe119f1514b706045'
CURRENT_PREPARE_PRODUCERS = {
    'run-bench-campaign.py': '36af2da9ad2b18a9f5dcb98693bd532dad87e40ba6e28177ec5b018b57d9cba1',
    'cloudbench-cleanup-tickets.py': 'b67ac4790306e542a06b2ad607d88b9582c8173f2eecc37cdcffc3df991b4734',
    'run-bench': '3b7192bbbe15e6fa050c5d06cfc163149901b3b22917d6416fcd7e0d563661c4',
    'deploy_test_cloud.py': '96badb95c00fd2a735a7ddeb7f1e5616eb336c389534ca85ae71264b1c808e29',
}
# Full original no-retry certificate, including its historical identities and zero-credit fields.
CURRENT_PREPARE_CUSTODY_SHA256 = '70331adcc9f36c3dff5ee25828b890b517f94f88a78942805aec6ddaffb2bab2'
CURRENT_PREPARE_CHECKS = (
    'test-mass-agent-run-0', 'chat-mode', 'spawn-sub-agents', 'parallel-tool-calls',
    'background-agent-message-smoke', 'claude-code-agent', 'browser-smoke',
    'agent-payment-test-shop', 'agent-payment-setup-resume', 'agent-payment-idempotent-abandonment',
    'browser-biometrics-webdecoy', 'agent-payment-new-user-journey',
)


def grant_path(root, budget):
    from deploy_test_native_cleanup import fleet_ownership_root
    reserve = fleet_ownership_root(root)
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
    current = observed == CURRENT_PREPARE_PRODUCERS
    source_bound = proof.get('source_bound_prepare') is True
    if source_bound:
        # Use the installed reviewed producers, not another historical hash allowlist.
        # Both commits and the installed files must have the exact failed producer bytes.
        for name, original in originals.items():
            installed = SOURCE_ROOT / 'scripts' / name
            need(installed.is_file() and not installed.is_symlink()
                 and installed.read_bytes() == original
                 and subprocess.check_output(['git', '--no-replace-objects', '-C',
                     str(SOURCE_ROOT), 'show', 'HEAD:scripts/' + name]) == original,
                 'prepare installed producer differs')
    need(source_bound or current or any(observed == reviewed for reviewed in REVIEWED_SOURCE_SETS), 'prepare producer changed')
    if current:
        need(receipt['source'] == {'head': CURRENT_PREPARE_SOURCE,
             'digest': 'b4caeead07132658dcc875c1231be33a9ec9c916ec36830d5e0ab7e2b53418a9'},
             'prepare current source')
    for name, original in originals.items():
        need(bound(root / 'scripts' / name, historical_head=head) == original, 'prepare producer changed')
    campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
    need(proof.get('campaign') == str(campaign) and str(campaign) in cli_text
         and owner['native_cleanup_reference']['native_directory'] == str(campaign)
         and adapter.get('fleet_directory') == str(campaign), 'prepare campaign root')
    request = document(Path(receipt['log']).parent / 'request.json')
    summary = document(campaign / 'summary.json')
    checks, jobs = request['checks'], summary.get('jobs')
    need(isinstance(checks, list) and all(isinstance(c, str) for c in checks), 'prepare unexecuted cases')
    count = 12 if current else 14
    if source_bound:
        from deploy_test_historical_custody import guard, state_identity
        from deploy_test_cycle import digest
        ledger = document(Path(proof.get('custody_ledger', '')))
        need(ledger.get('source') == receipt['source']
             and state_identity(ledger) == request.get('custody_state_sha256')
             and digest(ledger['plan']) == ledger.get('plan_digest'), 'prepare custody ledger binding')
        gates = [g for g in ledger['plan']['gates'] if g.get('name') == receipt['gate']]
        need(len(gates) == 1, 'prepare custody gate')
        gate = gates[0]
        current_binding = {k: ledger[k] for k in ('source', 'plan_digest', 'environment', 'input_fingerprints')}
        expected = guard(ledger, gate, root, current=current_binding)
        need(request.get('skips') == expected and receipt.get('custody_skips') == expected
             and request['checks'] == [name for name in gate['checks'] if name not in expected]
             and request['checks'] == list(CURRENT_PREPARE_CHECKS) +
                 ['browser-auth-guest-purchase', 'browser-auth-member-discount-purchase']
             and set(expected) == {'agent-payment-abandonment'}, 'prepare custody inventory')
    expected_cases = dict.fromkeys(checks, 'UNVERIFIED')
    if current or source_bound:
        skips = request.get('skips', {})
        protected = skips.get('agent-payment-abandonment', {})
        need((source_bound or checks == list(CURRENT_PREPARE_CHECKS))
             and set(skips) == {'agent-payment-abandonment'}
             and protected.get('kind') == 'historical-agentcard-no-retry-v1'
             and protected.get('disposition') == 'NO_RETRY_CUSTODY'
             and protected.get('source') == receipt['source'], 'prepare current inventory/custody')
        need(receipt.get('custody_skips') == skips
             and (source_bound or hashlib.sha256(json.dumps(protected, sort_keys=True, separators=(',', ':'),
                                           allow_nan=False).encode()).hexdigest() == CURRENT_PREPARE_CUSTODY_SHA256),
             'prepare full historical custody certificate')
        need(adapter.get('native_command') == ['bash', 'scripts/run-bench', *checks,
             '--runs', '1', '--concurrency', str(count), '--retry-infra', '0', '--ref', head],
             'prepare exact native command')
        expected_cases['agent-payment-abandonment'] = 'SKIP'
        need(summary.get('cleanup_ticket_error') == {
            'type': 'ValueError', 'message': 'insufficient physical cleanup cohort floors'},
            'prepare positive refusal')
        need(not any(proof.get(k) for k in ('credit_granted', 'financial_cleanup_credit', 'transfer_credit')),
             'prepare cleanup only')
    need(isinstance(checks, list) and len(checks) == len(set(checks)) == count
         and (current or source_bound or not request.get('skips'))
         and receipt['cases'] == expected_cases and adapter['cases'] == dict.fromkeys(checks, 'UNVERIFIED')
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
    if current or source_bound:
        logs = [runs.parent / 'cli.log', campaign / 'shared-relay/broker.private.log',
                campaign / 'shared-inventory/publisher.private.log', campaign / 'hub-group-publication.private.log']
        for path in logs:
            bound(path)
        observed = logs + [campaign / 'summary.json', Path(receipt['log']).parent / 'request.json',
                           Path(receipt['log']).parent / 'receipt.json', Path(receipt['worker_result']),
                           cohort / 'manifest.json', budget / 'prepare.lock']
        holders = subprocess.run(['lsof', '-t', '--', *map(str, observed)], capture_output=True, timeout=10)
        need(holders.returncode == 1 and not holders.stdout and not holders.stderr,
             'prepare active writer or unknown observation')
    for name in ('hub-group.json', 'hub-group-publication-ack.private.json'):
        document(campaign / name)
    native = runpy.run_path(str(root / 'scripts/run-bench-campaign.py'))
    need(campaign_published(summary, campaign, adapter['started_at'], native), 'prepare terminal publication')
    return dict(kind=KIND, gate=receipt['gate'], token=receipt['token'], owner=copy.deepcopy(owner),
                worker_result_sha256=proof['worker_result_sha256'], proof=copy.deepcopy(proof),
                participants=[], native_audit_seals={}, retained_services=[], prepare_supervision=supervision,
                credit_granted=False)
