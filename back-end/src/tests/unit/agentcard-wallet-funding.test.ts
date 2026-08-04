#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { AgentCardCompanyWalletFundingProvider } from '../../providers/wallet-funding';

async function main(): Promise<void> {
  let reads = 0;
  const calls: string[] = [];
  const provider = new AgentCardCompanyWalletFundingProvider(
    async (name, args) => {
      calls.push(name);
      assert.equal(name, 'list_transfers');
      assert.deepEqual(args, { limit: 100 });
      reads += 1;
      return {
        structuredContent: {
          transfers: [
            {
              id: 'owt-123',
              status: reads >= 3 ? 'reclaimed' : 'consumed',
              amount_cents: 4396,
              transferred_cents: 4396,
              released_cents: reads >= 3 ? 4396 : 0,
            },
          ],
        },
      };
    },
    { attempts: 4, delayMs: 0 }
  );

  const result = await provider.reclaimUserWalletFunding({
    userId: 'user-123',
    agentId: 'agent-123',
    purchaseId: 'purchase-123',
    amountCents: 4396,
    currency: 'usd',
    idempotencyKey: 'purchase-wallet-reclaim:purchase-123',
    providerTransferId: 'owt-123',
    cardId: 'card-123',
    reason: 'agent_cleanup_unspent_card',
  });

  assert.equal(reads, 3, 'provider must wait for MCP transfer release');
  assert.deepEqual(calls, ['list_transfers', 'list_transfers', 'list_transfers']);
  assert.equal(result.providerTransferId, 'owt-123');
  assert.equal(result.metadata?.status, 'release_confirmed');

  let rateLimitedCalls = 0;
  const rateLimitedProvider = new AgentCardCompanyWalletFundingProvider(
    async (name) => {
      assert.equal(name, 'list_transfers');
      rateLimitedCalls += 1;
      if (rateLimitedCalls === 1) throw new Error('429 Too many requests, please try again later');
      return {
        structuredContent: {
          transfers: [
            {
              id: 'owt-rate-limited',
              status: 'released',
              amount_cents: 100,
              released_cents: 100,
            },
          ],
        },
      };
    },
    { attempts: 3, delayMs: 0 }
  );
  const rateLimitedResult = await rateLimitedProvider.reclaimUserWalletFunding({
    userId: 'user-123',
    purchaseId: 'purchase-rate-limited',
    amountCents: 100,
    currency: 'usd',
    idempotencyKey: 'purchase-wallet-reclaim:purchase-rate-limited',
    providerTransferId: 'owt-rate-limited',
    reason: 'agent_cleanup_unspent_card',
  });
  assert.equal(rateLimitedCalls, 2);
  assert.equal(rateLimitedResult.metadata?.status, 'release_confirmed');

  // Regression: the release observer used to poll `list_transfers` on a FIXED interval for the
  // whole observation window (production: 20 requests, one every 3s). AgentCard throttles the
  // organization MCP org-wide at 120 requests/minute shared by EVERY caller, so one reclaim spent a
  // sixth of the window and starved card issuance, the cron reconciler and the lifecycle read —
  // surfacing as `agentcard_org_mcp_rate_limited`. Exponential backoff observes for exactly as long
  // while issuing far fewer requests.
  //
  // Scaled to 1/600 of production (delayMs 5 stands in for 3000) so the assertions run fast; the
  // schedule is a pure function of `delayMs`, so the request count is identical at either scale.
  const scaledDelayMs = 5;
  const productionAttempts = 20;
  const fixedCadenceTotalWaitMs = (productionAttempts - 1) * scaledDelayMs;
  let pendingObservations = 0;
  const pendingProvider = new AgentCardCompanyWalletFundingProvider(
    async (name) => {
      assert.equal(name, 'list_transfers');
      pendingObservations += 1;
      return {
        structuredContent: {
          transfers: [
            { id: 'owt-pending', status: 'consumed', amount_cents: 100, released_cents: 0 },
          ],
        },
      };
    },
    { attempts: productionAttempts, delayMs: scaledDelayMs }
  );
  const startedAt = Date.now();
  await assert.rejects(
    () =>
      pendingProvider.reclaimUserWalletFunding({
        userId: 'user-123',
        purchaseId: 'purchase-pending',
        amountCents: 100,
        currency: 'usd',
        idempotencyKey: 'purchase-wallet-reclaim:purchase-pending',
        providerTransferId: 'owt-pending',
        reason: 'agent_cleanup_unspent_card',
      }),
    (error: unknown) => error instanceof Error && /release is still pending/i.test(error.message),
    'a transfer that never releases must still end as release-pending, not as success'
  );
  const elapsedMs = Date.now() - startedAt;
  assert.equal(
    pendingObservations,
    6,
    `a full release observation window must cost 6 organization-MCP requests, not ${pendingObservations}`
  );
  // The deadline was NOT shortened to buy the request saving: the observer still spends the whole
  // fixed-cadence wait budget before giving up.
  assert.ok(
    elapsedMs >= fixedCadenceTotalWaitMs,
    `observation window shrank: waited ${elapsedMs}ms, expected at least ${fixedCadenceTotalWaitMs}ms`
  );

  process.stdout.write('AgentCard wallet funding release tests passed\n');
}

void main();
