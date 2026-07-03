#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import {
  assertSideEffectCanResume,
  claimToolSideEffect,
  markToolSideEffectFailed,
  markToolSideEffectSucceeded,
  ToolSideEffectAlreadyStartedError,
} from '../../providers/toolSideEffects';
import { prisma } from '../../providers/database';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

async function main(): Promise<void> {
  await test('tool side effects claim once, resume by external id, and record failure', async () => {
    const prefix = `unit-side-effect-${Date.now()}`;
    const operationKey = `${prefix}:success`;
    const failedOperationKey = `${prefix}:failure`;

    try {
      const firstClaim = await claimToolSideEffect({
        operationKey,
        operationType: 'unit-test',
        request: { provider: 'vapi', action: 'call' },
      });
      assert.strictEqual(firstClaim.status, 'claimed');
      assert.strictEqual(firstClaim.record.status, 'STARTED');

      const secondClaim = await claimToolSideEffect({
        operationKey,
        operationType: 'unit-test',
      });
      assert.strictEqual(secondClaim.status, 'existing');
      assert.strictEqual(secondClaim.record.id, firstClaim.record.id);

      assert.throws(
        () => assertSideEffectCanResume(secondClaim.record),
        ToolSideEffectAlreadyStartedError
      );

      const succeeded = await markToolSideEffectSucceeded({
        operationKey,
        externalId: 'external-call-123',
        response: { status: 'queued' },
      });
      assert.strictEqual(succeeded.status, 'SUCCEEDED');
      assert.strictEqual(succeeded.externalId, 'external-call-123');
      assert.strictEqual(succeeded.error, null);
      assert.strictEqual(assertSideEffectCanResume(succeeded), 'external-call-123');

      await claimToolSideEffect({
        operationKey: failedOperationKey,
        operationType: 'unit-test',
      });
      const failed = await markToolSideEffectFailed({
        operationKey: failedOperationKey,
        error: 'provider rejected request',
      });
      assert.strictEqual(failed.status, 'FAILED');
      assert.strictEqual(failed.error, 'provider rejected request');
    } finally {
      await prisma.toolSideEffect.deleteMany({
        where: { operationKey: { startsWith: prefix } },
      });
    }
  });

  if (failures.length > 0) {
    console.error('\nFailures:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`\n${passed}/1 tool side-effect tests passed`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
