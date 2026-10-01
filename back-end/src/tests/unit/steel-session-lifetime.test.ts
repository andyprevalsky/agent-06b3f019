#!/usr/bin/env tsx
/**
 * Steel releases a session when its absolute `timeout` elapses, even with a
 * CDP client attached. Every Steel session must outlive the browser activity
 * that drives it (prod agent 3efa7cae: four browser runs lost CDP exactly 15m
 * after session start while the activity was allowed 30m).
 *
 * Run: npx tsx src/tests/unit/steel-session-lifetime.test.ts
 */

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSteelRecoveryBrowserOptions } from '../../providers/steel/sessionRecovery';
import {
  BROWSER_ACTIVITY_START_TO_CLOSE_MINUTES,
  BROWSER_DEFAULT_MAX_ITERATIONS,
  STEEL_PLAN_MAX_SESSION_MS,
  browserActivityBudgetMinutes,
  steelSessionTimeoutMs,
} from '../../providers/steel/sessionLifetime';

const repoRoot = resolve(__dirname, '../../../..');
const steelProviderDir = resolve(__dirname, '../../providers/steel');
const pythonConfigPath = join(repoRoot, 'agents/domains/spawn_browser_agent_v3/config.py');

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

function pythonIntConstant(source: string, name: string): number {
  const match = new RegExp(`^${name}\\s*=\\s*(\\d+)\\s*$`, 'm').exec(source);
  assert(match !== null, `${name} not found in ${pythonConfigPath}`);
  return Number.parseInt(match[1], 10);
}

test('backend budget constants match the Python browser activity config', () => {
  const source = readFileSync(pythonConfigPath, 'utf8');
  assert.strictEqual(
    BROWSER_ACTIVITY_START_TO_CLOSE_MINUTES,
    pythonIntConstant(source, 'ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES')
  );
  assert.strictEqual(
    BROWSER_DEFAULT_MAX_ITERATIONS,
    pythonIntConstant(source, 'DEFAULT_MAX_ITERATIONS')
  );
  assert.ok(
    source.includes('return max(ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES, int(steps * 0.35) + 15)'),
    'Python step-scaled browser budget changed; update browserActivityBudgetMinutes to match'
  );
});

test('step-scaled budgets mirror the Python formula', () => {
  assert.strictEqual(browserActivityBudgetMinutes({}), 30);
  assert.strictEqual(browserActivityBudgetMinutes({ BROWSER_MAX_ITERATIONS: '60' }), 30);
  assert.strictEqual(browserActivityBudgetMinutes({ BROWSER_MAX_ITERATIONS: '0' }), 30);
  assert.strictEqual(browserActivityBudgetMinutes({ BROWSER_MAX_ITERATIONS: 'nope' }), 30);
  assert.strictEqual(browserActivityBudgetMinutes({ BROWSER_MAX_ITERATIONS: '100' }), 50);
  assert.strictEqual(browserActivityBudgetMinutes({ BROWSER_MAX_ITERATIONS: ' 120 ' }), 57);
});

test('Steel session outlives the browser activity budget within the plan cap', () => {
  for (const steps of [undefined, '60', '80', '100']) {
    const env = steps === undefined ? {} : { BROWSER_MAX_ITERATIONS: steps };
    const budgetMs = browserActivityBudgetMinutes(env) * 60_000;
    const timeoutMs = steelSessionTimeoutMs(env);
    assert.ok(
      timeoutMs > budgetMs,
      `steps=${String(steps)}: Steel timeout ${timeoutMs}ms <= activity budget ${budgetMs}ms`
    );
    assert.ok(timeoutMs <= STEEL_PLAN_MAX_SESSION_MS, `steps=${String(steps)}: exceeds plan cap`);
  }
});

test('challenge-recovery Steel sessions use the derived lifetime', () => {
  const options = buildSteelRecoveryBrowserOptions({ proxy: true });
  assert.strictEqual(options.timeout, steelSessionTimeoutMs());
  assert.ok(options.timeout > BROWSER_ACTIVITY_START_TO_CLOSE_MINUTES * 60_000);
});

test('every Steel session create site derives its lifetime, never a literal', () => {
  // `stealthConfig` only appears in Steel session-create options; Steel's
  // default lifetime when `timeout` is omitted is 5 minutes.
  const offenders: string[] = [];
  let createSites = 0;
  for (const file of readdirSync(steelProviderDir).filter((name) => name.endsWith('.ts'))) {
    const lines = readFileSync(join(steelProviderDir, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/^\s*stealthConfig:/.test(line)) return;
      createSites += 1;
      const window = lines.slice(index, index + 12);
      const timeoutLine = window.find((candidate) => /^\s*timeout:/.test(candidate));
      const value = timeoutLine
        ?.replace(/^\s*timeout:\s*/, '')
        .replace(/,\s*$/, '')
        .trim();
      if (value !== 'steelSessionTimeoutMs()') {
        offenders.push(`${file}:${index + 1} timeout: ${value ?? '(missing)'}`);
      }
    });
  }
  assert.ok(createSites >= 3, `expected the 3 Steel create sites, found ${createSites}`);
  assert.deepStrictEqual(offenders, []);
});

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} failure(s):\n${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`\n${passed} passed\n`);
