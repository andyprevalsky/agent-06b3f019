#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Unit tests for lastFiveAttemptsPassed — the helper that drives the
 * query-box green check when the last 5 runs in history all passed.
 */

import assert from 'node:assert';
import {
  LAST_FIVE_PASS_WINDOW,
  lastFiveAttemptsPassed,
} from '../../domains/benchmarks/hubCatalogService';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

test('window size is 5', () => {
  assert.strictEqual(LAST_FIVE_PASS_WINDOW, 5);
});

test('empty history → false', () => {
  assert.strictEqual(lastFiveAttemptsPassed([]), false);
});

test('fewer than 5 passes → false even if all passed', () => {
  assert.strictEqual(lastFiveAttemptsPassed([true, true, true, true]), false);
});

test('exactly 5 all passed → true', () => {
  assert.strictEqual(lastFiveAttemptsPassed([true, true, true, true, true]), true);
});

test('exactly 5 with one fail → false', () => {
  assert.strictEqual(lastFiveAttemptsPassed([true, true, false, true, true]), false);
});

test('more than 5: only the most recent 5 matter', () => {
  // Older fails, recent 5 all pass
  assert.strictEqual(
    lastFiveAttemptsPassed([false, false, true, true, true, true, true]),
    true
  );
  // Older passes, recent 5 include a fail
  assert.strictEqual(
    lastFiveAttemptsPassed([true, true, true, true, true, false]),
    false
  );
});

test('last of the window failing → false', () => {
  assert.strictEqual(lastFiveAttemptsPassed([true, true, true, true, false]), false);
});

test('first of the window failing → false', () => {
  assert.strictEqual(lastFiveAttemptsPassed([false, true, true, true, true]), false);
});

console.log(`\nlast-five-passed: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
