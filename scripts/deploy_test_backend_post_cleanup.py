"""Launch-only closure of an executed backend sweep; native failures are never adopted."""
import hashlib
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import time

import deploy_test_backend_post_cleanup_audit as audit

LAYOUT = 'nativebackend-post-execution-cleanup-v1'
AUDITOR_SHA256 = 'c5c3a7b4a80286fa299cf59bfccf5948685ac9781eceaffaa8f6fbcbc0f82865'
PINS = {'scripts/deploy_test_backend.py': '33f766521aeb401fa4d1f169e88a92f953b84452eaa9808342a76a4e9d4b3d89', 'back-end/scripts/run-coverage.sh': 'd5bd7061647f63d3d8148caa9720e611a5c5c73fa2512c035ccaea973da714fa', 'back-end/scripts/run-coverage-sharded.sh': '8a2385504f66e583c13b52308b1eceefe6b706f47cec531fa1ad8bde0f50ea10', 'back-end/scripts/run-blackbox-tests.sh': '4ea02accef9182a89859593b5458cc61396970756266f2e60f00b6e49a6b2538', 'back-end/scripts/test-db-run-lock.sh': '62f403f86b39dad90b50da382b35030c2c24177c0022c3e8ed9c8df3c543f6f9', 'scripts/tests/blackbox-backend-teardown.test.sh': '237f5ffcdd147a8f9f1b4e186add48663540ca2a97dd4746622083a465d025b1', 'scripts/lib/cloudbench-env.sh': '166f249b055d9b5ebf6d28cb54c7f522e4ad0ab5652cfe670ecc58388a947e2d'}


def need(value, message):
    if not value:
        raise ValueError('backend post-execution cleanup: ' + message)


def same(left, right):
    from deploy_test_cycle import digest
    return digest(left) == digest(right)


def source_bytes(root, head, name):
    return subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), 'show', head + ':' + name])


def current_gate(original, current):
    """Exact typed execution contract; only a typed selection explanation may change."""
    need(isinstance(original, dict) and isinstance(current, dict) and set(original) == set(current),
         'current contract shape changed')
    if 'selection_evidence' in original:
        need(all(isinstance(gate['selection_evidence'], list)
                 and all(isinstance(item, str) for item in gate['selection_evidence'])
                 for gate in (original, current)), 'selection metadata shape')
    need(same({k: v for k, v in original.items() if k != 'selection_evidence'},
              {k: v for k, v in current.items() if k != 'selection_evidence'}),
         'current execution contract changed')


def terminal_waits(process):
    need(set(process) == {'supervisor_pid', 'child_pid', 'native_exit', 'cancelled', 'timed_out', 'quiescent',
                         'orphaned_children', 'reaped', 'term_sent', 'kill_sent', 'remaining', 'error'}, 'supervisor shape')
    need(type(process.get('native_exit')) is int and process['native_exit'] == 1
         and process.get('quiescent') is True and process.get('error') is None
         and all(process.get(k) is False for k in ('cancelled', 'timed_out', 'orphaned_children'))
         and all(process.get(k) == [] for k in ('remaining', 'term_sent', 'kill_sent')), 'supervisor closure unknown')
    child, supervisor = process.get('child_pid'), process.get('supervisor_pid')
    rows = process.get('reaped')
    need(type(child) is int and child > 1 and type(supervisor) is int and supervisor > 1
         and child != supervisor and isinstance(rows, list) and rows, 'supervisor identities')
    pids = set(); primary = 0
    for row in rows:
        need(isinstance(row, dict) and set(row) == {'pid', 'status'}
             and type(row['pid']) is int and row['pid'] > 1 and row['pid'] != supervisor
             and row['pid'] not in pids and type(row['status']) is int
             and 0 <= row['status'] <= 65535
             and (os.WIFEXITED(row['status']) or os.WIFSIGNALED(row['status'])), 'malformed or nonterminal reap')
        pids.add(row['pid'])
        if row['pid'] == child:
            need(row['status'] == 256, 'primary wait status'); primary += 1
    need(primary == 1, 'primary child must be reaped exactly once')


def expected_artifacts(root, receipt, result):
    native = root / '.context/deploy-backend' / hashlib.sha256(receipt['token'].encode()).hexdigest()
    evidence = result['evidence']; artifacts = evidence['artifacts']
    need(result['runner_log'] == str(native / 'runner.log'), 'native directory identity')
    need(set(evidence['shard_logs']) == {str(root / 'back-end/coverage' / ('shard-%d.log' % i)) for i in (1, 2)},
         'native shard inventory')
    expected = {str(native / 'result.json'): None, str(native / 'runner.log'): artifacts['runner_log'],
                str(native / 'postgres-before.json'): evidence['postgres_fixture']['before_sha256'],
                str(native / 'postgres-after.json'): evidence['postgres_fixture']['after_sha256']}
    for key, filename, role in [('units', 'units.log', 'units_log'), ('fps', 'units-probe.log', 'fps_log')]:
        path = root / 'back-end/coverage' / filename
        need(evidence[key]['log'] == str(path), 'phase log path')
        expected[str(path)] = artifacts[role]
    for key, role in [('teardown', 'teardown_log'), ('coverage-threshold', 'threshold_log')]:
        path = native / ('teardown.log' if key == 'teardown' else 'threshold.log')
        need(evidence[key]['log'] == str(path), 'native control log path')
        expected[str(path)] = artifacts[role]
    expected.update(evidence['shard_logs'])
    summaries = artifacts['summaries']
    need(isinstance(summaries, dict) and summaries and all(
        re.fullmatch(re.escape(str(root / 'back-end/coverage')) + r'/blackbox-run-shard[12]/summary\.json', p)
        for p in summaries), 'original summary inventory')
    expected.update(summaries)
    return native, expected


def audit_spec(root, receipt, gate, sweep, fixture):
    env = sweep.get('env', {}); workspace = env.get('CONDUCTOR_WORKSPACE_NAME'); base = env.get('CONDUCTOR_PORT')
    need(isinstance(workspace, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', workspace)
         and isinstance(base, str) and base.isdecimal() and 1024 <= int(base) <= 65000
         and env.get('ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME') == '1', 'workspace binding')
    base = int(base)
    need(fixture.get('id') and re.fullmatch(r'[0-9a-f]{64}', fixture['id'])
         and fixture.get('name') == '/victoria-db-' + workspace and fixture.get('owner') == str(root)
         and fixture.get('ports') == {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(base + 5)}]}
         and type(fixture.get('running')) is bool
         and fixture.get('status') == ('running' if fixture['running'] else 'exited')
         and all(fixture.get(k) is False for k in ('paused', 'restarting', 'dead'))
         and len(fixture.get('mounts', [])) == 1
         and fixture['mounts'][0].get('Name') == 'victoria-pgdata-' + workspace
         and fixture['mounts'][0].get('Destination') == '/var/lib/postgresql/data'
         and fixture['mounts'][0].get('Type') == 'volume' and fixture['mounts'][0].get('RW') is True,
         'retained fixture scope')
    need(all(not env.get(k) for k in ('ROSE_TEST_DB_LOCK_DIR', 'BACKEND_COVERAGE_START_PORT',
         'BACKEND_COVERAGE_END_PORT', 'BACKEND_COVERAGE_PORT_LOCK_ROOT', 'BACKEND_COVERAGE_RUN_LOCK_FILE',
         'BACKEND_COVERAGE_RUN_LOCK_DIR', 'BLACKBOX_TEST_ARTIFACT_ROOT', 'CONTRACT_TEST_ARTIFACT_ROOT',
         'BLACKBOX_TEST_SKIP_DB_SYNC', 'CONTRACT_TEST_SKIP_DB_SYNC', 'BLACKBOX_TEST_SKIP_DOMAINS', 'CONTRACT_TEST_SKIP_DOMAINS')),
         'custom footprint requires separate qualification')
    locks = [str(root / '.context/test-runs/.port-locks' / (str(base + i) + '.lock')) for i in (20, 22, 24)]
    locks += [str(root / 'back-end/coverage' / ('.run-lock-' + s)) for s in ('units', 'units-probe', 'shard1', 'shard2')]
    locks += audit.database_locks(workspace, base + 5)
    return {'root': str(root), 'source': receipt['source'], 'token': receipt['token'], 'started_at': receipt['started_at'],
            'finished_at': receipt['finished_at'], 'ports': list(range(base, base + 10)) + [base + i for i in range(20, 26)],
            'locks': locks, 'fixture': fixture, 'fixture_port': base + 5}


def validate(state, receipt, proof):
    from deploy_test_cycle import ROOT, bounded_read, digest, sha_file
    from deploy_test_local_cleanup import KIND, FILES
    need(set(proof) == {'kind', 'layout', 'files', 'artifacts', 'audit', 'original_skips', 'confirmed_at', 'observed_by'}
         and proof['kind'] == KIND and proof['layout'] == LAYOUT, 'proof shape')
    need(all(type(receipt.get(k)) in (int, float) and math.isfinite(receipt[k]) for k in ('started_at', 'finished_at'))
         and receipt['started_at'] <= receipt['finished_at'], 'native times')
    need(type(proof['confirmed_at']) in (int, float) and math.isfinite(proof['confirmed_at'])
         and receipt['finished_at'] <= proof['confirmed_at'] <= time.time()
         and isinstance(proof['observed_by'], str) and proof['observed_by'].strip(), 'confirmation')
    gate, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
    root = Path(gate['worker_root']); need(root.resolve(strict=True) == root and gate.get('cwd') == str(root), 'root')
    need(gate.get('name') == 'backend-coverage-blackbox' and gate.get('native_backend') is True
         and gate.get('worker_transport') == 'local-isolated' and gate.get('case_protocol') is True
         and gate.get('result_transport') == 'file' and not gate.get('native_cloud'), 'owned backend gate')
    command = gate['command']
    need(isinstance(command, list) and len(command) == 4 and Path(command[1]) == ROOT / 'scripts/deploy_test_backend.py'
         and command[2:] == ['--root', str(root)] and receipt.get('command') == command
         and receipt.get('execution_binding', {}).get('contract_digest') == digest(gate)
         and receipt.get('host_admission', {}).get('started') is True
         and receipt['host_admission'].get('lock') == str(root / '.context/native-worker-admission.lock'), 'execution/admission')
    need(receipt.get('lifecycle') == 'owned' and receipt.get('executed') is True and receipt.get('status') == 'FAIL'
         and receipt.get('complete') is False and type(receipt.get('native_exit')) is int and receipt['native_exit'] == 1
         and all(receipt.get(k) is False for k in ('timed_out', 'cancelled', 'lingering_group'))
         and receipt.get('cleanup_owner') is None and receipt.get('native_cleanup_reference') is None, 'original incomplete native')
    folder = Path(receipt['log']).parent
    need(folder.resolve(strict=True) == folder and Path(receipt['log']) == folder / 'output.log'
         and receipt.get('worker_result') == str(folder / 'result.json')
         and set(proof['files']) == set(FILES), 'original controls')
    docs = {}
    for name in FILES:
        path = folder / name; audit.physical(path)
        need(sha_file(path) == proof['files'][name], 'original control changed: ' + name)
        docs[name] = bounded_read(path, 'backend post-execution ' + name)
    request, result, recorded, process = (docs[n] for n in FILES)
    need(same(recorded, receipt) and all(same(row.get(k), receipt.get(k)) for row in (request, result)
         for k in ('source', 'token', 'gate')), 'native identity')
    source = receipt['source']
    need(set(source) == {'head', 'digest'} and isinstance(source['head'], str)
         and re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', source['head'])
         and isinstance(source['digest'], str) and re.fullmatch(r'[0-9a-f]{64}', source['digest']), 'native source')
    for name, pin in PINS.items():
        need(hashlib.sha256(source_bytes(root, source['head'], name)).hexdigest() == pin, 'original producer changed')
    recipe = request['worker_recipe']; skips = request.get('skips'); checks = request['checks']
    need(isinstance(skips, dict) and same(skips, proof['original_skips']) and same(recipe, gate['worker_recipe'])
         and set(recipe) == {'cases', 'execution_timeout_seconds'}
         and same(result.get('recipe_digest'), digest(recipe))
         and request.get('worker_root') == result.get('worker_root') == str(root), 'no-services recipe / original skips')
    need(isinstance(checks, list) and all(isinstance(c, str) and c for c in checks)
         and len(checks) == len(set(checks)) and not set(checks).intersection(skips)
         and set(checks) | set(skips) == set(gate['checks']) == set(recipe['cases'])
         and len(gate['checks']) == len(set(gate['checks']))
         and set(result['cases']) == set(checks)
         and same(receipt['cases'], {c: 'SKIP' if c in skips else 'UNVERIFIED' for c in gate['checks']}), 'active/skip inventory')
    need(all(isinstance(v, dict) and same(v.get('source'), source) for v in skips.values()), 'standing skip source')
    import deploy_test_backend as backend
    backend_file = Path(backend.__file__); audit.physical(backend_file)
    need(sha_file(backend_file) == PINS['scripts/deploy_test_backend.py'], 'current sweep helper changed')
    sweep = backend.sweep_from_recipe(recipe, gate['checks'])
    need(sweep.get('command') == result.get('native_command') == ['npm', 'run', 'test:coverage:sharded']
         and sweep.get('cwd') == 'back-end', 'unchanged normal sweep')
    need(result.get('complete') is False and result.get('cleanup_complete') is False
         and all(result.get(k) is False for k in ('reused', 'interrupted'))
         and result.get('source_unchanged') is True and result.get('cleanup_owner') is None
         and result.get('native_cleanup_reference') is None and type(result.get('native_exit')) is int and result['native_exit'] == 1
         and result['cases'].get('units') == result['cases'].get('fps') == 'PASS'
         and result['cases'].get('teardown') == 'FAIL' and result['cases'].get('coverage-threshold') == 'UNVERIFIED'
         and any(k.startswith('blackbox:') and v == 'FAIL' for k, v in result['cases'].items())
         and all(v in ('PASS', 'FAIL', 'UNVERIFIED') for v in result['cases'].values()), 'post-execution native outcomes')
    evidence = result['evidence']
    need(same(receipt.get('worker_evidence'), evidence)
         and evidence['teardown'].get('recipe_cleanup_exit') is None
         and evidence['teardown'].get('recipe_setup_exit') is None
         and type(evidence['teardown'].get('exit')) is int and evidence['teardown']['exit'] == 1
         and evidence['teardown'].get('command') == ['bash', 'scripts/tests/blackbox-backend-teardown.test.sh'], 'native evidence / None exits')
    need(evidence.get('unknown_domains') == [] and all(type(evidence[k].get('exit')) is int
         and evidence[k]['exit'] == 0 for k in ('units', 'fps')), 'executed native phases unknown')
    for name, verdict in result['cases'].items():
        if name.startswith('blackbox:'):
            row = evidence.get(name)
            need(isinstance(row, dict) and type(row.get('passed')) is bool and row.get('aborted') is False
                 and row.get('shard') in evidence['artifacts']['summaries']
                 and verdict == ('PASS' if row['passed'] else 'FAIL'), 'native domain verdict changed')
    terminal_waits(process)
    native, expected = expected_artifacts(root, receipt, result)
    need(isinstance(proof['artifacts'], dict) and set(proof['artifacts']) == set(expected), 'archive scope')
    archived = {}; locations = set()
    for original, row in proof['artifacts'].items():
        need(set(row) == {'path', 'sha256', 'bytes'} and type(row['bytes']) is int
             and 0 <= row['bytes'] <= audit.MAX_CONTROL_BYTES, 'archive shape')
        path = Path(row['path']); audit.physical(path)
        need(root not in path.parents and path != Path(original) and str(path) not in locations, 'immutable external archive')
        locations.add(str(path)); raw = path.read_bytes()
        need(len(raw) == row['bytes'] and hashlib.sha256(raw).hexdigest() == row['sha256']
             and (expected[original] is None or row['sha256'] == expected[original]), 'archived native bytes changed')
        archived[original] = raw
    import json
    need(same(json.loads(archived[str(native / 'result.json')]), result), 'archived native result')
    before = json.loads(archived[str(native / 'postgres-before.json')]); after = json.loads(archived[str(native / 'postgres-after.json')])
    fixture = evidence['postgres_fixture']
    need(same(before, after) and fixture.get('restored') is False and before.get('id') == fixture.get('id')
         and before.get('image') == fixture.get('image') and before.get('name') == '/' + fixture.get('name', '')
         and fixture.get('volume') == before['mounts'][0]['Name'], 'original fixture not preserved')
    spec = audit_spec(root, receipt, gate, sweep, before)
    observer = Path(audit.__file__); audit.physical(observer)
    need(sha_file(observer) == AUDITOR_SHA256 and stat.S_IMODE(observer.stat().st_mode) == 0o644, 'reviewed observer source/mode changed')
    need(set(proof['audit']) == {'path', 'sha256'}, 'audit reference')
    path = Path(proof['audit']['path']); audit.physical(path)
    need(root not in path.parents and sha_file(path) == proof['audit']['sha256'], 'sealed physical audit changed')
    observed = audit.read(path); audit.check_observation(observed, spec)
    need(observed['observed_at'] <= proof['confirmed_at'], 'audit postdates confirmation')
    current = audit.observe(spec); audit.check_observation(current, spec)
    need(same(current['fixture'], observed['fixture']) and same(current['proxy'], observed['proxy']),
         'retained fixture/proxy changed after audit')
    return gate
