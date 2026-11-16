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
 * 4. Quarantine/flaky rows (QUARANTINED_FAIL/QUARANTINED_PASS + trailing `quarantine`, FLAKY +
 *    trailing `attempts`) are byte-identical to Python too; failures() counts FAIL/UNVERIFIED only.
 * 5. run.ts reruns a failed domain exactly once in a deploy gate: fail-then-pass is FLAKY (row,
 *    TEST_FLAKY line, exit 0), fail-twice is FAIL (exit 1), and no domain ever runs a third time.
 *    Without a progress file (local dev) nothing is rerun. A quarantined failing case leaves its
 *    domain green and writes its own `domain::case` QUARANTINED_FAIL row.
 * 6. Every failed domain attempt ends with the runner's exit line (code, signal, duration, and
 *    "with no output" when the process printed nothing, as a native SIGSEGV does).
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
  failures,
  flaky,
  gateProgressRow,
  gateProgressStdoutLine,
  quarantined,
  reportGateProgress,
  serializeGateProgressRow,
  type GateProgressRow,
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

const QUARANTINE = {
  since: '2026-11-08',
  repair: 'https://boxes.dev/thread/thr_0123456789abcdef0123456789abcdef',
  error: 'AssertionError: expected 2 got 3 ✓',
  evidence: '.context/test-runs/backend-coverage/beta.log',
};

/** The same row built by scripts/deploy_gate_progress.py, as its compact JSON line. */
function pythonRow(row: GateProgressRow): string {
  const python = spawnSync(
    'python3',
    [
      '-c',
      [
        'import json, sys',
        `sys.path.insert(0, ${JSON.stringify(repoScripts)})`,
        'import deploy_gate_progress as p',
        'a = json.loads(sys.stdin.read())',
        'extra = {k: a[k] for k in ("quarantine", "attempts") if k in a}',
        "r = p.row(a['unit'], a['status'], scope=a['scope'], detail=a['detail'], log=a['log'], case=a['case'], at=a['at'], **extra)",
        "sys.stdout.write(json.dumps(r, separators=(',', ':')) + '\\n')",
      ].join('\n'),
    ],
    { input: JSON.stringify(row), encoding: 'utf8' }
  );
  assert.equal(python.status, 0, python.stderr);
  return python.stdout;
}

/** deploy_gate_progress.stdout_line(row) plus its newline, or '' when it returns None. */
function pythonStdoutLine(row: GateProgressRow): string {
  const python = spawnSync(
    'python3',
    [
      '-c',
      [
        'import json, sys',
        `sys.path.insert(0, ${JSON.stringify(repoScripts)})`,
        'import deploy_gate_progress as p',
        'line = p.stdout_line(json.loads(sys.stdin.read()))',
        "sys.stdout.write('' if line is None else line + '\\n')",
      ].join('\n'),
    ],
    { input: JSON.stringify(row), encoding: 'utf8' }
  );
  assert.equal(python.status, 0, python.stderr);
  return python.stdout;
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

  // Quarantine and flaky rows: the new keys trail `log`, only on their own statuses.
  const keys = ['v', 'scope', 'case', 'unit', 'status', 'at', 'detail', 'log'];
  const at = () => 1762540000123.25;
  const caseEnv = { DEPLOY_GATE_CASE: 'case ✓' };
  const qFail = gateProgressRow(
    'beta::case é',
    'QUARANTINED_FAIL',
    { detail: unicode, quarantine: QUARANTINE },
    caseEnv,
    at
  );
  const qPass = gateProgressRow(
    'beta::case',
    'QUARANTINED_PASS',
    { quarantine: QUARANTINE },
    caseEnv,
    at
  );
  const flakyRow = gateProgressRow(
    'beta',
    'FLAKY',
    { scope: 'domain', detail: 'boom', attempts: 2 },
    caseEnv,
    at
  );
  const flakyDefault = gateProgressRow('beta', 'FLAKY', { scope: 'domain' }, caseEnv, at);
  const plainFail = gateProgressRow('beta', 'FAIL', { detail: 'boom' }, caseEnv, at);
  const reordered = Object.fromEntries(Object.entries(QUARANTINE).reverse()) as typeof QUARANTINE;
  const qReordered = gateProgressRow(
    'beta::case',
    'QUARANTINED_PASS',
    { quarantine: reordered },
    caseEnv,
    at
  );
  assert.equal(serializeGateProgressRow(qReordered), serializeGateProgressRow(qPass));
  assert.deepEqual(Object.keys(qFail), [...keys, 'quarantine']);
  assert.deepEqual(Object.keys(qFail.quarantine ?? {}), ['since', 'repair', 'error', 'evidence']);
  assert.deepEqual(Object.keys(qPass), [...keys, 'quarantine']);
  assert.deepEqual(Object.keys(flakyRow), [...keys, 'attempts']);
  assert.equal(flakyRow.attempts, 2);
  assert.deepEqual(Object.keys(flakyDefault), keys, 'attempts is optional');
  assert.deepEqual(Object.keys(plainFail), keys, 'PASS/FAIL rows never carry the new keys');
  for (const extended of [qFail, qPass, flakyRow, flakyDefault, plainFail]) {
    assert.equal(serializeGateProgressRow(extended), pythonRow(extended));
    assert.equal(gateProgressStdoutLine(extended), pythonStdoutLine(extended));
  }
  // Misplaced metadata is a programming error on both sides (Python row() raises too).
  const misuse: Array<[GateProgressRow['status'], Record<string, unknown>]> = [
    ['FAIL', { quarantine: QUARANTINE }],
    ['QUARANTINED_FAIL', {}],
    ['QUARANTINED_PASS', { quarantine: { ...QUARANTINE, repair: '' } }],
    ['QUARANTINED_PASS', { quarantine: { ...QUARANTINE, extra: 'x' } }],
    ['FLAKY', { attempts: true }],
    ['PASS', { attempts: 2 }],
    ['FLAKY', { attempts: 1 }],
    ['FLAKY', { attempts: 2.5 }],
  ];
  for (const [status, options] of misuse) {
    assert.throws(() => gateProgressRow('beta', status, options, caseEnv, at), status);
  }
  assert.equal(
    gateProgressStdoutLine(qFail),
    `TEST_QUARANTINE status=QUARANTINED_FAIL unit=beta::case é since=2026-11-08 repair=${QUARANTINE.repair}\n`
  );
  assert.equal(
    gateProgressStdoutLine(flakyRow),
    'TEST_FLAKY unit=beta attempts=2 attribution=REQUIRED\n'
  );
  assert.equal(gateProgressStdoutLine(plainFail), '');
  const unverified = gateProgressRow('x', 'UNVERIFIED', {}, caseEnv, at);
  const all = [qFail, qPass, flakyRow, plainFail, unverified];
  assert.deepEqual(failures(all), [plainFail, unverified]);
  assert.deepEqual(quarantined(all), [qFail, qPass]);
  assert.deepEqual(flaky(all), [flakyRow]);

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

async function runnerRerunsFailedDomainOnce(): Promise<void> {
  const tree = join(root, 'runner-rerun');
  const blackbox = join(tree, 'src', 'tests', 'blackbox');
  const helpers = join(tree, 'src', 'tests', 'helpers');
  mkdirSync(blackbox, { recursive: true });
  mkdirSync(helpers, { recursive: true });
  copyFileSync(join(backendDir, 'src/tests/blackbox/run.ts'), join(blackbox, 'run.ts'));
  for (const helper of ['gateProgress.ts', 'quarantine.ts']) {
    copyFileSync(join(backendDir, 'src/tests/helpers', helper), join(helpers, helper));
  }
  symlinkSync(dirname(dirname(require.resolve('tsx/package.json'))), join(tree, 'node_modules'));
  const counts = join(tree, 'counts');
  mkdirSync(counts);
  // Every domain appends one byte per execution, so the test can count runs exactly.
  const counted = (body: string) => `import { appendFileSync, readFileSync } from 'node:fs';
const counter = ${JSON.stringify(counts)} + '/' + process.env.BLACKBOX_TEST_DOMAIN;
appendFileSync(counter, 'x');
const run = readFileSync(counter, 'utf8').length;
${body}
`;
  writeFileSync(join(blackbox, 'steady.blackbox.ts'), counted("process.stdout.write('ok\\n');"));
  writeFileSync(
    join(blackbox, 'wobbly.blackbox.ts'),
    counted(
      // Attempt 1 names its failed case early, then prints far more than a progress row holds.
      "if (run === 1) { process.stderr.write('FAIL wobbly race: first attempt lost the race\\n'); process.stdout.write('PASS later case\\n'.repeat(8000)); process.exitCode = 1; }"
    )
  );
  // A native crash prints nothing: the first attempt dies by signal, the rerun passes.
  writeFileSync(
    join(blackbox, 'silent.blackbox.ts'),
    counted("if (run === 1) process.kill(process.pid, 'SIGKILL');")
  );
  writeFileSync(
    join(blackbox, 'broken.blackbox.ts'),
    counted('process.stderr.write(`AssertionError: broken run ${run}\\n`);\nprocess.exitCode = 1;')
  );
  writeFileSync(
    join(blackbox, 'held.blackbox.ts'),
    `import { quarantine } from '../helpers/quarantine';
${counted('')}
const meta = ${JSON.stringify(QUARANTINE)};
const cases = [
  { name: 'known bad', fn: quarantine(meta, async () => { throw new Error('still broken'); }, { unit: 'known bad' }) },
  { name: 'healthy', fn: async () => undefined },
];
void (async () => {
  for (const c of cases) await c.fn();
  process.stdout.write('held cases done\\n');
})();
`
  );

  const run = (domains: string, extra: Record<string, string>) => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(blackbox, 'run.ts'), domains],
      {
        cwd: tree,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? tree,
          TMPDIR: tmpdir(),
          BLACKBOX_TEST_CONCURRENCY: '4',
          DEPLOY_GATE_CASE: 'blackbox-shard-3',
          ...extra,
        },
        timeout: 120_000,
      }
    );
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const runs = (domain: string) =>
    existsSync(join(counts, domain)) ? readFileSync(join(counts, domain), 'utf8').length : 0;
  const reset = () => {
    for (const name of readdirSync(counts)) rmSync(join(counts, name));
  };

  // Deploy gate (progress file named): fail-then-pass is FLAKY and the sweep exits 0.
  const flakyProgress = join(tree, 'flaky.jsonl');
  const green = run('steady,wobbly,held', { DEPLOY_GATE_PROGRESS: flakyProgress });
  assert.equal(green.code, 0, green.output);
  assert.deepEqual([runs('steady'), runs('wobbly'), runs('held')], [1, 2, 1], green.output);
  const greenRows = lines(flakyProgress);
  const domainRows = greenRows.filter((row) => row.scope === 'domain');
  assert.deepEqual(domainRows.map((row) => `${row.unit}:${row.status}`).sort(), [
    'held:PASS',
    'steady:PASS',
    'wobbly:FLAKY',
  ]);
  const wobbly = domainRows.find((row) => row.unit === 'wobbly') as Record<string, unknown>;
  assert.deepEqual(Object.keys(wobbly), [
    'v',
    'scope',
    'case',
    'unit',
    'status',
    'at',
    'detail',
    'log',
    'attempts',
  ]);
  assert.equal(wobbly.attempts, 2);
  assert.equal(wobbly.case, 'blackbox-shard-3');
  assert.match(
    String(wobbly.detail),
    /\n\[runner\] 1 failure line\(s\) in this attempt:\nFAIL wobbly race: first attempt lost the race$/,
    'FLAKY detail keeps attempt 1 FAIL lines past its 2000-code-point tail'
  );
  assert.ok(String(wobbly.detail).length <= 2000);
  assert.match(
    green.output,
    /^wobbly: \[runner\] 1 failure line\(s\) in this attempt:\nFAIL wobbly race: first attempt lost the race$/m,
    'runner log names the flaky attempt FAIL lines'
  );
  assert.match(green.output, /^TEST_FLAKY unit=wobbly attempts=2 attribution=REQUIRED$/m);
  assert.match(green.output, /^ {2}FLAKY {2}wobbly \(/m);
  assert.match(green.output, /3 passed, 0 failed, 0 not run, 3 total/);
  assert.match(
    green.output,
    /1 flaky \(failed, then passed the single rerun; \/RCA attribution required\): wobbly/
  );

  // The quarantined case failed, but its domain stayed green and its own row says so.
  const held = greenRows.filter((row) => row.scope === 'test');
  assert.equal(held.length, 1, JSON.stringify(greenRows));
  assert.equal(held[0].unit, 'held::known bad');
  assert.equal(held[0].status, 'QUARANTINED_FAIL');
  assert.equal(held[0].case, 'blackbox-shard-3');
  assert.deepEqual(held[0].quarantine, QUARANTINE);
  assert.match(String(held[0].detail), /still broken/);
  assert.match(green.output, /Quarantined cases \(non-blocking\): 1/);
  assert.ok(
    green.output.includes(
      `  TEST_QUARANTINE status=QUARANTINED_FAIL unit=held::known bad since=2026-11-08 repair=${QUARANTINE.repair}`
    ),
    green.output
  );

  // Fail twice: a normal FAIL row from attempt 2, exit 1, and never a third run.
  reset();
  const failProgress = join(tree, 'fail.jsonl');
  const red = run('steady,broken', { DEPLOY_GATE_PROGRESS: failProgress });
  assert.equal(red.code, 1, red.output);
  assert.deepEqual([runs('steady'), runs('broken')], [1, 2], red.output);
  const brokenRows = lines(failProgress).filter((row) => row.unit === 'broken');
  assert.equal(brokenRows.length, 1, 'one final row per domain');
  assert.equal(brokenRows[0].status, 'FAIL');
  assert.deepEqual(Object.keys(brokenRows[0]), [
    'v',
    'scope',
    'case',
    'unit',
    'status',
    'at',
    'detail',
    'log',
  ]);
  assert.match(String(brokenRows[0].detail), /AssertionError: broken run 2/);
  assert.doesNotMatch(String(brokenRows[0].detail), /broken run 1/);
  assert.match(
    red.output,
    /=== attempt 1 \(FAIL\) ===[\s\S]*broken run 1[\s\S]*=== attempt 2 \(FAIL\) ===[\s\S]*broken run 2/
  );
  assert.doesNotMatch(red.output, /TEST_FLAKY/);
  assert.match(red.output, /1 passed, 1 failed, 0 not run, 2 total/);

  // Local dev (no progress file): unchanged, a failure is never rerun.
  reset();
  const local = run('wobbly', {});
  assert.equal(local.code, 1, local.output);
  assert.equal(runs('wobbly'), 1);
  assert.doesNotMatch(local.output, /RERUN|TEST_FLAKY/);
  // The explicit switch turns it on without a progress file, and off inside a gate.
  reset();
  assert.equal(run('wobbly', { BLACKBOX_TEST_RERUN_FAILED: '1' }).code, 0);
  assert.equal(runs('wobbly'), 2);
  reset();
  const off = run('wobbly', {
    BLACKBOX_TEST_RERUN_FAILED: '0',
    DEPLOY_GATE_PROGRESS: join(tree, 'off.jsonl'),
  });
  assert.equal(off.code, 1, off.output);
  assert.equal(runs('wobbly'), 1);
  assert.equal(run('wobbly', { BLACKBOX_TEST_RERUN_FAILED: 'yes' }).code, 1);

  // Every failed attempt names its exit: code and signal, plus "with no output" when silent.
  reset();
  const silentProgress = join(tree, 'silent.jsonl');
  const crashed = run('silent', { DEPLOY_GATE_PROGRESS: silentProgress });
  assert.equal(crashed.code, 0, crashed.output);
  assert.equal(runs('silent'), 2);
  const [silentRow] = lines(silentProgress).filter((row) => row.unit === 'silent');
  assert.equal(silentRow.status, 'FLAKY');
  assert.match(
    String(silentRow.detail),
    /^\n\[runner\] domain process exited code=null signal=SIGKILL after \d+ms with no output$/
  );
  assert.match(
    String(wobbly.detail),
    /PASS later case\n+\[runner\] domain process exited code=1 signal=none after \d+ms\n\[runner\] 1 failure line/
  );
}

async function main(): Promise<void> {
  try {
    await writerContract();
    await runnerReportsDomainImmediately();
    await runnerRerunsFailedDomainOnce();
    process.stdout.write(
      'PASS gate-progress: writer contract + quarantine/flaky rows + blackbox runner domain rows + rerun once\n'
    );
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
