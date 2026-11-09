#!/usr/bin/env tsx
/**
 * Unit tests for the injectable AgentCard MCP seams:
 *  - `card-provider/agentcard-org-mcp.ts` — validation, KYC gate, text-parsed details.
 *  - `card-provider/agentcard-user-mcp.ts` — validation, full-record mint, text details,
 *    isError + thrown-error mapping.
 *  - `agentcard/org-runtime.ts` — Bearer `acs_` secret (no JWT) plus auth retry.
 *  - `wallet-funding.ts` — fund/confirm-collection/reclaim edge cases.
 *
 * Every collaborator is injected (tool callers + fetch), so no MCP or network call is made.
 */

import assert from 'node:assert/strict';
import {
  AgentCardOrgMcpProvider,
  AgentCardProviderError,
  AgentCardUserMcpProvider,
} from '../../providers/card-provider';
import {
  AgentCardOrgRuntime,
  AgentCardOrgRuntimeError,
} from '../../providers/agentcard/org-runtime';
import {
  AgentCardCompanyWalletFundingProvider,
  WalletFundingProviderError,
} from '../../providers/wallet-funding';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  PASS ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  FAIL ${name}\n`);
  }
}

function structured(payload: Record<string, unknown>): unknown {
  return { structuredContent: payload };
}
function textResult(text: string): unknown {
  return { content: [{ type: 'text', text }] };
}

async function main(): Promise<void> {
  process.stdout.write('Running AgentCard MCP/runtime extras unit tests...\n');

  // ── org-mcp validation ──
  await test('org provider rejects an empty cardholder id', () => {
    assert.throws(() => new AgentCardOrgMcpProvider('  '), /cardholder id is required/);
  });

  await test('org provider validates mint amount and idempotency key', async () => {
    const provider = new AgentCardOrgMcpProvider('ch-1', async () => structured({}));
    await assert.rejects(
      () => provider.mintCard({ amountCents: 0, fundsSource: 'company_flow', idempotencyKey: 'k' }),
      /amountCents must be a positive integer/
    );
    await assert.rejects(
      () => provider.mintCard({ amountCents: 100, fundsSource: 'company_flow' }),
      /idempotencyKey is required/
    );
  });

  await test('org provider completes the KYC gate then retries the mint', async () => {
    const calls: string[] = [];
    const provider = new AgentCardOrgMcpProvider('ch-1', async (name) => {
      calls.push(name);
      if (name === 'create_card') {
        return calls.filter((c) => c === 'create_card').length === 1
          ? structured({ status: 'kyc_required' })
          : structured({ card_id: 'card-9', transfer_id: 'owt-9', status: 'OPEN' });
      }
      if (name === 'start_cardholder_kyc') return structured({ status: 'verified' });
      if (name === 'get_card_details') {
        return structured({
          pan: '4242424242424242',
          cvv: '123',
          expiry: '12/30',
          balance_cents: 4396,
          status: 'OPEN',
        });
      }
      throw new Error(`unexpected ${name}`);
    });
    const minted = await provider.mintCard({
      amountCents: 4396,
      fundsSource: 'company_flow',
      idempotencyKey: 'k',
    });
    assert.equal(minted.cardId, 'card-9');
    assert.equal(minted.providerTransferId, 'owt-9');
    assert.ok(calls.includes('start_cardholder_kyc'));
  });

  await test('org provider surfaces a setup-required error when KYC is unverified', async () => {
    const provider = new AgentCardOrgMcpProvider('ch-1', async (name) => {
      if (name === 'create_card') return structured({ status: 'kyc_required' });
      if (name === 'start_cardholder_kyc') {
        return structured({ status: 'pending', url: 'https://agentcard/kyc/1' });
      }
      throw new Error(`unexpected ${name}`);
    });
    await assert.rejects(
      () =>
        provider.mintCard({ amountCents: 4396, fundsSource: 'company_flow', idempotencyKey: 'k' }),
      (error: unknown) =>
        error instanceof AgentCardProviderError &&
        error.code === 'agentcard_setup_required' &&
        error.details.setupStatus === 'pending'
    );
  });

  await test('org provider parses card details from labeled MCP text', async () => {
    const provider = new AgentCardOrgMcpProvider('ch-1', async () =>
      textResult('PAN: 4242 4242 4242 4242\nCVV: 321\nExpiry: 11/29\nBalance: $43.96\nStatus: OPEN')
    );
    const details = await provider.getDetails('card-1');
    assert.equal(details.pan, '4242424242424242');
    assert.equal(details.cvv, '321');
    assert.equal(details.expiry, '11/29');
    assert.equal(details.balanceCents, 4396);
    assert.equal(details.status, 'OPEN');
  });

  await test('org provider throws when details omit a balance', async () => {
    const provider = new AgentCardOrgMcpProvider('ch-1', async () =>
      structured({ pan: '4242424242424242', cvv: '123', expiry: '12/30', status: 'OPEN' })
    );
    await assert.rejects(() => provider.getDetails('card-1'), /missing balance_cents/);
  });

  // ── user-mcp validation + branches ──
  await test('user provider rejects an empty user id', () => {
    assert.throws(
      () => new AgentCardUserMcpProvider(''),
      (error: unknown) => error instanceof AgentCardProviderError && error.status === 401
    );
  });

  await test('user provider validates the mint amount', async () => {
    const provider = new AgentCardUserMcpProvider('user-1', async () => structured({}));
    await assert.rejects(() => provider.mintCard({ amountCents: -1 }), /positive integer/);
  });

  await test('user provider skips getDetails when create_card returns a full record', async () => {
    let getDetailsCalls = 0;
    const provider = new AgentCardUserMcpProvider('user-1', async (_userId, name) => {
      if (name === 'get_card_details') getDetailsCalls += 1;
      return structured({
        card_id: 'card-full',
        last4: '4242',
        expiry: '12/30',
        spend_limit_cents: 4396,
        status: 'OPEN',
        transfer_id: 'owt-full',
      });
    });
    const minted = await provider.mintCard({ amountCents: 4396 });
    assert.equal(minted.cardId, 'card-full');
    assert.equal(minted.last4, '4242');
    assert.equal(minted.providerTransferId, 'owt-full');
    assert.equal(getDetailsCalls, 0, 'a complete create_card record must not require getDetails');
  });

  await test('user provider parses details from labeled text', async () => {
    // A structured (but field-less) envelope satisfies firstRecord; the labeled values live in the
    // human-readable content text, exercising the text-parsing fallback.
    const provider = new AgentCardUserMcpProvider('user-1', async () => ({
      structuredContent: {},
      content: [
        {
          type: 'text',
          text: 'PAN: 4242 4242 4242 4242\nCVV: 987\nExpiry: 05/31\nBalance: $12.00\nStatus: OPEN',
        },
      ],
    }));
    const details = await provider.getDetails('card-1');
    assert.equal(details.pan, '4242424242424242');
    assert.equal(details.expiry, '05/31');
    assert.equal(details.balanceCents, 1200);
  });

  await test('user provider validates empty card ids', async () => {
    const provider = new AgentCardUserMcpProvider('user-1', async () => structured({}));
    await assert.rejects(() => provider.getDetails('  '), /cardId is required/);
    await assert.rejects(() => provider.closeCard('  '), /cardId is required/);
  });

  await test('user provider maps an isError result to a provider error', async () => {
    const provider = new AgentCardUserMcpProvider('user-1', async () => ({
      isError: true,
      content: [{ type: 'text', text: 'card service unavailable' }],
    }));
    await assert.rejects(() => provider.closeCard('card-1'), /card service unavailable/);
  });

  await test('user provider maps a thrown MCP error to a provider error', async () => {
    const provider = new AgentCardUserMcpProvider('user-1', async () => {
      throw new Error('mcp transport closed');
    });
    await assert.rejects(
      () => provider.closeCard('card-1'),
      (error: unknown) => error instanceof AgentCardProviderError
    );
  });

  // ── org-runtime Bearer secret (no JWT exchange) ──
  await test('org runtime uses a direct access token when no client credentials exist', async () => {
    const prev = {
      token: process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN,
      id: process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID,
      globalId: process.env.AGENTCARD_OAUTH_CLIENT_ID,
    };
    delete process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID;
    delete process.env.AGENTCARD_OAUTH_CLIENT_ID;
    process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = 'direct-token';
    try {
      let seenToken: string | undefined;
      const runtime = new AgentCardOrgRuntime(async (token) => {
        seenToken = token;
        return { ok: true };
      });
      const result = await runtime.callTool('get_company_wallet', {});
      assert.deepEqual(result, { ok: true });
      assert.equal(seenToken, 'direct-token');
    } finally {
      if (prev.token === undefined) delete process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN;
      else process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = prev.token;
      if (prev.id !== undefined) process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = prev.id;
      if (prev.globalId !== undefined) process.env.AGENTCARD_OAUTH_CLIENT_ID = prev.globalId;
    }
  });

  await test('org runtime sends the client secret as Bearer and retries once on auth error', async () => {
    const prev = {
      id: process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID,
      secret: process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET,
      direct: process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN,
    };
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'client-id';
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET = 'client-secret';
    delete process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN;
    try {
      let tokenFetches = 0;
      let toolCalls = 0;
      let seenToken = '';
      const runtime = new AgentCardOrgRuntime(
        async (accessToken) => {
          seenToken = accessToken;
          toolCalls += 1;
          if (toolCalls === 1) throw new Error('401 unauthorized');
          return { ok: true };
        },
        (async () => {
          tokenFetches += 1;
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({ access_token: `tok-${tokenFetches}`, expires_in: 3600 }),
          } as Response;
        }) as typeof fetch
      );
      const result = await runtime.callTool('get_company_wallet', {});
      assert.deepEqual(result, { ok: true });
      assert.equal(seenToken, 'client-secret');
      assert.equal(toolCalls, 2, 'the tool call retries after an MCP auth error');
      assert.equal(tokenFetches, 0, 'organization MCP must not exchange a JWT for the org secret');
    } finally {
      if (prev.id === undefined) delete process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID;
      else process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = prev.id;
      if (prev.secret === undefined) delete process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET;
      else process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET = prev.secret;
      if (prev.direct !== undefined) process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = prev.direct;
    }
  });

  await test('org runtime throws when the organization MCP tools/call is unauthorized', async () => {
    const prev = {
      id: process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID,
      secret: process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET,
      direct: process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN,
    };
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'client-id';
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET = 'client-secret';
    delete process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN;
    try {
      // A sustained 401 exhausts the read auth-flap window; a virtual clock keeps that off the wall.
      let nowMs = Date.now();
      const runtime = new AgentCardOrgRuntime(
        undefined,
        (async () => ({
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ error: 'Invalid or expired organization token' }),
        })) as unknown as typeof fetch,
        {
          now: () => nowMs,
          sleep: async (ms) => {
            nowMs += ms;
          },
        }
      );
      await assert.rejects(
        () => runtime.callTool('get_company_wallet', {}),
        (error: unknown) => error instanceof AgentCardOrgRuntimeError && error.status === 401
      );
    } finally {
      if (prev.id === undefined) delete process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID;
      else process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = prev.id;
      if (prev.secret === undefined) delete process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET;
      else process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET = prev.secret;
      if (prev.direct !== undefined) process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = prev.direct;
    }
  });

  // ── wallet-funding provider edge cases ──
  await test('company wallet fundUserWallet returns the awaiting-transfer marker', async () => {
    const provider = new AgentCardCompanyWalletFundingProvider(async () => ({}));
    const result = await provider.fundUserWallet({
      userId: 'u',
      purchaseId: 'p',
      amountCents: 100,
      currency: 'usd',
      idempotencyKey: 'k',
    });
    assert.equal(result.metadata?.status, 'awaiting_create_card_transfer');
  });

  await test('company wallet confirmCollection confirms a successful collection', async () => {
    const calls: string[] = [];
    const provider = new AgentCardCompanyWalletFundingProvider(async (name) => {
      calls.push(name);
      return { structuredContent: { status: 'ok' } };
    });
    const result = await provider.confirmCollection({
      userId: 'u',
      purchaseId: 'p',
      amountCents: 100,
      currency: 'usd',
      idempotencyKey: 'k',
      providerTransferId: 'owt-1',
      outcome: 'succeeded',
    });
    assert.equal(result.providerTransferId, 'owt-1');
    assert.equal(result.metadata?.status, 'collection_confirmed');
    assert.deepEqual(calls, ['confirm_collection']);
  });

  await test('company wallet confirmCollection surfaces a tool failure', async () => {
    const provider = new AgentCardCompanyWalletFundingProvider(async () => ({
      structuredContent: { status: 'failed', message: 'transfer rejected' },
    }));
    await assert.rejects(
      () =>
        provider.confirmCollection({
          userId: 'u',
          purchaseId: 'p',
          amountCents: 100,
          currency: 'usd',
          idempotencyKey: 'k',
          providerTransferId: 'owt-1',
          outcome: 'succeeded',
        }),
      (error: unknown) => error instanceof WalletFundingProviderError
    );
  });

  await test('company wallet reclaim requires a transfer id', async () => {
    const provider = new AgentCardCompanyWalletFundingProvider(async () => ({}));
    await assert.rejects(
      () =>
        provider.reclaimUserWalletFunding({
          userId: 'u',
          purchaseId: 'p',
          amountCents: 100,
          currency: 'usd',
          idempotencyKey: 'k',
          reason: 'cleanup',
        }),
      (error: unknown) =>
        error instanceof WalletFundingProviderError &&
        error.code === 'agentcard_company_transfer_missing'
    );
  });

  await test('company wallet reclaim reports release-pending after exhausting retries', async () => {
    const provider = new AgentCardCompanyWalletFundingProvider(
      async () => {
        throw new Error('429 Too many requests');
      },
      { attempts: 2, delayMs: 0 }
    );
    await assert.rejects(
      () =>
        provider.reclaimUserWalletFunding({
          userId: 'u',
          purchaseId: 'p',
          amountCents: 100,
          currency: 'usd',
          idempotencyKey: 'k',
          providerTransferId: 'owt-1',
          reason: 'cleanup',
        }),
      (error: unknown) =>
        error instanceof WalletFundingProviderError &&
        error.code === 'agentcard_company_transfer_release_pending'
    );
  });

  process.stdout.write(
    `\nAgentCard MCP/runtime extras unit tests: ${passed} passed, ${failures.length} failed\n`
  );
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

main()
  .then(() => {
    if (failures.length > 0) process.exit(1);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
