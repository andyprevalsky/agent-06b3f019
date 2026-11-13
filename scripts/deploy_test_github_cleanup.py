"""Cleanup-only GitHub terminal observation; never imports remote case PASS into cycle."""
import hashlib
import copy
import json
from pathlib import Path
import time
import zipfile

KIND = 'github-terminal-cleanup-v1'
REPO = 'Rose-Ai-Labs/rose'
FILES = ('request.json', 'result.json', 'receipt.json', 'output.log.process.json')


class EvidenceRejected(ValueError):
    """An expected certificate, native evidence or remote observation refusal."""


def need(ok, message):
    """Refuse invalid evidence without granting cleanup or execution credit."""
    if not ok:
        raise EvidenceRejected('GitHub cleanup: ' + message)


def observe(run_id):
    """Read the exact run's terminal evidence; transport failure leaves its owner held."""
    from deploy_test_github import GitHub, ROOT, load_token
    try:
        gh = GitHub(load_token(ROOT), REPO, deadline=time.time())
        return {name: gh.json(f'/actions/runs/{run_id}' + suffix)
                for name, suffix in (('run', ''), ('jobs', '/jobs?per_page=100'), ('artifacts', '/artifacts?per_page=100'))}
    except (OSError, ValueError, RuntimeError) as error:
        raise EvidenceRejected('GitHub cleanup: remote observation unavailable') from error


def read_evidence(path, label):
    """Convert the bounded native-file reader's expected refusal to evidence rejection."""
    import deploy_test_cycle as c
    try:
        return c.bounded_read(path, label)
    except ValueError as error:
        raise EvidenceRejected('GitHub cleanup: invalid ' + label) from error


def validate(state, receipt, owner, proof):
    """Authenticate original custody and fresh remote terminal proof, with no PASS adoption."""
    import deploy_test_cycle as c
    from deploy_test_github import ARTIFACT, REMOTE_ROOT, tag_name
    need(isinstance(proof, dict) and set(proof) == {'kind', 'token', 'receipt_sha256', 'original_files', 'artifact', 'remote'}, 'proof fields')
    need(proof['kind'] == KIND and proof['token'] == receipt.get('token'), 'proof token')
    need(c.latest_receipts(state).get(receipt['gate']) == receipt, 'latest receipt')
    need(receipt.get('complete') is False and set(receipt.get('cases', {}).values()) == {'UNVERIFIED'}, 'original incomplete outcome')
    need(isinstance(owner, dict) and set(owner) == {'transport', 'run_id', 'url'}
         and owner['transport'] == 'github-actions' and type(owner['run_id']) is int and owner['run_id'] > 0
         and owner['url'] == f"https://github.com/{REPO}/actions/runs/{owner['run_id']}", 'exact GitHub owner')
    folder = Path(receipt['log']).parent
    need(isinstance(proof['original_files'], dict) and set(proof['original_files']) == set(FILES), 'original file closure')
    for name in FILES:
        need(c.sha_file(folder / name) == proof['original_files'][name], 'original bytes changed: ' + name)
    need(proof['receipt_sha256'] == proof['original_files']['receipt.json']
         and read_evidence(folder / 'receipt.json', 'original receipt') == receipt
         and receipt.get('worker_result') == str(folder / 'result.json'), 'receipt binding')
    request = read_evidence(folder / 'request.json', 'original request')
    adapter = read_evidence(folder / 'result.json', 'original adapter')
    process = read_evidence(folder / 'output.log.process.json', 'local process')
    need(all(isinstance(doc, dict) for doc in (request, adapter, process)), 'native object shapes')
    need(all(doc.get(k) == receipt.get(k) for doc in (request, adapter) for k in ('token', 'source', 'gate'))
         and adapter.get('cleanup_owner') == owner and adapter.get('cleanup_complete') is False, 'adapter identity')
    need(process.get('quiescent') is True and process.get('orphaned_children') is False
         and process.get('remaining') == [] and process.get('error') is None
         and isinstance(process.get('reaped'), list) and bool(process['reaped']), 'local closure')
    import os
    need(all(isinstance(x, dict) and type(x.get('pid')) is int and x['pid'] > 0 and type(x.get('status')) is int
             and 0 <= x['status'] <= 65535 and (os.WIFEXITED(x['status']) or os.WIFSIGNALED(x['status']))
             for x in process['reaped']), 'terminal local waits')
    child, supervisor, native = (process.get(k) for k in ('child_pid', 'supervisor_pid', 'native_exit'))
    need(type(child) is int and child > 1 and type(supervisor) is int and supervisor > 1
         and child != supervisor and type(native) is int and -64 <= native <= 255, 'local primary identities')
    waits = process['reaped']; pids = [r['pid'] for r in waits]
    need(all(p > 1 and p != supervisor for p in pids) and len(set(pids)) == len(pids)
         and pids.count(child) == 1, 'unique primary wait closure')
    primary = next(r['status'] for r in waits if r['pid'] == child)
    need(os.waitstatus_to_exitcode(primary) == native, 'primary native wait mismatch')
    remote = proof['remote']
    need(isinstance(remote, dict) and set(remote) == {'repository', 'run_id', 'run_attempt', 'job_ids', 'artifact_id', 'artifact_sha256'}
         and remote['repository'] == REPO and remote['run_id'] == owner['run_id']
         and all(type(remote[k]) is int and remote[k] > 0 for k in ('run_id', 'run_attempt', 'artifact_id')),
         'remote identity')
    seen = observe(owner['run_id'])
    need(isinstance(seen, dict) and all(isinstance(seen.get(k), dict) for k in ('run', 'jobs', 'artifacts')),
         'remote observation objects')
    run, jobs, arts = (seen[k] for k in ('run', 'jobs', 'artifacts'))
    need(isinstance(jobs.get('jobs'), list) and all(isinstance(j, dict) for j in jobs['jobs'])
         and isinstance(arts.get('artifacts'), list) and all(isinstance(a, dict) for a in arts['artifacts']),
         'remote observation rows')
    old = adapter.get('remote', {})
    need(isinstance(old, dict), 'original remote identity object')
    need(str(remote['run_attempt']) == str(old.get('run_attempt')) and old.get('run_id') == owner['run_id'], 'original attempt')
    need(run.get('id') == remote['run_id'] and type(run.get('id')) is int
         and run.get('run_attempt') == remote['run_attempt'] and type(run.get('run_attempt')) is int
         and run.get('status') == 'completed' and isinstance(run.get('conclusion'), str)
         and run.get('head_sha') == receipt['source']['head'] == old.get('event_sha')
         and run.get('head_branch') == old.get('tag')
         and run.get('path') == '.github/workflows/deploy-gates.yml' and run.get('event') == 'push', 'terminal run/source/tag')
    # The immutable original adapter tag plus server head_branch binds the deterministic request token.
    labels = [label for j in jobs.get('jobs', []) for label in j.get('labels', [])]
    runners = [x for x in labels if isinstance(x, str) and __import__('re').fullmatch(r'blacksmith-(2|4|8|16|32)vcpu-ubuntu-2404', x)]
    need(len(set(runners)) == 1 and tag_name(runners[0], receipt['gate'], request['token']) == old['tag'], 'request tag binding')
    rows = jobs.get('jobs', [])
    need(type(jobs.get('total_count')) is int and jobs['total_count'] == len(rows) > 0
         and isinstance(remote['job_ids'], list) and len(set(remote['job_ids'])) == len(remote['job_ids'])
         and all(type(x) is int and x > 0 for x in remote['job_ids'])
         and sorted(remote['job_ids']) == sorted(j.get('id') for j in rows)
         and all(type(j.get('id')) is int and j.get('run_id') == remote['run_id'] and j.get('run_attempt') == remote['run_attempt']
                 and j.get('status') == 'completed' and j.get('completed_at') for j in rows), 'complete job/VM closure')
    matches = [a for a in arts.get('artifacts', []) if a.get('name') == ARTIFACT and a.get('id') == remote['artifact_id']]
    need(len(matches) == 1 and matches[0].get('expired') is False
         and matches[0].get('digest') == 'sha256:' + remote['artifact_sha256'], 'artifact server digest')
    need(matches[0].get('workflow_run') == {'id': run['id'],
         'repository_id': run['repository']['id'], 'head_repository_id': run['head_repository']['id'],
         'head_branch': run['head_branch'], 'head_sha': run['head_sha']}, 'artifact workflow binding')
    path = Path(proof['artifact'])
    need(c.sha_file(path) == remote['artifact_sha256'], 'artifact bytes')
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        need(len(names) == len(set(names)), 'duplicate artifact members')
        if 'result.json' not in names:
            cancelled_controller(state, receipt, request, adapter, process, run, rows, z)
            return proof['receipt_sha256']
        need(all(n in names for n in ('request.json', 'result.json', 'timing.json')), 'artifact controls')
        docs = {}
        for n in ('request.json', 'result.json', 'timing.json'):
            need(z.getinfo(n).file_size <= 64 * 1024 * 1024, 'artifact control bound')
            docs[n] = json.loads(z.read(n))
    audit = docs['result.json']
    need(docs['request.json'] == request and all(audit.get(k) == request.get(k) for k in ('token', 'source', 'gate'))
         and audit.get('worker_root') == request.get('worker_root') == REMOTE_ROOT
         and audit.get('cleanup_complete') is True and not audit.get('cleanup_owner')
         and docs['timing.json'].get('worker_finished_at'), 'same-token native cleanup')
    # Task case status and original timeout/signals are preserved, never adopted as gate credit.
    return proof['receipt_sha256']


def cancelled_controller(state, receipt, request, adapter, process, run, jobs, archive):
    """VM closure is cleanup only for the exact hermetic controller fixture recipe.

    This cannot certify semantic, cloud, financial or other external-resource work.
    Original cancellation, exit, incomplete verdict and cases are never rewritten.
    """
    import deploy_test_cycle as c
    from deploy_test_github import REMOTE_ROOT
    name = 'cloudbench-controller'
    gates = [g for g in state.get('plan', {}).get('gates', []) if g.get('name') == name]
    need(len(gates) == 1 and state.get('source') == receipt['source']
         and state['plan'].get('source') == receipt['source'], 'cancelled controller source/plan')
    gate = gates[0]
    command = receipt.get('command')
    need(gate.get('worker_transport') == 'github-actions' and gate.get('worker_root') == REMOTE_ROOT
         and gate.get('checks') == [name] and gate.get('command') == command
         and isinstance(command, list) and all(isinstance(x, str) for x in command)
         and command.count('--worker-script') == 1
         and command[command.index('--worker-script') + 1:command.index('--worker-script') + 2]
             == ['deploy_test_worker.py'], 'source-owned controller worker')
    recipe = {'cases': {name: {'command': ['python3', 'scripts/run-cloudbench-controller-local.py'],
              'cwd': '.', 'env': {'CONDUCTOR_WORKSPACE_NAME': 'deploy-cloudbench-controller',
                                  'CONDUCTOR_PORT': '12000'}, 'aggregate': True}}}
    need(request.get('gate') == name and request.get('checks') == [name] and request.get('skips') == {}
         and request.get('worker_root') == adapter.get('worker_root') == REMOTE_ROOT
         and request.get('worker_recipe') == gate.get('worker_recipe') == recipe
         and adapter.get('recipe_digest') == c.digest(recipe)
         and receipt.get('execution_binding') == {'input_fingerprint': state.get('input_fingerprints', {}).get(name),
              'contract_digest': c.digest(gate), 'environment': state.get('environment')},
         'exact hermetic controller recipe')
    need(receipt.get('cancelled') is True and receipt.get('timed_out') is False
         and process.get('cancelled') is True and process.get('timed_out') is False
         and type(receipt.get('native_exit')) is int and receipt['native_exit'] == process['native_exit']
         and adapter.get('complete') is False and adapter.get('cases') == {name: 'UNVERIFIED'}
         and adapter.get('remote', {}).get('stop_cause') == 'SIGTERM'
         and run.get('conclusion') == 'cancelled' and len(jobs) == 1,
         'original cancelled incomplete controller')
    job = jobs[0]
    need(job.get('conclusion') == 'cancelled' and type(job.get('runner_id')) is int and job['runner_id'] > 0
         and isinstance(job.get('runner_name'), str) and job['runner_name']
         == adapter.get('remote', {}).get('runner_name'), 'cancelled exact ephemeral runner')
    steps = job.get('steps')
    need(isinstance(steps, list) and all(isinstance(s, dict) for s in steps), 'terminal runner steps')
    required = [('Run gate', 'cancelled'), ('Bundle evidence', 'success'),
                ('Release dependency mounts', 'success'), ('Run actions/upload-artifact@v4', 'success'),
                ('Post Mount dependency disk', 'success'), ('Post Mount git mirror', 'success'),
                ('Complete runner', 'success'), ('Complete job', 'success')]
    numbers = []
    for label, conclusion in required:
        found = [s for s in steps if s.get('name') == label]
        need(len(found) == 1 and found[0].get('status') == 'completed'
             and found[0].get('conclusion') == conclusion and found[0].get('completed_at')
             and type(found[0].get('number')) is int and found[0]['number'] > 0, 'runner cleanup step: ' + label)
        numbers.append(found[0]['number'])
    need(numbers == sorted(set(numbers)), 'runner cleanup step ordering')
    controls = {}
    for label in ('request.json', 'timing.json', 'bundle.json'):
        need(label in archive.namelist() and archive.getinfo(label).file_size <= 64 * 1024 * 1024,
             'cancelled artifact controls')
        controls[label] = json.loads(archive.read(label))
        need(isinstance(controls[label], dict), 'cancelled artifact control object')
    timing, bundle = controls['timing.json'], controls['bundle.json']
    need(controls['request.json'] == request and set(timing) == {'job_started_at', 'extracted_at'}
         and all(type(timing[k]) in (int, float) and __import__('math').isfinite(timing[k])
                 and timing[k] > 0 for k in timing)
         and timing['job_started_at'] <= timing['extracted_at'], 'cancelled original request/timing')
    need(set(bundle) == {'bytes', 'skipped', 'captured'} and bundle['skipped'] == []
         and type(bundle['bytes']) is int and bundle['bytes'] >= 0
         and isinstance(bundle['captured'], list), 'cancelled bundle manifest')
    paths, total = set(), 0
    for row in bundle['captured']:
        need(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256'}
             and isinstance(row['path'], str) and row['path'] and not Path(row['path']).is_absolute()
             and '..' not in Path(row['path']).parts and row['path'] not in paths
             and type(row['bytes']) is int and 0 <= row['bytes'] <= 64 * 1024 * 1024,
             'cancelled bundle row')
        member = 'files/' + row['path']
        need(member in archive.namelist() and archive.getinfo(member).file_size == row['bytes']
             and hashlib.sha256(archive.read(member)).hexdigest() == row['sha256'], 'cancelled bundle bytes')
        paths.add(row['path']); total += row['bytes']
    need(total == bundle['bytes'] and {'files/' + p for p in paths}
         == {n for n in archive.namelist() if n.startswith('files/') and not n.endswith('/')},
         'cancelled bundle closure')


def reconcile(state, occurrence, proof):
    """Record cleanup-only eligibility for the latest incomplete UNVERIFIED owner."""
    import deploy_test_cycle as c
    failure = next((f for f in state['failures'] if f['id'] == occurrence), None)
    need(failure is not None and failure.get('native_result') == 'UNVERIFIED' and failure.get('complete') is False, 'occurrence')
    receipt = c.latest_receipts(state).get(failure['gate'])
    need(receipt is not None, 'receipt absent')
    owner = c.receipt_owner(failure['gate'], receipt)
    key = validate(state, receipt, owner, proof)
    entry = {'kind': KIND, 'gate': receipt['gate'], 'token': receipt['token'], 'owner': owner,
             'worker_result_sha256': c.sha_file(receipt['worker_result']), 'proof': proof, 'credit_granted': False}
    with zipfile.ZipFile(proof['artifact']) as archive:
        if receipt['gate'] == 'cloudbench-controller' and 'result.json' not in archive.namelist():
            entry['original_controller_gate'] = copy.deepcopy(next(
                gate for gate in state['plan']['gates'] if gate['name'] == receipt['gate']))
    previous = state.setdefault('reconciled_owners', {}).get(key)
    need(previous is None or previous == entry, 'conflicting certificate')
    state['reconciled_owners'][key] = entry


def still_bound(state, receipt, owner, entry):
    """Return false for stale evidence so the caller retains and names the owned gate."""
    try:
        need(isinstance(entry, dict), 'certificate shape')
        need(entry.get('credit_granted') is False and entry.get('token') == receipt.get('token')
             and entry.get('owner') == owner, 'certificate identity')
        original_gate = entry.get('original_controller_gate')
        if original_gate is not None:
            import deploy_test_cycle as c
            binding = receipt.get('execution_binding', {})
            need(receipt['gate'] == 'cloudbench-controller' and isinstance(original_gate, dict)
                 and c.digest(original_gate) == binding.get('contract_digest'), 'original controller contract changed')
            # Cleanup belongs to the original execution, including after current
            # source/input renewal. Revalidate its authenticated native contract;
            # no old test result becomes credit for the refreshed selection.
            state = {**state, 'source': receipt['source'],
                     'plan': {'source': receipt['source'], 'gates': [original_gate]},
                     'input_fingerprints': {receipt['gate']: binding['input_fingerprint']},
                     'environment': binding['environment']}
        validate(state, receipt, owner, entry['proof'])
        return True
    except (EvidenceRejected, OSError, KeyError, TypeError, IndexError,
            json.JSONDecodeError, zipfile.BadZipFile):
        return False
