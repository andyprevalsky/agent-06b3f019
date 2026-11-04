"""Launch-only reconciliation of a local backend's failed teardown assertion."""
import copy
import fcntl
import math
import os
from pathlib import Path
import time

KIND = 'local-supervisor-cleanup-v1'
FILES = ('request.json', 'result.json', 'receipt.json', 'output.log.process.json')


def need(value, message):
    if not value:
        raise ValueError('local cleanup: ' + message)


def quiet(root):
    """Do not reconcile a root currently owned by another native worker/service."""
    admission = root / '.context/native-worker-admission.lock'
    need(admission.resolve(strict=True) == admission, 'admission lock is not owned by this root')
    with admission.open('r') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest = root / '.context/services.json'
        if manifest.exists() or manifest.is_symlink():
            from deploy_test_cycle import bounded_read
            need(not manifest.is_symlink(), 'services manifest is not owned by this root')
            row = bounded_read(manifest, 'local services')
            need(row.get('worktree') == str(root) and row.get('status') == 'stopped', 'services not stopped')
        # The supervisor owns processes under the invoking uid, including
        # double-forked descendants. A later process in this root also refuses
        # reconciliation; never signal it or infer ownership from recycled pids.
        for process in Path('/proc').iterdir():
            if not process.name.isdigit():
                continue
            try:
                if process.stat().st_uid != os.geteuid():
                    continue
                cwd = (process / 'cwd').resolve(strict=True)
                args = (process / 'cmdline').read_bytes().split(b'\0')
                prefix = os.fsencode(str(root) + '/')
                need(cwd != root and root not in cwd.parents
                     and not any(arg == os.fsencode(root) or arg.startswith(prefix) for arg in args),
                     'worker root still has a live process')
            except (FileNotFoundError, ProcessLookupError):
                continue  # process exited during the read; never signal it


def validate(state, receipt, proof):
    from deploy_test_cycle import bounded_read, digest, sha_file
    need(set(proof) == {'kind', 'files', 'confirmed_at', 'observed_by'} and proof['kind'] == KIND,
         'proof fields')
    need(isinstance(proof['observed_by'], str) and proof['observed_by'].strip(), 'independent observer missing')
    confirmed = proof['confirmed_at']
    need(type(confirmed) in (int, float) and math.isfinite(confirmed)
         and type(receipt.get('finished_at')) in (int, float)
         and receipt['finished_at'] <= confirmed <= time.time(), 'confirmation time')
    name = receipt['gate']
    gates = [g for g in state['plan']['gates'] if g['name'] == name]
    need(len(gates) == 1, 'current gate binding')
    gate = gates[0]
    root = Path(gate['worker_root']).resolve(strict=True)
    need(name == 'backend-coverage-blackbox' and gate.get('native_backend') is True
         and gate.get('worker_transport') == 'local-isolated'
         and gate.get('case_protocol') is True and gate.get('result_transport') == 'file'
         and str(root) == gate['worker_root'] == gate.get('cwd'), 'owned local backend binding')
    need(receipt.get('command') == gate['command'] and len(gate['command']) == 4
         and Path(gate['command'][1]).name == 'deploy_test_backend.py'
         and gate['command'][2:] == ['--root', str(root)], 'native backend command')
    need(receipt.get('execution_binding', {}).get('contract_digest') == digest(gate)
         and receipt.get('host_admission', {}).get('started') is True
         and receipt['host_admission'].get('lock') == str(root / '.context/native-worker-admission.lock'),
         'current execution/admission contract changed')
    need(receipt.get('lifecycle') == 'owned' and receipt.get('executed') is True
         and receipt.get('complete') is False and type(receipt.get('native_exit')) is int and receipt['native_exit'] == 1
         and all(receipt.get(k) is False for k in ('timed_out', 'cancelled', 'lingering_group'))
         and not receipt.get('cleanup_owner'), 'clean supervised terminal receipt required')
    folder = Path(receipt['log']).parent
    need(Path(receipt['log']) == folder / 'output.log'
         and folder.resolve(strict=True) == folder
         and Path(receipt['worker_result']) == folder / 'result.json', 'native artifact paths')
    need(isinstance(proof['files'], dict) and set(proof['files']) == set(FILES), 'artifact inventory')
    docs = {}
    for name in FILES:
        path = folder / name
        need(not path.is_symlink() and sha_file(path) == proof['files'][name], 'artifact changed: ' + name)
        docs[name] = bounded_read(path, 'local cleanup ' + name)
    request, result, recorded, process = (docs[n] for n in FILES)
    need(recorded == receipt, 'recorded receipt changed')
    need(all(row.get(k) == receipt.get(k) for row in (request, result) for k in ('token', 'source', 'gate')),
         'token/source/gate mismatch')
    need(request.get('worker_root') == result.get('worker_root') == str(root)
         and request.get('worker_recipe') == gate.get('worker_recipe')
         and result.get('recipe_digest') == digest(request['worker_recipe']), 'root/recipe mismatch')
    cases = result.get('cases')
    need(isinstance(cases, dict) and set(cases) == set(request['checks']) == set(receipt['cases'])
         and set(cases) == set(gate['checks']) and len(request['checks']) == len(cases) and request.get('skips') == {}
         and all(v in ('PASS', 'FAIL', 'UNVERIFIED') for v in cases.values())
         and all(v == 'UNVERIFIED' for v in receipt['cases'].values())
         and result.get('complete') is False and 'UNVERIFIED' in cases.values()
         and result.get('cleanup_complete') is False and not result.get('cleanup_owner')
         and result.get('reused') is False and result.get('interrupted') is False
         and result.get('source_unchanged') is True and type(result.get('native_exit')) is int
         and result['native_exit'] == 1, 'native incomplete result')
    recipe = request['worker_recipe']
    need(recipe.get('services') is True and recipe.get('cleanup', {}).get('command') == [
        'bash', '-c', 'bash scripts/kill-services.sh && bash scripts/run-deploy-stage --finish']
         and recipe['cleanup'].get('cwd', '.') == '.',
         'existing root-scoped cleanup recipe required')
    teardown = result.get('evidence', {}).get('teardown', {})
    need(type(teardown.get('recipe_cleanup_exit')) is int and teardown['recipe_cleanup_exit'] == 0
         and type(teardown.get('exit')) is int and teardown['exit'] == 1, 'recipe cleanup/test outcome distinction')
    runner = Path(result['runner_log'])
    need(root / '.context/deploy-backend' in runner.parents and runner.resolve(strict=True) == runner
         and sha_file(runner) == result['evidence']['artifacts']['runner_log'], 'native cleanup log changed')
    need(type(process.get('native_exit')) is int and process['native_exit'] == receipt['native_exit']
         and process.get('quiescent') is True
         and all(process.get(k) is False for k in ('orphaned_children', 'cancelled', 'timed_out'))
         and all(process.get(k) == [] for k in ('remaining', 'term_sent', 'kill_sent'))
         and process.get('error') is None, 'native process tree not clean')
    child, supervisor = process.get('child_pid'), process.get('supervisor_pid')
    need(type(child) is int and type(supervisor) is int and child > 1 and supervisor > 1 and child != supervisor
         and process.get('reaped') == [{'pid': child, 'status': 256}], 'native child was not cleanly reaped')
    quiet(root)
    return gate


def reconcile(state, occurrence_id, proof):
    from deploy_test_cycle import latest_receipts
    failure = next((f for f in state['failures'] if f['id'] == occurrence_id), None)
    need(failure and failure.get('native_result') == 'UNVERIFIED' and failure.get('complete') is False,
         'incomplete occurrence required')
    receipt = latest_receipts(state).get(failure['gate'])
    need(receipt and receipt.get('cases', {}).get(failure['check'].split('/', 1)[1]) == 'UNVERIFIED',
         'latest incomplete receipt required')
    need(all(failure.get(a) == receipt.get(b) for a, b in (
        ('source', 'source'), ('evidence', 'log'), ('worker_result', 'worker_result'), ('finished_at', 'finished_at'))),
         'occurrence does not identify the latest receipt')
    try:
        gate = validate(state, receipt, proof)
    except (OSError, KeyError, TypeError) as error:
        raise ValueError('local cleanup: missing or unknown evidence') from error
    state.setdefault('reconciled_owners', {})[proof['files']['receipt.json']] = {
        'kind': KIND, 'gate': gate['name'], 'token': receipt['token'],
        'occurrence': occurrence_id, 'proof': copy.deepcopy(proof), 'credit_granted': False}


def still_bound(state, receipt, entry):
    need(entry.get('kind') == KIND and entry.get('gate') == receipt['gate']
         and entry.get('token') == receipt['token'] and entry.get('credit_granted') is False, 'reconciliation changed')
    try:
        validate(state, receipt, entry['proof'])
    except (OSError, KeyError, TypeError) as error:
        raise ValueError('local cleanup: sealed evidence no longer available') from error
