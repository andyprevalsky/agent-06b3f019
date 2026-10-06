#!/usr/bin/env tsx
/** A provider acknowledgement cannot certify that purchase funds were returned. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { refundCapturedPurchase } from '../../providers/stripe';
import { withFakeStripe } from './purchases.testkit';

async function main() {
  let failures = 0;
  const paymentIntentId = `pi_${randomUUID()}`;
  const purchaseId = randomUUID();
  const cases: Array<readonly [string, () => Promise<void>]> = [];
  for (const status of ['pending', 'requires_action', 'failed', 'canceled', null]) {
    cases.push([
      `unconfirmed refund ${String(status)} stays retryable`,
      async () => {
        await withFakeStripe(
          async (calls) => {
            await assert.rejects(
              refundCapturedPurchase(paymentIntentId, purchaseId),
              /refund.*not.*succeeded/i
            );
            assert.equal(calls.refunds.length, 1);
            assert.equal(calls.refundRetrieves.length, 1);
            assert.deepEqual(calls.refundIdempotencyKeys, [`purchase-refund:${purchaseId}`]);
          },
          { refundStatus: status, refundRetrievedStatus: status }
        );
      },
    ]);
  }
  cases.push([
    'cached pending acknowledgement reads current completion',
    async () => {
      await withFakeStripe(
        async (calls) => {
          await refundCapturedPurchase(paymentIntentId, purchaseId);
          assert.equal(calls.refunds.length, 1);
          assert.equal(calls.refundRetrieves.length, 1);
          assert.match(calls.refundRetrieves[0], /^re_/);
          assert.deepEqual(calls.refundIdempotencyKeys, [`purchase-refund:${purchaseId}`]);
        },
        { refundStatus: 'pending', refundRetrievedStatus: 'succeeded' }
      );
    },
  ]);
  cases.push([
    'completed acknowledgement needs no further request',
    async () => {
      await withFakeStripe(async (calls) => {
        await refundCapturedPurchase(paymentIntentId, purchaseId);
        assert.equal(calls.refunds.length, 1);
        assert.deepEqual(calls.refundRetrieves, []);
        assert.deepEqual(calls.refundIdempotencyKeys, [`purchase-refund:${purchaseId}`]);
      });
    },
  ]);
  try {
    for (const [name, test] of cases) {
      try {
        await test();
        console.log(`PASS ${name}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  assert.equal(failures, 0, `${failures} refund completion cases failed`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
