#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { AgentCardCompanyWalletFundingProvider } from '../../providers/wallet-funding';

/**
 * Regression (2026-11-13, shared sandbox AgentCard org throttling): during one stalled release,
 * the cron reconciler, the abandon POST and the harness resume each ran their own release
 * observation, and every observation of the still-consumed transfer fired the recover_funds
 * accelerator again. A stalled guest issued 12 recover_funds in 9 minutes, 9 of them within 12 s
 * of the previous one, against the org-wide 120 requests/minute budget. The accelerator never
 * substitutes for the transfer's own release status, so repeats for the same cardholder inside one
 * rate window are redundant provider calls: one recovery per cardholder per window.
 */
const transferId = (n: number) => `owt-coalesce-${n}`;

function stalledProvider(cardholderId: string, n: number, recoveries: string[]) {
  return new AgentCardCompanyWalletFundingProvider(
    async (name, args) => {
      if (name === 'recover_funds') {
        recoveries.push(String(args.cardholder_id));
        return { structuredContent: { status: 'completed', amount_cents: 0 } };
      }
      assert.equal(name, 'list_transfers');
      return {
        structuredContent: {
          transfers: [
            {
              id: transferId(n),
              card_id: `card-coalesce-${n}`,
              amount_cents: 4396,
              transferred_cents: 4396,
              released_cents: 0,
              status: 'consumed',
            },
          ],
        },
      };
    },
    { attempts: 20, delayMs: 5 },
    async () => cardholderId
  );
}

function reclaim(provider: AgentCardCompanyWalletFundingProvider, n: number) {
  return provider
    .reclaimUserWalletFunding({
      userId: 'user-coalesce',
      purchaseId: `purchase-coalesce-${n}`,
      amountCents: 4396,
      currency: 'usd',
      idempotencyKey: `purchase-wallet-reclaim:purchase-coalesce-${n}`,
      providerTransferId: transferId(n),
      cardId: `card-coalesce-${n}`,
      reason: 'failed_company_transfer_release_retry',
    })
    .then(
      () => 'released',
      (error: unknown) =>
        error instanceof Error && /release is still pending/i.test(error.message)
          ? 'pending'
          : Promise.reject(error)
    );
}

/**
 * CodeRabbit cycle 1 on PR #2016: an in-flight recovery must never expire (a duplicate call would
 * start), and a reclaim joining another's recovery waits only within its own deadline.
 */
async function assertInFlightRecoveryIsSharedWithinEachDeadline(): Promise<void> {
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  let clockMs = realNow();
  Date.now = () => clockMs;
  // Virtual clock: every timer fires at once and advances the clock by its delay.
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, timeoutMs?: number) => {
    if (typeof timeoutMs === 'number' && timeoutMs > 0) clockMs += timeoutMs;
    return realSetTimeout(handler, 0);
  }) as unknown as typeof setTimeout;
  try {
    let releaseRecovery: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const recoveries: string[] = [];
    const provider = (n: number) =>
      new AgentCardCompanyWalletFundingProvider(
        async (name, args) => {
          if (name === 'recover_funds') {
            recoveries.push(String(args.cardholder_id));
            await held;
            return { structuredContent: { status: 'completed', amount_cents: 0 } };
          }
          return {
            structuredContent: {
              transfers: [
                {
                  id: transferId(n),
                  card_id: `card-coalesce-${n}`,
                  amount_cents: 4396,
                  transferred_cents: 4396,
                  released_cents: 0,
                  status: 'consumed',
                },
              ],
            },
          };
        },
        { attempts: 20, delayMs: 5 },
        async () => 'cardholder-coalesce-inflight'
      );
    const first = reclaim(provider(4), 4);
    while (recoveries.length === 0) await new Promise((resolve) => realSetTimeout(resolve, 5));
    clockMs += 61_000; // the in-flight recovery is now older than the window
    const second = await Promise.race([
      reclaim(provider(5), 5),
      new Promise((resolve) => realSetTimeout(() => resolve('blocked'), 3_000)),
    ]);
    assert.equal(second, 'pending', 'a joining reclaim finishes within its own deadline');
    assert.deepEqual(
      recoveries,
      ['cardholder-coalesce-inflight'],
      'an in-flight recovery is shared, never duplicated after the window'
    );
    releaseRecovery();
    // The first reclaim keeps observing past the window, where a fresh accelerator is legitimate.
    assert.equal(await first, 'pending');
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
  }
}

async function main(): Promise<void> {
  const realNow = Date.now;
  let offsetMs = 0;
  Date.now = () => realNow() + offsetMs;
  try {
    const recoveries: string[] = [];
    // Two concurrent observation windows of the same stalled transfer for the same cardholder.
    const outcomes = await Promise.all([
      reclaim(stalledProvider('cardholder-coalesce-a', 1, recoveries), 1),
      reclaim(stalledProvider('cardholder-coalesce-a', 1, recoveries), 1),
    ]);
    assert.deepEqual(
      outcomes,
      ['pending', 'pending'],
      'the stall is still reported release-pending'
    );
    assert.deepEqual(
      recoveries,
      ['cardholder-coalesce-a'],
      'one recover_funds per cardholder per rate window, not one per observation'
    );

    // A different cardholder is accelerated independently.
    await reclaim(stalledProvider('cardholder-coalesce-b', 2, recoveries), 2);
    assert.deepEqual(recoveries, ['cardholder-coalesce-a', 'cardholder-coalesce-b']);

    // After the window the same cardholder is accelerated again.
    offsetMs += 61_000;
    await reclaim(stalledProvider('cardholder-coalesce-a', 3, recoveries), 3);
    assert.deepEqual(recoveries, [
      'cardholder-coalesce-a',
      'cardholder-coalesce-b',
      'cardholder-coalesce-a',
    ]);
  } finally {
    Date.now = realNow;
  }
  await assertInFlightRecoveryIsSharedWithinEachDeadline();
  process.stdout.write('AgentCard recover_funds accelerator coalescing tests passed\n');
}

void main();
