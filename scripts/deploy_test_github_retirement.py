"""Verify a cancelled ephemeral CI runner's retirement without adopting test results."""
from datetime import datetime
import hashlib
from pathlib import Path
import re
import time
import urllib.request

from deploy_test_github_cleanup import EvidenceRejected, REPO, need

KIND = 'github-runner-retirement-v1'
GATES = frozenset({'semantic-stack', 'deploy-command-structural', 'agents-coverage-blackbox',
                   'backend-coverage-blackbox', 'frontend-coverage-blackbox', 'cloudbench-controller'})
MAX_LOG_BYTES = 64 * 1024 * 1024


def registered_runners():
    from deploy_test_github import GitHub, ROOT, load_token
    gh = GitHub(load_token(ROOT), REPO, deadline=time.time() + 60)
    rows = []
    total = None
    for page in range(1, 101):
        doc = gh.json(f'/actions/runners?per_page=100&page={page}')
        need(type(doc.get('total_count')) is int and doc['total_count'] >= 0
             and isinstance(doc.get('runners'), list), 'runner inventory unavailable')
        if total is None:
            total = doc['total_count']
        need(total == doc['total_count'], 'runner inventory changed during pagination')
        rows.extend(doc['runners'])
        if len(rows) >= total:
            break
        need(bool(doc['runners']), 'runner inventory incomplete')
    ids = [r.get('id') for r in rows]
    need(len(rows) == total and all(type(i) is int and i > 0 for i in ids)
         and len(set(ids)) == len(ids), 'runner inventory incomplete or ambiguous')
    return set(ids)


def job_log(job_id):
    from deploy_test_github import GitHub, ROOT, load_token
    gh = GitHub(load_token(ROOT), REPO, deadline=time.time() + 60)
    status, headers, body = gh.request('GET', f'/actions/jobs/{job_id}/logs', redirect=False)
    if status in (301, 302, 303, 307, 308):
        # GitHub's signed blob URL must never receive the repository credential.
        with urllib.request.urlopen(urllib.request.Request(headers['Location'],
                                    headers={'User-Agent': 'rose-deploy-gates'}), timeout=60) as response:
            body = response.read(MAX_LOG_BYTES + 1)
    need(len(body) <= MAX_LOG_BYTES, 'oversized runner log')
    return body


def epoch(value):
    need(isinstance(value, str), 'missing provider timestamp')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as error:
        raise EvidenceRejected('invalid provider timestamp') from error
    need(parsed.tzinfo is not None, 'provider timestamp lacks timezone')
    return parsed.timestamp()


def validate(receipt, proof, docs, run, jobs):
    from deploy_test_cycle import digest, sha_file
    gate = proof['execution_gate']
    need(isinstance(gate, dict) and gate.get('name') == receipt['gate'] in GATES
         and gate.get('category') == receipt['gate'] and gate.get('worker_transport') == 'github-actions'
         and not gate.get('native_cloud')
         and (not gate.get('native_backend') or receipt['gate'] == 'backend-coverage-blackbox')
         and gate.get('command') == receipt.get('command')
         and len(gate.get('command', [])) > 1
         and Path(gate['command'][1]).name == 'deploy_test_github.py'
         and digest(gate) == receipt.get('execution_binding', {}).get('contract_digest'),
         'retirement is limited to the original non-cloud CI execution contract')
    need(receipt.get('cancelled') is True and receipt.get('timed_out') is False
         and type(receipt.get('native_exit')) is int and receipt['native_exit'] != 0
         and run.get('conclusion') == 'cancelled', 'retirement requires an actual cancelled invocation')
    need('worker_finished_at' not in docs['timing.json'], 'use the native completed-worker cleanup proof')
    logs = proof['job_logs']
    need(isinstance(logs, dict) and set(logs) == {str(j['id']) for j in jobs}, 'exact job log inventory')
    registered = registered_runners()
    for job in jobs:
        runner_id = job.get('runner_id')
        need(type(runner_id) is int and runner_id > 0 and runner_id not in registered,
             'original runner is registered or its identity is unknown')
        steps = job.get('steps')
        need(isinstance(steps, list), 'provider teardown steps missing')
        for step_name, marker in [('Complete runner', 'No active SSH sessions detected. Proceeding with shutdown immediately.'),
                                  ('Complete job', 'Cleaning up orphan processes')]:
            matching = [s for s in steps if s.get('name') == step_name]
            need(len(matching) == 1 and matching[0].get('status') == 'completed'
                 and matching[0].get('conclusion') == 'success', 'provider teardown did not finish')
            step = matching[0]
            start, end = epoch(step.get('started_at')), epoch(step.get('completed_at'))
            need(start <= end, 'invalid teardown interval')
            log = logs[str(job['id'])]
            need(isinstance(log, dict) and set(log) == {'path', 'sha256'}
                 and isinstance(log['path'], str) and isinstance(log['sha256'], str)
                 and re.fullmatch('[0-9a-f]{64}', log['sha256']), 'invalid retained job log')
            path = Path(log['path'])
            need(path.is_absolute() and path.resolve(strict=True) == path and not path.is_symlink()
                 and path.stat().st_size <= MAX_LOG_BYTES and sha_file(path) == log['sha256'], 'retained job log changed')
            body = job_log(job['id'])
            need(hashlib.sha256(body).hexdigest() == log['sha256'], 'job log differs from the provider')
            # The REST step timestamps have whole-second precision. Require the
            # provider message inside its own teardown step, never test stdout.
            matching_lines = [line for line in body.decode('utf-8').splitlines() if line.endswith(marker)]
            need(any(start <= epoch(line.split(' ', 1)[0]) < end + 1 for line in matching_lines),
                 'provider shutdown marker is absent from its teardown interval')
