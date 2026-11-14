"""Physical closure of an original backend sweep refused by Prisma preflight."""
import fcntl
import hashlib
import math
import os
from pathlib import Path
import re
import subprocess
import time

LAYOUT = 'backend-prisma-preflight-v1'
PINS = {
    'scripts/deploy_test_backend.py': '33f766521aeb401fa4d1f169e88a92f953b84452eaa9808342a76a4e9d4b3d89',
    'back-end/scripts/run-coverage-sharded.sh': '8a2385504f66e583c13b52308b1eceefe6b706f47cec531fa1ad8bde0f50ea10',
    'back-end/scripts/run-coverage.sh': 'd5bd7061647f63d3d8148caa9720e611a5c5c73fa2512c035ccaea973da714fa',
    'back-end/scripts/run-blackbox-tests.sh': 'edfb4872916f7322b54e589fd1b73c52354c4a7eaadc15083060e9953738c909',
    'back-end/scripts/assert-prisma-client-current.mjs': '90f2062ae79b66bee2b8bd3693f45d38f3f24311fa695069b33512ecf653ab94',
    'scripts/tests/blackbox-backend-teardown.test.sh': '237f5ffcdd147a8f9f1b4e186add48663540ca2a97dd4746622083a465d025b1',
    'back-end/package.json': '1a955a2e8552fe405725d74a4c7fe8ee02458e3d2bb476ec813efd75b8d6cdf5',
    'back-end/scripts/test-db-run-lock.sh': '62f403f86b39dad90b50da382b35030c2c24177c0022c3e8ed9c8df3c543f6f9',
}
STALE = ('Prisma client is stale or unavailable. Stop local stacks, run '
         '`cd back-end && npm run prisma:generate`, then restart tests.\n')
TRACE = "⚠️  TRACE_ARCHIVE_BACKEND='' is not a local blackbox backend; forcing local.\n"
BROWSER = "⚠️  BROWSER_PROVIDER='' is unsupported; forcing kernel for coverage.\n"
DOCKER_TEMPLATE = ('{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},'
                   '"image_name":{{json .Config.Image}},"owner":{{json (index .Config.Labels "ai.rose.deploy-worktree.path")}},'
                   '"running":{{json .State.Running}},"status":{{json .State.Status}},"paused":{{json .State.Paused}},'
                   '"restarting":{{json .State.Restarting}},"dead":{{json .State.Dead}},'
                   '"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}}}')


def docker_snapshot(machine):
    """Read only the exact retained local fixture; never start, exec or change it."""
    import json
    from deploy_test_local_cleanup import need
    result = subprocess.run(['docker', 'inspect', '--format', DOCKER_TEMPLATE, machine],
                            capture_output=True, timeout=15, check=False)
    need(result.returncode == 0 and len(result.stdout) <= 1024 * 1024, 'preflight Docker observation unavailable')
    return json.loads(result.stdout)


def listeners():
    ports = set()
    for name in ('tcp', 'tcp6'):
        for line in Path('/proc/net', name).read_text().splitlines()[1:]:
            row = line.split()
            if row[3] == '0A':
                ports.add(int(row[1].rsplit(':', 1)[1], 16))
    return ports


def physical_file(path):
    from deploy_test_local_cleanup import need
    path = Path(path)
    need(path.is_absolute() and path.resolve() == path and path.is_file() and not path.is_symlink(),
         'preflight canonical regular file required')
    info = path.stat()
    need(info.st_uid == os.getuid() and not info.st_mode & 0o022, 'preflight file owner/mode')
    return info


def validate(state, receipt, proof):
    import json
    from deploy_test_cycle import bounded_read, digest, sha_file
    from deploy_test_local_cleanup import KIND, FILES, need
    from deploy_test_process import scan_same_user_processes
    need(set(proof) == {'kind', 'layout', 'files', 'artifacts', 'confirmed_at', 'observed_by'}
         and proof['kind'] == KIND and proof['layout'] == LAYOUT, 'preflight proof fields')
    need(type(proof['confirmed_at']) in (int, float) and math.isfinite(proof['confirmed_at'])
         and receipt['finished_at'] <= proof['confirmed_at'] <= time.time()
         and isinstance(proof['observed_by'], str) and proof['observed_by'].strip(), 'preflight confirmation')
    gate, = [g for g in state['plan']['gates'] if g['name'] == receipt['gate']]
    root = Path(gate['worker_root']).resolve(strict=True)
    need(gate['name'] == 'backend-coverage-blackbox' and gate.get('native_backend') is True
         and gate.get('worker_transport') == 'local-isolated' and gate.get('case_protocol') is True
         and gate.get('result_transport') == 'file' and gate['worker_root'] == gate.get('cwd') == str(root),
         'preflight owned backend binding')
    need(receipt.get('command') == gate['command'] and len(gate['command']) == 4
         and Path(gate['command'][1]).name == 'deploy_test_backend.py'
         and gate['command'][2:] == ['--root', str(root)]
         and receipt.get('execution_binding', {}).get('contract_digest') == digest(gate)
         and receipt.get('host_admission', {}).get('started') is True
         and receipt['host_admission'].get('lock') == str(root / '.context/native-worker-admission.lock'),
         'preflight original execution contract')
    need(receipt.get('lifecycle') == 'owned' and receipt.get('executed') is True
         and receipt.get('complete') is False and type(receipt.get('native_exit')) is int
         and receipt['native_exit'] == 1 and not receipt.get('cleanup_owner')
         and all(receipt.get(k) is False for k in ('timed_out', 'cancelled', 'lingering_group')), 'preflight native terminal')
    folder = Path(receipt['log']).parent
    need(folder.resolve() == folder and Path(receipt['log']) == folder / 'output.log'
         and Path(receipt['worker_result']) == folder / 'result.json'
         and set(proof['files']) == set(FILES), 'preflight control artifacts')
    docs = {}
    for name in FILES:
        path = folder / name; physical_file(path)
        need(sha_file(path) == proof['files'][name], 'preflight control hash')
        docs[name] = bounded_read(path, 'preflight ' + name)
    request, result, recorded, process = (docs[n] for n in FILES)
    need(recorded == receipt and all(row.get(k) == receipt[k] for row in (request, result)
         for k in ('token', 'source', 'gate')), 'preflight native identity')
    head = receipt['source']['head']
    need(isinstance(head, str) and re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', head), 'preflight full source')
    for name, expected in PINS.items():
        original = subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), 'show', head + ':' + name])
        need(hashlib.sha256(original).hexdigest() == expected, 'preflight original producer changed')
    recipe = request['worker_recipe']; checks = gate['checks']; cases = result['cases']
    need(request.get('worker_root') == result.get('worker_root') == str(root)
         and recipe == gate['worker_recipe'] and set(recipe) == {'cases', 'execution_timeout_seconds'}
         and result.get('recipe_digest') == digest(recipe) and request.get('skips') == {}
         and set(request['checks']) == set(checks) == set(cases) == set(receipt['cases']) == set(recipe['cases'])
         and len(request['checks']) == len(checks) == len(set(checks)), 'preflight full recipe inventory')
    from deploy_test_backend import sweep_from_recipe
    sweep = sweep_from_recipe(recipe, checks)
    need(sweep['command'] == result.get('native_command') == ['npm', 'run', 'test:coverage:sharded']
         and sweep.get('cwd') == 'back-end' and all(v == 'UNVERIFIED' for v in receipt['cases'].values())
         and cases.get('units') == cases.get('fps') == cases.get('teardown') == 'FAIL'
         and cases.get('coverage-threshold') == 'UNVERIFIED'
         and all(k in ('units', 'fps', 'teardown', 'coverage-threshold') or
                 k.startswith('blackbox:') and v == 'UNVERIFIED' for k, v in cases.items())
         and result.get('complete') is False and result.get('cleanup_complete') is False
         and result.get('reused') is False and result.get('interrupted') is False
         and result.get('source_unchanged') is True and not result.get('cleanup_owner')
         and type(result.get('native_exit')) is int and result['native_exit'] == 1, 'preflight outcomes remain unverified')
    evidence = result['evidence']; artifacts = evidence['artifacts']
    need(artifacts['summaries'] == {} and evidence.get('unknown_domains') == []
         and all(type(evidence[role].get('exit')) is int and evidence[role]['exit'] == 1
                 for role in ('units', 'fps', 'teardown'))
         and evidence['teardown'].get('command') == ['bash', 'scripts/tests/blackbox-backend-teardown.test.sh']
                  and evidence['teardown'].get('recipe_cleanup_exit') is None
         and evidence['teardown'].get('recipe_setup_exit') is None, 'preflight original phase results')
    runner = Path(result['runner_log']); native = runner.parent
    need(root / '.context/deploy-backend' in runner.parents and runner.resolve() == runner, 'preflight native directory')
    env = gate['env']; workspace = env['CONDUCTOR_WORKSPACE_NAME']; base = int(env['CONDUCTOR_PORT'])
    need(re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', workspace) is not None
         and 1024 <= base <= 65000
         and env.get('ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME') == '1'
         and all((sweep.get('env') or {}).get(key) == env.get(key) for key in
                 ('CONDUCTOR_WORKSPACE_NAME', 'CONDUCTOR_PORT', 'ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME'))
         and not any((sweep.get('env') or {}).get(k) for k in ('BLACKBOX_TEST_SKIP_DOMAINS', 'CONTRACT_TEST_SKIP_DOMAINS',
                         'BLACKBOX_TEST_SKIP_DB_SYNC', 'CONTRACT_TEST_SKIP_DB_SYNC')), 'preflight original workspace')
    locks = [root / '.context/test-runs/.port-locks' / (str(base + i) + '.lock') for i in (20, 22, 24)]
    expected = {str(runner): artifacts['runner_log'], evidence['units']['log']: artifacts['units_log'],
                evidence['fps']['log']: artifacts['fps_log'], evidence['teardown']['log']: artifacts['teardown_log'],
                evidence['coverage-threshold']['log']: artifacts['threshold_log'], **evidence['shard_logs'],
                str(native / 'postgres-before.json'): evidence['postgres_fixture']['before_sha256'],
                str(native / 'postgres-after.json'): evidence['postgres_fixture']['after_sha256']}
    need(set(evidence['shard_logs']) == {str(root / 'back-end/coverage' / ('shard-%d.log' % i)) for i in (1, 2)}
         and evidence['units']['log'] == str(root / 'back-end/coverage/units.log')
         and evidence['fps']['log'] == str(root / 'back-end/coverage/units-probe.log')
         and evidence['teardown']['log'] == str(native / 'teardown.log')
         and evidence['coverage-threshold']['log'] == str(native / 'threshold.log'), 'preflight phase paths')
    need(isinstance(proof['artifacts'], dict) and set(proof['artifacts']) == set(expected) | set(map(str, locks)),
         'preflight archived file closure')
    archived = {}; archive_paths = set()
    for original, row in proof['artifacts'].items():
        need(set(row) == {'path', 'sha256', 'bytes'} and type(row['bytes']) is int and 0 <= row['bytes'] <= 64 * 1024 * 1024,
             'preflight archive entry')
        path = Path(row['path']); physical_file(path)
        need(path != Path(original) and root not in path.parents and str(path) not in archive_paths,
             'preflight immutable archive required')
        archive_paths.add(str(path))
        raw = path.read_bytes()
        need(len(raw) == row['bytes'] and hashlib.sha256(raw).hexdigest() == row['sha256']
             and (original not in expected or row['sha256'] == expected[original]), 'preflight archived native hash')
        archived[original] = raw
    prefix = 'Using local Postgres (Docker container=victoria-db-%s) at localhost:%d, database victoria_%s' % (workspace, base + 5, workspace)
    for original, suffix in [(evidence['units']['log'], '_s0'), (evidence['fps']['log'], '_s0'),
                             *[(str(root / 'back-end/coverage' / ('shard-%d.log' % i)), '_s%d' % i) for i in (1, 2)]]:
        need(archived[original].decode() == BROWSER + TRACE + prefix + suffix + '\n' + STALE, 'preflight guarded phase boundary')
    need(archived[evidence['teardown']['log']].decode() == TRACE + prefix + '\n' + STALE
         + 'FAIL: the isolated backend never became ready\n', 'preflight teardown is a refused test')
    text = archived[str(runner)].decode()
    need(all(text.count(row) == 1 for row in ('Started coverage shard 1/2', 'Started coverage shard 2/2',
         'Started the unit pass beside the shards', '❌ Coverage shard 1/2 failed (exit 1)',
         '❌ Coverage shard 2/2 failed (exit 1)', '❌ Unit pass failed (exit 1)', '❌ fps probe pass failed (exit 1)'))
         and not any(marker in text for marker in ('Starting backend', 'Starting isolated backend', 'Backend ready at')),
         'preflight runner phase boundary')
    need(type(process.get('native_exit')) is int and process['native_exit'] == 1 and process.get('quiescent') is True
         and all(process.get(k) is False for k in ('orphaned_children', 'cancelled', 'timed_out'))
         and all(process.get(k) == [] for k in ('remaining', 'term_sent', 'kill_sent'))
         and process.get('error') is None, 'preflight native process closure')
    child, supervisor = process.get('child_pid'), process.get('supervisor_pid'); reaped = process.get('reaped')
    need(type(child) is int and type(supervisor) is int and child > 1 and supervisor > 1 and child != supervisor
         and isinstance(reaped, list) and len(reaped) == 11
         and all(set(row) == {'pid', 'status'} and type(row['pid']) is int and row['pid'] > 1
                 and type(row['status']) is int and row['status'] == (256 if row['pid'] == child else 0) for row in reaped)
         and len({row['pid'] for row in reaped}) == 11 and sum(row['pid'] == child for row in reaped) == 1,
         'preflight exact reaped descendants')
    before = json.loads(archived[str(native / 'postgres-before.json')]); after = json.loads(archived[str(native / 'postgres-after.json')])
    fixture = evidence['postgres_fixture']
    need(before == after and fixture.get('restored') is False and before.get('id') == fixture['id']
         and re.fullmatch(r'[0-9a-f]{64}', fixture['id']) and before.get('name') == '/' + fixture['name'] == '/victoria-db-' + workspace
         and before.get('image') == fixture['image'] and before.get('owner') == str(root)
         and fixture['volume'] == 'victoria-pgdata-' + workspace and fixture['port'] == base + 5
         and before.get('running') is True and before.get('status') == 'running'
         and all(before.get(k) is False for k in ('paused', 'restarting', 'dead'))
         and before.get('ports') == {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(base + 5)}]}
         and len(before.get('mounts', [])) == 1 and before['mounts'][0].get('Name') == fixture['volume']
         and before['mounts'][0].get('Type') == 'volume' and before['mounts'][0].get('RW') is True
         and before['mounts'][0].get('Destination') == '/var/lib/postgresql/data', 'preflight protected fixture')
    admission = root / '.context/native-worker-admission.lock'; physical_file(admission)
    with admission.open('r') as lock:
        # Keep every current process/listener/lock/Docker observation under this SAME native lock.
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest = root / '.context/services.json'
        if manifest.exists() or manifest.is_symlink():
            physical_file(manifest); service = bounded_read(manifest, 'preflight services')
            need(service.get('worktree') == str(root) and service.get('status') == 'stopped', 'preflight services remain')
        def inspect(process_path):
            cwd = (process_path / 'cwd').resolve(strict=True)
            args = (process_path / 'cmdline').read_bytes().split(b'\0'); prefix_bytes = os.fsencode(str(root) + '/')
            need(cwd != root and root not in cwd.parents and not any(arg == os.fsencode(root) or arg.startswith(prefix_bytes)
                 for arg in args), 'preflight worker root still live')
        scan_same_user_processes(inspect, lambda pid: need(False, 'preflight root process %s unverifiable' % pid))
        need(not listeners().intersection(set(range(base, base + 126)) - {base + 5}), 'preflight app listener remains')
        for path in locks:
            info = physical_file(path); raw = path.read_bytes()
            need(raw == archived[str(path)] and receipt['started_at'] <= info.st_mtime <= receipt['finished_at'],
                 'preflight original port lock changed')
            pid = raw.decode().strip()
            need(pid.isdigit() and int(pid) > 1 and not Path('/proc', pid).exists(), 'preflight port lock owner remains')
            with path.open('r') as port_lock:
                fcntl.flock(port_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        need(docker_snapshot(fixture['id']) == after, 'preflight protected fixture changed')
    return gate
