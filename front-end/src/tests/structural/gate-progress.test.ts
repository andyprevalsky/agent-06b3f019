/**
 * DEPLOY_GATE_PROGRESS rows from the front-end runners (src/tests/gate-progress/).
 *
 *   writer             exact Python-protocol bytes (incl. QUARANTINED_* + quarantine, FLAKY +
 *                      attempts), mode 0600, no-op when unset, never throws; blocking = FAIL/UNVERIFIED
 *   vitest reporter    FAIL row the moment a failing test case reports; FLAKY row (+ TEST_FLAKY
 *                      line) for a pass after a retry; file PASS/FAIL rows
 *   vitest plugin      appended after the reporters Vitest resolved; config adds it only when set
 *   playwright         FAIL row only for a test's final failing attempt, "<file> > <titles>";
 *                      FLAKY row (detail = the failed attempt) for a pass on a retry
 *   retry              retry/retries 1 only behind DEPLOY_GATE_PROGRESS (local runs never retry)
 *
 * Runners are fed fake test/result objects; each writes to a private temp file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  FullConfig,
  TestCase as PlaywrightTestCase,
  TestResult as PlaywrightTestResult,
} from '@playwright/test/reporter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  failures,
  flaky,
  gateProgressRow,
  gateProgressStdoutLine,
  quarantined,
  reportGateProgress,
  serializeGateProgressRow,
} from '../gate-progress/gateProgress';
import GateProgressPlaywrightReporter from '../gate-progress/playwrightReporter';
import {
  GateProgressVitestReporter,
  gateProgressVitestPlugin,
  type VitestPluginContext,
  type VitestTestCase as TestCase,
  type VitestTestModule as TestModule,
} from '../gate-progress/vitestReporter';

const ESC = String.fromCharCode(27);
const KEYS = ['v', 'scope', 'case', 'unit', 'status', 'at', 'detail', 'log'];
const FRONTEND_DIR = path.resolve(__dirname, '../../..');

let dir = '';
let progress = '';
let env: Record<string, string> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-progress-frontend-'));
  progress = path.join(dir, 'progress.jsonl');
  env = { DEPLOY_GATE_PROGRESS: progress, DEPLOY_GATE_CASE: 'frontend-coverage' };
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

function rows(): Record<string, unknown>[] {
  if (!fs.existsSync(progress)) return [];
  return fs
    .readFileSync(progress, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const QUARANTINE = {
  since: '2026-11-08',
  repair: 'https://boxes.dev/thread/thr_0123456789abcdef0123456789abcdef',
  error: 'AssertionError: é ✓',
  evidence: '.context/x.log',
};

function vitestCase(
  fullName: string,
  state: 'passed' | 'failed' | 'skipped',
  retryCount = 0,
): TestCase {
  const errors =
    state === 'failed' || retryCount > 0
      ? [
          {
            name: 'AssertionError',
            message: 'expected 2 to be 3',
            stack: 'AssertionError: expected 2 to be 3\n    at agents.blackbox.ts:10:5',
            diff: '- 3\n+ 2',
          },
        ]
      : undefined;
  return {
    module: { relativeModuleId: 'src/tests/blackbox/agents.blackbox.ts' },
    fullName,
    result: () => ({ state, errors }),
    diagnostic: () => ({ retryCount, flaky: state === 'passed' && retryCount > 0 }),
  } as unknown as TestCase;
}

function vitestModule(ok: boolean, errors: { message: string }[], failed: TestCase[]): TestModule {
  return {
    relativeModuleId: 'src/tests/blackbox/agents.blackbox.ts',
    state: () => (ok ? 'passed' : 'failed'),
    ok: () => ok,
    errors: () => errors,
    children: {
      *allTests() {
        yield* failed;
      },
    },
  } as unknown as TestModule;
}

describe('gate progress writer', () => {
  it('appends one row with the exact protocol shape and 0600 mode', () => {
    const before = Date.now() / 1000;
    const detail = `${'x'.repeat(3000)}\nAssertionError: boom`;
    expect(reportGateProgress('src/a.test.ts > a', 'FAIL', { scope: 'test', detail }, env)).toBe(
      true,
    );
    const raw = fs.readFileSync(progress, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.indexOf('\n')).toBe(raw.length - 1);
    const row = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(KEYS);
    expect(row).toEqual({
      v: 1,
      scope: 'test',
      case: 'frontend-coverage',
      unit: 'src/a.test.ts > a',
      status: 'FAIL',
      at: row.at,
      detail: detail.slice(-2000),
      log: '',
    });
    expect(row.at as number).toBeGreaterThanOrEqual(before);
    expect(row.at as number).toBeLessThanOrEqual(Date.now() / 1000);
    expect(fs.statSync(progress).mode & 0o777).toBe(0o600);
  });

  it('serializes byte-for-byte like scripts/deploy_gate_progress.py', () => {
    // Golden output of deploy_gate_progress.row(...) + json.dumps(separators=(',', ':')).
    const python = String.raw`{"v":1,"scope":"test","case":"frontend-coverage","unit":"src/a.test.ts > suite > \u00e9 \u2713 \ud83d\ude00","status":"FAIL","at":1762540000.125,"detail":"\u00e9 \u2713 \ud83d\ude00 \u007f \u0001 \"q\" \\ tail","log":""}`;
    const row = gateProgressRow(
      'src/a.test.ts > suite > é ✓ 😀',
      'FAIL',
      { scope: 'test', detail: 'é ✓ 😀 \u007f \u0001 "q" \\ tail' },
      env,
      () => 1762540000125,
    );
    expect(serializeGateProgressRow(row)).toBe(`${python}\n`);
    const long = gateProgressRow('u', 'FAIL', { detail: '😀'.repeat(2100) }, env);
    expect(Array.from(long.detail)).toHaveLength(2000);
  });

  it('serializes quarantine and flaky rows byte-for-byte like the Python helper', () => {
    // Golden output of deploy_gate_progress.row(..., quarantine=...) / row(..., attempts=2).
    const quarantinedGolden = String.raw`{"v":1,"scope":"test","case":"frontend-coverage","unit":"src/a.test.ts > suite > \u00e9","status":"QUARANTINED_FAIL","at":1762540000.125,"detail":"boom \u2713","log":"","quarantine":{"since":"2026-11-08","repair":"https://boxes.dev/thread/thr_0123456789abcdef0123456789abcdef","error":"AssertionError: \u00e9 \u2713","evidence":".context/x.log"}}`;
    const flakyGolden = String.raw`{"v":1,"scope":"test","case":"frontend-coverage","unit":"src/a.test.ts > suite > a","status":"FLAKY","at":1762540000.125,"detail":"first","log":"","attempts":2}`;
    const at = () => 1762540000125;
    const held = gateProgressRow(
      'src/a.test.ts > suite > é',
      'QUARANTINED_FAIL',
      { scope: 'test', detail: 'boom ✓', quarantine: QUARANTINE },
      env,
      at,
    );
    const retried = gateProgressRow(
      'src/a.test.ts > suite > a',
      'FLAKY',
      { scope: 'test', detail: 'first', attempts: 2 },
      env,
      at,
    );
    expect(serializeGateProgressRow(held)).toBe(`${quarantinedGolden}\n`);
    expect(serializeGateProgressRow(retried)).toBe(`${flakyGolden}\n`);
    expect(gateProgressStdoutLine(held)).toBe(
      `TEST_QUARANTINE status=QUARANTINED_FAIL unit=src/a.test.ts > suite > é since=2026-11-08 repair=${QUARANTINE.repair}\n`,
    );
    expect(gateProgressStdoutLine(retried)).toBe(
      'TEST_FLAKY unit=src/a.test.ts > suite > a attempts=2 attribution=REQUIRED\n',
    );
    const plain = gateProgressRow('u', 'FAIL', {}, env, at);
    const unverified = gateProgressRow('u', 'UNVERIFIED', {}, env, at);
    expect(Object.keys(plain)).toEqual(KEYS);
    expect(gateProgressStdoutLine(plain)).toBe('');
    const all = [held, retried, plain, unverified];
    expect(failures(all)).toEqual([plain, unverified]);
    expect(quarantined(all)).toEqual([held]);
    expect(flaky(all)).toEqual([retried]);
    // Misplaced metadata is a programming error, as in Python's row().
    expect(() => gateProgressRow('u', 'FAIL', { quarantine: QUARANTINE }, env)).toThrow();
    expect(() => gateProgressRow('u', 'QUARANTINED_PASS', {}, env)).toThrow();
    expect(() => gateProgressRow('u', 'FLAKY', { attempts: 1 }, env)).toThrow();
    expect(() => gateProgressRow('u', 'PASS', { attempts: 2 }, env)).toThrow();
  });

  it('writes nothing when DEPLOY_GATE_PROGRESS is unset or empty', () => {
    expect(reportGateProgress('u', 'FAIL', {}, {})).toBe(false);
    expect(reportGateProgress('u', 'FAIL', {}, { DEPLOY_GATE_PROGRESS: '' })).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('swallows write errors', () => {
    for (const target of [dir, path.join(dir, 'missing', 'progress.jsonl')]) {
      expect(() =>
        reportGateProgress('u', 'FAIL', {}, { DEPLOY_GATE_PROGRESS: target }),
      ).not.toThrow();
      expect(reportGateProgress('u', 'FAIL', {}, { DEPLOY_GATE_PROGRESS: target })).toBe(false);
    }
  });
});

describe('vitest gate progress reporter', () => {
  it('appends a FAIL row as soon as a failing test case reports', () => {
    const reporter = new GateProgressVitestReporter({ env });
    reporter.onTestCaseResult(vitestCase('agents > accepts input', 'passed'));
    reporter.onTestCaseResult(vitestCase('agents > skipped', 'skipped'));
    expect(rows()).toEqual([]);
    const failing = vitestCase('agents > rejects bad input', 'failed');
    reporter.onTestCaseResult(failing);
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(Object.keys(row)).toEqual(KEYS);
    expect(row).toMatchObject({
      v: 1,
      scope: 'test',
      case: 'frontend-coverage',
      unit: 'src/tests/blackbox/agents.blackbox.ts > agents > rejects bad input',
      status: 'FAIL',
      log: '',
    });
    expect(row.detail).toContain('AssertionError: expected 2 to be 3');
    expect(row.detail).toContain('- 3\n+ 2');

    reporter.onTestModuleEnd(vitestModule(false, [], [failing]));
    expect(rows()[1]).toMatchObject({
      scope: 'file',
      unit: 'src/tests/blackbox/agents.blackbox.ts',
      status: 'FAIL',
      detail: 'failed tests: agents > rejects bad input',
    });
  });

  it('maps a pass after a retry to FLAKY with a TEST_FLAKY line', () => {
    const lines: string[] = [];
    const reporter = new GateProgressVitestReporter({ env, write: (line) => lines.push(line) });
    reporter.onTestCaseResult(vitestCase('agents > steady', 'passed'));
    expect(rows()).toEqual([]);
    reporter.onTestCaseResult(vitestCase('agents > wobbly', 'passed', 1));
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(Object.keys(row)).toEqual([...KEYS, 'attempts']);
    expect(row).toMatchObject({
      scope: 'test',
      case: 'frontend-coverage',
      unit: 'src/tests/blackbox/agents.blackbox.ts > agents > wobbly',
      status: 'FLAKY',
      attempts: 2,
    });
    expect(row.detail).toContain('AssertionError: expected 2 to be 3');
    expect(lines).toEqual([
      'TEST_FLAKY unit=src/tests/blackbox/agents.blackbox.ts > agents > wobbly attempts=2 attribution=REQUIRED\n',
    ]);
  });

  it('reports file PASS rows and collection failures', () => {
    const reporter = new GateProgressVitestReporter({ env });
    reporter.onTestModuleEnd(vitestModule(true, [], []));
    reporter.onTestModuleEnd(vitestModule(false, [{ message: 'Failed to load ./missing' }], []));
    expect(rows().map((row) => [row.scope, row.status, row.detail])).toEqual([
      ['file', 'PASS', ''],
      ['file', 'FAIL', 'Error: Failed to load ./missing'],
    ]);
  });

  it('writes nothing when unset and swallows write errors', () => {
    new GateProgressVitestReporter({ env: {} }).onTestCaseResult(vitestCase('a > b', 'failed'));
    expect(fs.readdirSync(dir)).toEqual([]);
    const broken = new GateProgressVitestReporter({ env: { DEPLOY_GATE_PROGRESS: dir } });
    expect(() => broken.onTestCaseResult(vitestCase('a > b', 'failed'))).not.toThrow();
    expect(() => broken.onTestModuleEnd(vitestModule(false, [], []))).not.toThrow();
  });

  it('plugin appends the reporter once after the resolved reporters', () => {
    const reporters: unknown[] = [
      ['default', {}],
      ['github-actions', {}],
    ];
    const context = { vitest: { config: { reporters } } } as unknown as VitestPluginContext;
    const plugin = gateProgressVitestPlugin(env);
    plugin.configureVitest(context);
    plugin.configureVitest(context);
    expect(reporters).toHaveLength(3);
    expect(reporters.slice(0, 2)).toEqual([
      ['default', {}],
      ['github-actions', {}],
    ]);
    expect(reporters[2]).toBeInstanceOf(GateProgressVitestReporter);
  });

  it('vitest.config.ts adds the plugin and one retry only when DEPLOY_GATE_PROGRESS is set', () => {
    const config = fs.readFileSync(path.join(FRONTEND_DIR, 'vitest.config.ts'), 'utf8');
    expect(config).toContain(
      '...(process.env.DEPLOY_GATE_PROGRESS ? [gateProgressVitestPlugin()] : [])',
    );
    expect(config).toContain('retry: process.env.DEPLOY_GATE_PROGRESS ? 1 : 0,');
    expect(config.match(/\bretry:/g)).toHaveLength(1);
    expect(gateProgressVitestPlugin(env).name).toBe('rose-deploy-gate-progress');
  });
});

describe('playwright gate progress reporter', () => {
  const configFile = path.join(FRONTEND_DIR, 'playwright.config.ts');
  const fileSuite = { type: 'file', title: 'login.spec.ts' };
  const outer = { type: 'describe', title: 'Login', parent: fileSuite };
  const inner = { type: 'describe', title: 'with OTP', parent: outer };

  function test(retries = 0, expectedStatus = 'passed'): PlaywrightTestCase {
    return {
      id: 'login-signs-in',
      title: 'signs in',
      parent: inner,
      location: { file: path.join(FRONTEND_DIR, 'tests-e2e/login.spec.ts'), line: 9, column: 3 },
      retries,
      expectedStatus,
    } as unknown as PlaywrightTestCase;
  }

  function result(status: string, retry = 0): PlaywrightTestResult {
    return {
      status,
      retry,
      // Playwright colors expect() messages; the row carries plain text.
      errors: [
        {
          message: `Timed out 15000ms waiting for ${ESC}[2mexpect(${ESC}[22mlocator).toBeVisible()`,
        },
      ],
    } as unknown as PlaywrightTestResult;
  }

  function reporter(reporterEnv: Record<string, string> = env, write?: (line: string) => void) {
    const instance = new GateProgressPlaywrightReporter({ env: reporterEnv, write });
    instance.onBegin({ configFile, rootDir: path.dirname(configFile) } as FullConfig);
    return instance;
  }

  it('appends a FAIL row for the final failing attempt only', () => {
    const instance = reporter();
    instance.onTestEnd(test(1), result('failed', 0));
    expect(rows()).toEqual([]);
    instance.onTestEnd(test(1), result('timedOut', 1));
    expect(rows()).toHaveLength(1);
    const [row] = rows();
    expect(Object.keys(row)).toEqual(KEYS);
    expect(row).toMatchObject({
      v: 1,
      scope: 'test',
      case: 'frontend-coverage',
      unit: 'tests-e2e/login.spec.ts > Login > with OTP > signs in',
      status: 'FAIL',
      log: '',
    });
    expect(row.detail).toBe('Timed out 15000ms waiting for expect(locator).toBeVisible()');
  });

  it('reads process.env when Playwright constructs it with its config options', () => {
    vi.stubEnv('DEPLOY_GATE_PROGRESS', progress);
    vi.stubEnv('DEPLOY_GATE_CASE', 'semantic');
    const options = { configDir: FRONTEND_DIR } as unknown as { env?: Record<string, string> };
    const instance = new GateProgressPlaywrightReporter(options);
    instance.onBegin({ configFile, rootDir: path.dirname(configFile) } as FullConfig);
    instance.onTestEnd(test(), result('failed'));
    expect(rows()).toMatchObject([{ case: 'semantic', status: 'FAIL' }]);
  });

  it('ignores passed, skipped and expected failures', () => {
    const instance = reporter();
    instance.onTestEnd(test(), result('passed'));
    instance.onTestEnd(test(), result('skipped'));
    instance.onTestEnd(test(0, 'failed'), result('failed'));
    expect(rows()).toEqual([]);
    expect(instance.printsToStdio()).toBe(false);
  });

  it('maps failed-then-passed-on-retry to FLAKY with the failed attempt as detail', () => {
    const lines: string[] = [];
    const instance = reporter(env, (line) => lines.push(line));
    instance.onTestEnd(test(1), result('failed', 0));
    expect(rows()).toEqual([]);
    instance.onTestEnd(test(1), { status: 'passed', retry: 1, errors: [] } as never);
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(Object.keys(row)).toEqual([...KEYS, 'attempts']);
    expect(row).toMatchObject({
      unit: 'tests-e2e/login.spec.ts > Login > with OTP > signs in',
      status: 'FLAKY',
      attempts: 2,
      detail: 'Timed out 15000ms waiting for expect(locator).toBeVisible()',
    });
    expect(lines).toEqual([
      'TEST_FLAKY unit=tests-e2e/login.spec.ts > Login > with OTP > signs in attempts=2 attribution=REQUIRED\n',
    ]);
  });

  it('writes nothing when unset and swallows write errors', () => {
    reporter({}).onTestEnd(test(), result('failed'));
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(() =>
      reporter({ DEPLOY_GATE_PROGRESS: dir }).onTestEnd(test(), result('failed')),
    ).not.toThrow();
  });

  it('is wired into the config and the semantic runner only behind DEPLOY_GATE_PROGRESS', () => {
    const reporterPath = './src/tests/gate-progress/playwrightReporter.ts';
    expect(fs.existsSync(path.join(FRONTEND_DIR, reporterPath))).toBe(true);
    const config = fs.readFileSync(configFile, 'utf8');
    expect(config).toContain('process.env.DEPLOY_GATE_PROGRESS');
    expect(config).toContain(`'${reporterPath}'`);
    expect(config).toContain('retries: process.env.DEPLOY_GATE_PROGRESS ? 1 : 0,');
    expect(config.match(/\bretries:/g)).toHaveLength(1);
    const runner = fs.readFileSync(
      path.join(FRONTEND_DIR, 'scripts/run-semantic-tests.sh'),
      'utf8',
    );
    expect(runner).toContain('if [[ -n "${DEPLOY_GATE_PROGRESS:-}" ]]; then');
    expect(runner).toContain(`SEMANTIC_REPORTERS="list,${reporterPath}"`);
    expect(runner.match(/--reporter="\$SEMANTIC_REPORTERS"/g)).toHaveLength(2);
    expect(runner).not.toContain('--reporter=list ');
  });
});
