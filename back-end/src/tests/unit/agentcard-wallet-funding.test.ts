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
  process.stdout.write('AgentCard wallet funding release tests passed\n');
}

void main();
