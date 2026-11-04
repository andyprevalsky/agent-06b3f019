"""Launch-only reconciliation of a local backend's failed teardown assertion."""
import copy
import fcntl
import math
import os
from pathlib import Path
import re
import time

KIND = 'local-supervisor-cleanup-v1'
FILES = ('request.json', 'result.json', 'receipt.json', 'output.log.process.json')
CARD_FILES = ('request.json', 'result.json', 'receipt.json', 'case.log', 'native-result.json',
              'local-benchmark-owner.json', 'local-stack-owner.json', 'local-stack-cleanup.status', 'services.json')


def card_preflight(state, receipt, proof):
    """Release only a never-admitted local Card producer, never a task outcome."""
    from deploy_test_cycle import bounded_read, digest, sha_file
    gate, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
    root = Path(gate['worker_root']).resolve(strict=True)
    need(gate.get('category') == gate['name'] == 'agentcard-lifecycle'
         and gate.get('worker_transport') == 'local-isolated' and gate.get('case_protocol') is True
         and gate.get('result_transport') == 'stdout' and str(root) == gate['worker_root'] == gate.get('cwd'),
         'owned local Card binding')
    command = gate['command']
    need(receipt.get('command') == command and len(command) == 5
         and command[1:] == [str(root / 'scripts/deploy_test_worker.py'), '--root', str(root), '--stdio'],
         'native Card command')
    # Cleanup belongs to the original source. A later source may repair the
    # failed startup, but receives no credit from releasing this old owner.
    binding = receipt.get('execution_binding', {})
    need(binding.get('contract_digest') == digest(gate)
         and all(isinstance(binding.get(k), str) and binding[k] for k in ('input_fingerprint', 'environment')),
         'current Card contract changed')
    need(receipt.get('host_admission', {}).get('started') is True
         and receipt['host_admission'].get('lock') == str(root / '.context/native-worker-admission.lock'),
         'Card admission binding')
    need(receipt.get('lifecycle') == 'native-producer' and receipt.get('executed') is True
         and receipt.get('complete') is False and type(receipt.get('native_exit')) is int
         and receipt['native_exit'] == 1 and receipt.get('lingering_group') is True
         and all(receipt.get(k) is False for k in ('timed_out', 'cancelled')),
         'terminal incomplete Card producer required')
    folder = Path(receipt['log']).parent
    need(Path(receipt['log']) == folder / 'output.log' and folder.resolve(strict=True) == folder
         and Path(receipt['worker_result']) == folder / 'result.json'
         and set(proof['files']) == set(CARD_FILES), 'Card artifact inventory')

    def sealed(path, name, json_file=True):
        need(not path.is_symlink() and path.resolve(strict=True) == path
             and sha_file(path) == proof['files'][name], 'Card artifact changed: ' + name)
        if json_file:
            return bounded_read(path, 'Card cleanup ' + name)
        need(path.stat().st_size <= 65536, 'Card text receipt too large')
        return path.read_text()

    request, result, recorded = (sealed(folder / n, n) for n in CARD_FILES[:3])
    need(recorded == receipt and all(row.get(k) == receipt.get(k) for row in (request, result)
                                    for k in ('token', 'source', 'gate')), 'Card identity mismatch')
    need(request.get('worker_root') == result.get('worker_root') == str(root)
         and request.get('worker_recipe') == gate.get('worker_recipe')
         and result.get('recipe_digest') == digest(request['worker_recipe']), 'Card recipe/root mismatch')
    name = gate['name']
    need(request.get('checks') == gate['checks'] == [name] and request.get('skips') == {}
         and receipt.get('cases') == result.get('cases') == {name: 'UNVERIFIED'}
         and result.get('complete') is False and result.get('cleanup_complete') is True
         and result.get('reused') is False and not result.get('cleanup_owner'), 'Card incomplete result')
    reference = receipt.get('native_cleanup_reference', {})
    need(reference == {'result': str(folder / 'result.json'), 'native_directory': None,
                      'cleanup_complete': True, 'result_sha256': proof['files']['result.json'],
                      'native_evidence': result['evidence']}
         and receipt.get('cleanup_owner') == {'request_token': receipt['token'], 'worker_root': str(root),
                                             'native_cleanup_reference': reference}, 'Card retained owner changed')
    recipe = request['worker_recipe']
    need(recipe.get('services') is True and recipe.get('cleanup', {}).get('command') == [
        'bash', '-c', 'bash scripts/kill-services.sh && bash scripts/run-deploy-stage --finish']
         and recipe['cleanup'].get('cwd', '.') == '.' and recipe['cases'][name].get('aggregate') is True,
         'native Card cleanup recipe')
    case = result['evidence'][name]
    need(case.get('status') == 'UNVERIFIED' and type(case.get('native_exit')) is int and case['native_exit'] == 1
         and case.get('command') == recipe['cases'][name]['command']
         and all(case.get(k) is False for k in ('timed_out', 'cancelled', 'lingering_group'))
         and receipt['started_at'] <= case['started_at'] <= case['finished_at'] <= receipt['finished_at'],
         'Card case was not cleanly joined')
    import hashlib
    native = root / '.context/deploy-worker' / hashlib.sha256(receipt['token'].encode()).hexdigest()
    log = native / (hashlib.sha256(name.encode()).hexdigest() + '.log')
    need(case.get('log') == str(log) and case.get('sha256') == proof['files']['case.log'], 'Card case log binding')
    text = sealed(log, 'case.log', False)
    need(sealed(native / 'result.json', 'native-result.json') == result, 'native Card result changed')
    errors = re.findall(r'^RuntimeError: run.sh exited early with code 143; see (.+/services\.log)$', text, re.M)
    need(len(errors) == 1, 'not the pre-admission service startup failure')
    run = Path(errors[0]).parent
    need(run.parent == root / '.context/benchmarks' and run.resolve(strict=True) == run, 'foreign Card run')
    benchmark = sealed(run / 'local-benchmark-owner.json', 'local-benchmark-owner.json')
    need(benchmark == {'version': 1, 'run_id': run.name, 'state': 'not_started', 'pid': None,
                       'native_identity': '', 'token': '', 'receipt': str(run / 'benchmark-cleanup.status'),
                       'signal': None}, 'benchmark was admitted or owner is unknown')
    need(not any((run / n).exists() or (run / n).is_symlink() for n in
                 ('run.json', 'report-card.json', 'local-benchmark-results.json'))
         and not list(run.glob('benchmark-cleanup*.status')), 'benchmark task evidence exists')
    owner = sealed(run / 'local-stack-owner.json', 'local-stack-owner.json')
    need(owner.get('version') == 1 and owner.get('run_id') == run.name
         and type(owner.get('pid')) is int and owner['pid'] > 1
         and isinstance(owner.get('birth'), str) and bool(owner['birth'])
         and re.fullmatch(r'[0-9a-f]{32}', owner.get('token', ''))
         and re.fullmatch('linux:' + Path('/proc/sys/kernel/random/boot_id').read_text().strip()
                          + r':[0-9]+', owner.get('native_identity', '')),
         'native stack owner identity')
    lines = sealed(run / 'local-stack-cleanup.status', 'local-stack-cleanup.status', False).splitlines()
    pairs = [line.partition('=') for line in lines]
    need(all(sep and key for key, sep, value in pairs) and len({key for key, _, _ in pairs}) == len(pairs),
         'malformed stack receipt')
    cleanup = {key: value for key, _, value in pairs}
    need(cleanup == {'version': '2', 'state': 'clean', 'token': owner['token'], 'stack_pid': str(owner['pid']),
                     'stack_birth': owner['birth'], 'stack_native_identity': owner['native_identity']}
         and not Path('/proc', str(owner['pid'])).exists(), 'stack cleanup not clean or owner still live')
    services = sealed(run / 'services.json', 'services.json')
    need(services.get('worktree') == str(root) and services.get('status') == 'stopped'
         and services.get('run_sh_pid') == owner['pid'], 'Card services identity/state')
    ports = services.get('ports')
    need(isinstance(ports, dict) and ports and all(type(p) is int and 0 <= p <= 65535 for p in ports.values()),
         'Card service ports unknown')
    listeners = set()
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        for line in Path(table).read_text().splitlines()[1:]:
            row = line.split()
            if row[3] == '0A':
                listeners.add(int(row[1].rsplit(':', 1)[1], 16))
    need(not listeners.intersection(p for p in ports.values() if p), 'Card service listener remains')
    quiet(root)
    return gate


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


def structural_cleanup(state, receipt, proof):
    """A fully reaped failed structural suite may launch again, without test credit."""
    import hashlib
    from deploy_test_cycle import bounded_read, digest, sha_file
    gate, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
    root = Path(gate['worker_root']).resolve(strict=True)
    name = gate['name']
    need(gate.get('category') == name == 'deploy-command-structural'
         and gate.get('worker_transport') == 'local-isolated' and gate.get('case_protocol') is True
         and gate.get('result_transport') == 'stdout' and str(root) == gate['worker_root'] == gate.get('cwd')
         and not gate.get('native_cloud') and not gate.get('native_backend'), 'owned structural binding')
    command = gate['command']
    need(receipt.get('command') == command and len(command) == 5
         and command[1:] == [str(root / 'scripts/deploy_test_worker.py'), '--root', str(root), '--stdio'],
         'native structural command')
    binding = receipt.get('execution_binding', {})
    need(binding.get('contract_digest') == digest(gate)
         and all(isinstance(binding.get(k), str) and binding[k] for k in ('input_fingerprint', 'environment'))
         and receipt.get('host_admission', {}).get('started') is True
         and receipt['host_admission'].get('lock') == str(root / '.context/native-worker-admission.lock'),
         'structural execution/admission contract changed')
    need(receipt.get('lifecycle') == 'owned' and receipt.get('executed') is True
         and receipt.get('complete') is False and receipt.get('status') == 'FAIL'
         and type(receipt.get('native_exit')) is int and receipt['native_exit'] == 1
         and receipt.get('lingering_group') is True and not receipt.get('cleanup_owner')
         and receipt.get('native_cleanup_reference') is None
         and all(receipt.get(k) is False for k in ('timed_out', 'cancelled')), 'failed structural receipt required')
    folder = Path(receipt['log']).parent
    need(Path(receipt['log']) == folder / 'output.log' and folder.resolve(strict=True) == folder
         and Path(receipt['worker_result']) == folder / 'result.json'
         and isinstance(proof['files'], dict) and set(proof['files']) == set(FILES), 'structural artifact inventory')
    docs = {}
    for item in FILES:
        path = folder / item
        need(not path.is_symlink() and path.resolve(strict=True) == path
             and sha_file(path) == proof['files'][item], 'structural artifact changed: ' + item)
        docs[item] = bounded_read(path, 'structural cleanup ' + item)
    request, result, recorded, process = (docs[n] for n in FILES)
    need(recorded == receipt and all(row.get(k) == receipt.get(k) for row in (request, result)
                                    for k in ('token', 'source', 'gate')), 'structural identity mismatch')
    need(request.get('worker_root') == result.get('worker_root') == str(root)
         and request.get('worker_recipe') == gate.get('worker_recipe')
         and result.get('recipe_digest') == digest(request['worker_recipe']), 'structural root/recipe mismatch')
    need(request.get('checks') == gate['checks'] == [name] and request.get('skips') == {}
         and receipt.get('cases') == result.get('cases') == {name: 'UNVERIFIED'}
         and result.get('complete') is False and result.get('cleanup_complete') is True
         and result.get('reused') is False and not result.get('cleanup_owner'), 'structural result incomplete cleanup')
    recipe = request['worker_recipe']
    need(recipe.get('services') is True and recipe.get('cleanup', {}).get('command') == [
        'bash', '-c', 'bash scripts/kill-services.sh && bash scripts/run-deploy-stage --finish']
         and recipe['cleanup'].get('cwd', '.') == '.' and set(recipe['cases']) == {name}
         and recipe['cases'][name].get('aggregate') is True, 'native structural cleanup recipe')
    case = result['evidence'][name]
    native = root / '.context/deploy-worker' / hashlib.sha256(receipt['token'].encode()).hexdigest()
    log = native / (hashlib.sha256(name.encode()).hexdigest() + '.log')
    need(case.get('status') == 'UNVERIFIED' and type(case.get('native_exit')) is int and case['native_exit'] == 1
         and case.get('command') == recipe['cases'][name]['command'] and case.get('log') == str(log)
         and log.resolve(strict=True) == log and sha_file(log) == case.get('sha256')
         and all(case.get(k) is False for k in ('timed_out', 'cancelled', 'lingering_group'))
         and receipt['started_at'] <= case['started_at'] <= case['finished_at'] <= receipt['finished_at'],
         'structural case not cleanly joined')
    need(type(process.get('native_exit')) is int and process['native_exit'] == receipt['native_exit']
         and process.get('quiescent') is True and process.get('orphaned_children') is True
         and all(process.get(k) is False for k in ('cancelled', 'timed_out'))
         and process.get('remaining') == [] and process.get('kill_sent') == []
         and process.get('error') is None, 'structural supervisor closure incomplete')
    child, supervisor = process.get('child_pid'), process.get('supervisor_pid')
    rows, terms = process.get('reaped'), process.get('term_sent')
    need(type(child) is int and type(supervisor) is int and child > 1 and supervisor > 1 and child != supervisor
         and isinstance(rows, list) and len(rows) > 1 and isinstance(terms, list) and terms
         and all(isinstance(row, dict) and set(row) == {'pid', 'status'}
                 and type(row['pid']) is int and row['pid'] > 1 and row['pid'] != supervisor
                 and type(row['status']) is int and 0 <= row['status'] <= 65535
                 and (os.WIFEXITED(row['status']) or os.WIFSIGNALED(row['status'])) for row in rows),
         'unknown structural descendant wait records')
    reaped = {row['pid']: row['status'] for row in rows}
    need(len(reaped) == len(rows) and reaped.get(child) == 256
         and all(type(pid) is int and pid > 1 and pid != child and pid in reaped for pid in terms)
         and len(set(terms)) == len(terms), 'structural owned descendants not all reaped')
    quiet(root)
    return gate


def interrupted_card(state, receipt, proof):
    """A never-admitted Card stack with failed cleanup needs independent physical closure."""
    import hashlib
    from deploy_test_cycle import bounded_read, digest, sha_file
    gate, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
    root = Path(gate['worker_root']).resolve(strict=True)
    command = gate['command']
    need(gate.get('category') == gate['name'] == 'agentcard-lifecycle'
         and gate.get('worker_transport') == 'local-isolated' and gate.get('case_protocol') is True
         and gate.get('result_transport') == 'stdout' and str(root) == gate['worker_root'] == gate.get('cwd')
         and receipt.get('command') == command and len(command) == 5
         and command[1:] == [str(root / 'scripts/deploy_test_worker.py'), '--root', str(root), '--stdio'],
         'interrupted Card binding')
    need(receipt.get('lifecycle') == 'native-producer' and receipt.get('executed') is True
         and receipt.get('complete') is False and type(receipt.get('native_exit')) is int and receipt['native_exit'] == -9
         and receipt.get('cancelled') is True and receipt.get('timed_out') is False
         and receipt.get('lingering_group') is True and receipt.get('worker_result') is None
         and receipt.get('native_cleanup_reference') is None
         and receipt.get('cleanup_owner') == {'request_token': receipt['token'], 'worker_root': str(root),
                                              'native_cleanup_reference': None}, 'interrupted Card owner')
    binding = receipt.get('execution_binding', {})
    need(binding.get('contract_digest') == digest(gate)
         and all(isinstance(binding.get(k), str) and binding[k] for k in ('environment', 'input_fingerprint'))
         and receipt.get('host_admission', {}).get('started') is True
         and receipt['host_admission'].get('lock') == str(root / '.context/native-worker-admission.lock'),
         'interrupted Card execution contract')
    folder = Path(receipt['log']).parent
    names = {'request.json', 'receipt.json', 'case.log', 'local-benchmark-owner.json',
             'local-stack-owner.json', 'local-stack-cleanup.status', 'services.json'}
    paths = set(proof['files']) - names
    need(len(paths) == 1 and names <= set(proof['files']), 'interrupted Card file inventory')
    physical_path = Path(next(iter(paths)))
    need(physical_path.is_absolute() and physical_path.name == 'card-physical.json'
         and folder.resolve(strict=True) == folder and Path(receipt['log']) == folder / 'output.log'
         and not (folder / 'result.json').exists() and not (folder / 'result.json').is_symlink(),
         'interrupted Card proof paths')
    def sealed(path, name, text=False):
        need(not path.is_symlink() and path.resolve(strict=True) == path
             and sha_file(path) == proof['files'][name], 'interrupted Card artifact changed: ' + name)
        if text:
            need(path.stat().st_size <= 65536, 'interrupted Card text bound')
            return path.read_text()
        return bounded_read(path, 'interrupted Card ' + name)
    request, recorded = (sealed(folder / n, n) for n in ('request.json', 'receipt.json'))
    need(recorded == receipt and all(request.get(k) == receipt.get(k) for k in ('token', 'source', 'gate'))
         and request.get('worker_root') == str(root) and request.get('worker_recipe') == gate.get('worker_recipe')
         and request.get('checks') == gate['checks'] == ['agentcard-lifecycle'] and request.get('skips') == {}
         and receipt.get('cases') == {'agentcard-lifecycle':'UNVERIFIED'}, 'interrupted Card request identity')
    native = root / '.context/deploy-worker' / hashlib.sha256(receipt['token'].encode()).hexdigest()
    log = native / (hashlib.sha256(b'agentcard-lifecycle').hexdigest() + '.log')
    text = sealed(log, 'case.log', True)
    runs = set(re.findall(r'cleanup remains unverified; retaining its recovery authority: (.+/local-stack-cleanup\.status)', text))
    # The log's native repair command follows the path on its second occurrence.
    runs = {Path(value.split('. If the stack owner exited,', 1)[0]).parent for value in runs}
    need(len(runs) == 1, 'interrupted Card run linkage')
    run = runs.pop()
    need(run.parent == root / '.context/benchmarks' and run.resolve(strict=True) == run
         and not any((run / n).exists() or (run / n).is_symlink() for n in
                     ('run.json', 'report-card.json', 'local-benchmark-results.json'))
         and not list(run.glob('benchmark-cleanup*.status')), 'Card task admission unknown')
    benchmark = sealed(run / 'local-benchmark-owner.json', 'local-benchmark-owner.json')
    need(benchmark == {'version':1, 'run_id':run.name, 'state':'not_started', 'pid':None,
                      'native_identity':'', 'token':'', 'receipt':str(run / 'benchmark-cleanup.status'), 'signal':None},
         'Card benchmark was admitted')
    owner = sealed(run / 'local-stack-owner.json', 'local-stack-owner.json')
    need(owner.get('version') == 1 and owner.get('run_id') == run.name and type(owner.get('pid')) is int
         and owner['pid'] > 1 and owner.get('birth') and re.fullmatch(r'[0-9a-f]{32}', owner.get('token',''))
         and re.fullmatch('linux:' + Path('/proc/sys/kernel/random/boot_id').read_text().strip()
                          + r':[0-9]+', owner.get('native_identity',''))
         and not Path('/proc', str(owner['pid'])).exists(), 'interrupted Card stack identity')
    lines = sealed(run / 'local-stack-cleanup.status', 'local-stack-cleanup.status', True).splitlines()
    pairs = [line.partition('=') for line in lines]
    need(all(key and sep for key,sep,_ in pairs) and len({key for key,_,_ in pairs}) == len(pairs), 'Card cleanup fields')
    need({key:value for key,_,value in pairs} == {'version':'2', 'state':'failed', 'token':owner['token'],
         'stack_pid':str(owner['pid']), 'stack_birth':owner['birth'], 'stack_native_identity':owner['native_identity']},
         'interrupted Card failed receipt changed')
    services = sealed(run / 'services.json', 'services.json')
    need(services.get('status') == 'stopped' and services.get('worktree') == str(root)
         and services.get('run_sh_pid') == owner['pid'], 'interrupted Card services')
    physical = sealed(physical_path, str(physical_path))
    observed = physical.get('observed_at')
    need(type(observed) in (int,float) and math.isfinite(observed)
         and receipt['finished_at'] <= observed <= proof['confirmed_at']
         and physical.get('source') == receipt['source']['head'] and physical.get('root') == str(root)
         and physical.get('run') == str(run) and physical.get('physical',{}).get('matched') == []
         and physical['physical'].get('unknown_live_userland') == [] and physical.get('listeners') == []
         and physical.get('database_status') == 'ABSENT'
         and type(physical.get('canonical_reconcile_exit')) is int and physical['canonical_reconcile_exit'] == 1
         and physical.get('ports') == services.get('ports'), 'independent Card physical closure unknown')
    ports = physical['ports']
    need(isinstance(ports,dict) and ports and all(type(port) is int and 0 <= port <= 65535 for port in ports.values()),
         'interrupted Card ports')
    listeners = set()
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        for line in Path(table).read_text().splitlines()[1:]:
            row = line.split()
            if row[3] == '0A': listeners.add(int(row[1].rsplit(':',1)[1],16))
    need(not listeners.intersection(port for port in ports.values() if port), 'interrupted Card listener remains')
    quiet(root)
    return gate


def interrupted_worker(state, receipt, proof):
    """Account fully reaped interrupted custody; a missing adapter earns no credit."""
    from deploy_test_cycle import bounded_read, digest, sha_file
    gate, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
    root = Path(gate['worker_root']).resolve(strict=True)
    backend = gate.get('native_backend') is True and gate['name'] == 'backend-coverage-blackbox'
    command = gate['command']
    native_command = (len(command) == 4 and Path(command[1]).name == 'deploy_test_backend.py'
                      and command[2:] == ['--root', str(root)]) if backend else (
                      len(command) == 5 and command[1:] == [str(root / 'scripts/deploy_test_worker.py'), '--root', str(root), '--stdio'])
    need(gate.get('worker_transport') == 'local-isolated' and gate.get('case_protocol') is True
         and gate.get('result_transport') == ('file' if backend else 'stdout')
         and not gate.get('native_cloud') and gate.get('category') != 'agentcard-lifecycle'
         and gate.get('native_backend') in (None, False, True) and (not gate.get('native_backend') or backend)
         and str(root) == gate['worker_root'] == gate.get('cwd')
         and native_command and receipt.get('command') == command, 'interrupted native local worker binding')
    need(receipt.get('lifecycle') == 'owned' and receipt.get('executed') is True
         and receipt.get('complete') is False and receipt.get('status') == 'FAIL'
         and type(receipt.get('native_exit')) is int and receipt['native_exit'] == -9
         and receipt.get('cancelled') is True and receipt.get('timed_out') is False
         and receipt.get('lingering_group') is True and not receipt.get('cleanup_owner')
         and receipt.get('worker_result') is None and receipt.get('native_cleanup_reference') is None,
         'interrupted supervised receipt required')
    binding = receipt.get('execution_binding', {})
    need(binding.get('contract_digest') == digest(gate)
         and all(isinstance(binding.get(k), str) and binding[k] for k in ('input_fingerprint', 'environment'))
         and receipt.get('host_admission', {}).get('started') is True
         and receipt['host_admission'].get('lock') == str(root / '.context/native-worker-admission.lock'),
         'interrupted execution/admission contract changed')
    folder = Path(receipt['log']).parent
    names = {'request.json', 'receipt.json', 'output.log.process.json'}
    need(Path(receipt['log']) == folder / 'output.log' and folder.resolve(strict=True) == folder
         and isinstance(proof['files'], dict) and set(proof['files']) == names
         and not any((folder / n).exists() or (folder / n).is_symlink()
                     for n in ('result.json', 'output.log.process.json.watchdog.json')),
         'interrupted artifact inventory')
    docs = {}
    for name in names:
        path = folder / name
        need(not path.is_symlink() and path.resolve(strict=True) == path
             and sha_file(path) == proof['files'][name], 'interrupted artifact changed: ' + name)
        docs[name] = bounded_read(path, 'interrupted cleanup ' + name)
    request, recorded, process = (docs[n] for n in ('request.json', 'receipt.json', 'output.log.process.json'))
    need(recorded == receipt and all(request.get(k) == receipt.get(k) for k in ('token', 'source', 'gate'))
         and request.get('worker_root') == str(root) and request.get('worker_recipe') == gate.get('worker_recipe')
         and isinstance(request.get('skips'), dict) and set(request['skips']) <= set(gate['checks'])
         and request.get('checks') == [case for case in gate['checks'] if case not in request['skips']]
         and request['checks'] and receipt.get('cases') == {case: 'SKIP' if case in request['skips'] else 'UNVERIFIED'
                                                         for case in gate['checks']}, 'interrupted request identity/inventory')
    need(type(process.get('native_exit')) is int and process['native_exit'] == -9
         and process.get('cancelled') is True and process.get('timed_out') is False
         and process.get('quiescent') is True and process.get('remaining') == []
         and type(process.get('orphaned_children')) is bool and process.get('error') is None,
         'interrupted supervisor closure unknown')
    child, supervisor = process.get('child_pid'), process.get('supervisor_pid')
    rows, terms, kills = (process.get(k) for k in ('reaped', 'term_sent', 'kill_sent'))
    need(type(child) is int and type(supervisor) is int and child > 1 and supervisor > 1 and child != supervisor
         and isinstance(rows, list) and rows and isinstance(terms, list) and isinstance(kills, list) and kills
         and all(isinstance(row, dict) and set(row) == {'pid', 'status'}
                 and type(row['pid']) is int and row['pid'] > 1 and row['pid'] != supervisor
                 and type(row['status']) is int and 0 <= row['status'] <= 65535
                 and (os.WIFEXITED(row['status']) or os.WIFSIGNALED(row['status'])) for row in rows),
         'interrupted wait records unknown')
    reaped = {r['pid']: r['status'] for r in rows}
    need(len(reaped) == len(rows) and reaped.get(child) == 9 and child in kills
         and all(type(pid) is int and pid > 1 and pid in reaped for pid in terms + kills)
         and len(set(terms)) == len(terms) and len(set(kills)) == len(kills) and set(kills) <= set(terms),
         'interrupted owned targets were not all reaped')
    from deploy_test_isolation import _ports
    port = gate.get('env', {}).get('CONDUCTOR_PORT')
    need(isinstance(port, str) and port.isdigit(), 'interrupted port identity')
    wanted = {int(port) + offset for offset in _ports.LISTENER_OFFSETS}
    listeners = set()
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        for line in Path(table).read_text().splitlines()[1:]:
            row = line.split()
            if row[3] == '0A': listeners.add(int(row[1].rsplit(':', 1)[1], 16))
    need(not wanted & listeners, 'interrupted root listener remains')
    quiet(root)
    return gate


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
    if receipt.get('cancelled') is True and receipt.get('lifecycle') == 'owned':
        return interrupted_worker(state, receipt, proof)
    if name == 'agentcard-lifecycle':
        if receipt.get('cancelled') is True:
            return interrupted_card(state, receipt, proof)
        return card_preflight(state, receipt, proof)
    if name == 'deploy-command-structural':
        return structural_cleanup(state, receipt, proof)
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
    if failure is None:
        from deploy_test_cycle import interrupted_receipt
        receipt = interrupted_receipt(state, occurrence_id)
    else:
        need(failure.get('native_result') == 'UNVERIFIED' and failure.get('complete') is False,
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
        'occurrence': occurrence_id, 'proof': copy.deepcopy(proof), 'credit_granted': False,
        'execution_gate': copy.deepcopy(gate)}


def still_bound(state, receipt, entry):
    need(entry.get('kind') == KIND and entry.get('gate') == receipt['gate']
         and entry.get('token') == receipt['token'] and entry.get('credit_granted') is False, 'reconciliation changed')
    # Cleanup belongs to the original execution contract; a refreshed full
    # inventory may add checks while the same old physical root is rechecked.
    gate = entry.get('execution_gate')
    original = {**state, 'plan': {'gates': [gate]}} if gate is not None else state
    try:
        if gate is not None:
            from deploy_test_result import preserve_contract
            current, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
            preserve_contract(gate, current)
            need(set(gate['checks']) <= set(current['checks']), 'original checks removed')
        validate(original, receipt, entry['proof'])
    except (OSError, KeyError, TypeError) as error:
        raise ValueError('local cleanup: sealed evidence no longer available') from error
