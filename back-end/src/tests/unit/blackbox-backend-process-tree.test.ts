import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helperPath = join(process.cwd(), '..', 'scripts', 'lib', 'process-tree.sh');
const runnerPath = join(process.cwd(), 'scripts', 'run-blackbox-tests.sh');

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
  pathPrefix?: string
): TreeRun {
  const script = `
set -euo pipefail
${pathPrefix ? `export PATH="${pathPrefix}:$PATH"` : ''}
source "${helperPath}"
${command} >/dev/null 2>&1 &
root=$!
members=""
for _ in $(seq 1 200); do
  members="$(process_tree_pids "$root" | tr '\\n' ' ')"
  [[ $(wc -w <<<"$members") -ge ${minMembers} ]] && break
  sleep 0.05
done
started=$(date +%s%N)
stop_process_tree "$root" ${graceSeconds}
echo "stop_ms=$(( ($(date +%s%N) - started) / 1000000 ))"
echo "root=$root"
echo "members=$members"
`;
  const result = spawnSync('bash', ['-c', script], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, `process-tree harness failed: ${result.stderr}`);
  const field = (name: string): string =>
    result.stdout.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  const members = field('members').split(/\s+/).filter(Boolean).map(Number);
  const deadline = Date.now() + 300;
  while (Date.now() < deadline && members.some(isAlive)) {
    spawnSync('sleep', ['0.05']);
  }
  const survivors = new Set(members.filter(isAlive));
  if (token) for (const pid of processesCarrying(token)) survivors.add(pid);
  for (const pid of survivors) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  return {
    root: Number(field('root')),
    members,
    survivors: [...survivors],
    stopMs: Number(field('stop_ms')),
  };
}

// The isolated blackbox backend is `npx tsx src/bootstrap.ts`. npx exits on
// SIGTERM without forwarding it, so the old `kill $!` left tsx and the server
// under PID 1: 54 leaked backends (~300MB each) exhausted a 16GB VM.
const token = `process-tree-${randomUUID()}`;
const npxTree = runTree(`npx tsx -e "setInterval(() => {}, 1000, '${token}')"`, 3, 5, token);
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

const runner = readFileSync(runnerPath, 'utf8');
assert.match(
  runner,
  /npx tsx src\/bootstrap\.ts >"\$BACKEND_LOG" 2>&1 &\nBACKEND_PID=\$!/,
  'the isolated blackbox backend must stay a child of the runner, in its process group'
);
assert.match(
  runner,
  /cleanup\(\) \{\n\s+stop_process_tree "\$BACKEND_PID"/,
  'runner cleanup must stop the backend and every process under it'
);
assert.ok(
  runner.indexOf('trap cleanup EXIT') < runner.indexOf('npx tsx src/bootstrap.ts'),
  'the cleanup trap must be installed before the backend starts'
);

// A loaded host makes every `ps` slow. The grace counted 0.1s sleeps, each also
// paying a `ps` per pid, so a 1s grace took 13.8s at load average 90. Shim a
// 0.4s `ps` to reproduce that deterministically: the grace is wall clock.
const slowPsDir = mkdtempSync(join(tmpdir(), 'slow-ps-'));
const slowPs = join(slowPsDir, 'ps');
writeFileSync(slowPs, '#!/bin/sh\nsleep 0.4\nexec /bin/ps "$@"\n');
chmodSync(slowPs, 0o755);
let slowPsProof: TreeRun;
try {
  slowPsProof = runTree(`bash -c 'trap "" TERM; sleep 1000 & wait'`, 2, 1, undefined, slowPsDir);
} finally {
  rmSync(slowPsDir, { recursive: true, force: true });
}
assert.deepEqual(slowPsProof.survivors, [], 'a slow ps must not leave TERM-ignoring processes alive');
assert.ok(
  slowPsProof.stopMs >= 900 && slowPsProof.stopMs < 4000,
  `the grace must be wall clock even when each ps is slow (took ${slowPsProof.stopMs}ms)`
);

process.stdout.write(
  `blackbox-backend-process-tree: npx tree of ${npxTree.members.length} stopped in ` +
    `${npxTree.stopMs}ms; TERM-ignoring tree killed after ${termProof.stopMs}ms; ` +
    `with slow ps after ${slowPsProof.stopMs}ms\n`
);
