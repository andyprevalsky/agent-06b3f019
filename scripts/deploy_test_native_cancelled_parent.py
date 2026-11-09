"""Validate isolated cancellation custody without granting test or cleanup credit."""
import hashlib
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path

REVIEWED_SOURCES = {'scripts/deploy_test_cloud.py': '207fa1224ad0d75c2c05525ce02a4a1db518a7aacc2cd65d7ced920b9b2482bc', 'scripts/run-bench': 'd6a63399d3ae00ae83d469f06ad44870a57ad13a85c99703366137012fc1420e', 'scripts/run-bench-campaign.py': '2659729480ec12c10bac14ef264e01528b97b4efaf7b5f88cdcbf1054323c93a', 'scripts/run-bench-fleet': 'db6ca7938e1ca359402f6cf678569cca8a5562a721ccf8dfd47a53db5f37b429', 'scripts/cloudbench_execution_provenance.py': '25c3d3b7cd13370c86ce0a36d68660f005096a71be79a77bfbe1ef1390fb019f', 'scripts/cloudbench-script-snapshot.py': 'fc6fabcdf8724d28d5bedbf5c87019ca92d930beafbf817b489cc405d186bfbd'}


def cancelled_parent_admission(receipt, proof, adapter, root, parents, participants, bound, document, tree):
    from deploy_test_native_cleanup import need
    listed = proof.get('cancelled_parent_admission', [])
    need(proof.get('purpose') == 'isolated-validation' and proof.get('layout') == 'campaign-v1'
         and isinstance(listed, list) and listed and all(isinstance(p, str) for p in listed)
         and len(listed) == len(set(listed)), 'cancelled parent scope')
    selected = {Path(p) for p in listed}
    need(selected <= set(parents) <= participants, 'cancelled parent original inventory')
    head = receipt['source']['head']
    need(isinstance(head, str) and re.fullmatch('[0-9a-f]{40}', head), 'cancelled parent full source')
    for name, expected in REVIEWED_SOURCES.items():
        original = subprocess.check_output(['git', '-C', str(root), 'show', head + ':' + name])
        need(hashlib.sha256(original).hexdigest() == expected, 'cancelled parent producer changed')
    # Preserve historical proof closure while validating source bytes at its original commit.
    for filename in proof['files']:
        path = Path(filename)
        if path.is_relative_to(root / 'scripts'):
            bound(path, historical_head=head)
    request = document(Path(receipt['log']).parent / 'request.json')
    summary = document(Path(proof['campaign']) / 'summary.json')
    width = summary['concurrency']
    need(type(width) is int and width > 0 and adapter.get('native_command') ==
         ['bash', 'scripts/run-bench', *request['checks'], '--runs', '1', '--concurrency', str(width),
          '--retry-infra', '0', '--ref', head], 'cancelled parent ordinary request only')
    failures = [job for job in summary['jobs'] if job['status'] == 'failed'
                and type(job['controller_exit_code']) is int and job['controller_exit_code'] == 1]
    need(len(failures) == 1, 'cancelled parent primary failure')
    trigger = datetime.fromisoformat(failures[0]['finished_at']).timestamp()
    pids = set()
    for fleet in selected:
        pid = int(fleet.name.rsplit('-', 1)[-1])
        jobs = [job for job in summary['jobs'] if type(job['controller_pid']) is int
                and job['controller_pid'] == pid]
        need(len(jobs) == 1 and pid > 1 and pid not in pids, 'cancelled parent controller identity')
        pids.add(pid)
        job = jobs[0]
        start = datetime.fromisoformat(job['started_at']).timestamp()
        finish = datetime.fromisoformat(job['finished_at']).timestamp()
        need(job['status'] == 'cancelled' and type(job['controller_exit_code']) is int
             and job['controller_exit_code'] == 143 and start <= trigger <= finish,
             'cancelled parent positive cancellation')
        lines = bound(Path(job['log'])).decode().splitlines()
        need(sum(re.fullmatch(r'⚰️  controller received TERM \([0-9]{2}:[0-9]{2}:[0-9]{2}\)', line)
                 is not None for line in lines) == 1, 'cancelled parent TERM receipt')
        # Full pinned ordinary-path source orders task provenance before primary
        # task provisioning; pre-task pool/donor effects remain separate custody.
        life = document(fleet / '_batch/lifecycle.json')
        need(life['status'] == 'failed' and type(life['controller_exit_code']) is int
             and life['controller_exit_code'] == 143, 'cancelled parent lifecycle')
        benches = json.loads(bound(fleet / '_batch/benches.json'))
        run = document(fleet / '_batch/run.json')
        from deploy_test_native_admission import validate_parent
        # Reuses ALL exact sealed mirrored zero-ownership/projection/no-metadata guards.
        validate_parent(fleet, life, benches, run, root, bound, document, tree)
        disposable = document(fleet / '_batch/disposable-cleanup.json')
        need(disposable.get('schema') == 'disposable-cleanup-v1' and disposable.get('owner') == life['fleet_owner_token']
             and disposable.get('guest_cleanup_missing') is False and disposable.get('runtime_evidence_missing') is False,
             'cancelled parent disposable closure')
    return frozenset(selected)
