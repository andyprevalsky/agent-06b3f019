#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import {
  AgentCardOrgMcpProvider,
  AgentCardRoutingProvider,
  type CardProvider,
} from '../../providers/card-provider';

type ToolCall = { name: string; args: Record<string, unknown> };

function toolResult(payload: Record<string, unknown>): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function fakePersonalProvider(onMint: () => never): CardProvider {
  return {
    mintCard: async () => onMint(),
    getDetails: async () => {
      throw new Error('unexpected personal getDetails');
    },
    closeCard: async () => {
      throw new Error('unexpected personal closeCard');
    },
  };
}

async function main(): Promise<void> {
  const calls: ToolCall[] = [];
  const provider = new AgentCardOrgMcpProvider('cardholder-123', async (name, args) => {
    calls.push({ name, args });
    if (name === 'create_card') {
      return toolResult({
        card_id: 'card-123',
        transfer_id: 'owt-123',
        status: 'OPEN',
        amount_cents: 4396,
      });
    }
    if (name === 'get_card_details') {
      return toolResult({
        pan: '4242424242424242',
        cvv: '123',
        expiry: '12/30',
        balance_cents: 4396,
        status: 'OPEN',
      });
    }
    if (name === 'close_card') return toolResult({ status: 'closed' });
    throw new Error(`unexpected tool ${name}`);
  });

  const minted = await provider.mintCard({
    amountCents: 4396,
    fundsSource: 'company_flow',
    idempotencyKey: 'purchase:purchase-123',
  });
  const details = await provider.getDetails(minted.cardId);
  await provider.closeCard(minted.cardId);

  assert.deepStrictEqual(calls, [
    {
      name: 'create_card',
      args: {
        cardholder_id: 'cardholder-123',
        amount_cents: 4396,
        funds_source: 'company_flow',
        idempotency_key: 'purchase:purchase-123',
      },
    },
    { name: 'get_card_details', args: { card_id: 'card-123' } },
    { name: 'get_card_details', args: { card_id: 'card-123' } },
    { name: 'close_card', args: { card_id: 'card-123' } },
  ]);
  assert.strictEqual(minted.providerTransferId, 'owt-123');
  assert.strictEqual(minted.last4, '4242');
  assert.strictEqual(details.balanceCents, 4396);

  const instantCalls: ToolCall[] = [];
  let transferLookups = 0;
  const instantFundingProvider = new AgentCardOrgMcpProvider(
    'cardholder-123',
    async (name, args) => {
      instantCalls.push({ name, args });
      if (name === 'create_card') {
        return toolResult({
          status: 'created',
          cardId: 'card-instant',
          last4: '8633',
        });
      }
      if (name === 'get_card_details') {
        return toolResult({
          pan: '4242424242428633',
          cvv: '933',
          expiry: '07/28',
          balanceCents: 4396,
          status: 'OPEN',
        });
      }
      if (name === 'list_transfers') {
        transferLookups += 1;
        if (transferLookups < 3) {
          return toolResult({ transfers: [] });
        }
        return toolResult({
          transfers: [
            {
              id: 'owt-instant',
              card_id: 'card-instant',
              amount_cents: 4396,
              status: 'consumed',
            },
          ],
        });
      }
      throw new Error(`unexpected instant-funding tool ${name}`);
    }
  );
  const instantMinted = await instantFundingProvider.mintCard({
    amountCents: 4396,
    fundsSource: 'company_flow',
    idempotencyKey: 'purchase:instant',
  });
  assert.strictEqual(instantMinted.providerTransferId, 'owt-instant');
  assert.deepStrictEqual(
    instantCalls.map((call) => call.name),
    ['create_card', 'get_card_details', 'list_transfers', 'list_transfers', 'list_transfers']
  );
  assert.deepStrictEqual(
    instantCalls.slice(2).map((call) => call.args),
    [{ status: 'consumed', limit: 100 }, { limit: 100 }, { status: 'consumed', limit: 100 }]
  );

  let orgMintCalls = 0;
  const routing = new AgentCardRoutingProvider('rose-user-123', {
    resolveOrgCardholderId: async () => 'cardholder-123',
    startOrgOnboarding: async () => {
      throw new Error('mapped user must not start onboarding');
    },
    createOrgProvider: () => ({
      mintCard: async (request) => {
        orgMintCalls += 1;
        return provider.mintCard(request);
      },
      getDetails: (cardId) => provider.getDetails(cardId),
      closeCard: (cardId) => provider.closeCard(cardId),
    }),
    createUserProvider: () =>
      fakePersonalProvider(() => {
        throw new Error('company flow must not use personal OAuth');
      }),
  });

  await routing.mintCard({
    amountCents: 4396,
    fundsSource: 'company_flow',
    idempotencyKey: 'purchase:routed',
  });
  assert.strictEqual(orgMintCalls, 1);

  const unmapped = new AgentCardRoutingProvider('rose-user-unmapped', {
    resolveOrgCardholderId: async () => undefined,
    startOrgOnboarding: async () => ({
      sessionId: 'cos-123',
      setupUrl: 'https://agentcard.test/onboarding/cos-123',
    }),
    createOrgProvider: () => provider,
    createUserProvider: () =>
      fakePersonalProvider(() => {
        throw new Error('company flow must not fall back to personal OAuth');
      }),
  });
  await assert.rejects(
    () =>
      unmapped.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:unmapped',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_setup_required' &&
      'details' in error &&
      error.details.agentcardStatus === 'cardholder_onboarding_required' &&
      error.details.setupSessionId === 'cos-123'
  );

  console.log('AgentCard organization MCP provider tests passed');
}

void main();
