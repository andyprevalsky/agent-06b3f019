import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const processGroupHelperPath = join(process.cwd(), 'scripts', 'coverage-process-group.py');
const processLockHelperPath = join(process.cwd(), 'scripts', 'coverage-process-lock.py');

const fixtureRoot = mkdtempSync(join(tmpdir(), 'coverage-process-registry-'));
try {
  const unterminatedRegistryPath = join(fixtureRoot, 'unterminated-groups');
  writeFileSync(unterminatedRegistryPath, 'incomplete-registration');
  const unterminatedRegistryCommand = spawnSync(
    'python3',
    [processGroupHelperPath, unterminatedRegistryPath, join(fixtureRoot, 'missing-command')],
    { encoding: 'utf8' }
  );
  assert.equal(unterminatedRegistryCommand.status, 127);
  const repairedRegistryLines = readFileSync(unterminatedRegistryPath, 'utf8').split(/\n/);
  assert.equal(repairedRegistryLines[0], 'incomplete-registration');
  assert.doesNotThrow(
    () => JSON.parse(repairedRegistryLines[1] ?? ''),
    'a registration after an unterminated tail must remain independently parseable'
  );

  execFileSync(
    'python3',
    [
      '-c',
      [
        'import sys',
        'sys.path.insert(0, sys.argv[1])',
        'from coverage_process_registry import parse_process_group',
        'assert parse_process_group(\'{"pgid":true,"identity_pid":1,"start_identity":"x"}\') is None',
        'assert parse_process_group(\'{"pgid":1,"identity_pid":true,"start_identity":"x"}\') is None',
      ].join('\n'),
      join(process.cwd(), 'scripts'),
    ],
    { stdio: 'pipe' }
  );

  execFileSync(
    'python3',
    [
      '-c',
      [
        'import json, os, shutil, signal, subprocess, sys, tempfile, time',
        'group_helper = sys.argv[1]',
        "with tempfile.TemporaryDirectory(prefix='coverage-sentinel-exit-') as root:",
        "    registry = os.path.join(root, 'groups')",
        // Delay a genuine native group read beyond the old one-second observer
        // budget. Keep the existing ten-second empty-group completion bound.
        "    native_ps = shutil.which('ps')",
        '    assert native_ps',
        "    observer_bin = os.path.join(root, 'observer-bin')",
        '    os.makedirs(observer_bin)',
        "    observer_ps = os.path.join(observer_bin, 'ps')",
        "    with open(observer_ps, 'w', encoding='utf-8') as handle:",
        "        handle.write('#!' + sys.executable + '\\nimport os, sys, time\\n')",
        "        handle.write(\"if sys.argv[1:] == ['-e', '-o', 'pid=', '-o', 'pgid=']:\\n    time.sleep(1.5)\\n\")",
        "        handle.write('os.execv(' + repr(native_ps) + ', [\"ps\", *sys.argv[1:]])\\n')",
        '    os.chmod(observer_ps, 0o700)',
        '    env = dict(os.environ)',
        "    env['PATH'] = observer_bin + os.pathsep + env['PATH']",
        '    launcher = subprocess.Popen(',
        "        [sys.executable, group_helper, registry, sys.executable, '-c', 'pass'],",
        '        env=env,',
        '        stdout=subprocess.PIPE,',
        '        stderr=subprocess.STDOUT,',
        '    )',
        '    launcher.communicate(timeout=5)',
        '    assert launcher.returncode == 0',
        "    registration = json.loads(open(registry, encoding='utf-8').read().strip())",
        "    identity_pid = registration['identity_pid']",
        '    try:',
        '        deadline = time.monotonic() + 10',
        '        while time.monotonic() < deadline:',
        '            status = subprocess.run(',
        "                ['ps', '-o', 'stat=', '-p', str(identity_pid)],",
        '                check=False, capture_output=True, text=True, timeout=2,',
        '            )',
        '            state = status.stdout.strip()',
        "            if status.returncode != 0 or not state or state.startswith('Z'):",
        '                break',
        '            time.sleep(0.02)',
        '        else:',
        "            raise AssertionError('identity sentinel did not exit with an empty group')",
        '    finally:',
        '        sys.path.insert(0, os.path.dirname(group_helper))',
        '        from coverage_process_registry import process_start_identity',
        "        if process_start_identity(identity_pid) == registration['start_identity']:",
        '            try:',
        "                if os.getpgid(identity_pid) == registration['pgid']:",
        "                    os.killpg(registration['pgid'], signal.SIGKILL)",
        '            except ProcessLookupError:',
        '                pass',
      ].join('\n'),
      processGroupHelperPath,
    ],
    { stdio: 'pipe' }
  );

  execFileSync(
    'python3',
    [
      '-c',
      [
        'import json, os, signal, subprocess, sys, tempfile, time',
        'group_helper, lock_helper = sys.argv[1:]',
        'pgid = None',
        'try:',
        "    with tempfile.TemporaryDirectory(prefix='coverage-leader-exit-') as root:",
        "        registry = os.path.join(root, 'groups')",
        "        marker = os.path.join(root, 'child-pid')",
        "        status = os.path.join(root, 'status')",
        "        lock = os.path.join(root, 'lock')",
        "        command = '\\n'.join([",
        "            'import os, sys, time',",
        "            'child = os.fork()',",
        "            'if child == 0:',",
        "            '    time.sleep(30)',",
        "            '    os._exit(0)',",
        "            \"with open(sys.argv[1], 'w', encoding='utf-8') as handle:\",",
        "            '    handle.write(str(child))',",
        "            'os._exit(0)',",
        '        ])',
        "        launcher = subprocess.Popen([sys.executable, group_helper, registry, sys.executable, '-c', command, marker])",
        '        assert launcher.wait(timeout=5) == 0',
        "        child_pid = int(open(marker, encoding='utf-8').read())",
        "        registration = json.loads(open(registry, encoding='utf-8').read().strip())",
        "        pgid = registration['pgid']",
        "        assert registration['identity_pid'] != pgid",
        '        os.kill(child_pid, 0)',
        '        guardian = subprocess.Popen([sys.executable, lock_helper, lock, status, str(os.getpid()), registry])',
        '        for _ in range(100):',
        "            if os.path.exists(status) and open(status, encoding='utf-8').read() == 'acquired':",
        '                break',
        '            time.sleep(0.02)',
        '        else:',
        "            raise AssertionError('guardian did not acquire leader-exit fixture lock')",
        '        guardian.send_signal(signal.SIGTERM)',
        '        guardian_rc = guardian.wait(timeout=10)',
        "        assert guardian_rc == 0, f'guardian exited {guardian_rc} instead of reaping its registered groups'",
        '        for _ in range(100):',
        '            try:',
        '                os.kill(child_pid, 0)',
        '            except ProcessLookupError:',
        '                break',
        '            time.sleep(0.02)',
        '        else:',
        "            raise AssertionError('surviving descendant was not reaped after leader exit')",
        'finally:',
        '    if pgid is not None:',
        '        try:',
        '            os.killpg(pgid, signal.SIGKILL)',
        '        except ProcessLookupError:',
        '            pass',
      ].join('\n'),
      processGroupHelperPath,
      processLockHelperPath,
    ],
    { stdio: 'pipe' }
  );
  // The owner sends SIGTERM the moment it reads "acquired". A guardian whose
  // stop handler is installed only after that publication dies under the
  // default disposition when the signal lands first (ordinary CPU contention
  // in the sharded unit pass), and its registered groups are never reaped.
  execFileSync(
    'python3',
    [
      '-c',
      [
        'import json, os, select, signal, subprocess, sys, tempfile, time',
        'group_helper, lock_helper = sys.argv[1:]',
        'pgid = None',
        'try:',
        "    with tempfile.TemporaryDirectory(prefix='coverage-early-term-') as root:",
        "        registry = os.path.join(root, 'groups')",
        "        marker = os.path.join(root, 'child-pid')",
        "        status = os.path.join(root, 'status')",
        "        lock = os.path.join(root, 'lock')",
        "        command = '\\n'.join([",
        "            'import os, sys, time',",
        "            'child = os.fork()',",
        "            'if child == 0:',",
        "            '    time.sleep(30)',",
        "            '    os._exit(0)',",
        "            \"with open(sys.argv[1], 'w', encoding='utf-8') as handle:\",",
        "            '    handle.write(str(child))',",
        "            'os._exit(0)',",
        '        ])',
        "        launcher = subprocess.Popen([sys.executable, group_helper, registry, sys.executable, '-c', command, marker])",
        '        assert launcher.wait(timeout=5) == 0',
        "        child_pid = int(open(marker, encoding='utf-8').read())",
        "        pgid = json.loads(open(registry, encoding='utf-8').read().strip())['pgid']",
        '        os.kill(child_pid, 0)',
        '        # The status sink is a FIFO whose buffer is already full, so the guardian',
        '        # parks inside write_status("acquired") until this test drains it. That',
        '        # pins the guardian in the window an owner otherwise only hits under',
        '        # CPU contention: lock held, publication in flight, SIGTERM arriving.',
        '        os.mkfifo(status)',
        '        reader = os.open(status, os.O_RDONLY | os.O_NONBLOCK)',
        '        filler = os.open(status, os.O_WRONLY | os.O_NONBLOCK)',
        '        while True:',
        '            try:',
        "                os.write(filler, b'x' * 65536)",
        '            except BlockingIOError:',
        '                break',
        '        guardian = subprocess.Popen([sys.executable, lock_helper, lock, status, str(os.getpid()), registry])',
        '        # The lock file names its owner immediately before the status publication.',
        '        for _ in range(500):',
        '            if guardian.poll() is not None:',
        "                raise AssertionError(f'guardian exited {guardian.returncode} before taking the lock')",
        '            try:',
        "                if open(lock, encoding='utf-8').read().strip() == str(os.getpid()):",
        '                    break',
        '            except FileNotFoundError:',
        '                pass',
        '            time.sleep(0.02)',
        '        else:',
        "            raise AssertionError('guardian never wrote the lock owner')",
        '        guardian.send_signal(signal.SIGTERM)',
        '        os.close(filler)',
        "        drained = b''",
        '        deadline = time.monotonic() + 10',
        "        while time.monotonic() < deadline and not drained.endswith(b'acquired'):",
        '            if guardian.poll() is not None:',
        '                break',
        '            ready, _, _ = select.select([reader], [], [], 0.05)',
        '            if ready:',
        '                try:',
        '                    drained += os.read(reader, 65536)',
        '                except BlockingIOError:',
        '                    pass',
        '        os.close(reader)',
        '        guardian_rc = guardian.wait(timeout=10)',
        "        assert guardian_rc == 0, f'guardian exited {guardian_rc} on a SIGTERM that arrived while it published its lock'",
        "        assert drained.endswith(b'acquired'), drained[-40:]",
        '        for _ in range(100):',
        '            try:',
        '                os.kill(child_pid, 0)',
        '            except ProcessLookupError:',
        '                break',
        '            time.sleep(0.02)',
        '        else:',
        "            raise AssertionError('surviving descendant was not reaped after an early SIGTERM')",
        'finally:',
        '    if pgid is not None:',
        '        try:',
        '            os.killpg(pgid, signal.SIGKILL)',
        '        except ProcessLookupError:',
        '            pass',
      ].join('\n'),
      processGroupHelperPath,
      processLockHelperPath,
    ],
    { stdio: 'pipe' }
  );
  // `ps` can miss one identity read under concurrent coverage work. The
  // guardian must retry that transient result before abandoning a registered
  // group, while a definite identity mismatch must still fail closed.
  execFileSync(
    'python3',
    [
      '-c',
      [
        'import importlib.util, sys',
        'sys.path.insert(0, sys.argv[1])',
        "spec = importlib.util.spec_from_file_location('lock_helper', sys.argv[2])",
        'lock_helper = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(lock_helper)',
        'group = lock_helper.RegisteredProcessGroup(pgid=1, identity_pid=2, start_identity="same")',
        'lock_helper.process_group_exists = lambda pgid: True',
        'observations = iter([None, "same"])',
        'lock_helper.process_start_identity = lambda pid: next(observations)',
        'assert lock_helper.process_group_identity_matches(group)',
        'lock_helper.process_start_identity = lambda pid: "different"',
        'assert not lock_helper.process_group_identity_matches(group)',
      ].join('\n'),
      join(process.cwd(), 'scripts'),
      processLockHelperPath,
    ],
    { stdio: 'pipe' }
  );
  // The guardian publishes `shutdown` under the same lock launchers hold through
  // exec. If it fuses onto an unterminated tail ("...recordshutdown"), a waiting
  // launcher sees no complete closed marker, registers, and execs after the final
  // snapshot — so its group is never terminated.
  const unterminatedShutdownRegistry = join(fixtureRoot, 'unterminated-shutdown-groups');
  writeFileSync(unterminatedShutdownRegistry, 'incomplete-registration');
  execFileSync(
    'python3',
    [
      '-c',
      [
        'import os, sys, tempfile',
        'sys.path.insert(0, sys.argv[1])',
        'from pathlib import Path',
        'import importlib.util',
        "spec = importlib.util.spec_from_file_location('lock_helper', sys.argv[2])",
        'lock_helper = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(lock_helper)',
        'registry = Path(sys.argv[3])',
        'lock_helper.close_registry_and_snapshot_process_groups(registry)',
        "values = registry.read_text(encoding='utf-8').splitlines()",
        'assert "shutdown" in values, values',
        'assert "incomplete-registration" in values, values',
      ].join('\n'),
      join(process.cwd(), 'scripts'),
      processLockHelperPath,
      unterminatedShutdownRegistry,
    ],
    { stdio: 'pipe' }
  );

  // A registration is a promise to the guardian that the sentinel's identity
  // survives the group SIGTERM that precedes escalation. Slow interpreter start
  // widens the window between spawning the sentinel and it ignoring SIGTERM;
  // registering inside that window strands the group, because the guardian
  // skips SIGKILL when the identity check fails.
  execFileSync(
    'python3',
    [
      '-c',
      [
        'import json, os, signal, subprocess, sys, tempfile, time',
        'group_helper = sys.argv[1]',
        'pgid = None',
        'try:',
        "    with tempfile.TemporaryDirectory(prefix='coverage-sentinel-ready-') as root:",
        "        slow_start = os.path.join(root, 'slow-start')",
        '        os.makedirs(slow_start)',
        "        with open(os.path.join(slow_start, 'sitecustomize.py'), 'w', encoding='utf-8') as handle:",
        "            handle.write('import os, time\\n')",
        '            handle.write("if os.environ.get(\'COVERAGE_SENTINEL_SLOW_START\'):\\n")',
        '            handle.write("    time.sleep(1.0)\\n")',
        "        registry = os.path.join(root, 'groups')",
        '        env = dict(os.environ)',
        "        env['PYTHONPATH'] = slow_start + os.pathsep + env.get('PYTHONPATH', '')",
        "        env['COVERAGE_SENTINEL_SLOW_START'] = '1'",
        '        launcher = subprocess.Popen(',
        "            [sys.executable, group_helper, registry, sys.executable, '-c', 'import time; time.sleep(30)'],",
        '            env=env,',
        '        )',
        '        registration = None',
        '        for _ in range(2000):',
        '            try:',
        "                line = open(registry, encoding='utf-8').read().strip()",
        '            except FileNotFoundError:',
        "                line = ''",
        '            if line:',
        '                registration = json.loads(line)',
        '                break',
        '            time.sleep(0.01)',
        '        else:',
        "            raise AssertionError('launcher never registered its process group')",
        "        pgid = registration['pgid']",
        "        identity_pid = registration['identity_pid']",
        '        os.kill(identity_pid, signal.SIGTERM)',
        '        time.sleep(0.3)',
        '        state = subprocess.run(',
        "            ['ps', '-p', str(identity_pid), '-o', 'stat='],",
        '            capture_output=True,',
        '            text=True,',
        '        ).stdout.strip()',
        "        assert state and not state.startswith('Z'), (",
        "            'registered sentinel was not TERM-proof (ps state=%r)' % state",
        '        )',
        'finally:',
        '    if pgid is not None:',
        '        try:',
        '            os.killpg(pgid, signal.SIGKILL)',
        '        except ProcessLookupError:',
        '            pass',
      ].join('\n'),
      processGroupHelperPath,
    ],
    { stdio: 'pipe' }
  );
  // The post-SIGKILL wait must be bounded. A zombie or uninterruptible process
  // keeps kill(pgid, 0) succeeding forever, and this loop runs while the guardian
  // still holds lock_file — so an unbounded wait would block every later coverage
  // run, not just this one. The fixture pins a group that never disappears and
  // asserts termination still returns.
  execFileSync(
    'python3',
    [
      '-c',
      [
        'import importlib.util, os, signal, sys, time',
        'sys.path.insert(0, sys.argv[1])',
        "spec = importlib.util.spec_from_file_location('lock_helper', sys.argv[2])",
        'lock_helper = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(lock_helper)',
        '',
        '# A group that outlives every signal: exists() is always true, so an',
        '# unbounded post-SIGKILL loop would never terminate.',
        'lock_helper.process_group_exists = lambda pgid: True',
        'lock_helper.process_group_identity_matches = lambda group: True',
        'os.killpg = lambda pgid, sig: None',
        '',
        'group = lock_helper.RegisteredProcessGroup(',
        '    pgid=424242, identity_pid=424242, start_identity="fixture",',
        ')',
        'started = time.monotonic()',
        'lock_helper.terminate_process_groups({group})',
        'elapsed = time.monotonic() - started',
        'budget = 5 + lock_helper.SIGKILL_REAP_TIMEOUT_SECONDS + 15',
        'assert elapsed < budget, f"post-SIGKILL wait was unbounded: {elapsed}s"',
        '',
        '# PermissionError must not crash cleanup: a group we cannot signal is',
        '# skipped, not escalated into an unbounded wait.',
        'def deny(pgid, sig):',
        '    raise PermissionError(1, "Operation not permitted")',
        'os.killpg = deny',
        'started = time.monotonic()',
        'lock_helper.terminate_process_groups({group})',
        'assert time.monotonic() - started < budget',
      ].join('\n'),
      join(process.cwd(), 'scripts'),
      processLockHelperPath,
    ],
    { stdio: 'pipe', timeout: 120_000 }
  );
  // A pgid past a C int makes os.killpg raise OverflowError, which would abort
  // the guardian before it reached the other registered groups; an oversized
  // integer literal raises ValueError rather than JSONDecodeError under
  // CPython's int/str conversion limit, which would escape json.loads entirely.
  execFileSync(
    'python3',
    [
      '-c',
      [
        'import json, sys',
        'sys.path.insert(0, sys.argv[1])',
        'from coverage_process_registry import MAX_PROCESS_ID, parse_process_group',
        'def rec(**kw): return json.dumps(kw)',
        'assert parse_process_group(rec(pgid=123, identity_pid=123, start_identity="x")) is not None',
        'assert parse_process_group(rec(pgid=MAX_PROCESS_ID, identity_pid=MAX_PROCESS_ID, start_identity="x")) is not None',
        'assert parse_process_group(rec(pgid=MAX_PROCESS_ID + 1, identity_pid=1, start_identity="x")) is None',
        'assert parse_process_group(rec(pgid=1, identity_pid=MAX_PROCESS_ID + 1, start_identity="x")) is None',
        'giant = "{\\"pgid\\": " + "9" * 5000 + ", \\"identity_pid\\": 1, \\"start_identity\\": \\"x\\"}"',
        'assert parse_process_group(giant) is None',
        '# A deeply nested line raises RecursionError, which would otherwise abort',
        '# the whole snapshot before valid groups were terminated.',
        'assert parse_process_group("[" * 200000 + "]" * 200000) is None',
      ].join('\n'),
      join(process.cwd(), 'scripts'),
    ],
    { stdio: 'pipe' }
  );
  // Once Popen has reaped the sentinel, its pid is released to the OS and may
  // name an unrelated process. Signalling it then is a kill of somebody else's
  // process, not a no-op — so a completed sentinel must never be signalled.
  execFileSync(
    'python3',
    [
      '-c',
      [
        'import importlib.util, os, subprocess, sys',
        'sys.path.insert(0, sys.argv[1])',
        "spec = importlib.util.spec_from_file_location('group_helper', sys.argv[2])",
        'group_helper = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(group_helper)',
        '',
        'signalled = []',
        'real_kill = os.kill',
        'os.kill = lambda pid, sig: signalled.append((pid, sig))',
        '',
        '# A sentinel that has already exited and been reaped.',
        'done = subprocess.Popen([sys.executable, "-c", "pass"])',
        'done.wait()',
        'assert done.poll() is not None',
        'group_helper.stop_identity_sentinel(done)',
        'assert signalled == [], f"signalled a reaped sentinel: {signalled}"',
        '',
        '# A live sentinel must still be signalled.',
        'live = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])',
        'assert live.poll() is None',
        'group_helper.stop_identity_sentinel(live)',
        'assert signalled and signalled[0][0] == live.pid, signalled',
        'os.kill = real_kill',
        'live.kill()',
        'live.wait()',
      ].join('\n'),
      join(process.cwd(), 'scripts'),
      processGroupHelperPath,
    ],
    { stdio: 'pipe', timeout: 60_000 }
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

process.stdout.write('coverage process registry contracts passed\n');
