#!/usr/bin/env tsx
/**
 * Unit tests for lastFiveAttemptsPassed — the helper that drives the
 * query-box green check when the last 5 runs in history all passed.
 */

import assert from 'node:assert';
import {
  LAST_FIVE_PASS_WINDOW,
  compareAttemptTimestamps,
  lastFiveAttemptsPassed,
  mergeAttemptSamples,
  type AttemptSample,
} from '../../domains/benchmarks/hubCatalogService';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`  ❌ ${name}\n`);
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
  assert.strictEqual(lastFiveAttemptsPassed([false, false, true, true, true, true, true]), true);
  // Older passes, recent 5 include a fail
  assert.strictEqual(lastFiveAttemptsPassed([true, true, true, true, true, false]), false);
});

test('last of the window failing → false', () => {
  assert.strictEqual(lastFiveAttemptsPassed([true, true, true, true, false]), false);
});

test('first of the window failing → false', () => {
  assert.strictEqual(lastFiveAttemptsPassed([false, true, true, true, true]), false);
});

test('compareAttemptTimestamps: equal → 0 (both argument orders)', () => {
  assert.strictEqual(compareAttemptTimestamps('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), 0);
  const t = '2026-08-26T06:00:00.000Z';
  assert.strictEqual(compareAttemptTimestamps(t, t), 0);
});

test('compareAttemptTimestamps: chronological order', () => {
  assert.strictEqual(compareAttemptTimestamps('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), -1);
  assert.strictEqual(compareAttemptTimestamps('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'), 1);
});

test('equal-timestamp sort preserves insertion order (stable)', () => {
  const list = [
    { timestamp: '2026-01-01T00:00:00Z', passed: false },
    { timestamp: '2026-01-02T00:00:00Z', passed: true },
    { timestamp: '2026-01-02T00:00:00Z', passed: false },
    { timestamp: '2026-01-03T00:00:00Z', passed: true },
  ];
  list.sort((a, b) => compareAttemptTimestamps(a.timestamp, b.timestamp));
  assert.deepStrictEqual(
    list.map((s) => s.passed),
    [false, true, false, true]
  );
});

function sample(agentId: string | null, passedFlag: boolean, timestamp: string): AttemptSample {
  return {
    passed: passedFlag,
    status: passedFlag ? 'COMPLETED' : 'FAILED',
    duration: 1,
    fastMode: false,
    timestamp,
    agentId,
  };
}

test('mergeAttemptSamples drops a hub dual-write of the same agent_id', () => {
  const ledger = [
    sample('fa1980b8-7626-4aee-b6e6-cd86c47f8858', true, '2026-09-02T17:55:24.844304+00:00'),
  ];
  const hub = [
    sample('7edaedd2-5bf1-498e-9125-099f9e41abb2', true, '2026-09-01T03:32:23.194833+00:00'),
    sample('eeadc310-9210-4b0b-aeed-f411690bf76b', true, '2026-09-01T20:31:16.530244+00:00'),
    sample('bd80f521-efe6-4d9b-9024-ef898d4157dd', true, '2026-09-01T23:09:34.187921+00:00'),
    sample('4fa5bb9e-747d-4034-af75-7972a6f3b528', false, '2026-09-01T03:24:07.829570+00:00'),
    sample('fa1980b8-7626-4aee-b6e6-cd86c47f8858', true, '2026-09-02T17:55:24.844304+00:00'),
  ];
  const merged = mergeAttemptSamples(ledger, hub);
  assert.strictEqual(merged.length, 5);
  assert.strictEqual(
    lastFiveAttemptsPassed(merged.map((row) => row.passed)),
    false,
    'duplicate ledger+hub pass must not invent a 5-pass window'
  );
});

test('mergeAttemptSamples keeps a hub-only newer attempt', () => {
  const ledger = [sample('aaa', false, '2026-09-01T00:00:00.000Z')];
  const hub = [sample('bbb', true, '2026-09-02T00:00:00.000Z')];
  const merged = mergeAttemptSamples(ledger, hub);
  assert.deepStrictEqual(
    merged.map((row) => row.agentId),
    ['aaa', 'bbb']
  );
});

process.stdout.write(`\nlast-five-passed: ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`  ${f}\n`);
  process.exit(1);
}
