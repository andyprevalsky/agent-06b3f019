#!/usr/bin/env tsx
/**
 * Unit tests for BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH.
 *
 * The flag is dead in production: it is ignored unless BENCHMARK_MODE or
 * BENCHMARK_ISOLATED_RUN is on. Isolated sandbox AgentCard lifecycle benches
 * set both the flag and benchmark mode so an admin run-user still hits
 * chargeAndIssueCard.
 *
 * Run: npx tsx src/tests/unit/benchmark-force-customer-purchase-path.test.ts
 */

import assert from 'node:assert/strict';
import { benchmarkForceCustomerPurchasePath } from '../../domains/purchases/config';

const ENV_KEYS = [
  'BENCHMARK_MODE',
  'BENCHMARK_ISOLATED_RUN',
  'BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH',
] as const;

const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
  saved[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearFlagEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  clearFlagEnv();
  try {
    fn();
    passed += 1;
    process.stdout.write(`  PASS ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  FAIL ${name}\n`);
  } finally {
    restoreEnv();
  }
}

test('off when no env is set', () => {
  assert.equal(benchmarkForceCustomerPurchasePath(), false);
});

test('ignored without benchmark or isolated mode', () => {
  process.env.BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH = '1';
  assert.equal(benchmarkForceCustomerPurchasePath(), false);
});

test('on with BENCHMARK_MODE=1', () => {
  process.env.BENCHMARK_MODE = '1';
  process.env.BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH = '1';
  assert.equal(benchmarkForceCustomerPurchasePath(), true);
});

test('on with BENCHMARK_ISOLATED_RUN=true', () => {
  process.env.BENCHMARK_ISOLATED_RUN = 'true';
  process.env.BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH = 'yes';
  assert.equal(benchmarkForceCustomerPurchasePath(), true);
});

test('off when benchmark mode is on but the force flag is absent', () => {
  process.env.BENCHMARK_MODE = 'true';
  assert.equal(benchmarkForceCustomerPurchasePath(), false);
});

test('off for unrecognized force-flag values even in benchmark mode', () => {
  process.env.BENCHMARK_MODE = '1';
  process.env.BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH = 'maybe';
  assert.equal(benchmarkForceCustomerPurchasePath(), false);
});

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`PASS benchmark force customer purchase path (${passed})\n`);
