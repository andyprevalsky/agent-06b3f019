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
          funding: {
            id: 'funding-is-not-a-transfer',
          },
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

  const delayedReplayCalls: ToolCall[] = [];
  let replayCount = 0;
  const delayedReplayProvider = new AgentCardOrgMcpProvider(
    'cardholder-123',
    async (name, args) => {
      delayedReplayCalls.push({ name, args });
      if (name === 'create_card') {
        replayCount += 1;
        return toolResult({
          status: 'created',
          card_id: 'card-delayed-replay',
          ...(replayCount > 1 ? { transfer_id: 'owt-delayed-replay' } : {}),
        });
      }
      if (name === 'get_card_details') {
        return toolResult({
          pan: '4242424242429911',
          cvv: '911',
          expiry: '07/28',
          balance_cents: 4396,
          status: 'OPEN',
        });
      }
      if (name === 'list_transfers') return toolResult({ transfers: [] });
      if (name === 'close_card') throw new Error('a transfer visibility delay must not close card');
      throw new Error(`unexpected delayed-replay tool ${name}`);
    },
    { attempts: 1, delayMs: 0 }
  );
  await assert.rejects(
    () =>
      delayedReplayProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:delayed-replay',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_company_funding_in_progress' &&
      'details' in error &&
      error.details.cardId === 'card-delayed-replay'
  );
  const delayedReplayMint = await delayedReplayProvider.mintCard({
    amountCents: 4396,
    fundsSource: 'company_flow',
    idempotencyKey: 'purchase:delayed-replay',
  });
  assert.strictEqual(delayedReplayMint.cardId, 'card-delayed-replay');
  assert.strictEqual(delayedReplayMint.providerTransferId, 'owt-delayed-replay');
  assert.strictEqual(
    delayedReplayCalls.filter((call) => call.name === 'close_card').length,
    0,
    'the first transferless response must leave the exact-key replay card live'
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

  // An omitted fundsSource defaults to company_flow, so it must still require an idempotency key
  // (retries otherwise mint duplicate cards + transfers).
  const defaultingProvider = new AgentCardOrgMcpProvider('cardholder-123', async () => {
    throw new Error('create_card must not be called without an idempotency key');
  });
  await assert.rejects(
    () => defaultingProvider.mintCard({ amountCents: 4396 }),
    (error: unknown) =>
      error instanceof Error && error.message.includes('idempotencyKey is required')
  );

  const fundingGateProvider = new AgentCardOrgMcpProvider('cardholder-123', async (name) => {
    if (name === 'create_card') {
      return toolResult({
        status: 'funding_in_progress',
        provider_transfer_id: 'owt-provider-snake',
        retry_after_seconds: 3,
      });
    }
    throw new Error(`unexpected funding-gate tool ${name}`);
  });
  await assert.rejects(
    () =>
      fundingGateProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:funding-gate',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_company_funding_in_progress' &&
      'details' in error &&
      error.details.transferId === 'owt-provider-snake' &&
      error.details.retryAfterSeconds === 3
  );

  const nestedFundingGateProvider = new AgentCardOrgMcpProvider('cardholder-123', async (name) => {
    if (name === 'create_card') {
      return toolResult({
        status: 'funding_in_progress',
        funding: {
          transfer: {
            id: 'owt-nested-transfer',
          },
        },
        retryAfterSeconds: 4,
      });
    }
    throw new Error(`unexpected nested funding-gate tool ${name}`);
  });
  await assert.rejects(
    () =>
      nestedFundingGateProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:nested-funding-gate',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_company_funding_in_progress' &&
      'details' in error &&
      error.details.transferId === 'owt-nested-transfer' &&
      error.details.retryAfterSeconds === 4
  );

  const transferlessFundingGateProvider = new AgentCardOrgMcpProvider(
    'cardholder-123',
    async (name) => {
      if (name === 'create_card') {
        return toolResult({
          status: 'funding_in_progress',
          message: 'Company funding is still settling',
          retryAfterSeconds: 5,
        });
      }
      throw new Error(`unexpected transferless funding-gate tool ${name}`);
    }
  );
  await assert.rejects(
    () =>
      transferlessFundingGateProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:transferless-funding-gate',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_company_funding_in_progress' &&
      'details' in error &&
      error.details.transferId === undefined &&
      error.details.retryAfterSeconds === 5
  );

  const textFundingGateProvider = new AgentCardOrgMcpProvider('cardholder-123', async (name) => {
    if (name === 'create_card') {
      return {
        content: [
          {
            type: 'text',
            text: 'status: funding_in_progress\nCompany Transfer ID: owt-text-transfer',
          },
        ],
      };
    }
    throw new Error(`unexpected text funding-gate tool ${name}`);
  });
  await assert.rejects(
    () =>
      textFundingGateProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:text-funding-gate',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_company_funding_in_progress' &&
      'details' in error &&
      error.details.transferId === 'owt-text-transfer'
  );

  // An MCP error with no textual content must still surface the fallback message rather than an
  // empty string.
  const emptyErrorProvider = new AgentCardOrgMcpProvider('cardholder-123', async (name) => {
    if (name === 'create_card') {
      return { isError: true, structuredContent: {}, content: [] };
    }
    throw new Error(`unexpected tool ${name}`);
  });
  await assert.rejects(
    () =>
      emptyErrorProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:empty-error',
      }),
    (error: unknown) =>
      error instanceof Error && error.message === 'AgentCard Organization MCP failed'
  );

  const proseKycCalls: string[] = [];
  const proseKycProvider = new AgentCardOrgMcpProvider('cardholder-123', async (name) => {
    proseKycCalls.push(name);
    if (name === 'create_card') {
      return {
        isError: true,
        structuredContent: {
          status: 'error',
          message: 'upstream failed after create; kyc_required was mentioned in diagnostics',
        },
      };
    }
    throw new Error(`unexpected prose-KYC tool ${name}`);
  });
  await assert.rejects(
    () =>
      proseKycProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:prose-kyc',
      }),
    (error: unknown) =>
      error instanceof Error && !('code' in error && error.code === 'agentcard_kyc_required')
  );
  assert.deepStrictEqual(proseKycCalls, ['create_card']);

  const missingCardholderProvider = new AgentCardOrgMcpProvider(
    'cardholder-missing',
    async (name) => {
      if (name === 'create_card') {
        throw new Error('create_card failed: Cardholder not found');
      }
      throw new Error(`unexpected missing-cardholder tool ${name}`);
    }
  );
  await assert.rejects(
    () =>
      missingCardholderProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:missing-cardholder',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_setup_required' &&
      'details' in error &&
      error.details.agentcardStatus === 'cardholder_not_found'
  );

  const missingCardholderResultProvider = new AgentCardOrgMcpProvider(
    'cardholder-missing',
    async (name) => {
      if (name === 'create_card') {
        return {
          isError: true,
          structuredContent: { status: 'error', message: 'Cardholder not found' },
        };
      }
      throw new Error(`unexpected missing-cardholder-result tool ${name}`);
    }
  );
  await assert.rejects(
    () =>
      missingCardholderResultProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:missing-cardholder-result',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_setup_required' &&
      'details' in error &&
      error.details.agentcardStatus === 'cardholder_not_found'
  );

  console.log('AgentCard organization MCP provider tests passed');
}

void main();
