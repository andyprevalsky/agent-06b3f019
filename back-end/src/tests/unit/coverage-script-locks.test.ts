import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const processGroupHelperPath = join(process.cwd(), 'scripts', 'coverage-process-group.py');
const processLockHelperPath = join(process.cwd(), 'scripts', 'coverage-process-lock.py');

function waitForPath(path: string, shouldExist: boolean): void {
  for (let attempt = 0; attempt < 100 && existsSync(path) !== shouldExist; attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.equal(existsSync(path), shouldExist, `Timed out waiting for ${path}`);
}

const processHelperFixtureRoot = mkdtempSync(join(tmpdir(), 'coverage-process-helpers-'));
try {
  const missingRegistryPath = join(processHelperFixtureRoot, 'missing-command-groups');
  const missingCommand = spawnSync(
    'python3',
    [
      processGroupHelperPath,
      missingRegistryPath,
      join(processHelperFixtureRoot, 'missing-command'),
    ],
    { encoding: 'utf8' }
  );
  assert.equal(missingCommand.status, 127, 'a missing coverage child executable must return 127');

  const deniedExecutablePath = join(processHelperFixtureRoot, 'not-executable');
  writeFileSync(deniedExecutablePath, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(deniedExecutablePath, 0o644);
  const deniedCommand = spawnSync(
    'python3',
    [
      processGroupHelperPath,
      join(processHelperFixtureRoot, 'denied-command-groups'),
      deniedExecutablePath,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(deniedCommand.status, 126, 'a non-executable coverage child must return 126');

  const delayedRegistryPath = join(processHelperFixtureRoot, 'delayed-launch-groups');
  const delayedMarkerPath = join(processHelperFixtureRoot, 'delayed-command-ran');
  execFileSync(
    'python3',
    [
      '-c',
      [
        'import fcntl, os, subprocess, sys, time',
        'helper, registry_path, marker_path = sys.argv[1:]',
        "with open(registry_path, 'a+', encoding='utf-8') as registry:",
        '    fcntl.flock(registry.fileno(), fcntl.LOCK_EX)',
        '    child = subprocess.Popen([',
        "        sys.executable, helper, registry_path, sys.executable, '-c',",
        '        "from pathlib import Path; import sys; Path(sys.argv[1]).write_text(\'ran\')",',
        '        marker_path,',
        '    ])',
        '    time.sleep(0.1)',
        "    registry.write('shutdown\\n')",
        '    registry.flush()',
        '    os.fsync(registry.fileno())',
        '    fcntl.flock(registry.fileno(), fcntl.LOCK_UN)',
        'status = child.wait(timeout=5)',
        "assert status == 125, f'delayed launcher exited {status}, expected 125'",
        "assert not os.path.exists(marker_path), 'delayed command ran after shutdown was published'",
      ].join('\n'),
      processGroupHelperPath,
      delayedRegistryPath,
      delayedMarkerPath,
    ],
    { stdio: 'pipe' }
  );
  assert.equal(
    existsSync(delayedMarkerPath),
    false,
    'a launcher delayed behind the registry lock must stop before exec after guardian shutdown'
  );

  execFileSync(
    'python3',
    [
      '-c',
      [
        'import json, os, signal, subprocess, sys, tempfile, time',
        'lock_helper = sys.argv[1]',
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)",
        'try:',
        "    with tempfile.TemporaryDirectory(prefix='coverage-identity-mismatch-') as root:",
        "        registry = os.path.join(root, 'groups')",
        "        status = os.path.join(root, 'status')",
        "        lock = os.path.join(root, 'lock')",
        "        with open(registry, 'w', encoding='utf-8') as handle:",
        "            handle.write(json.dumps({'pgid': child.pid, 'identity_pid': child.pid, 'start_identity': 'wrong-identity'}) + '\\n')",
        '        guardian = subprocess.Popen([sys.executable, lock_helper, lock, status, str(os.getpid()), registry])',
        '        for _ in range(100):',
        "            if os.path.exists(status) and open(status, encoding='utf-8').read() == 'acquired':",
        '                break',
        '            time.sleep(0.02)',
        '        else:',
        "            raise AssertionError('guardian did not acquire identity mismatch fixture lock')",
        '        guardian.send_signal(signal.SIGTERM)',
        '        guardian.wait(timeout=5)',
        '        os.killpg(child.pid, 0)',
        'finally:',
        '    try:',
        '        os.killpg(child.pid, signal.SIGKILL)',
        '    except ProcessLookupError:',
        '        pass',
        '    child.wait(timeout=5)',
      ].join('\n'),
      processLockHelperPath,
    ],
    { stdio: 'pipe' }
  );

  const nestedStatusPath = join(processHelperFixtureRoot, 'nested', 'status', 'lock-status');
  const nestedStatusGuardian = spawn(
    'python3',
    [
      processLockHelperPath,
      join(processHelperFixtureRoot, 'nested-status-lock'),
      nestedStatusPath,
      String(process.pid),
    ],
    { stdio: 'ignore' }
  );
  try {
    waitForPath(nestedStatusPath, true);
    assert.equal(
      readFileSync(nestedStatusPath, 'utf8'),
      'acquired',
      'the coverage lock guardian must create a nested status directory before reporting'
    );
  } finally {
    nestedStatusGuardian.kill('SIGTERM');
  }
} finally {
  rmSync(processHelperFixtureRoot, { recursive: true, force: true });
}

const runLockFixtureRoot = mkdtempSync(join(tmpdir(), 'coverage-run-lock-'));
const runLockPath = join(runLockFixtureRoot, 'active');
const processGroupsPath = join(runLockFixtureRoot, 'process-groups');
const lockHolder = spawn('bash', ['scripts/run-coverage.sh', '--hold-coverage-lock-with-child'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    BACKEND_COVERAGE_RUN_LOCK_DIR: runLockPath,
    BACKEND_COVERAGE_PROCESS_GROUPS_FILE: processGroupsPath,
    BACKEND_COVERAGE_HOLD_SECONDS: '30',
  },
  detached: true,
  stdio: 'ignore',
});
try {
  // Wait for the owner to publish itself rather than a fixed window: a loaded
  // host can take seconds to start the shell. Stop early if the holder exits;
  // the cap stays inside its 30s hold. These synchronous waits block the event
  // loop, so liveness is probed directly instead of through exitCode.
  const holderAlive = (): boolean => {
    try {
      process.kill(lockHolder.pid ?? -1, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (
    let attempt = 0;
    attempt < 1250 &&
    holderAlive() &&
    readFileSync(runLockPath, { encoding: 'utf8', flag: 'a+' }).trim() === '';
    attempt++
  ) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.equal(
    readFileSync(runLockPath, 'utf8').trim(),
    String(lockHolder.pid),
    'coverage process lock must identify its live shell owner'
  );
  for (
    let attempt = 0;
    attempt < 1250 &&
    holderAlive() &&
    (!existsSync(processGroupsPath) || readFileSync(processGroupsPath, 'utf8').trim() === '');
    attempt++
  ) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  const registeredProcessGroup = JSON.parse(readFileSync(processGroupsPath, 'utf8').trim()) as {
    identity_pid: number;
    pgid: number;
    start_identity: string;
  };
  const childProcessGroup = registeredProcessGroup.pgid;
  assert.ok(Number.isInteger(childProcessGroup) && childProcessGroup > 0);
  assert.ok(
    Number.isInteger(registeredProcessGroup.identity_pid) &&
      registeredProcessGroup.identity_pid > 0 &&
      registeredProcessGroup.identity_pid !== childProcessGroup,
    'coverage process registration must use a distinct persistent identity sentinel'
  );
  assert.match(
    registeredProcessGroup.start_identity,
    /^(proc-start-ticks|ps-lstart):/,
    'coverage process registration must include an immutable session-leader start identity'
  );
  process.kill(-childProcessGroup, 0);
  let blockedStderr = '';
  try {
    execFileSync('bash', ['scripts/run-coverage.sh', '--print-coverage-port'], {
      cwd: process.cwd(),
      env: { ...process.env, BACKEND_COVERAGE_RUN_LOCK_DIR: runLockPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    blockedStderr = String((error as { stderr?: Buffer }).stderr ?? '');
  }
  assert.match(
    blockedStderr,
    /Another backend coverage run is already active/,
    'a second same-worktree coverage run must fail before mutating shared state'
  );

  // A directory mutex survives SIGKILL forever. Kill the owning shell's whole
  // process group and prove the separately-sessioned guardian reaps registered
  // descendants before releasing the same lock without manual cleanup.
  if (lockHolder.pid !== undefined) process.kill(-lockHolder.pid, 'SIGKILL');
  let recoveredPort = '';
  for (let attempt = 0; attempt < 100 && recoveredPort === ''; attempt++) {
    try {
      recoveredPort =
        execFileSync('bash', ['scripts/run-coverage.sh', '--print-coverage-port'], {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            BACKEND_COVERAGE_RUN_LOCK_DIR: runLockPath,
            BACKEND_COVERAGE_START_PORT: '59000',
            BACKEND_COVERAGE_END_PORT: '59020',
            BACKEND_COVERAGE_PORT_LOCK_ROOT: join(runLockFixtureRoot, 'recovery-port-locks'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
          .trim()
          .split('\n')
          .at(-1) ?? '';
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  assert.match(recoveredPort, /^59\d{3}$/, 'coverage run lock must recover after owner SIGKILL');
  assert.throws(
    () => process.kill(-childProcessGroup, 0),
    /ESRCH/,
    'coverage must terminate registered descendant groups before releasing the run lock'
  );
} finally {
  if (lockHolder.pid !== undefined) {
    try {
      process.kill(-lockHolder.pid, 'SIGTERM');
    } catch {
      // The SIGKILL recovery assertion normally reaches this cleanup after exit.
    }
  }
  if (existsSync(processGroupsPath)) {
    for (const value of readFileSync(processGroupsPath, 'utf8').split(/\n+/)) {
      let pgid = 0;
      try {
        pgid = Number((JSON.parse(value) as { pgid?: number }).pgid);
      } catch {
        continue;
      }
      if (!Number.isInteger(pgid) || pgid <= 0) continue;
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // The orphan cleanup assertion normally reaps every registered group.
      }
    }
  }
  rmSync(runLockFixtureRoot, { recursive: true, force: true });
}

// RCA 2026-10-26 07:18Z: two backend runners sharing one CONDUCTOR_WORKSPACE_NAME
// shared victoria_<workspace>; the second runner's schema sync (prisma db push +
// DROP TRIGGER hooks) deadlocked the first runner's live cases (40P01). Each
// runner that prepares a database must hold a per-database lock for its whole
// run, and a second runner must fail fast naming the holder.
const testDbLockLibPath = join(process.cwd(), 'scripts', 'test-db-run-lock.sh');
const testDbLockFixtureRoot = mkdtempSync(join(tmpdir(), 'test-db-run-lock-'));
let testDbLockHolder: ReturnType<typeof spawn> | undefined;
try {
  const lockEnv = { ...process.env, ROSE_TEST_DB_LOCK_DIR: testDbLockFixtureRoot };
  const holderReady = join(testDbLockFixtureRoot, 'holder-ready');
  testDbLockHolder = spawn(
    'bash',
    [
      '-c',
      'source "$1"; acquire_test_db_run_lock "postgresql://postgres:pw@127.0.0.1:5432/victoria_gate-x?connection_limit=16" "fixture holder" || exit 9; touch "$2"; sleep 30',
      'holder',
      testDbLockLibPath,
      holderReady,
    ],
    { env: { ...lockEnv, CONDUCTOR_WORKSPACE_NAME: 'gate-x' }, stdio: 'ignore' }
  );
  waitForPath(holderReady, true);

  const tryAcquire = (url: string) =>
    spawnSync(
      'bash',
      ['-c', 'source "$1"; acquire_test_db_run_lock "$2" "fixture contender"', 'contender', testDbLockLibPath, url],
      { env: lockEnv, encoding: 'utf8', timeout: 15_000 }
    );

  // Same database through a differently spelled URL (no credentials or query).
  const blocked = tryAcquire('postgresql://localhost/victoria_gate-x');
  assert.equal(blocked.status, 1, 'a second runner on the same database must fail fast');
  assert.match(
    blocked.stderr,
    new RegExp(`localhost:5432/victoria_gate-x is in use by another backend test runner: pid=${testDbLockHolder.pid} runner=fixture holder workspace=gate-x`),
    'the failure must name the live holder'
  );

  // A different database is independent.
  const other = tryAcquire('postgresql://postgres:postgres@localhost:5432/victoria_gate-y');
  assert.equal(other.status, 0, `a different database must not be blocked: ${other.stderr}`);

  // A SIGKILLed holder never strands the lock: the kernel lock dies with its keeper.
  testDbLockHolder.kill('SIGKILL');
  let recovered = tryAcquire('postgresql://localhost:5432/victoria_gate-x');
  for (let attempt = 0; attempt < 100 && recovered.status !== 0; attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    recovered = tryAcquire('postgresql://localhost:5432/victoria_gate-x');
  }
  assert.equal(recovered.status, 0, `a dead holder's lock must be recoverable: ${recovered.stderr}`);

  // Both runners take the lock on the selected database BEFORE any schema sync
  // and the blackbox child of coverage (BLACKBOX_TEST_SKIP_DB_SYNC=1) does not
  // contend with its parent's lock.
  for (const runner of ['run-blackbox-tests.sh', 'run-coverage.sh']) {
    const source = readFileSync(join(process.cwd(), 'scripts', runner), 'utf8');
    const lockAt = source.indexOf('acquire_test_db_run_lock "');
    const pushAt = source.indexOf('npx prisma db push');
    const ensureAt = source.indexOf('ensure_workspace_system_db "$LOCAL_DB_PORT"');
    assert.ok(lockAt > 0, `${runner} must acquire the per-database run lock`);
    assert.ok(lockAt < pushAt && lockAt < ensureAt, `${runner} must lock before its schema sync`);
  }
  const blackboxSource = readFileSync(join(process.cwd(), 'scripts', 'run-blackbox-tests.sh'), 'utf8');
  const skipBranch = blackboxSource.indexOf('if [[ "$SKIP_DB_SYNC" == "1" ]]; then');
  const skipElse = blackboxSource.indexOf('  else', skipBranch);
  assert.ok(
    blackboxSource.indexOf('acquire_test_db_run_lock "') > skipElse,
    'the coverage-launched blackbox child (skip sync) must not take its parent coverage lock'
  );
} finally {
  testDbLockHolder?.kill('SIGKILL');
  rmSync(testDbLockFixtureRoot, { recursive: true, force: true });
}

process.stdout.write('coverage script lock contracts passed\n');
