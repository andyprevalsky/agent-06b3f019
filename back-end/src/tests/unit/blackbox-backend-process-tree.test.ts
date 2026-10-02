import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const helperPath = join(process.cwd(), '..', 'scripts', 'lib', 'cloudbench-env.sh');
const runnerPath = join(process.cwd(), 'scripts', 'run-blackbox-tests.sh');
const runner = readFileSync(runnerPath, 'utf8');
const runnerCleanup = runner.match(/^cleanup\(\) \{\n[\s\S]*?^\}/m)?.[0];
assert.ok(runnerCleanup, 'runner cleanup function is missing');

function monotonicMs(): number {
  const result = spawnSync(
    'python3',
    ['-c', 'import time; print(time.monotonic_ns() // 1000000)'],
    {
      encoding: 'utf8',
    }
  );
  assert.equal(result.status, 0, 'portable monotonic clock failed');
  return Number(result.stdout.trim());
}

function processBirth(pid: number): string {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().replace(/\s+/g, ' ') : '';
}

interface TreeRun {
  root: number;
  members: number[];
  survivors: number[];
  stopMs: number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PIDs whose command line carries `token` (the harness shell has exited by now). */
function processesCarrying(token: string): number[] {
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return ps.stdout
    .split('\n')
    .filter((line) => line.includes(token))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

/**
 * Backgrounds `command` the way the runner does (`&`, PID from `$!`), waits
 * until its tree has `minMembers` processes, stops it with the runner's
 * helper, and reports every process that outlived the stop.
 */
function runTree(
  command: string,
  minMembers: number,
  graceSeconds: number,
  token?: string,
  useRunnerCleanup = false
): TreeRun {
  const script = `
set -euo pipefail
source "${helperPath}"
PORT_LOCK_DIR=""
${runnerCleanup}
process_tree_pids() {
  local pid="$1" child
  echo "$pid"
  for child in $(pgrep -P "$pid" 2>/dev/null); do process_tree_pids "$child"; done
}
${command} >/dev/null 2>&1 &
root=$!
BACKEND_PID=$root
members=""
for _ in $(seq 1 200); do
  members="$(process_tree_pids "$root" | tr '\\n' ' ')"
  [[ $(wc -w <<<"$members") -ge ${minMembers} ]] && break
  sleep 0.05
done
echo "root=$root"
echo "members=$members"
for pid in $members; do printf 'birth=%s\t%s\n' "$pid" "$(cloudbench_pid_start_time "$pid")"; done
echo "started_ms=$(python3 -c 'import time; print(time.monotonic_ns() // 1000000)')"
${useRunnerCleanup ? 'cleanup' : `cloudbench_terminate_tree_and_wait ${graceSeconds} "$root"`}

`;
  const result = spawnSync('bash', ['-c', script], { cwd: process.cwd(), encoding: 'utf8' });
  const finishedMs = monotonicMs();
  const field = (name: string): string =>
    result.stdout.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  const members = field('members').split(/\s+/).filter(Boolean).map(Number);
  const births = new Map(
    [...result.stdout.matchAll(/^birth=(\d+)\t(.+)$/gm)].map((match) => [
      Number(match[1]),
      match[2].trim().replace(/\s+/g, ' '),
    ])
  );
  const deadline = Date.now() + 300;
  while (Date.now() < deadline && members.some(isAlive)) {
    spawnSync('sleep', ['0.05']);
  }
  const survivors = new Set(members.filter(isAlive));
  if (token) for (const pid of processesCarrying(token)) survivors.add(pid);
  for (const pid of survivors) {
    try {
      const expectedBirth = births.get(pid);
      if (expectedBirth && processBirth(pid) === expectedBirth) process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  assert.equal(result.status, 0, `process-tree harness failed: ${result.stderr}`);
  return {
    root: Number(field('root')),
    members,
    survivors: [...survivors],
    stopMs: finishedMs - Number(field('started_ms')),
  };
}

// The isolated blackbox backend is `npx tsx src/bootstrap.ts`. npx exits on
// SIGTERM without forwarding it, so the old `kill $!` left tsx and the server
// under PID 1: 54 leaked backends (~300MB each) exhausted a 16GB VM.
const token = `process-tree-${randomUUID()}`;
const npxTree = runTree(`npx tsx -e "setInterval(() => {}, 1000, '${token}')"`, 3, 5, token, true);
assert.ok(
  npxTree.members.length >= 3,
  `the launch must reach npx, tsx, and the node process tsx runs ` +
    `(tree of ${npxTree.root}: ${npxTree.members.join(' ')})`
);
assert.deepEqual(
  npxTree.survivors,
  [],
  `stopping the backend must stop npx and every process under it ` +
    `(tree ${npxTree.members.join(' ')})`
);

const termProof = runTree(`bash -c 'trap "" TERM; sleep 1000 & wait'`, 2, 1);
assert.deepEqual(
  termProof.survivors,
  [],
  'processes that ignore SIGTERM must be killed once the grace period ends'
);
assert.ok(
  termProof.stopMs >= 900 && termProof.stopMs < 4000,
  `escalation must wait out the 1s grace, then kill promptly (took ${termProof.stopMs}ms)`
);

assert.match(
  runner,
  /npx tsx src\/bootstrap\.ts >"\$BACKEND_LOG" 2>&1 &\nBACKEND_PID=\$!/,
  'the isolated blackbox backend must stay a child of the runner, in its process group'
);
assert.equal(
  runner.match(/npx tsx src\/bootstrap\.ts/g)?.length,
  1,
  'the isolated backend must launch exactly once'
);
assert.ok(
  runner.indexOf('trap cleanup EXIT') < runner.indexOf('npx tsx src/bootstrap.ts'),
  'the cleanup trap must be installed before the backend starts'
);

process.stdout.write(
  `blackbox-backend-process-tree: npx tree of ${npxTree.members.length} stopped in ` +
    `${npxTree.stopMs}ms; TERM-ignoring tree killed after ${termProof.stopMs}ms\n`
);
