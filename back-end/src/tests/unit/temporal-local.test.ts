#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';

import { isLocalTemporalAddress } from '../../providers/temporal';

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

const LOOPBACK_ADDRESSES = ['localhost:7233', '127.0.0.1:7233', '[::1]:7233', '::1'];

for (const address of LOOPBACK_ADDRESSES) {
  test(`accepts loopback address ${address}`, () => {
    assert.strictEqual(isLocalTemporalAddress(address), true);
  });
}

test('keeps Temporal Cloud on authenticated TLS', () => {
  assert.strictEqual(isLocalTemporalAddress('rose.tmprl.cloud:7233'), false);
});

if (failures.length > 0) {
  console.error('\nFailures:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`\n${passed}/${LOOPBACK_ADDRESSES.length + 1} temporal local-address tests passed`);
