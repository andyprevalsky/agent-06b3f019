#!/usr/bin/env tsx
/**
 * DEPLOY_GATE_PROGRESS rows from the backend: the shared writer and the blackbox runner.
 *
 * 1. The row is byte-identical to `scripts/deploy_gate_progress.py` (key order, separators,
 *    ASCII escaping, 2000-code-point detail tail) and is appended with mode 0600.
 * 2. Unset variable: nothing is written. Unwritable target: the error is swallowed.
 * 3. The real `src/tests/blackbox/run.ts`, copied with fake domains into a temp tree, appends a
 *    domain's FAIL row the moment that domain settles: a sibling domain stays blocked until the
 *    test has read the row, so a row written only at the end of the sweep deadlocks and fails.
 *
 * No database: the fake domains never connect and DATABASE_URL is not passed to the runner.
 * Run: npx tsx src/tests/unit/gate-progress.test.ts (via scripts/run-unit-tests.ts)
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  gateProgressRow,
  reportGateProgress,
  serializeGateProgressRow,
} from '../helpers/gateProgress';

const backendDir = resolve(__dirname, '../../..');
const repoScripts = resolve(backendDir, '../scripts');
const root = mkdtempSync(join(tmpdir(), 'gate-progress-backend-'));

function lines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function writerContract(): Promise<void> {
  const progress = join(root, 'writer', 'progress.jsonl');
  mkdirSync(dirname(progress));
  const env = { DEPLOY_GATE_PROGRESS: progress, DEPLOY_GATE_CASE: 'blackbox-shard-1' };
  const detail = `${'x'.repeat(3000)}\nAssertionError: boom`;
  const before = Date.now() / 1000;
  assert.equal(reportGateProgress('alpha', 'FAIL', { scope: 'domain', detail }, env), true);
  const after = Date.now() / 1000;

  const raw = readFileSync(progress, 'utf8');
  assert.ok(raw.endsWith('\n') && raw.indexOf('\n') === raw.length - 1, 'exactly one line');
  const row = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(row), [
    'v',
    'scope',
    'case',
    'unit',
    'status',
    'at',
    'detail',
    'log',
  ]);
  assert.equal(typeof row.at, 'number');
  assert.ok((row.at as number) >= before && (row.at as number) <= after, 'at is epoch seconds');
  assert.deepEqual(row, {
    v: 1,
    scope: 'domain',
    case: 'blackbox-shard-1',
    unit: 'alpha',
    status: 'FAIL',
    at: row.at,
    detail: detail.slice(-2000),
    log: '',
  });
  assert.equal(statSync(progress).mode & 0o777, 0o600);

  // Byte-for-byte parity with the Python protocol helper, including non-ASCII and controls.
  const unicode = `é ✓ 😀 \u007f \u0001 "quoted" \\ ${'😀'.repeat(2100)}`;
  const fixed = gateProgressRow(
    'beta',
    'FAIL',
    { scope: 'test', detail: unicode, log: '/tmp/beta.log' },
    { DEPLOY_GATE_CASE: 'case ✓' },
    () => 1762540000123.25
  );
  const python = spawnSync(
    'python3',
    [
      '-c',
      [
        'import json, sys',
        `sys.path.insert(0, ${JSON.stringify(repoScripts)})`,
        'import deploy_gate_progress as p',
        'a = json.loads(sys.stdin.read())',
        "r = p.row(a['unit'], a['status'], scope=a['scope'], detail=a['detail'], log=a['log'], case=a['case'], at=a['at'])",
        "sys.stdout.write(json.dumps(r, separators=(',', ':')) + '\\n')",
      ].join('\n'),
    ],
    { input: JSON.stringify({ ...fixed, detail: unicode }), encoding: 'utf8' }
  );
  assert.equal(python.status, 0, python.stderr);
  assert.equal(serializeGateProgressRow(fixed), python.stdout);
  assert.equal(Array.from(fixed.detail).length, 2000);

  // Unset or empty: nothing is written anywhere (the existing file and directory are unchanged).
  const listing = readdirSync(dirname(progress));
  assert.equal(reportGateProgress('alpha', 'FAIL', { detail }, {}), false);
  assert.equal(
    reportGateProgress('alpha', 'FAIL', { detail }, { DEPLOY_GATE_PROGRESS: '' }),
    false
  );
  assert.deepEqual(readdirSync(dirname(progress)), listing);
  assert.equal(readFileSync(progress, 'utf8'), raw);

  // Unwritable targets (a directory, a missing parent) are swallowed, never thrown.
  for (const target of [join(root, 'writer'), join(root, 'missing', 'progress.jsonl')]) {
    assert.doesNotThrow(() =>
      assert.equal(reportGateProgress('alpha', 'FAIL', {}, { DEPLOY_GATE_PROGRESS: target }), false)
    );
  }
}

async function runnerReportsDomainImmediately(): Promise<void> {
  const tree = join(root, 'runner');
  const blackbox = join(tree, 'src', 'tests', 'blackbox');
  const helpers = join(tree, 'src', 'tests', 'helpers');
  mkdirSync(blackbox, { recursive: true });
  mkdirSync(helpers, { recursive: true });
  copyFileSync(join(backendDir, 'src/tests/blackbox/run.ts'), join(blackbox, 'run.ts'));
  copyFileSync(
    join(backendDir, 'src/tests/helpers/gateProgress.ts'),
    join(helpers, 'gateProgress.ts')
  );
  // The runner starts each domain with `--import tsx` from the tree root.
  symlinkSync(dirname(dirname(require.resolve('tsx/package.json'))), join(tree, 'node_modules'));
  const release = join(tree, 'release');
  writeFileSync(join(blackbox, 'alpha.blackbox.ts'), "process.stdout.write('alpha ok\\n');\n");
  writeFileSync(
    join(blackbox, 'beta.blackbox.ts'),
    "process.stderr.write('AssertionError: beta expected 2 got 3\\n');\nprocess.exitCode = 1;\n"
  );
  writeFileSync(
    join(blackbox, 'gamma.blackbox.ts'),
    `import { existsSync } from 'node:fs';
const deadline = Date.now() + 60_000;
const wait = setInterval(() => {
  if (existsSync(${JSON.stringify(release)}) || Date.now() > deadline) clearInterval(wait);
}, 20);
`
  );

  const run = (progress: string | undefined) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? tree,
      TMPDIR: tmpdir(),
      BLACKBOX_TEST_CONCURRENCY: '3',
      DEPLOY_GATE_CASE: 'blackbox-shard-2',
    };
    if (progress) env.DEPLOY_GATE_PROGRESS = progress;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(blackbox, 'run.ts'), 'alpha,beta,gamma'],
      { cwd: tree, env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    const exited = new Promise<number | null>((done) => child.on('close', done));
    return { exited, output: () => output };
  };

  const progress = join(tree, 'progress.jsonl');
  const live = run(progress);
  let settled = false;
  void live.exited.then(() => (settled = true));
  let early: Record<string, unknown>[] = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !settled) {
    early = existsSync(progress) ? lines(progress) : [];
    if (early.some((row) => row.unit === 'beta')) break;
    await sleep(25);
  }
  const exitedBeforeBeta = settled;
  // Release gamma and let the sweep finish before any assertion, so a failure never
  // leaves the runner or its domain children behind the temp tree's removal.
  writeFileSync(release, '');
  const code = await live.exited;
  assert.equal(exitedBeforeBeta, false, `runner exited before reporting beta:\n${live.output()}`);
  const beta = early.find((row) => row.unit === 'beta');
  assert.ok(beta, `beta FAIL row must be appended while gamma still runs:\n${live.output()}`);
  assert.equal(
    early.some((row) => row.unit === 'gamma'),
    false,
    'gamma is still blocked, so its row cannot exist yet'
  );
  assert.deepEqual(Object.keys(beta), [
    'v',
    'scope',
    'case',
    'unit',
    'status',
    'at',
    'detail',
    'log',
  ]);
  assert.equal(beta.v, 1);
  assert.equal(beta.scope, 'domain');
  assert.equal(beta.case, 'blackbox-shard-2');
  assert.equal(beta.status, 'FAIL');
  assert.equal(beta.log, '');
  assert.match(String(beta.detail), /AssertionError: beta expected 2 got 3/);

  assert.equal(code, 1, live.output());
  const rows = lines(progress);
  assert.deepEqual(rows.map((row) => `${row.unit}:${row.status}`).sort(), [
    'alpha:PASS',
    'beta:FAIL',
    'gamma:PASS',
  ]);
  for (const row of rows.filter((r) => r.status === 'PASS')) assert.equal(row.detail, '');
  assert.match(live.output(), /2 passed, 1 failed, 0 not run, 3 total/);

  // Unset: the same sweep (gamma released) keeps its verdict and writes no progress row.
  const listing = readdirSync(tree).sort();
  const quiet = run(undefined);
  assert.equal(await quiet.exited, 1, quiet.output());
  assert.match(quiet.output(), /2 passed, 1 failed, 0 not run, 3 total/);
  assert.deepEqual(readdirSync(tree).sort(), listing, 'an unset run creates no file');
  assert.deepEqual(lines(progress), rows, 'an unset run appends nothing');
}

async function main(): Promise<void> {
  try {
    await writerContract();
    await runnerReportsDomainImmediately();
    process.stdout.write('PASS gate-progress: writer contract + blackbox runner domain rows\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
