#!/usr/bin/env tsx
/**
 * The backend in-definition quarantine marker (src/tests/helpers/quarantine.ts).
 *
 * 1. Refusal: a marker with missing/invalid since, repair, error or evidence (or an unknown key)
 *    throws when it is DEFINED, before any test body runs.
 * 2. A quarantined failure is reported, not thrown: QUARANTINED_FAIL row (with the marker's
 *    metadata) + one TEST_QUARANTINE stdout line; a pass writes QUARANTINED_PASS the same way.
 * 3. Unit id: { unit } option, else the node:test context name, else the function name; prefixed
 *    `<domain>::` inside a blackbox domain. An anonymous function with no unit is refused.
 * 4. A real node:test file with a failing quarantined test exits 0 and reports its row.
 *
 * No database. Run: npx tsx src/tests/unit/test-quarantine.test.ts (via scripts/run-unit-tests.ts)
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { quarantine, QuarantineMetadataError, validateQuarantineMeta } from '../helpers/quarantine';

const META = {
  since: '2026-11-08',
  repair: 'https://boxes.dev/thread/thr_0123456789abcdef0123456789abcdef',
  error: 'AssertionError: expected 2 got 3',
  evidence: '.context/test-runs/backend-coverage/blackbox-run-shard1/agents.log',
};
const root = mkdtempSync(join(tmpdir(), 'test-quarantine-backend-'));
const helper = resolve(__dirname, '../helpers/quarantine.ts');

function rows(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function refusals(): void {
  const invalid: Array<[unknown, RegExp]> = [
    [{ ...META, repair: undefined }, /repair is required/],
    [{ ...META, repair: '   ' }, /repair is required/],
    [{ ...META, since: '' }, /since is required/],
    [{ ...META, error: undefined, evidence: undefined }, /error is required; evidence is required/],
    [{ ...META, since: '2026-02-30' }, /since must be a YYYY-MM-DD date/],
    [{ ...META, since: '11/08/2026' }, /since must be a YYYY-MM-DD date/],
    [{ ...META, repair: 'https://github.com/Rose-Ai-Labs/rose/pull/1' }, /boxes\.dev thread URL/],
    [{ ...META, repair: 'https://boxes.dev/thread/thr_x?evil=1' }, /boxes\.dev thread URL/],
    [{ ...META, repair: 'pending-handoff:not-hex' }, /boxes\.dev thread URL/],
    [{ ...META, error: 'first line\nsecond line' }, /error must be one line/],
    [{ ...META, evidence: 'a.log\nb.log' }, /evidence must be one line/],
    [{ ...META, owner: 'me' }, /unknown key\(s\): owner/],
    [null, /metadata must be an object/],
  ];
  for (const [meta, message] of invalid) {
    let bodyRan = false;
    assert.throws(
      () =>
        quarantine(meta as typeof META, () => {
          bodyRan = true;
        }),
      (error: unknown) => error instanceof QuarantineMetadataError && message.test(error.message),
      JSON.stringify(meta)
    );
    assert.equal(bodyRan, false, 'a refused marker never runs its test');
  }
  assert.deepEqual(validateQuarantineMeta({ ...META }), META);
  // Before merge a marker names its FLAKY occurrence; the repair is dispatched after merge.
  const pending = { ...META, repair: `pending-handoff:${'a'.repeat(32)}` };
  assert.deepEqual(validateQuarantineMeta(pending), pending);
  // Same trimming as scripts/lib/test_quarantine.py: rows match whichever runner wrote them.
  assert.deepEqual(validateQuarantineMeta({ ...META, error: ` ${META.error} ` }), META);
}

async function rowsAndLines(): Promise<void> {
  const progress = join(root, 'progress.jsonl');
  const env = { DEPLOY_GATE_PROGRESS: progress, DEPLOY_GATE_CASE: 'backend-unit' };
  const lines: string[] = [];
  const write = (line: string) => lines.push(line);
  const errors: string[] = [];
  const writeError = (text: string) => errors.push(text);

  let ran = 0;
  const failing = quarantine(
    META,
    async () => {
      ran += 1;
      throw new Error('expected 2 got 3');
    },
    { unit: 'agents::known bad', env, write, writeError }
  );
  await assert.doesNotReject(failing(), 'a quarantined failure never throws');
  const passing = quarantine(
    META,
    () => {
      ran += 1;
    },
    { unit: 'agents::recovered', env, write, writeError }
  );
  await passing();
  assert.equal(ran, 2, 'quarantined tests still run');

  const [fail, pass] = rows(progress);
  const keys = ['v', 'scope', 'case', 'unit', 'status', 'at', 'detail', 'log', 'quarantine'];
  assert.deepEqual(Object.keys(fail), keys);
  assert.deepEqual(fail, {
    ...fail,
    v: 1,
    scope: 'test',
    case: 'backend-unit',
    unit: 'agents::known bad',
    status: 'QUARANTINED_FAIL',
    log: '',
    quarantine: META,
  });
  assert.match(String(fail.detail), /^Error: expected 2 got 3\n\s+at /);
  assert.equal(errors.length, 1, 'only the failure prints its detail');
  assert.match(
    errors[0],
    /^quarantined test failed \(non-blocking\): agents::known bad\nError: expected 2 got 3/
  );
  assert.deepEqual(Object.keys(pass), keys);
  assert.equal(pass.status, 'QUARANTINED_PASS');
  assert.equal(pass.detail, '');
  assert.deepEqual(pass.quarantine, META);
  assert.deepEqual(lines, [
    `TEST_QUARANTINE status=QUARANTINED_FAIL unit=agents::known bad since=2026-11-08 repair=${META.repair}\n`,
    `TEST_QUARANTINE status=QUARANTINED_PASS unit=agents::recovered since=2026-11-08 repair=${META.repair}\n`,
  ]);

  // Without a progress file the stdout line is still printed; nothing is written.
  const quiet: string[] = [];
  const unset = quarantine(
    META,
    () => {
      throw new Error('x');
    },
    {
      unit: 'u',
      env: {},
      write: (line) => quiet.push(line),
      writeError: () => undefined,
    }
  );
  await unset();
  assert.deepEqual(quiet, [
    `TEST_QUARANTINE status=QUARANTINED_FAIL unit=u since=2026-11-08 repair=${META.repair}\n`,
  ]);
  // A broken progress target or stdout never turns the report into a failure.
  const broken = quarantine(META, () => undefined, {
    unit: 'u',
    env: { DEPLOY_GATE_PROGRESS: root },
    write: () => {
      throw new Error('EPIPE');
    },
    writeError: () => {
      throw new Error('EPIPE');
    },
  });
  await assert.doesNotReject(broken());
  const brokenFail = quarantine(
    META,
    () => {
      throw new Error('x');
    },
    {
      unit: 'u',
      env: { DEPLOY_GATE_PROGRESS: root },
      write: () => {
        throw new Error('EPIPE');
      },
      writeError: () => {
        throw new Error('EPIPE');
      },
    }
  );
  await assert.doesNotReject(brokenFail());
}

async function unitNames(): Promise<void> {
  const seen: string[] = [];
  const write = (line: string) => seen.push(/unit=(.*) since=/.exec(line)?.[1] ?? '');
  const domainEnv = { BLACKBOX_TEST_DOMAIN: 'auth' };
  async function testNamedCase(): Promise<void> {}
  await quarantine(META, testNamedCase, { env: {}, write })();
  await quarantine(META, testNamedCase, { env: domainEnv, write })();
  await quarantine(META, async () => undefined, { unit: 'explicit case', env: domainEnv, write })();
  await quarantine(META, async () => undefined, { unit: 'auth::already', env: domainEnv, write })();
  await quarantine(META, async (_t: { name: string }) => undefined, { env: {}, write })({
    name: 'node test name',
  });
  assert.deepEqual(seen, [
    'testNamedCase',
    'auth::testNamedCase',
    'auth::explicit case',
    'auth::already',
    'node test name',
  ]);
  await assert.rejects(
    quarantine(META, async () => undefined, { env: {}, write })(),
    /unit is required/
  );
}

function realNodeTest(): void {
  const file = join(root, 'held.test.ts');
  const progress = join(root, 'node-test.jsonl');
  writeFileSync(
    file,
    `import test from 'node:test';
import { quarantine } from ${JSON.stringify(helper)};
const meta = ${JSON.stringify(META)};
test('quarantined and still broken', quarantine(meta, async () => {
  throw new Error('still broken');
}));
test('ordinary test', () => undefined);
`
  );
  const run = spawnSync(process.execPath, ['--import', 'tsx', file], {
    cwd: resolve(__dirname, '../../..'),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? root,
      TMPDIR: tmpdir(),
      DEPLOY_GATE_PROGRESS: progress,
      DEPLOY_GATE_CASE: 'backend-unit',
    },
    timeout: 60_000,
  });
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, output);
  assert.match(
    output,
    /^TEST_QUARANTINE status=QUARANTINED_FAIL unit=quarantined and still broken since=2026-11-08 repair=https:\/\/boxes\.dev\/thread\/thr_0123456789abcdef0123456789abcdef$/m
  );
  const [row] = rows(progress);
  assert.equal(rows(progress).length, 1);
  assert.equal(row.unit, 'quarantined and still broken');
  assert.equal(row.status, 'QUARANTINED_FAIL');
  assert.match(String(row.detail), /still broken/);
}

async function main(): Promise<void> {
  try {
    refusals();
    await rowsAndLines();
    await unitNames();
    realNodeTest();
    process.stdout.write(
      'PASS test-quarantine: refusal, rows, stdout lines, unit ids, node:test\n'
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
