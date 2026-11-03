import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helperPath = join(process.cwd(), '..', 'scripts', 'lib', 'cloudbench-env.sh');
const processTreeHelperPath = join(process.cwd(), '..', 'scripts', 'lib', 'process-tree.sh');
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
  const observed = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (observed.status === 0) {
    const state = observed.stdout.trim();
    assert.match(state, /^[DIRSTUWXYZ][A-Za-z+<=>-]*$/, 'native process state is malformed');
    return !state.startsWith('Z');
  }
  assert.equal(observed.status, 1, 'native process-state observation failed');
  assert.equal(observed.stdout.trim(), '', 'failed process lookup returned ambiguous state');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH', 'process absence is unverified');
    return false;
  }
}

// Hold a real exited child unreaped: PID existence must not mean execution.
// The same predicate must retain live children and reject unavailable state.
const predicateSource = readFileSync(process.argv[1], 'utf8').match(
  /^function isAlive\(pid: number\): boolean \{[\s\S]*?^\}/m
)?.[0];
assert.ok(predicateSource, 'owning process-state predicate is missing');
const predicateProgram = `const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
${predicateSource
  .replace('(pid: number): boolean', '(pid)')
  .replace('(error as NodeJS.ErrnoException)', 'error')}
console.log(isAlive(Number(process.argv[1])));`;
const predicateControls = spawnSync(
  'python3',
  [
    '-c',
    String.raw`
import os,pathlib,signal,subprocess,sys,tempfile,time
node,program=sys.argv[1:]
def probe(pid,env=None):
 return subprocess.run([node,'-e',program,str(pid)],env=env,capture_output=True,text=True,timeout=20)
reader,writer=os.pipe();child=os.fork()
if child==0:
 os.close(writer);os.read(reader,1);os._exit(0)
os.close(reader)
try:
 live=probe(child);assert live.returncode==0 and live.stdout.strip()=='true','live child rejected'
 os.write(writer,b'x');os.close(writer);deadline=time.monotonic()+15
 while True:
  state=subprocess.check_output(['ps','-p',str(child),'-o','stat='],text=True,timeout=5).strip()
  if state.startswith('Z'):break
  assert time.monotonic()<deadline,'child never became terminal';time.sleep(.01)
 terminal=probe(child);assert terminal.returncode==0 and terminal.stdout.strip()=='false','terminal child counted as executing'
 original=child;os.waitpid(child,0);child=None
 absent=probe(original);assert absent.returncode==0 and absent.stdout.strip()=='false','joined child counted as executing'
 with tempfile.TemporaryDirectory() as tmp:
  fake=pathlib.Path(tmp)/'ps';fake.write_text('#!/bin/sh\nexit 2\n');fake.chmod(0o700)
  failed=probe(os.getpid(),{**os.environ,'PATH':tmp+os.pathsep+os.environ['PATH']})
  assert failed.returncode!=0,'unavailable native state counted as absence'
finally:
 if child is not None:
  os.kill(child,signal.SIGKILL);os.waitpid(child,0)
`,
    process.execPath,
    predicateProgram,
  ],
  { encoding: 'utf8', timeout: 60_000 }
);
assert.equal(predicateControls.status, 0, predicateControls.stderr);

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
  useRunnerCleanup = false,
  pathPrefix?: string,
  useWallClockHelper = false,
  readyFile?: string
): TreeRun {
  const script = `
set -euo pipefail
${pathPrefix ? `export PATH="${pathPrefix}:$PATH"` : ''}
source "${helperPath}"
PORT_LOCK_DIR=""
${runnerCleanup}
process_tree_pids() {
  local pid="$1" child
  echo "$pid"
  for child in $(pgrep -P "$pid" 2>/dev/null); do process_tree_pids "$child"; done
}
${useWallClockHelper ? `source "${processTreeHelperPath}"` : ''}
${command} >/dev/null 2>&1 &
root=$!
BACKEND_PID=$root
members=""
for _ in $(seq 1 1200); do
  members="$(process_tree_pids "$root" | tr '\\n' ' ')"
  [[ $(wc -w <<<"$members") -ge ${minMembers} ]] ${readyFile ? `&& [[ -e "${readyFile}" ]]` : ''} && break
  sleep 0.05
done
echo "root=$root"
echo "members=$members"
for pid in $members; do printf 'birth=%s\t%s\n' "$pid" "$(cloudbench_pid_start_time "$pid")"; done
echo "started_ms=$(python3 -c 'import time; print(time.monotonic_ns() // 1000000)')"
${
  useRunnerCleanup
    ? 'cleanup'
    : useWallClockHelper
      ? `stop_process_tree "$root" ${graceSeconds}`
      : `cloudbench_terminate_tree_and_wait ${graceSeconds} "$root"`
}

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
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && members.some(isAlive)) {
    spawnSync('sleep', ['0.05']);
  }
  const survivors = new Set(members.filter(isAlive));
  // The random token identifies a survivor born after the member snapshot.
  const tokenCarriers = new Set(token ? processesCarrying(token) : []);
  for (const pid of tokenCarriers) survivors.add(pid);
  for (const pid of survivors) {
    try {
      const expectedBirth = births.get(pid);
      if (tokenCarriers.has(pid) || (expectedBirth && processBirth(pid) === expectedBirth)) {
        process.kill(pid, 'SIGKILL');
      }
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
// The backend is serving before cleanup runs, so wait for the node process tsx
// runs to exist: on a loaded host tsx can still be spawning it at three members.
const token = `process-tree-${randomUUID()}`;
const npxReadyDir = mkdtempSync(join(tmpdir(), 'npx-tree-ready-'));
const npxReady = join(npxReadyDir, 'ready');
let npxTree: TreeRun;
try {
  npxTree = runTree(
    `npx tsx -e "require('node:fs').writeFileSync('${npxReady}', ''); setInterval(() => {}, 1000, '${token}')"`,
    3,
    5,
    token,
    true,
    undefined,
    false,
    npxReady
  );
} finally {
  rmSync(npxReadyDir, { recursive: true, force: true });
}
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
if (termProof.stopMs < 900 || termProof.stopMs >= 4000) {
  process.stderr.write(`timing warning: TERM-ignoring tree retired in ${termProof.stopMs}ms\n`);
}

assert.match(
  runner,
  /npx tsx src\/bootstrap\.ts >"\$BACKEND_LOG" 2>&1 &\n[ \t]*BACKEND_PID=\$!/,
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

// A loaded host makes every `ps` slow. The grace counted 0.1s sleeps, each also
// paying a `ps` per pid, so a 1s grace took 13.8s at load average 90. Shim a
// 0.4s `ps` to reproduce that deterministically: the grace is wall clock.
const slowPsDir = mkdtempSync(join(tmpdir(), 'slow-ps-'));
const slowPs = join(slowPsDir, 'ps');
writeFileSync(slowPs, '#!/bin/sh\nsleep 0.4\nexec /bin/ps "$@"\n');
chmodSync(slowPs, 0o755);
let slowPsProof: TreeRun;
try {
  slowPsProof = runTree(
    `bash -c 'trap "" TERM; sleep 1000 & wait'`,
    2,
    1,
    undefined,
    false,
    slowPsDir,
    true
  );
} finally {
  rmSync(slowPsDir, { recursive: true, force: true });
}
assert.deepEqual(
  slowPsProof.survivors,
  [],
  'a slow ps must not leave TERM-ignoring processes alive'
);
if (slowPsProof.stopMs < 900 || slowPsProof.stopMs >= 4000) {
  process.stderr.write(`timing warning: slow-ps tree retired in ${slowPsProof.stopMs}ms\n`);
}

process.stdout.write(
  `blackbox-backend-process-tree: npx tree of ${npxTree.members.length} stopped in ` +
    `${npxTree.stopMs}ms; TERM-ignoring tree killed after ${termProof.stopMs}ms; ` +
    `with slow ps after ${slowPsProof.stopMs}ms\n`
);
