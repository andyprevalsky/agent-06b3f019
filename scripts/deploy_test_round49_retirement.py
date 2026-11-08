"""Retire exact sealed round49 launch debt; never reconcile a newer owner or grant credit."""
import copy
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import time

KIND = 'round49-launch-debt-retirement-v1'
GATES = {'agents-coverage-blackbox', 'backend-coverage-blackbox', 'cloudbench-controller',
         'deploy-command-structural', 'frontend-coverage-blackbox', 'semantic-stack'}
OBSERVERS = ('scripts/deploy_test_cycle.py', 'scripts/deploy_test_local_cleanup.py',
             'scripts/deploy_test_process.py', 'scripts/deploy_test_result.py')
PRODUCERS = ('scripts/deploy_test_worker.py', 'scripts/deploy_test_backend.py',
             'scripts/deploy_test_semantic.py', 'scripts/deploy_test_process.py',
             'scripts/deploy_test_result.py', 'scripts/deploy_test_supervisor.py',
             'scripts/kill-services.sh', 'scripts/run-deploy-stage',
             'scripts/run-deploy-semantic-stack.sh', 'back-end/scripts/run-coverage.sh',
             'back-end/scripts/run-coverage-sharded.sh', 'back-end/scripts/run-blackbox-tests.sh')
NAMES = ('request.json', 'result.json', 'receipt.json', 'output.log.process.json')


def need(value, reason):
    if not value:
        raise ValueError('round49 retirement: ' + reason)


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + '\n').encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def contract_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def physical(path, directory=False):
    path = Path(path)
    need(path.is_absolute() and path.resolve(strict=True) == path and not path.is_symlink(), 'canonical path')
    info = path.stat()
    need(info.st_uid == os.getuid() and not info.st_mode & 0o022
         and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)), 'physical owner/type/mode')
    return {'device': info.st_dev, 'inode': info.st_ino}


def sha(path):
    physical(path)
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def doc(path):
    before = sha(path)
    need(Path(path).stat().st_size <= 32 * 1024 * 1024, 'bounded document')
    result = json.loads(Path(path).read_bytes())
    need(isinstance(result, dict) and sha(path) == before, 'stable object')
    return result


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def terminal(process):
    need(process.get('quiescent') is True and process.get('error') is None
         and all(process.get(k) is False for k in ('orphaned_children', 'cancelled', 'timed_out'))
         and all(process.get(k) == [] for k in ('remaining', 'term_sent', 'kill_sent')), 'native physical closure')
    need(type(process.get('native_exit')) is int and process['native_exit'] in (0, 1)
         and type(process.get('child_pid')) is int and process['child_pid'] > 1
         and type(process.get('supervisor_pid')) is int and process['supervisor_pid'] > 1
         and process['child_pid'] != process['supervisor_pid'], 'native identity')
    waits = process.get('reaped')
    need(isinstance(waits, list) and waits and all(isinstance(v, dict) and set(v) == {'pid', 'status'}
         and type(v['pid']) is int and v['pid'] > 1 and type(v['status']) is int
         and 0 <= v['status'] <= 65535
         and (os.WIFEXITED(v['status']) or os.WIFSIGNALED(v['status'])) for v in waits)
         and len({v['pid'] for v in waits}) == len(waits)
         and [v['status'] for v in waits if v['pid'] == process['child_pid']]
         == [process['native_exit'] << 8], 'complete wait closure')


def git_files(repository, head, paths):
    need(isinstance(head, str) and re.fullmatch('[0-9a-f]{40}|[0-9a-f]{64}', head), 'historical source')
    prefix = ['git', '--no-replace-objects', '-C', str(repository)]
    entries = subprocess.check_output([*prefix, 'ls-tree', '-r', head, '--', *paths], timeout=15).decode().splitlines()
    result = {}
    for entry in entries:
        meta, name = entry.split('\t', 1)
        mode, kind, _ = meta.split()
        need(kind == 'blob' and mode in ('100644', '100755'), 'historical regular source')
        raw = subprocess.check_output([*prefix, 'show', head + ':' + name], timeout=15)
        result[name] = {'sha256': hashlib.sha256(raw).hexdigest(), 'mode': int(mode, 8) & 0o100100}
    need(set(result) == set(paths), 'missing historical source files')
    return result


def inventory(request, gate):
    checks, skips = request.get('checks'), request.get('skips')
    need(isinstance(checks, list) and all(isinstance(v, str) for v in checks)
         and len(checks) == len(set(checks)) and isinstance(skips, dict)
         and not set(checks) & set(skips) and set(checks) | set(skips) == set(gate['checks'])
         and all(isinstance(v, dict) and v.get('source') == request['source'] for v in skips.values()), 'full qualified inventory')


def historical(directory, state, repository):
    journal_path = directory / 'settlement-round49-journal.json'
    journal = doc(journal_path)
    need(doc(directory / 'settlement-round49-committed.json') == {'journal_sha256': sha(journal_path)}
         and journal.get('kind') == 'native-settlement-journal-v1'
         and type(journal.get('round')) is int and journal['round'] == 49
         and journal.get('positive_credit') is False, 'committed negative journal')
    proposal_path, auth_path = map(Path, (journal['proposal_path'], journal['authorization_path']))
    need(sha(proposal_path) == journal['proposal_sha256'] and sha(auth_path) == journal['authorization_sha256'], 'sealed authorization')
    proposal, auth = doc(proposal_path), doc(auth_path)
    need(proposal.get('positive_credit') is False and type(proposal.get('round')) is int
         and proposal['round'] == 49 and proposal['source'] == journal['native_source'] == auth['native_source']
         and auth['operator_source'] == journal['operator_source']
         and auth['proposal_sha256'] == journal['proposal_sha256']
         and auth['after_state_sha256'] == journal['after_state_sha256'] == digest(proposal['after_state']), 'sealed state identity')
    observers = git_files(repository, journal['operator_source']['head'], OBSERVERS)
    need(all(encoded(observers[p]) == encoded(auth['operator_files'][p]) for p in OBSERVERS), 'historical observer bytes/mode')
    seals = proposal['input_artifacts']
    need(isinstance(seals, dict) and len(seals) == 64, 'all64 original seals')
    for name, value in seals.items():
        if Path(name) == directory / 'cycle.json':
            need(value == journal['before_state_sha256'] == proposal['before_state_sha256'], 'original cycle anchor')
        else:
            need(sha(name) == value, 'original artifact changed')
    paths = proposal['original_missing_outer_paths']
    need(isinstance(paths, list) and len(paths) == len(set(paths)) == 6
         and {Path(v).parent.name for v in paths} == GATES, 'exact six missing paths')
    old_keys = {(Path(v).parent.name, doc(Path(v).parent / 'request.json')['token']) for v in paths}
    old_attempts = proposal['after_state']['attempts']
    need(encoded(state['attempts'][:len(old_attempts)]) == encoded(old_attempts), 'original attempt history changed')
    old_rows = [r for a in old_attempts for r in a.get('results', [])
                if r.get('kind') == 'recovered-native-execution-v1'
                and (r.get('gate'), r.get('token')) in old_keys]
    need(len(old_rows) == 6, 'original six recovered rows')
    current_rows = [r for a in state['attempts'] for r in a.get('results', [])]
    for missing in paths:
        folder = Path(missing).parent
        need(folder == directory / 'attempts/49/triage' / folder.name
             and not Path(missing).exists() and not Path(missing).is_symlink(), 'original still missing')
        request, process, result = (doc(folder / n) for n in ('request.json', 'output.log.process.json', 'result.json'))
        need(all(str(folder / n) in seals for n in ('request.json', 'output.log.process.json', 'result.json')), 'original request closure sealed')
        row, = [v for v in old_rows if v['gate'] == folder.name]
        gate, = [v for v in proposal['after_state']['plan']['gates'] if v['name'] == folder.name]
        inventory(request, gate)
        matching = [v for v in current_rows if v.get('gate') == row['gate'] and v.get('token') == row['token']]
        need(len(matching) == 1 and encoded(matching[0]) == encoded(row)
             and row.get('status') == 'FAIL' and row.get('complete') is False
             and row.get('cancelled') == row.get('timed_out') == 'UNKNOWN'
             and row.get('source') == request.get('source') == journal['native_source']
             and row.get('token') == request.get('token')
             and request.get('gate') == result.get('gate') == folder.name
             and result.get('token') == request['token'] and result.get('source') == request['source']
             and result.get('cleanup_complete') is True and result.get('reused') is False
             and request.get('worker_root') == result.get('worker_root') == gate['worker_root']
             and encoded(request.get('worker_recipe')) == encoded(gate['worker_recipe'])
             and row.get('cases') == {**dict.fromkeys(request['checks'], 'UNVERIFIED'), **dict.fromkeys(request['skips'], 'SKIP')}
             and finite(row.get('recovered_at')), 'original negative physical closure')
        terminal(process)
        from deploy_test_result import validate as validate_result
        validate_result(result, request, process['native_exit'])
    native = git_files(repository, journal['native_source']['head'], PRODUCERS)
    need(all(encoded(native[p]) == encoded(proposal['native_files'][p]) for p in PRODUCERS), 'original producer source closure')
    return journal, proposal, {'journal': sha(journal_path), 'proposal': sha(proposal_path), 'authorization': sha(auth_path)}


def audit_locked(root, lock, held, identity):
    """Same process/service observations as quiet(), under the caller's one held lock."""
    from deploy_test_process import scan_same_user_processes
    info = os.fstat(held.fileno())
    need({'device': info.st_dev, 'inode': info.st_ino} == identity['admission']
         and physical(root, directory=True) == identity['root']
         and physical(lock) == identity['admission'], 'incarnation changed')
    manifest = root / '.context/services.json'
    if manifest.exists() or manifest.is_symlink():
        row = doc(manifest)
        need(row.get('worktree') == str(root) and row.get('status') == 'stopped', 'services not stopped')
    def inspect(process):
        cwd = (process / 'cwd').resolve(strict=True)
        args = (process / 'cmdline').read_bytes().split(b'\0')
        prefix = os.fsencode(str(root) + '/')
        need(cwd != root and root not in cwd.parents
             and not any(arg == os.fsencode(root) or arg.startswith(prefix) for arg in args), 'worker root still live')
    scan_same_user_processes(inspect, lambda pid: need(False, 'unverifiable worker process ' + str(pid)))
    need(physical(root, directory=True) == identity['root'] and physical(lock) == identity['admission'], 'incarnation changed during audit')


def witness(state, directory, proof, current_gate):
    need(isinstance(proof, dict) and set(proof) == {'kind', 'gate', 'old_request', 'later_request', 'files', 'confirmed_at', 'observed_by'}
         and proof['kind'] == KIND and proof['gate'] in GATES, 'typed proof fields')
    when = proof['confirmed_at']
    need(finite(when) and when <= time.time() and isinstance(proof['observed_by'], str)
         and proof['observed_by'].strip(), 'dated observer')
    directory = Path(directory).resolve(strict=True)
    repository = directory.parents[1]
    journal, proposal, anchors = historical(directory, state, repository)
    old = Path(proof['old_request'])
    need(str(old.parent / 'receipt.json') in proposal['original_missing_outer_paths']
         and old.name == 'request.json' and old.parent.name == proof['gate'], 'exact old request')
    folder = Path(proof['later_request']).parent
    need(Path(proof['later_request']).name == 'request.json' and folder.name == proof['gate']
         and folder.parent.name in ('initial', 'focused', 'failed-gates', 'final', 'triage')
         and folder.parent.parent.parent == directory / 'attempts'
         and re.fullmatch('[1-9][0-9]*', folder.parent.parent.name)
         and int(folder.parent.parent.name) > 49, 'later canonical folder')
    need(isinstance(proof['files'], dict) and set(proof['files']) == set(NAMES), 'later artifact inventory')
    for name in NAMES:
        need(sha(folder / name) == proof['files'][name], 'later bytes changed')
    request, result, receipt, process = (doc(folder / n) for n in NAMES)
    rows = [(i, r) for i, a in enumerate(state['attempts']) for r in a.get('results', [])]
    matches = [(i, r) for i, r in rows if encoded(r) == encoded(receipt)]
    need(len(matches) == 1, 'actual recorded later native receipt')
    old_request = doc(old)
    old_indexes = [i for i, r in rows if r.get('gate') == proof['gate'] and r.get('token') == old_request['token']]
    need(len(old_indexes) == 1 and matches[0][0] > old_indexes[0], 'strict later attempt order')
    attempt = state['attempts'][matches[0][0]]
    need(not any(attempt.get(k) for k in ('stale', 'interrupted'))
         and attempt.get('source', request['source']) == request['source'], 'recorded attempt source')
    original_gate, = [g for g in proposal['after_state']['plan']['gates'] if g['name'] == proof['gate']]
    need(encoded(current_gate) == encoded(original_gate)
         and request['worker_root'] == old_request['worker_root'] == current_gate['worker_root']
         and encoded(request['worker_recipe']) == encoded(old_request['worker_recipe']) == encoded(current_gate['worker_recipe']), 'same logical root and exact footprint')
    inventory(request, current_gate)
    for key in ('token', 'source', 'gate'):
        need(encoded(request[key]) == encoded(result.get(key)) == encoded(receipt.get(key)), 'later identity')
    binding = receipt.get('execution_binding', {})
    need(binding.get('contract_digest') == contract_digest(current_gate)
         and all(isinstance(binding.get(k), str) and re.fullmatch('[0-9a-f]{64}', binding[k]) for k in ('input_fingerprint', 'environment')),
         'later execution binding')
    root = Path(current_gate['worker_root'])
    lock = root / '.context/native-worker-admission.lock'
    need(receipt.get('host_admission', {}).get('started') is True
         and receipt['host_admission'].get('lock') == str(lock), 'later native admission')
    need(request['token'] != old_request['token'] and request['gate'] == proof['gate']
         and receipt.get('executed') is True and receipt.get('lifecycle') == 'owned'
         and receipt.get('kind') is None and receipt.get('command') == current_gate['command']
         and receipt.get('log') == str(folder / 'output.log') and receipt.get('worker_result') == str(folder / 'result.json')
         and result.get('worker_root') == str(root) and result.get('cleanup_complete') is True
         and result.get('reused') is False and result.get('interrupted', False) is False
         and not result.get('cleanup_owner') and not receipt.get('cleanup_owner')
         and receipt.get('lingering_group') is False and receipt.get('cancelled') is False
         and receipt.get('timed_out') is False, 'genuine clean later execution')
    terminal(process)
    need(type(receipt.get('native_exit')) is int and receipt['native_exit'] == process['native_exit']
         and ('native_exit' not in result or type(result['native_exit']) is int and result['native_exit'] == process['native_exit']), 'native outcome identity')
    from deploy_test_result import validate as validate_result
    cases, complete = validate_result(result, request, process['native_exit'])
    need(receipt.get('cases') == {**dict.fromkeys(request['skips'], 'SKIP'), **cases}
         and receipt.get('complete') is complete, 'native result/receipt verdicts')
    producers = git_files(repository, request['source']['head'], PRODUCERS)
    need(all(encoded(producers[p]) == encoded(proposal['native_files'][p]) for p in PRODUCERS), 'later producer footprint drift')
    recovered, = [r for a in proposal['after_state']['attempts'] for r in a.get('results', [])
                    if r.get('kind') == 'recovered-native-execution-v1'
                    and r['gate'] == proof['gate'] and r.get('token') == old_request['token']]
    need(finite(receipt.get('finished_at')) and recovered['recovered_at'] < receipt['finished_at'] <= when, 'later physical observation time')
    return root, lock, anchors


def validate(state, directory, proof, current_gate, certificate=None, commit=None):
    root, lock, anchors = witness(state, directory, proof, current_gate)
    when = proof['confirmed_at']
    identity = {'root': physical(root, directory=True), 'admission': physical(lock)}
    issued_at = time.time() if certificate is None else certificate.get('issued_at')
    need(finite(issued_at) and when <= issued_at <= time.time(), 'certificate issuance time')
    candidate = {'kind': KIND, 'issued_at': issued_at, 'proof': copy.deepcopy(proof), 'anchors': anchors,
                 'identity': identity, 'credit_granted': False}
    if certificate is not None:
        need(encoded(certificate) == encoded(candidate), 'certificate changed or root replaced')
    with lock.open('r') as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        audit_locked(root, lock, held, identity)
        # The CLI's atomic state writer runs before releasing this admission lock.
        if commit is not None:
            commit(candidate)
    return candidate


def reconcile(state, occurrence, proof, persist=None):
    need(isinstance(proof, dict) and proof.get('kind') == KIND, 'typed reconcile')
    directory = Path(proof['old_request']).parents[4]
    need(occurrence == doc(proof['old_request'])['token'], 'original request token occurrence')
    gate, = [g for g in state['plan']['gates'] if g['name'] == proof.get('gate')]
    key = proof['old_request']
    entries = state.get('historical_launch_retirements', {})
    need(isinstance(entries, dict), 'retirement map')
    prior = entries.get(key)
    need(key not in entries or isinstance(prior, dict), 'malformed present certificate')
    def commit(certificate):
        need(key not in entries or encoded(prior) == encoded(certificate), 'append-only certificate')
        previous = copy.deepcopy(state)
        state.setdefault('historical_launch_retirements', {})[key] = certificate
        try:
            if persist is not None:
                persist()
        except BaseException:
            state.clear()
            state.update(previous)
            raise
    validate(state, directory, proof, gate, prior, commit)


def recognized(state, directory, gate, request):
    entries = state.get('historical_launch_retirements', {})
    need(isinstance(entries, dict), 'retirement map')
    if str(request) not in entries:
        return False
    cert = entries[str(request)]
    need(isinstance(cert, dict) and cert.get('kind') == KIND and cert.get('credit_granted') is False
         and isinstance(cert.get('proof'), dict) and cert['proof'].get('old_request') == str(request)
         and cert['proof'].get('gate') == gate['name'], 'malformed present certificate')
    validate(state, directory, cert['proof'], gate, cert)
    return True
