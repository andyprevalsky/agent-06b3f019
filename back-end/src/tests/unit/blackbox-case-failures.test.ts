/** No database or provider calls: exercise guarded aggregate quarantine through real case execution. */
import assert, { AssertionError } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  BlackboxCaseFailures,
  BlackboxCaseResults,
  onlyKnownCaseAssertions,
} from '../helpers/blackboxCaseFailures';
import { quarantine } from '../helpers/quarantine';

const META = {
  since: '2026-11-16',
  repair: `pending-handoff:${'a'.repeat(32)}`,
  error: 'RERUN: synthetic domain failed; rerunning once',
  evidence: 'synthetic assertion fixture',
};
const DIFFERENCE = [{ fixture: 'positive', expected: 'confirmed', actual: 'unknown' }];
const mismatch = (actual: unknown = DIFFERENCE, expected: unknown = []) =>
  new AssertionError({
    actual,
    expected,
    operator: 'deepStrictEqual',
    message: 'fixture mismatch',
  });

interface Scenario {
  knownError?: unknown;
  otherError?: unknown;
  contractError?: unknown;
  setupError?: unknown;
  cleanupError?: unknown;
  alias?: boolean;
  rename?: boolean;
}

async function exercise(scenario: Scenario) {
  const calls: string[] = [],
    lines: string[] = [];
  const results = new BlackboxCaseResults(() => undefined);
  const known = async () => {
    calls.push('known');
    if (scenario.knownError) throw scenario.knownError;
  };
  const alias = async () => {
    await known();
  };
  const other = async () => {
    calls.push('other');
    if (scenario.otherError) throw scenario.otherError;
  };
  const cleanup = async () => {
    calls.push('cleanup');
    if (scenario.cleanupError) throw scenario.cleanupError;
  };
  const body = async () => {
    try {
      if (scenario.setupError) throw scenario.setupError;
      await results.run(
        scenario.rename ? 'renamed' : 'known',
        scenario.alias ? alias : known,
        scenario.alias ? alias : known,
        () => {
          calls.push('contract');
          if (scenario.contractError) throw scenario.contractError;
        }
      );
      await results.run('other', other, other);
    } finally {
      await cleanup();
    }
    results.throwFailures();
  };
  let thrown: unknown;
  try {
    await quarantine(META, body, {
      unit: 'synthetic-domain',
      env: {},
      write: (line) => lines.push(line),
      writeError: () => undefined,
      acceptsError: (error) =>
        onlyKnownCaseAssertions(error, [
          {
            name: 'known',
            action: known,
            operator: 'deepStrictEqual',
            actual: DIFFERENCE,
            expected: [],
          },
        ]),
    })();
  } catch (error) {
    thrown = error;
  }
  return { calls, lines, results, thrown };
}

test('the known assertion runs every callback and cleanup, reports actual counts and QUARANTINED_FAIL', async () => {
  const run = await exercise({ knownError: mismatch() });
  assert.equal(run.thrown, undefined);
  assert.deepEqual(run.calls, ['known', 'contract', 'other', 'cleanup']);
  assert.equal(run.results.passed, 1);
  assert.equal(run.results.failed, 1);
  assert.equal(run.lines.length, 1);
  assert.match(run.lines[0], /status=QUARANTINED_FAIL/);
});

test('all passing callbacks produce QUARANTINED_PASS with unchanged counts', async () => {
  const run = await exercise({});
  assert.equal(run.thrown, undefined);
  assert.equal(run.results.passed, 2);
  assert.equal(run.results.failed, 0);
  assert.deepEqual(run.calls, ['known', 'contract', 'other', 'cleanup']);
  assert.equal(run.lines.length, 1);
  assert.match(run.lines[0], /status=QUARANTINED_PASS/);
});

const rejectedScenarios: Record<string, Scenario> = {
  unrelated: { otherError: mismatch() },
  mixed: { knownError: mismatch(), otherError: new Error('new failure') },
  changedPositive: { knownError: mismatch([{ fixture: 'another positive' }]) },
  changedNegative: { knownError: mismatch(DIFFERENCE, ['different expected value']) },
  callbackAlias: { knownError: mismatch(), alias: true },
  renamedCase: { knownError: mismatch(), rename: true },
  providerContract: { knownError: mismatch(), contractError: new Error('provider contract') },
  setup: { setupError: new Error('setup') },
  cleanup: { knownError: mismatch(), cleanupError: new Error('cleanup') },
  malformedAssertion: {
    knownError: { actual: DIFFERENCE, expected: [], operator: 'deepStrictEqual' },
  },
  changedOperator: {
    knownError: new AssertionError({ actual: DIFFERENCE, expected: [], operator: 'strictEqual' }),
  },
};
for (const [name, scenario] of Object.entries(rejectedScenarios)) {
  test(`${name} stays blocking without a quarantine outcome`, async () => {
    const run = await exercise(scenario);
    assert.notEqual(run.thrown, undefined);
    assert.deepEqual(run.lines, []);
    assert.equal(run.calls.filter((call) => call === 'cleanup').length, 1);
    if (!scenario.setupError) assert.equal(run.calls.filter((call) => call === 'other').length, 1);
  });
}

test('a provider violation is retained even when the action already failed', async () => {
  const run = await exercise({
    knownError: mismatch(),
    contractError: new Error('wire violation'),
  });
  assert.ok(run.thrown instanceof BlackboxCaseFailures);
  assert.deepEqual(
    run.thrown.failures.map((failure) => failure.stage),
    ['action', 'contract']
  );
  assert.equal(run.results.failed, 1, 'two errors in one callback remain one failed case');
});

test('malformed or empty aggregates cannot qualify', () => {
  assert.equal(onlyKnownCaseAssertions(new Error('not an aggregate'), []), false);
  assert.equal(onlyKnownCaseAssertions(new BlackboxCaseFailures([]), []), false);
});

test('an asynchronous contract rejection is retained and blocks suppression', async () => {
  const results = new BlackboxCaseResults(() => undefined);
  const action = async () => {
    throw mismatch();
  };
  await results.run('known', action, action, async () => {
    await Promise.resolve();
    throw new Error('asynchronous provider contract');
  });
  assert.throws(
    () => results.throwFailures(),
    (error: unknown) =>
      error instanceof BlackboxCaseFailures &&
      error.failures.length === 2 &&
      !onlyKnownCaseAssertions(error, [
        {
          name: 'known',
          action,
          operator: 'deepStrictEqual',
          actual: DIFFERENCE,
          expected: [],
        },
      ])
  );
});

test('an unknown failure exits a real domain process nonzero after later cases and cleanup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'guarded-domain-'));
  try {
    const helper = resolve(__dirname, '../helpers/blackboxCaseFailures.ts');
    const marker = resolve(__dirname, '../helpers/quarantine.ts');
    const file = join(directory, 'domain.ts');
    writeFileSync(
      file,
      `import {AssertionError} from 'node:assert';
import {BlackboxCaseResults,onlyKnownCaseAssertions} from ${JSON.stringify(helper)};
import {quarantine} from ${JSON.stringify(marker)};
const results=new BlackboxCaseResults((ok,name)=>console.log(ok?'PASS':'FAIL',name));
const isKnown=process.argv[2]==='known';
async function known(){if(isKnown)throw new AssertionError({actual:['known difference'],expected:[],operator:'deepStrictEqual'});};
async function other(){if(!isKnown)throw Error('unrelated callback');}; async function later(){};
quarantine(${JSON.stringify(META)},async()=>{try{await results.run('known',known,known);await results.run('other',other,other);await results.run('later',later,later);}finally{console.log('CLEANUP');}results.throwFailures();},{unit:'another-domain',env:{},acceptsError:error=>onlyKnownCaseAssertions(error,[{name:'known',action:known,operator:'deepStrictEqual',actual:['known difference'],expected:[]}])})().catch(error=>{console.error(error.message);process.exitCode=1;});`
    );
    const options = {
      cwd: resolve(__dirname, '../../..'),
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? directory },
    } as const;
    const run = spawnSync(process.execPath, ['--import', 'tsx', file], options);
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /PASS later/);
    assert.match(run.stdout, /CLEANUP/);
    assert.doesNotMatch(run.stdout, /TEST_QUARANTINE/);
    assert.match(run.stderr, /unrelated callback/);
    const known = spawnSync(process.execPath, ['--import', 'tsx', file, 'known'], options);
    assert.equal(known.status, 0, `${known.stdout}${known.stderr}`);
    assert.match(known.stdout, /PASS other/);
    assert.match(known.stdout, /PASS later/);
    assert.match(known.stdout, /CLEANUP/);
    assert.match(known.stdout, /TEST_QUARANTINE status=QUARANTINED_FAIL/);
    assert.doesNotMatch(known.stdout, /QUARANTINED_PASS/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
