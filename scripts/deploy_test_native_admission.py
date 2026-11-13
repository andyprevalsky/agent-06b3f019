"""Cleanup-only parent admission rejection; no synthetic execution provenance."""
import hashlib
import re
import subprocess
from datetime import datetime
from pathlib import Path

# Filled with the reviewed producer bytes for this pre-provenance boundary.
REVIEWED_SOURCES = {'scripts/run-bench-fleet': 'db6ca7938e1ca359402f6cf678569cca8a5562a721ccf8dfd47a53db5f37b429', 'scripts/run-bench-campaign.py': '2659729480ec12c10bac14ef264e01528b97b4efaf7b5f88cdcbf1054323c93a', 'scripts/lib/cloudbench-env.sh': 'fe203ad691d840b104c208d390d5185290971ac721c859f8c787a4969cabfa8c', 'scripts/cloudbench_execution_provenance.py': '25c3d3b7cd13370c86ce0a36d68660f005096a71be79a77bfbe1ef1390fb019f'}


def validate_campaign(receipt, proof, root, runs, parents, participants, bound, document):
    from deploy_test_native_cleanup import need
    need(proof.get('purpose') is None and not proof.get('recovered_runtime'),
         'admission cleanup only; no isolated execution or recovery')
    head = receipt.get('source', {}).get('head')
    need(isinstance(head, str) and re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', head),
         'admission source head invalid')
    for relative, expected in REVIEWED_SOURCES.items():
        try:
            original = subprocess.check_output(['git', '-C', str(root), 'show', head + ':' + relative])
        except subprocess.SubprocessError:
            raise ValueError('admission producer source unavailable') from None
        need(hashlib.sha256(original).hexdigest() == expected
             and bound(root / relative, historical_head=head) == original,
             'admission producer boundary changed')
    campaign = Path(proof['campaign'])
    summary = document(campaign / 'summary.json')
    jobs = summary['jobs']
    failures = [job for job in jobs if job.get('status') == 'failed' and job.get('controller_exit_code') == 1]
    need(set(parents) == participants and len(parents) == len(jobs) == 10 and len(failures) == 1,
         'admission requires one rejecting owner and only original parents')
    failed = failures[0]
    rejected_at = datetime.fromisoformat(failed['finished_at']).timestamp()
    pids = set()
    marker = 'cleanup reserve admission failed: [Errno 28] insufficient physical cleanup floors for pending controllers'
    refusal = '❌ could not allocate the emergency fleet teardown disk reserve; refusing provider mutation'
    for job in jobs:
        pid = job['controller_pid']
        need(type(pid) is int and pid > 1 and type(job['controller_exit_code']) is int,
             'admission controller identity')
        need(pid not in pids, 'duplicate admission controller identity')
        pids.add(pid)
        start = datetime.fromisoformat(job['started_at']).timestamp()
        finish = datetime.fromisoformat(job['finished_at']).timestamp()
        campaign_start = datetime.fromisoformat(summary['started_at']).timestamp()
        campaign_finish = datetime.fromisoformat(summary['finished_at']).timestamp()
        need(campaign_start <= start <= finish <= campaign_finish, 'admission job clocks')
        log = Path(job['log'])
        lines = bound(log).decode().splitlines()
        independently_rejected = job.get('status') == 'cancelled' and job['controller_exit_code'] == 1
        if job is failed or independently_rejected:
            need(lines.count(marker) == lines.count(refusal) == 1
                 and lines.index(marker) < lines.index(refusal), 'positive reserve admission rejection missing')
            need(job is failed or start <= rejected_at <= finish,
                 'independent sibling admission clocks')
        else:
            need(job.get('status') == 'cancelled' and job['controller_exit_code'] == 143
                 and datetime.fromisoformat(job['started_at']).timestamp() <= rejected_at
                 <= datetime.fromisoformat(job['finished_at']).timestamp()
                 and any(re.fullmatch(r'⚰️  controller received TERM \([0-9]{2}:[0-9]{2}:[0-9]{2}\)', line) for line in lines),
                 'sibling cancellation boundary missing')
    processes = subprocess.check_output(['ps', '-ax', '-o', 'pid=,pgid=,stat='], text=True)
    for line in processes.splitlines():
        row = line.split()
        if len(row) >= 3 and not row[2].startswith('Z'):
            need(int(row[0]) not in pids and int(row[1]) not in pids, 'admission controller group still live')
    return frozenset(parents)


def validate_parent(fleet, life, benches, run, root, bound, document, tree):
    from deploy_test_native_cleanup import fields, need
    need(not (fleet / 'execution-provenance.json').exists()
         and not (fleet / 'execution-task-matrix.json').exists(), 'admission has execution metadata')
    names = {bench['name'] for bench in benches}
    tasks = run.get('tasks')
    need(run.get('run_id') == fleet.name and run.get('status') == 'failed'
         and type(run.get('controller_exit_code')) is int
         and run['controller_exit_code'] == life['controller_exit_code']
         and isinstance(tasks, list) and len(tasks) == len(names)
         and {task.get('name') for task in tasks} == names
         and all(task.get('status') == 'INFRA_ERROR' and task.get('passed') is False
                 and task.get('agent_id') is None and task.get('owned_roots') is None
                 and task.get('lifecycle_stage') == 'released'
                 and task.get('failure_reason') == 'no current run artifact produced' for task in tasks),
         'admission must preserve failed unexecuted projection')
    audit = fleet / 'teardown-ownership'
    canonical = root / '.git/cloudbench-fleet-audits' / life['fleet_owner_token']
    seal = tree(audit)
    need(fields(bound(audit / 'source-audit')) == {'path': str(canonical), 'sha256': seal}
         and tree(canonical) == seal == life['audit_sha256'], 'admission original audit seal')
    meta = fields(bound(audit / 'meta'))
    need(meta.get('status') == 'provider-teardown-verified'
         and meta.get('fleet_owner_token') == life['fleet_owner_token']
         and meta.get('run_id') == fleet.name and meta.get('workspace_root') == str(root),
         'admission ownership closure missing')
    directories = {'fresh', 'expected-fresh', 'pool', 'pool-handoffs', 'volume-migrations', 'by-machine-id'}
    files = {'meta', 'source-audit', 'owned-clones.ids', 'owned-clones.names', 'provider-teardown-verified.epoch'}
    # A private-source fleet keeps its captured source manifest beside the audit; only that exact copy.
    copy = audit / 'source-manifest.json'
    if copy.exists() or copy.is_symlink():
        need(not copy.is_symlink() and bound(copy) == bound(fleet / 'source-manifest.json'),
             'admission source manifest copy differs')
        files = files | {'source-manifest.json'}
    need({p.name for p in audit.iterdir()} <= directories | files, 'unknown admission audit record')
    for name in directories:
        path = audit / name
        need(not path.exists() or path.is_dir() and not path.is_symlink() and not any(path.iterdir()),
             'admission has nonempty or unknown ownership')
    need(bound(audit / 'owned-clones.ids') == bound(audit / 'owned-clones.names') == b'',
         'admission clone ownership is not empty')
    # Caller continues ALL normal release epoch, registry, disposable cleanup,
    # retained Hub custody and file-closure guards; this grants no pass credit.
