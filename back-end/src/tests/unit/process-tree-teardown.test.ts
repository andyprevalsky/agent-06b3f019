import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helperPath = join(process.cwd(), '..', 'scripts', 'lib', 'process-tree.sh');
const blackboxRunnerPath = join(process.cwd(), 'scripts', 'run-blackbox-tests.sh');

/** Like `npx`: starts the real server as a child and dies on TERM without forwarding it. */
const WRAPPER = 'sleep 300 & echo $! > "$1"; wait';
/** A wrapper and server that both ignore TERM, so only KILL stops them. */
const TERM_IGNORING_WRAPPER = 'trap "" TERM; sleep 300 & echo $! > "$1"; wait';

const DRIVER = `
set -euo pipefail
source "$1"
pid_file="$2"
bash -c "$3" wrapper "$pid_file" >/dev/null 2>&1 &
service_pid=$!
for _ in $(seq 1 100); do [[ -s "$pid_file" ]] && break; sleep 0.05; done
[[ -s "$pid_file" ]] || { echo "server never started" >&2; exit 1; }
case "$4" in
  leader-only) kill "$service_pid"; wait "$service_pid" 2>/dev/null || true ;;
  tree) stop_process_tree "$service_pid" 1 ;;
esac
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAliveAfterSettling(pid: number): boolean {
  for (let attempt = 0; attempt < 40 && isAlive(pid); attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return isAlive(pid);
}

function runDriver(
  wrapper: string,
  mode: 'leader-only' | 'tree'
): { serverPid: number; ms: number } {
  const dir = mkdtempSync(join(tmpdir(), 'process-tree-teardown-'));
  const pidFile = join(dir, 'server.pid');
  try {
    const startedAt = Date.now();
    const result = spawnSync('bash', ['-c', DRIVER, 'driver', helperPath, pidFile, wrapper, mode], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(result.error, undefined, `driver did not finish (${mode}): ${result.error}`);
    assert.equal(result.status, 0, `driver failed (${mode}):\n${result.stderr}`);
    return { serverPid: Number(readFileSync(pidFile, 'utf8').trim()), ms: Date.now() - startedAt };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const control = runDriver(WRAPPER, 'leader-only');
try {
  assert.ok(
    isAliveAfterSettling(control.serverPid),
    'control: signalling only the wrapper must orphan its server, or this fixture cannot ' +
      'reproduce the leaked blackbox backends'
  );
} finally {
  if (isAlive(control.serverPid)) process.kill(control.serverPid, 'SIGKILL');
}

const stopped = runDriver(WRAPPER, 'tree');
assert.ok(
  !isAliveAfterSettling(stopped.serverPid),
  `stop_process_tree left the wrapper's server (pid ${stopped.serverPid}) running`
);

const escalated = runDriver(TERM_IGNORING_WRAPPER, 'tree');
try {
  assert.ok(
    !isAliveAfterSettling(escalated.serverPid),
    `stop_process_tree must KILL a tree that ignores TERM (pid ${escalated.serverPid} survived)`
  );
  assert.ok(
    escalated.ms < 10_000,
    `stopping a TERM-ignoring tree took ${escalated.ms}ms; the grace period must bound it`
  );
} finally {
  if (isAlive(escalated.serverPid)) process.kill(escalated.serverPid, 'SIGKILL');
}

const runner = readFileSync(blackboxRunnerPath, 'utf8');
assert.match(
  runner,
  /npx tsx src\/bootstrap\.ts >"\$BACKEND_LOG" 2>&1 &\n[ \t]*BACKEND_PID=\$!/,
  'run-blackbox-tests.sh must record the PID of its isolated backend launcher'
);
assert.match(
  runner,
  /cloudbench_terminate_tree_and_wait 5 "\$BACKEND_PID"/,
  'run-blackbox-tests.sh must verify its isolated backend process-tree retirement'
);

process.stdout.write('PASS process-tree teardown: 3 lifecycle cases + runner wiring\n');
