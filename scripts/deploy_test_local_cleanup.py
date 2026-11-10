"""Launch-only reconciliation of a local backend's failed teardown assertion."""
import copy
import hashlib
import fcntl
import math
import os
from pathlib import Path
import re
import stat
import signal
import time

KIND = 'local-supervisor-cleanup-v1'
SUPPLEMENT_KIND = 'local-cancelled-log-supplement-v1'
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
        from deploy_test_process import scan_same_user_processes

        def inspect(process):
            cwd = (process / 'cwd').resolve(strict=True)
            args = (process / 'cmdline').read_bytes().split(b'\0')
            prefix = os.fsencode(str(root) + '/')
            need(cwd != root and root not in cwd.parents
                 and not any(arg == os.fsencode(root) or arg.startswith(prefix) for arg in args),
                 'worker root still has a live process')
        # An exited process is skipped (never signalled); an unreadable same-user one refuses.
        scan_same_user_processes(inspect, lambda pid: need(False, f'worker root process {pid} is unverifiable'))


def structural_original_gate(original, current):
    """Authenticate only a selection-explanation change, never an execution change."""
    from deploy_test_cycle import digest
    need(isinstance(original, dict) and set(original) == set(current)
         and all(isinstance(gate.get('selection_evidence'), list)
                 and all(isinstance(item, str) for item in gate['selection_evidence'])
                 for gate in (original, current)), 'structural original contract shape')
    need(digest({k: v for k, v in original.items() if k != 'selection_evidence'}) ==
         digest({k: v for k, v in current.items() if k != 'selection_evidence'}),
         'structural execution contract changed')


def structural_cleanup(state, receipt, proof):
    """A fully reaped failed structural suite may launch again, without test credit."""
    import hashlib
    from deploy_test_cycle import ROOT, bounded_read, digest, sha_file
    gate, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
    if 'original_gate' in proof:
        structural_original_gate(proof['original_gate'], gate)
        gate = proof['original_gate']
    root = Path(gate['worker_root']).resolve(strict=True)
    name = gate['name']
    file_adapter = gate.get('result_transport') == 'file'
    need(gate.get('category') == name == 'deploy-command-structural'
         and gate.get('worker_transport') == 'local-isolated' and gate.get('case_protocol') is True
         and gate.get('result_transport') in ('stdout', 'file') and str(root) == gate['worker_root'] == gate.get('cwd')
         and not gate.get('native_cloud') and not gate.get('native_backend'), 'owned structural binding')
    command = gate['command']
    if file_adapter:
        import sys
        need(isinstance(command, list) and len(command) == 4
             and isinstance(command[0], str)
             and Path(command[0]).is_absolute()
             and Path(command[0]).resolve(strict=True) == Path(sys.executable).resolve(strict=True)
             and command[1:] in ([str(ROOT / 'scripts/deploy_test_worker.py'), '--root', str(root)],
                                 [str(root / 'scripts/deploy_test_worker.py'), '--root', str(root)])
             and receipt.get('command') == command, 'native structural file command')
    else:
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
         and type(receipt.get('native_exit')) is int and receipt['native_exit'] in (0, 1)
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
    native_exit = receipt['native_exit']
    inner_status = 'PASS' if native_exit == 0 else 'UNVERIFIED'
    need(request.get('checks') == gate['checks'] == [name] and request.get('skips') == {}
         and receipt.get('cases') == {name: 'UNVERIFIED'}
         and result.get('cases') == {name: inner_status}
         and result.get('complete') is (native_exit == 0) and result.get('cleanup_complete') is True
         and result.get('reused') is False and not result.get('cleanup_owner'), 'structural result incomplete cleanup')
    recipe = request['worker_recipe']
    service_recipe = (recipe.get('services') is True and recipe.get('cleanup', {}).get('command') == [
        'bash', '-c', 'bash scripts/kill-services.sh && bash scripts/run-deploy-stage --finish']
        and recipe['cleanup'].get('cwd', '.') == '.')
    structural_case = recipe.get('cases', {}).get(name, {})
    cases_only = (set(recipe) == {'cases'}
                  and set(structural_case) == {'command', 'cwd', 'env', 'aggregate'}
                  and structural_case.get('command') == [
                      'python3', 'scripts/run-deploy-structural-gates.py', '--max-workers', '5']
                  and structural_case.get('cwd') == '.')
    if file_adapter:
        coordinator_file = command[1] == str(ROOT / 'scripts/deploy_test_worker.py')
        need((cases_only and structural_case.get('env') == {}) if coordinator_file else service_recipe,
             'native structural file command/recipe pairing')
    need((service_recipe or cases_only) and set(recipe['cases']) == {name}
         and structural_case.get('aggregate') is True, 'native structural cleanup recipe')
    case = result['evidence'][name]
    native = root / '.context/deploy-worker' / hashlib.sha256(receipt['token'].encode()).hexdigest()
    log = native / (hashlib.sha256(name.encode()).hexdigest() + '.log')
    need(case.get('status') == inner_status and type(case.get('native_exit')) is int
         and case['native_exit'] == native_exit
         and case.get('command') == recipe['cases'][name]['command'] and case.get('log') == str(log)
         and log.resolve(strict=True) == log and sha_file(log) == case.get('sha256')
         and all(case.get(k) is False for k in ('timed_out', 'cancelled', 'lingering_group'))
         and receipt['started_at'] <= case['started_at'] <= case['finished_at'] <= receipt['finished_at'],
         'structural case not cleanly joined')
    need(type(process.get('native_exit')) is int and process['native_exit'] == receipt['native_exit']
         and process.get('quiescent') is True and process.get('orphaned_children') is True
         and all(process.get(k) is False for k in ('cancelled', 'timed_out'))
         and process.get('remaining') == []
         and process.get('error') is None, 'structural supervisor closure incomplete')
    child, supervisor = process.get('child_pid'), process.get('supervisor_pid')
    rows, terms, kills = (process.get(key) for key in ('reaped', 'term_sent', 'kill_sent'))
    need(type(child) is int and type(supervisor) is int and child > 1 and supervisor > 1 and child != supervisor
         and isinstance(rows, list) and len(rows) > 1 and isinstance(terms, list) and terms
         and isinstance(kills, list)
         and all(isinstance(row, dict) and set(row) == {'pid', 'status'}
                 and type(row['pid']) is int and row['pid'] > 1 and row['pid'] != supervisor
                 and type(row['status']) is int and 0 <= row['status'] <= 65535
                 and (os.WIFEXITED(row['status']) or os.WIFSIGNALED(row['status'])) for row in rows),
         'unknown structural descendant wait records')
    reaped = {row['pid']: row['status'] for row in rows}
    need(len(reaped) == len(rows) and reaped.get(child) == native_exit << 8
         and all(type(pid) is int and pid > 1 and pid != child and pid in reaped for pid in terms + kills)
         and len(set(terms)) == len(terms) and len(set(kills)) == len(kills)
         and set(kills) <= set(terms)
         # kill_sent records accepted requests, not which signal won an exit race.
         and all(os.WIFSIGNALED(reaped[pid])
                 and os.WTERMSIG(reaped[pid]) in (signal.SIGTERM, signal.SIGKILL)
                 for pid in kills), 'structural owned descendants not all reaped')
    quiet(root)
    return gate


def _premanifest_scan_main():
    """Fixed read-only extension of the native scanner for token/root custody."""
    try:
        signal.alarm(25)
        raw = sys.stdin.buffer.read(65537)
        request = json.loads(raw)
        if (len(raw) > 65536 or set(request) != {'uid', 'pid', 'birth', 'root', 'token', 'owner_pid'}
                or os.geteuid() != 0 or type(request['uid']) is not int or request['uid'] <= 0
                or os.environ.get('SUDO_UID') != str(request['uid'])
                or type(request['pid']) is not int or request['pid'] <= 1
                or type(request['owner_pid']) is not int or request['owner_pid'] <= 1
                or not isinstance(request['token'], str) or not re.fullmatch('[0-9a-f]{32}', request['token'])):
            raise ValueError('scan identity')
        original = identity(request['pid'])
        if original[:3] != (request['uid'], request['uid'], request['birth']):
            raise ValueError('caller changed')
        ancestor = os.getppid()
        for _ in range(6):
            if ancestor == request['pid']:
                break
            uid, euid, birth, ancestor = identity(ancestor)
            if uid not in (0, request['uid']) or euid not in (0, request['uid']):
                raise ValueError('foreign caller')
        else:
            raise ValueError('caller ancestry')
        root = Path(request['root'])
        if (not root.is_absolute() or str(root) != request['root'] or len(root.parts) < 3
                or root.resolve(strict=True) != root or root.stat().st_uid != request['uid']):
            raise ValueError('root custody')
        if Path('/proc', str(request['owner_pid'])).exists():
            raise ValueError('owner live or reused')
        seen = {}

        def census():
            rows = {}
            for entry in Path('/proc').glob('[0-9]*'):
                try:
                    pid = int(entry.name)
                    current = identity(pid)[:3]
                    if pid in seen and seen[pid] != current:
                        raise ValueError('process identity reused across scan passes')
                    seen[pid] = rows[pid] = current
                except (FileNotFoundError, ProcessLookupError):
                    if entry.exists():
                        raise ValueError('unobservable process identity')
            return rows

        # Inspect arrivals, never exempt them. Four complete passes bound churn;
        # only a final census wholly covered by one pass permits admission.
        for round_number in range(4):
            if Path('/proc', str(request['owner_pid'])).exists():
                raise ValueError('owner live or reused')
            before = census()
            scan_roots([root], birth_guard=True, excluded=(request['pid'],))
            for pid, expected in before.items():
                entry = Path('/proc', str(pid))
                if pid in (os.getpid(), request['pid']):
                    continue
                try:
                    if identity(pid)[:3] != expected:
                        raise ValueError('process identity changed')
                    proc_root = Path(os.readlink(entry / 'root').removesuffix(' (deleted)'))
                    argv = (entry / 'cmdline').read_bytes().split(b'\0')
                    env = (entry / 'environ').read_bytes().split(b'\0')
                    if (proc_root == root or root in proc_root.parents
                            or any(a == os.fsencode(root) or a.startswith(os.fsencode(str(root) + '/')) for a in argv)
                            or os.fsencode('RUN_STACK_CLEANUP_TOKEN=' + request['token']) in env
                            or identity(pid)[:3] != expected):
                        raise ValueError('active or changed process')
                except (FileNotFoundError, ProcessLookupError):
                    if entry.exists():
                        raise ValueError('unobservable process')
            after = census()
            if any(before[pid] != after[pid] for pid in before.keys() & after.keys()):
                raise ValueError('process identity changed')
            if identity(request['pid']) != original:
                raise ValueError('caller changed')
            if not after.keys() - before.keys():
                if Path('/proc', str(request['owner_pid'])).exists():
                    raise ValueError('owner live or reused')
                break
        else:
            raise ValueError('process census did not settle within four passes')
        print(json.dumps({'request_sha256': hashlib.sha256(raw).hexdigest(), 'quiescent': True}))
    except Exception:
        print(json.dumps({'quiescent': False}))
        raise SystemExit(2)


def premanifest_card_scan(root, owner):
    import hashlib
    import inspect
    import json
    import subprocess
    from deploy_test_process_scan import ProcessAccessError, identity, scan_roots
    uid, euid, birth, _ = identity(os.getpid())
    need(uid == euid and uid > 0, 'Card scan requires original nonroot caller')
    request = dict(uid=uid, pid=os.getpid(), birth=birth, root=str(root),
                   token=owner['token'], owner_pid=owner['pid'])
    raw = json.dumps(request, sort_keys=True).encode()
    program = ('import os,sys,json,hashlib,signal,re\nfrom pathlib import Path\n'
               + inspect.getsource(ProcessAccessError) + '\n' + inspect.getsource(identity) + '\n'
               + inspect.getsource(scan_roots) + '\n' + inspect.getsource(_premanifest_scan_main)
               + '\n_premanifest_scan_main()\n')
    result = subprocess.run(['/usr/bin/sudo', '-n', '/usr/bin/python3', '-I', '-S', '-B', '-c', program],
                            input=raw, capture_output=True, timeout=30, close_fds=True,
                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
    need(result.returncode == 0 and len(result.stdout) <= 4096, 'Card process custody unverified')
    need(json.loads(result.stdout) == {'request_sha256': hashlib.sha256(raw).hexdigest(), 'quiescent': True}
         and identity(os.getpid())[:3] == (uid, euid, birth), 'Card scan response changed')


def premanifest_card_database(database):
    # Reuse the existing read-only native catalog query, never a cleanup operation.
    import runpy
    from deploy_test_cycle import ROOT
    return runpy.run_path(str(ROOT / 'agents/benchmarks/local_cleanup_reconcile.py'))['_database_present'](database)


def premanifest_card_absent(root, run, owner, database, ports):
    premanifest_card_scan(root, owner)
    listeners = set()
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        for line in Path(table).read_text().splitlines()[1:]:
            row = line.split()
            if row[3] == '0A':
                listeners.add(int(row[1].rsplit(':', 1)[1], 16))
    need(not set(ports.values()) & listeners, 'Card listener remains')
    need(premanifest_card_database(database) is None, 'Card database present')
    premanifest_card_scan(root, owner)


def premanifest_card(state, receipt, proof, *, clean_manifest=False):
    """Only resource closure of a cancelled FILE startup; original evidence stays failed."""
    import hashlib
    import sys
    from deploy_test_cycle import ROOT, bounded_read, digest, sha_file
    gate, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
    root = Path(gate['worker_root']).resolve(strict=True)
    name = 'agentcard-lifecycle'
    need(gate.get('name') == gate.get('category') == name and gate.get('worker_transport') == 'local-isolated'
         and gate.get('case_protocol') is True and gate.get('result_transport') == 'file'
         and gate.get('cwd') == gate['worker_root'] == str(root)
         and not gate.get('native_backend') and not gate.get('native_cloud'), 'pre-manifest Card binding')
    command = gate['command']
    need(len(command) == 4 and Path(command[0]).resolve(strict=True) == Path(sys.executable).resolve(strict=True)
         and command[1:] == [str(ROOT / 'scripts/deploy_test_worker.py'), '--root', str(root)]
         and receipt.get('command') == command, 'pre-manifest native command')
    binding = receipt.get('execution_binding', {})
    need(binding.get('contract_digest') == digest(gate)
         and all(isinstance(binding.get(k), str) and binding[k] for k in ('environment', 'input_fingerprint'))
         and receipt.get('host_admission', {}).get('started') is True
         and receipt['host_admission'].get('lock') == str(root / '.context/native-worker-admission.lock'),
         'pre-manifest execution binding')
    need(receipt.get('lifecycle') == 'native-producer' and receipt.get('executed') is True
         and receipt.get('complete') is False and receipt.get('native_exit') == 1
         and type(receipt['native_exit']) is int and receipt.get('cancelled') is True
         and receipt.get('timed_out') is False and receipt.get('lingering_group') is True,
         'pre-manifest cancelled receipt')
    names = {'request.json', 'receipt.json', 'result.json', 'native-result.json', 'case.log',
             'services.log', 'local-stack-owner.json', 'local-benchmark-owner.json'}
    if clean_manifest:
        names |= {'services.json', 'local-stack-cleanup.status'}
    need(set(proof['files']) == names, 'pre-manifest sealed inventory')
    folder = Path(receipt['log']).parent
    need(folder.resolve(strict=True) == folder and Path(receipt['log']) == folder / 'output.log'
         and receipt.get('worker_result') == str(folder / 'result.json'), 'pre-manifest result path')
    def sealed(path, key, text=False):
        need(not path.is_symlink() and path.resolve(strict=True) == path and path.is_file()
             and sha_file(path) == proof['files'][key], 'pre-manifest artifact changed: ' + key)
        if text:
            need(path.stat().st_size <= 65536, 'pre-manifest log bound')
            return path.read_text()
        return bounded_read(path, key)
    request, result, recorded = [sealed(folder / n, n) for n in ('request.json', 'result.json', 'receipt.json')]
    need(recorded == receipt and all(row.get(k) == receipt.get(k) for row in (request, result)
                                    for k in ('source', 'token', 'gate'))
         and request.get('worker_root') == result.get('worker_root') == str(root)
         and request.get('checks') == gate['checks'] == [name] and request.get('skips') == {},
         'pre-manifest source/token/inventory')
    recipe = request['worker_recipe']
    spec = recipe.get('cases', {}).get(name, {})
    need(recipe == gate.get('worker_recipe') and set(recipe) == {'cases'} and set(recipe['cases']) == {name}
         and spec.get('cwd') == '.' and spec.get('aggregate') is True
         and spec.get('command') == ['bash', 'scripts/run-bench', '--local', 'agent-payment-test-shop',
             'agent-payment-setup-resume', 'agent-payment-idempotent-abandonment', 'agent-payment-abandonment',
             '--bootstrap', '--max-concurrency', '1', '--no-dashboard']
         and result.get('recipe_digest') == digest(recipe), 'pre-manifest recipe')
    need(receipt.get('cases') == result.get('cases') == {name: 'UNVERIFIED'}
         and result.get('complete') is False and result.get('cleanup_complete') is True
         and result.get('reused') is False and not result.get('cleanup_owner'), 'pre-manifest result state')
    reference = dict(result=str(folder / 'result.json'), native_directory=None, cleanup_complete=True,
                     result_sha256=proof['files']['result.json'], native_evidence=result['evidence'])
    need(receipt.get('native_cleanup_reference') == reference and receipt.get('cleanup_owner') == dict(
        request_token=receipt['token'], worker_root=str(root), native_cleanup_reference=reference), 'pre-manifest retained owner')
    case = result['evidence'][name]
    native = root / '.context/deploy-worker' / hashlib.sha256(receipt['token'].encode()).hexdigest()
    log = native / (hashlib.sha256(name.encode()).hexdigest() + '.log')
    need(case.get('log') == str(log) and case.get('sha256') == proof['files']['case.log']
         and case.get('command') == spec['command'] and case.get('status') == 'UNVERIFIED'
         and type(case.get('native_exit')) is int and case['native_exit'] == (143 if clean_manifest else 1)
         and case.get('cancelled') is True and case.get('timed_out') is False and case.get('lingering_group') is False
         and receipt['started_at'] <= case['started_at'] <= case['finished_at'] <= receipt['finished_at']
         and sealed(native / 'result.json', 'native-result.json') == result, 'pre-manifest native result')
    text = sealed(log, 'case.log', True)
    need('Received signal 15; draining owned benchmark before services...' in text,
         'Card startup interruption linkage')
    launch = None
    if clean_manifest:
        launches = re.findall(r'^Isolated benchmark stack: (.+)$', text, re.M)
        need(len(launches) == 1, 'clean Card launch log missing or ambiguous')
        pairs = [field.split('=', 1) for field in launches[0].split()]
        need(all(len(pair) == 2 for pair in pairs) and len({p[0] for p in pairs}) == len(pairs),
             'clean Card launch log malformed')
        launch = dict(pairs)
        run = root / '.context/benchmarks' / launch.get('run_id', '')
        need(launch.get('context') == '.context/benchmarks/' + run.name, 'clean Card context mismatch')
    else:
        matches = set(re.findall(r'cleanup receipt is missing or unsafe: (.+/local-stack-cleanup\.status)', text))
        need(len(matches) == 1, 'pre-manifest startup interruption linkage')
        run = Path(matches.pop().split('. If the stack owner exited,', 1)[0]).parent
    need(run.parent == root / '.context/benchmarks' and run.resolve(strict=True) == run
         and re.fullmatch(r'[0-9]+-[0-9]+-[0-9]+', run.name), 'pre-manifest run identity')
    forbidden = ['services.json.tmp', 'run.json', 'report-card.json', 'local-benchmark-results.json']
    if not clean_manifest:
        forbidden += ['local-stack-cleanup.status', 'services.json']
    need(not any((run / n).exists() or (run / n).is_symlink() for n in forbidden) and not list(run.glob('benchmark-cleanup*.status')),
         'pre-manifest conflicting or admitted artifact')
    benchmark = sealed(run / 'local-benchmark-owner.json', 'local-benchmark-owner.json')
    need(benchmark == dict(version=1, run_id=run.name, state='not_started', pid=None, native_identity='',
                           token='', receipt=str(run / 'benchmark-cleanup.status'), signal=None), 'benchmark admitted')
    owner = sealed(run / 'local-stack-owner.json', 'local-stack-owner.json')
    need(owner.get('version') == 1 and owner.get('run_id') == run.name and type(owner.get('pid')) is int
         and owner['pid'] > 1 and isinstance(owner.get('birth'), str) and owner['birth']
         and re.fullmatch('[0-9a-f]{32}', owner.get('token', ''))
         and re.fullmatch('linux:' + Path('/proc/sys/kernel/random/boot_id').read_text().strip() + r':[0-9]+',
                          owner.get('native_identity', '')) and not Path('/proc', str(owner['pid'])).exists(),
         'pre-manifest native owner live/reused/unknown')
    startup = sealed(run / 'services.log', 'services.log', True)
    if not clean_manifest:
        need(startup.rstrip().endswith('Python and Node Playwright Chromium assets are ready'),
             'not the observed pre-manifest bootstrap boundary')
    port = gate.get('env', {}).get('CONDUCTOR_PORT')
    need(isinstance(port, str) and port.isdecimal() and gate['env'].get('ROSE_USE_SYSTEM_PG') == 'true',
         'pre-manifest system PG launch')
    base = int(port) + 200
    ports = {key: base + offset for key, offset in
             [('backend', 0), ('frontend', 1), ('health', 2), ('mac-app', 3), ('metrics', 4),
              ('db', 5), ('wmh', 6), ('ngrok_api', 9)]}
    need(all(1 <= p <= 65535 for p in ports.values()), 'pre-manifest port range')
    port_rows = re.findall(r'^🔌 Ports: (.+)$', startup, re.M)
    need(len(port_rows) == 1 and all(re.search(r'(?:^| )' + key + '=' + str(value) + r'(?: |$)', port_rows[0])
                                   for key, value in ports.items()), 'pre-manifest launch ports')
    database = dict(use_system_postgres=True, name='victoria_bench_' + run.name.replace('-', '_'))
    need(re.findall(r'^🐘 Created isolated system database (\S+)$', startup, re.M) == [database['name']]
         and '🐘 System Postgres already running on port 5432' in startup,
         'pre-manifest database identity')
    need(spec.get('env', {}) == {k: v for k, v in spec.get('env', {}).items()
         if (k, v) in {('BENCHMARK_SKIP_WMH_BUILD', '1'), ('BENCHMARK_ATTEMPT_SUITE', 'predeploy'),
                       ('BENCHMARK_COUNTS_FOR_DEPLOY_ELIGIBILITY', '0'), ('BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL', '1')}},
         'pre-manifest case environment changed')
    workspace = gate['env'].get('CONDUCTOR_WORKSPACE_NAME')
    need(isinstance(workspace, str) and workspace
         and 'queue=navi-agent-tasks-' + workspace + '-bench-' + run.name + ' ' in port_rows[0],
         'pre-manifest workspace/run linkage')
    if clean_manifest:
        need(launch == dict(run_id=run.name, context='.context/benchmarks/' + run.name,
                           backend=str(ports['backend']), frontend=str(ports['frontend']), db='5432',
                           db_name=database['name'], queue='navi-agent-tasks-' + workspace + '-bench-' + run.name),
             'clean Card launch resources changed')
        lines = sealed(run / 'local-stack-cleanup.status', 'local-stack-cleanup.status', True).splitlines()
        pairs = [line.partition('=') for line in lines]
        need(all(key and sep for key, sep, value in pairs) and len({p[0] for p in pairs}) == len(pairs),
             'clean Card receipt malformed')
        need({key:value for key, sep, value in pairs} == dict(version='2', state='clean', token=owner['token'],
             stack_pid=str(owner['pid']), stack_birth=owner['birth'], stack_native_identity=owner['native_identity']),
             'clean Card receipt identity/state mismatch')
        manifest = sealed(run / 'services.json', 'services.json')
        manifest_ports = dict(backend=ports['backend'], frontend=ports['frontend'], health=ports['health'],
                              local_db=ports['db'], mac_app=ports['mac-app'], sdk_metrics=ports['metrics'],
                              ngrok_api=ports['ngrok_api'], wmh=0)
        need(type(manifest.get('schema_version')) is int and manifest['schema_version'] == 1
             and manifest.get('benchmark_mode') is True
             and manifest.get('status') == 'stopped' and manifest.get('worktree') == str(root)
             and manifest.get('run_sh_pid') == owner['pid'] and manifest.get('ports') == manifest_ports
             and all(type(value) is int for value in manifest['ports'].values())
             and manifest.get('database', {}).get('use_system_postgres') is True
             and manifest.get('database', {}).get('owned_by_run_sh') is True
             and all(type(manifest['database'].get(key)) is int for key in ('port', 'runtime_port'))
             and manifest.get('temporal_task_queue') == launch['queue']
             and manifest.get('database') == dict(name=database['name'], use_system_postgres=True,
                 port=5432, runtime_port=5432, owned_by_run_sh=True, container='', volume=''),
             'clean Card stopped manifest resources mismatch')
        services = manifest.get('services')
        need(isinstance(services, list) and len(services) == 4
             and all(isinstance(row, dict) and set(row) == {'name','pid'} for row in services)
             and {row['name'] for row in services} == {'cloudflared','back-end','front-end','agents'}
             and all(type(row['pid']) is int and row['pid'] > 1 and row['pid'] != owner['pid'] for row in services)
             and len({row['pid'] for row in services}) == 4
             and all(not Path('/proc', str(row['pid'])).exists() for row in services),
             'clean Card service identity live/reused/unknown')
    quiet(root)
    premanifest_card_absent(root, run, owner, database, ports)
    if clean_manifest:
        need(all(not Path('/proc', str(row['pid'])).exists() for row in services),
             'clean Card service identity appeared during validation')
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


def cancelled_log_supplement(receipt, proof, case, expected_log):
    """Seal late cancelled output for resource custody only; never repair test evidence."""
    from deploy_test_cycle import sha_file
    final = proof['final_log']
    need(isinstance(final, dict) and set(final) == {'path', 'sha256', 'size', 'mtime_ns', 'recorded_sha256'},
         'cancelled log supplement fields')
    need(receipt['gate'] == 'agents-coverage-blackbox' and case.get('native_exit') == -15
         and case.get('lingering_group') is True
         and case.get('sha256') == final['recorded_sha256'] == hashlib.sha256(b'').hexdigest(),
         'cancelled log supplement origin')
    need(final['path'] == str(expected_log) and expected_log.resolve(strict=True) == expected_log,
         'cancelled log supplement path')
    before = expected_log.stat()
    need(stat.S_ISREG(before.st_mode) and type(final['size']) is int and final['size'] > 0
         and before.st_size == final['size']
         and type(final['mtime_ns']) is int and before.st_mtime_ns == final['mtime_ns']
         and case['finished_at'] < before.st_mtime_ns / 1e9 <= receipt['finished_at']
         and final['sha256'] != final['recorded_sha256'] and sha_file(expected_log) == final['sha256'],
         'cancelled log supplement content/time')
    after = expected_log.stat()
    need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
         == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
         'cancelled log changed during verification')
    return True


def interrupted_worker(state, receipt, proof):
    """Account fully reaped interrupted custody; a missing adapter earns no credit.

    A KILL escalation (-9) and a coordinator TERM cancellation (-15) are both supported. A TERM'd
    supervisor that exited before writing its receipt has no wait records: then only the
    coordinator's own token-bound clean teardown record plus root/port quiescence can release it."""
    from deploy_test_cycle import ROOT, bounded_read, digest, sha_file
    import sys
    gate, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
    root = Path(gate['worker_root']).resolve(strict=True)
    backend = gate.get('native_backend') is True and gate['name'] == 'backend-coverage-blackbox'
    command = gate['command']
    file_adapter = gate.get('result_transport') == 'file' and not backend
    returned = file_adapter and gate['name'] in {'deploy-command-structural', 'frontend-coverage-blackbox', 'agents-coverage-blackbox'} and receipt.get('native_exit') == 1
    native_command = (len(command) == 4 and Path(command[1]).name == 'deploy_test_backend.py'
                      and command[2:] == ['--root', str(root)]) if backend else (
                      len(command) == 5 and command[1:] == [str(root / 'scripts/deploy_test_worker.py'), '--root', str(root), '--stdio'])
    if file_adapter:
        native_command = (len(command) == 4 and Path(command[0]).resolve(strict=True) == Path(sys.executable).resolve(strict=True)
                          and command[1:] == [str(ROOT / 'scripts/deploy_test_worker.py'), '--root', str(root)])
    need(gate.get('worker_transport') == 'local-isolated' and gate.get('case_protocol') is True
         and gate.get('result_transport') == ('file' if backend or file_adapter else 'stdout')
         and not gate.get('native_cloud') and gate.get('category') != 'agentcard-lifecycle'
         and gate.get('native_backend') in (None, False, True) and (not gate.get('native_backend') or backend)
         and str(root) == gate['worker_root'] == gate.get('cwd')
         and native_command and receipt.get('command') == command, 'interrupted native local worker binding')
    need(receipt.get('lifecycle') == 'owned' and receipt.get('executed') is True
         and receipt.get('complete') is False and receipt.get('status') == 'FAIL'
         and type(receipt.get('native_exit')) is int and (receipt['native_exit'] == 1 if returned else receipt['native_exit'] in (-9, -15))
         and receipt.get('cancelled') is True and receipt.get('timed_out') is False
         and (type(receipt.get('lingering_group')) is bool if returned else receipt.get('lingering_group') is True)
         and not receipt.get('cleanup_owner')
         and (receipt.get('worker_result') == str(Path(receipt['log']).parent / 'result.json') if returned else receipt.get('worker_result') is None)
         and receipt.get('native_cleanup_reference') is None,
         'interrupted supervised receipt required')
    binding = receipt.get('execution_binding', {})
    need(binding.get('contract_digest') == digest(gate)
         and all(isinstance(binding.get(k), str) and binding[k] for k in ('input_fingerprint', 'environment'))
         and receipt.get('host_admission', {}).get('started') is True
         and receipt['host_admission'].get('lock') == str(root / '.context/native-worker-admission.lock'),
         'interrupted execution/admission contract changed')
    folder = Path(receipt['log']).parent
    signal = -receipt['native_exit']
    sidecar = folder / 'output.log.process.json'
    attempt = folder.parent.parent.name  # attempts/<round>/<phase>/<gate>: stable across later rounds
    need(attempt.isdigit(), 'interrupted attempt identity')
    teardown = f"teardown/attempt-{attempt}-{receipt['gate']}.json"
    supervised = sidecar.exists() or sidecar.is_symlink()
    names = ({'request.json', 'receipt.json', 'output.log.process.json'} if supervised
             else {'request.json', 'receipt.json', teardown})
    need(supervised or signal == 15, 'a KILLed supervisor must leave its wait records')
    if returned:
        need(supervised, 'returned adapter requires its supervisor receipt')
        names.add('result.json')
    need(Path(receipt['log']) == folder / 'output.log' and folder.resolve(strict=True) == folder
         and isinstance(proof['files'], dict) and set(proof['files']) == names
         and not any((folder / n).exists() or (folder / n).is_symlink()
                     for n in (('output.log.process.json.watchdog.json',) if returned else ('result.json', 'output.log.process.json.watchdog.json'))),
         'interrupted artifact inventory')
    docs = {}
    for name in names:
        path = folder / name
        need(not path.is_symlink() and path.resolve(strict=True) == path
             and sha_file(path) == proof['files'][name], 'interrupted artifact changed: ' + name)
        docs[name] = bounded_read(path, 'interrupted cleanup ' + name)
    request, recorded = docs['request.json'], docs['receipt.json']
    need(recorded == receipt and all(request.get(k) == receipt.get(k) for k in ('token', 'source', 'gate'))
         and request.get('worker_root') == str(root) and request.get('worker_recipe') == gate.get('worker_recipe')
         and isinstance(request.get('skips'), dict) and set(request['skips']) <= set(gate['checks'])
         and request.get('checks') == [case for case in gate['checks'] if case not in request['skips']]
         and request['checks'] and receipt.get('cases') == {case: 'SKIP' if case in request['skips'] else 'UNVERIFIED'
                                                         for case in gate['checks']}, 'interrupted request identity/inventory')
    if returned:
        process = docs['output.log.process.json']
        need(type(process.get('native_exit')) is int and process['native_exit'] == (1 if returned else -9)
             and process.get('cancelled') is True and process.get('timed_out') is False
             and process.get('quiescent') is True and process.get('remaining') == []
             and type(process.get('orphaned_children')) is bool and process.get('error') is None,
             'interrupted supervisor closure unknown')
        child, supervisor = process.get('child_pid'), process.get('supervisor_pid')
        rows, terms, kills = (process.get(k) for k in ('reaped', 'term_sent', 'kill_sent'))
        need(type(child) is int and type(supervisor) is int and child > 1 and supervisor > 1 and child != supervisor
             and isinstance(rows, list) and rows and isinstance(terms, list) and isinstance(kills, list) and (returned or kills)
             and all(isinstance(row, dict) and set(row) == {'pid', 'status'}
                     and type(row['pid']) is int and row['pid'] > 1 and row['pid'] != supervisor
                     and type(row['status']) is int and 0 <= row['status'] <= 65535
                     and (os.WIFEXITED(row['status']) or os.WIFSIGNALED(row['status'])) for row in rows),
             'interrupted wait records unknown')
        reaped = {r['pid']: r['status'] for r in rows}
        need(len(reaped) == len(rows) and reaped.get(child) == (256 if returned else 9) and (child not in kills if returned else child in kills)
             and all(type(pid) is int and pid > 1 and pid in reaped for pid in terms + kills)
             and len(set(terms)) == len(terms) and len(set(kills)) == len(kills) and set(kills) <= set(terms),
             'interrupted owned targets were not all reaped')
        if returned:
            result = docs['result.json']
            need(all(result.get(k) == request.get(k) for k in ('token', 'source', 'gate', 'worker_root'))
                 and result.get('recipe_digest') == digest(request['worker_recipe'])
                 and result.get('cases') == receipt.get('cases')
                 and result.get('complete') is False and result.get('reused') is False
                 and result.get('cleanup_complete') is True and not result.get('cleanup_owner'),
                 'interrupted returned result identity/cleanup')
            case = result.get('evidence', {}).get(gate['name'], {})
            expected_log = root / '.context/deploy-worker' / hashlib.sha256(receipt['token'].encode()).hexdigest() / (hashlib.sha256(gate['name'].encode()).hexdigest() + '.log')
            expected = {
                'deploy-command-structural': {'command': ['python3', 'scripts/run-deploy-structural-gates.py', '--max-workers', '5'], 'cwd': '.', 'env': {}, 'aggregate': True},
                'frontend-coverage-blackbox': {'command': ['npm', 'run', 'test:coverage', '--', '--maxWorkers=1'], 'cwd': 'front-end', 'env': {}, 'aggregate': True},
                'agents-coverage-blackbox': {'command': ['bash', 'scripts/run-coverage.sh'], 'cwd': 'agents', 'env': {'AGENTS_COVERAGE_CONCURRENCY': '2'}, 'aggregate': True},
            }[gate['name']]
            need(gate['worker_recipe'] == {'cases': {gate['name']: expected}}
                 and case.get('status') == 'UNVERIFIED' and type(case.get('native_exit')) is int and case['native_exit'] in {-15, 143}
                 and case.get('cancelled') is True and case.get('timed_out') is False and type(case.get('lingering_group')) is bool
                 and case.get('command') == gate['worker_recipe']['cases'][gate['name']]['command']
                 and case.get('log') == str(expected_log) and not expected_log.is_symlink()
                 and receipt['started_at'] <= case['started_at'] <= case['finished_at'] <= receipt['finished_at'],
                 'interrupted returned case boundary')
            if proof['kind'] == SUPPLEMENT_KIND:
                cancelled_log_supplement(receipt, proof, case, expected_log)
            else:
                need(sha_file(expected_log) == case.get('sha256'), 'interrupted returned log changed')
    else:
        if supervised:
            process = docs['output.log.process.json']
            need(type(process.get('native_exit')) is int and process['native_exit'] == -signal
                 and process.get('cancelled') is True and process.get('timed_out') is False
                 and process.get('quiescent') is True and process.get('remaining') == []
                 and type(process.get('orphaned_children')) is bool and process.get('error') is None,
                 'interrupted supervisor closure unknown')
            child, supervisor = process.get('child_pid'), process.get('supervisor_pid')
            rows, terms, kills = (process.get(k) for k in ('reaped', 'term_sent', 'kill_sent'))
            need(type(child) is int and type(supervisor) is int and child > 1 and supervisor > 1 and child != supervisor
                 and isinstance(rows, list) and rows and isinstance(terms, list) and isinstance(kills, list)
                 and (bool(kills) if signal == 9 else kills == [])
                 and all(isinstance(row, dict) and set(row) == {'pid', 'status'}
                         and type(row['pid']) is int and row['pid'] > 1 and row['pid'] != supervisor
                         and type(row['status']) is int and 0 <= row['status'] <= 65535
                         and (os.WIFEXITED(row['status']) or os.WIFSIGNALED(row['status'])) for row in rows),
                 'interrupted wait records unknown')
            reaped = {r['pid']: r['status'] for r in rows}
            need(len(reaped) == len(rows) and reaped.get(child) == signal and child in (kills if signal == 9 else terms)
                 and all(type(pid) is int and pid > 1 and pid in reaped for pid in terms + kills)
                 and len(set(terms)) == len(terms) and len(set(kills)) == len(kills) and set(kills) <= set(terms),
                 'interrupted owned targets were not all reaped')
        else:
            # The coordinator's own token-bound teardown observed this lane after the TERM.
            record = docs[teardown]
            need(record.get('token') == receipt['token'] and record.get('lane') == receipt['gate']
                 and record.get('attempt') == int(attempt) and record.get('outcome') == 'clean'
                 and all(record.get(k) == [] for k in ('survivors', 'lingering', 'owned', 'foreign')),
                 'interrupted teardown did not observe a clean lane')
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
    if proof['kind'] == SUPPLEMENT_KIND:
        from deploy_test_process_scan import prepared_workers_idle
        prepared_workers_idle([root], birth_guard=True)
        cancelled_log_supplement(receipt, proof, case, expected_log)
    return gate


def validate(state, receipt, proof):
    if proof.get('layout') == 'nativebackend-post-execution-cleanup-v1':
        from deploy_test_backend_post_cleanup import validate as validate_post_execution
        return validate_post_execution(state, receipt, proof)
    if proof.get('layout') == 'backend-prisma-preflight-v1':
        from deploy_test_backend_preflight_cleanup import validate as validate_preflight
        return validate_preflight(state, receipt, proof)
    from deploy_test_cycle import bounded_read, digest, sha_file
    supplemented = proof.get('kind') == SUPPLEMENT_KIND
    fields = {'kind', 'files', 'confirmed_at', 'observed_by'} | ({'final_log'} if supplemented else set())
    if (receipt.get('gate') == 'deploy-command-structural'
            and receipt.get('cancelled') is False and receipt.get('lifecycle') == 'owned'
            and 'original_gate' in proof):
        fields.add('original_gate')
    need(set(proof) == fields and proof['kind'] in (KIND, SUPPLEMENT_KIND), 'proof fields')
    if supplemented:
        need(receipt.get('gate') == 'agents-coverage-blackbox' and receipt.get('cancelled') is True
             and receipt.get('lifecycle') == 'owned' and receipt.get('native_exit') == 1,
             'cancelled log supplement receipt')
    need(isinstance(proof['observed_by'], str) and proof['observed_by'].strip(), 'independent observer missing')
    confirmed = proof['confirmed_at']
    need(type(confirmed) in (int, float) and math.isfinite(confirmed)
         and type(receipt.get('finished_at')) in (int, float)
         and receipt['finished_at'] <= confirmed <= time.time(), 'confirmation time')
    name = receipt['gate']
    if receipt.get('cancelled') is True and receipt.get('lifecycle') == 'owned':
        return interrupted_worker(state, receipt, proof)
    if name == 'agentcard-lifecycle':
        gate, = [g for g in state['plan']['gates'] if g['name'] == name]
        if gate.get('result_transport') == 'file' and receipt.get('cancelled') is True:
            return premanifest_card(state, receipt, proof,
                clean_manifest={'services.json', 'local-stack-cleanup.status'} <= set(proof['files']))
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
    if receipt['gate'] == 'agentcard-lifecycle' and receipt.get('cancelled') is True:
        gate, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
        if gate.get('result_transport') == 'file':
            need(proof['files'].get('receipt.json') not in state.get('reconciled_owners', {}), 'reconciliation already recorded')
    try:
        gate = validate(state, receipt, proof)
    except (OSError, KeyError, TypeError) as error:
        raise ValueError('local cleanup: missing or unknown evidence') from error
    state.setdefault('reconciled_owners', {})[proof['files']['receipt.json']] = {
        'kind': proof['kind'], 'gate': gate['name'], 'token': receipt['token'],
        'occurrence': occurrence_id, 'proof': copy.deepcopy(proof), 'credit_granted': False,
        'execution_gate': copy.deepcopy(gate)}


def tmpdir_transition_gate(state, execution, current):
    """Follow only recorded, same-source, lease-validated TMPDIR replacements."""
    from deploy_test_result import preserve_contract
    from deploy_test_isolation import external_tmpdir
    try:
        preserve_contract(execution, current)
        return execution  # No runtime transition is needed for this original receipt.
    except ValueError:
        pass
    cursor = execution
    for item in state.get('prepared_binding_history', []):
        if item.get('kind') != 'replace-owned-tmpdir-v1' or execution['name'] not in item.get('gates', []):
            continue
        before_plan, after_plan = item.get('from_plan', {}), item.get('to_plan', {})
        before = [g for g in before_plan.get('gates', []) if g['name'] == execution['name']]
        after = [g for g in after_plan.get('gates', []) if g['name'] == execution['name']]
        need(len(before) == 1, 'TMPDIR transition origin missing')
        before = before[0]
        # Unrelated historical transitions are not authority for this execution.
        if cursor.get('env', {}).get('TMPDIR') != before.get('env', {}).get('TMPDIR'):
            continue
        need(len(after) == 1, 'TMPDIR transition destination missing')
        after = after[0]
        preserve_contract(cursor, before)
        need(item.get('credit_granted') is False
             and before_plan.get('source') == item.get('from_source')
             == item.get('to_source') == after_plan.get('source'), 'TMPDIR transition source changed')
        expected = copy.deepcopy(before_plan)
        names = item['gates']
        need(len(names) == len(set(names)) and set(item.get('leases', {})) == set(names),
             'TMPDIR transition lease inventory')
        for name in names:
            old, = [g for g in expected['gates'] if g['name'] == name]
            new, = [g for g in after_plan['gates'] if g['name'] == name]
            value = new.get('env', {}).get('TMPDIR')
            need(old.get('worker_transport') == 'local-isolated' and not old.get('quick')
                 and isinstance(value, str) and old.get('env', {}).get('TMPDIR') != value,
                 'TMPDIR transition did not replace a local binding')
            lease = item['leases'][name]
            need(external_tmpdir(value, Path(old['worker_root']), Path(lease['coordinator_root']),
                                 name, item['to_source']) == lease, 'TMPDIR transition custody changed')
            old['env']['TMPDIR'] = value
        need(expected == after_plan, 'TMPDIR transition changed another contract')
        cursor = after
    preserve_contract(cursor, current)
    return cursor


def still_bound(state, receipt, entry):
    from deploy_test_cycle import digest
    need(entry.get('kind') in (KIND, SUPPLEMENT_KIND) and entry.get('kind') == entry.get('proof', {}).get('kind')
         and entry.get('gate') == receipt['gate']
         and entry.get('token') == receipt['token'] and entry.get('credit_granted') is False, 'reconciliation changed')
    # Cleanup belongs to the original execution contract; a refreshed full
    # inventory may add checks while the same old physical root is rechecked.
    gate = entry.get('execution_gate')
    original = {**state, 'plan': {'gates': [gate]}} if gate is not None else state
    try:
        if 'original_gate' in entry['proof']:
            need(entry['gate'] == 'deploy-command-structural'
                 and isinstance(gate, dict) and digest(gate) == digest(entry['proof']['original_gate']),
                 'original structural witness changed')
        if gate is not None:
            from deploy_test_result import preserve_contract
            current, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
            comparison = tmpdir_transition_gate(state, gate, current)
            if 'original_gate' in entry['proof']:
                structural_original_gate(comparison, current)
            if entry['proof'].get('layout') == 'nativebackend-post-execution-cleanup-v1':
                from deploy_test_backend_post_cleanup import current_gate
                current_gate(comparison, current)
            preserve_contract(comparison, current)
            need(set(gate['checks']) <= set(current['checks']), 'original checks removed')
        validate(original, receipt, entry['proof'])
    except (OSError, KeyError, TypeError) as error:
        raise ValueError('local cleanup: sealed evidence no longer available') from error
