#!/usr/bin/env tsx
/**
 * Unit tests for the remaining AgentCard provider surfaces:
 *  - `benchmark-float.ts` — sandbox-float top-up math against an injected fetch.
 *  - `org-wallet-monitor.ts` — wallet extraction error branches, the fallback
 *    deposit-address message, the DB-backed alert store, and the disabled monitor.
 *  - `sandbox-settlement.ts` — the real markPurchaseCleared Postgres transaction.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  ensureAgentCardSandboxFloat,
  loadAgentCardBenchmarkAdmin,
  refreshAgentCardSession,
  selectAgentCardBenchmarkAdminToken,
  selectAgentCardBenchmarkWalletToken,
} from '../../providers/agentcard/benchmark-float';
import {
  createAgentCardOrgWalletAlertStore,
  extractAgentCardOrgWallet,
  monitorAgentCardOrgWallet,
  runAgentCardOrgWalletMonitor,
  type AgentCardOrgWallet,
} from '../../providers/agentcard/org-wallet-monitor';
import { settleAgentCardSandboxPayment } from '../../providers/agentcard/sandbox-settlement';

const createdUserIds: string[] = [];
const ALERT_OPERATION_KEY = 'agentcard-org-wallet-low-balance';
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

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function jwtWithExpiration(exp: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ exp })}.signature`;
}

async function seedUser(): Promise<string> {
  const userId = `agentcard-extras-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  createdUserIds.push(userId);
  return userId;
}

const ADMIN = { apiUrl: 'https://api.agentcard.test', token: 'jwt-token' };

async function main(): Promise<void> {
  process.stdout.write('Running AgentCard provider-extras unit tests...\n');

  // ── benchmark-float ──
  await test('ensureAgentCardSandboxFloat leaves an already-funded wallet untouched', async () => {
    let calls = 0;
    const result = await ensureAgentCardSandboxFloat(ADMIN, 'org-1', 50_000, (async () => {
      calls += 1;
      return jsonResponse(200, { settings: { sandbox_balance_cents: 50_000 } });
    }) as typeof fetch);
    assert.equal(result.addedCents, 0);
    assert.equal(result.balanceCents, 50_000);
    assert.equal(calls, 1, 'no test-fund call when the target is already met');
  });

  await test('ensureAgentCardSandboxFloat tops up a low wallet', async () => {
    const bodies: unknown[] = [];
    const result = await ensureAgentCardSandboxFloat(ADMIN, 'org-1', 50_000, (async (
      _url: string,
      init: RequestInit
    ) => {
      if (init.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        return jsonResponse(200, { sandboxWalletBalanceCents: 50_000 });
      }
      return jsonResponse(200, { settings: { sandbox_balance_cents: 10_000 } });
    }) as typeof fetch);
    assert.equal(result.previousCents, 10_000);
    assert.equal(result.addedCents, 40_000);
    assert.equal(result.balanceCents, 50_000);
    assert.deepEqual(bodies[0], { amountCents: 40_000 });
  });

  await test('ensureAgentCardSandboxFloat uses the member wallet token for company wallet routes', async () => {
    const authorizations: Array<string | null> = [];
    const result = await ensureAgentCardSandboxFloat(
      { ...ADMIN, walletToken: 'member-wallet-token' },
      'org-1',
      50_000,
      (async (_url: string, init: RequestInit) => {
        authorizations.push(new Headers(init.headers).get('authorization'));
        if (init.method === 'POST') return jsonResponse(200, { sandboxWalletBalanceCents: 50_000 });
        return jsonResponse(200, { settings: { sandbox_balance_cents: 28_020 } });
      }) as typeof fetch
    );

    assert.deepEqual(result, { previousCents: 28_020, balanceCents: 50_000, addedCents: 21_980 });
    assert.deepEqual(authorizations, ['Bearer member-wallet-token', 'Bearer member-wallet-token']);
  });

  await test('ensureAgentCardSandboxFloat keeps using the primary token without a wallet token', async () => {
    const authorizations: Array<string | null> = [];
    const result = await ensureAgentCardSandboxFloat(ADMIN, 'org-1', 50_000, (async (
      _url: string,
      init: RequestInit
    ) => {
      authorizations.push(new Headers(init.headers).get('authorization'));
      if (init.method === 'POST') return jsonResponse(200, { sandboxWalletBalanceCents: 50_000 });
      return jsonResponse(200, { settings: { sandbox_balance_cents: 40_000 } });
    }) as typeof fetch);

    assert.deepEqual(result, { previousCents: 40_000, balanceCents: 50_000, addedCents: 10_000 });
    assert.deepEqual(authorizations, ['Bearer jwt-token', 'Bearer jwt-token']);
  });

  await test('ensureAgentCardSandboxFloat rejects malformed wallet responses', async () => {
    await assert.rejects(
      () =>
        ensureAgentCardSandboxFloat(ADMIN, 'org-1', 50_000, (async () =>
          jsonResponse(200, { settings: {} })) as typeof fetch),
      /omitted sandbox balance/
    );
    await assert.rejects(
      () =>
        ensureAgentCardSandboxFloat(ADMIN, 'org-1', 50_000, (async (
          _url: string,
          init: RequestInit
        ) =>
          init.method === 'POST'
            ? jsonResponse(200, {})
            : jsonResponse(200, { settings: { sandbox_balance_cents: 10_000 } })) as typeof fetch),
      /test-fund response omitted/
    );
    await assert.rejects(
      () =>
        ensureAgentCardSandboxFloat(ADMIN, 'org-1', 50_000, (async () =>
          jsonResponse(500, {})) as typeof fetch),
      /HTTP 500/
    );
  });

  await test('loadAgentCardBenchmarkAdmin reads the env JWT + API url override', async () => {
    const prevJwt = process.env.AGENT_CARDS_ADMIN_JWT;
    const prevUrl = process.env.ADMIN_API_URL;
    process.env.AGENT_CARDS_ADMIN_JWT = 'env-jwt';
    process.env.ADMIN_API_URL = 'https://admin.override.test';
    try {
      const admin = await loadAgentCardBenchmarkAdmin();
      assert.equal(admin.token, 'env-jwt');
      assert.equal(admin.apiUrl, 'https://admin.override.test');
    } finally {
      if (prevJwt === undefined) delete process.env.AGENT_CARDS_ADMIN_JWT;
      else process.env.AGENT_CARDS_ADMIN_JWT = prevJwt;
      if (prevUrl === undefined) delete process.env.ADMIN_API_URL;
      else process.env.ADMIN_API_URL = prevUrl;
    }
  });

  await test('benchmark admin token prefers active stored API key over stale file JWT', () => {
    const token = selectAgentCardBenchmarkAdminToken(
      {
        jwt: 'stale-jwt',
        lastApiKey: 'last-api-key',
        activeKeyId: 'active-key-id',
        storedKeys: [
          { id: 'old-key-id', key: 'old-api-key' },
          { id: 'active-key-id', key: 'active-api-key' },
        ],
      },
      {}
    );
    assert.equal(token, 'active-api-key');
  });

  await test('benchmark admin token skips an expired access JWT for the active API key', () => {
    const token = selectAgentCardBenchmarkAdminToken(
      {
        accessToken: jwtWithExpiration(Math.floor(Date.now() / 1000) - 1),
        activeKeyId: 'active-key-id',
        storedKeys: [{ id: 'active-key-id', key: 'active-api-key' }],
      },
      {}
    );
    assert.equal(token, 'active-api-key');
  });

  await test('benchmark admin token keeps a live access JWT ahead of stored API keys', () => {
    const accessToken = jwtWithExpiration(Math.floor(Date.now() / 1000) + 300);
    const token = selectAgentCardBenchmarkAdminToken(
      {
        accessToken,
        activeKeyId: 'active-key-id',
        storedKeys: [{ id: 'active-key-id', key: 'active-api-key' }],
      },
      {}
    );
    assert.equal(token, accessToken);
  });

  await test('benchmark wallet token prefers the user CLI session over admin API keys', () => {
    const token = selectAgentCardBenchmarkWalletToken(
      { jwt: 'cli-member-jwt' },
      {
        jwt: 'stale-admin-jwt',
        lastApiKey: 'last-api-key',
        activeKeyId: 'active-key-id',
        storedKeys: [{ id: 'active-key-id', key: 'active-api-key' }],
      },
      {}
    );
    assert.equal(token, 'cli-member-jwt');
  });

  await test('benchmark wallet token drops expired sessions so the admin token can be used', () => {
    const token = selectAgentCardBenchmarkWalletToken(
      { accessToken: jwtWithExpiration(Math.floor(Date.now() / 1000) - 1) },
      { jwt: jwtWithExpiration(Math.floor(Date.now() / 1000) - 1) },
      {}
    );
    assert.equal(token, undefined);
  });

  await test('benchmark session refresh rotates the short-lived credential pair', async () => {
    let receivedUrl = '';
    let receivedBody: unknown;
    const refreshed = await refreshAgentCardSession(
      'https://api.agentcard.test',
      'old-refresh-token',
      (async (url: string, init: RequestInit) => {
        receivedUrl = url;
        receivedBody = JSON.parse(String(init.body));
        return jsonResponse(200, {
          accessToken: 'new-access-token',
          refreshToken: 'new-refresh-token',
        });
      }) as typeof fetch
    );
    assert.equal(receivedUrl, 'https://api.agentcard.test/auth/refresh');
    assert.deepEqual(receivedBody, { refreshToken: 'old-refresh-token' });
    assert.deepEqual(refreshed, {
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
  });

  await test('benchmark session refresh fails closed on rejected or malformed responses', async () => {
    const rejected = await refreshAgentCardSession(
      'https://api.agentcard.test',
      'old-refresh-token',
      (async () => jsonResponse(401, { error: 'expired' })) as typeof fetch
    );
    assert.equal(rejected, undefined);

    const malformed = await refreshAgentCardSession(
      'https://api.agentcard.test',
      'old-refresh-token',
      (async () =>
        jsonResponse(200, { accessToken: 'missing-rotated-refresh-token' })) as typeof fetch
    );
    assert.equal(malformed, undefined);
  });

  // ── org-wallet-monitor extraction + message ──
  await test('extractAgentCardOrgWallet rejects missing wallet and missing numbers', () => {
    assert.throws(
      () => extractAgentCardOrgWallet({ structuredContent: {} }),
      /no structured wallet/
    );
    assert.throws(
      () =>
        extractAgentCardOrgWallet({
          structuredContent: { wallet: { livemode: true, committed_cents: 0, available_cents: 0 } },
        }),
      /missing balance_cents/
    );
  });

  await test('low-balance alert falls back to the configured deposit address', async () => {
    const messages: string[] = [];
    const result = await monitorAgentCardOrgWallet({
      thresholdCents: 10_000,
      alertPhone: '+15555550100',
      reloadUrl: 'https://app.agentcard.sh/org/org-1',
      fallbackDepositAddress: '0xfallback',
      callOrgTool: async () => ({
        structuredContent: {
          wallet: { livemode: true, balance_cents: 500, committed_cents: 0, available_cents: 500 },
        },
      }),
      sendSms: async (_phone, message) => {
        messages.push(message);
        return { success: true, messageSid: 'sms-fallback' };
      },
      store: {
        claim: async () => true,
        markSent: async () => {},
        release: async () => {},
        rearm: async () => {},
      },
    });
    assert.equal(result.status, 'alerted');
    assert.match(messages[0], /0xfallback/);
  });

  await test('createAgentCardOrgWalletAlertStore claims once, dedupes, and re-arms', async () => {
    const store = createAgentCardOrgWalletAlertStore();
    await store.rearm(); // clear any residue from prior runs
    const wallet: AgentCardOrgWallet = {
      livemode: true,
      balanceCents: 100,
      committedCents: 0,
      availableCents: 100,
    };
    assert.equal(await store.claim(wallet), true, 'first claim wins');
    assert.equal(await store.claim(wallet), false, 'second concurrent claim is deduped');
    await store.markSent('sms-store-1');
    const sent = await prisma.toolSideEffect.findUnique({
      where: { operationKey: ALERT_OPERATION_KEY },
    });
    assert.equal(sent?.status, 'SUCCEEDED');
    assert.equal(sent?.externalId, 'sms-store-1');
    await store.rearm();
    assert.equal(
      await prisma.toolSideEffect.findUnique({ where: { operationKey: ALERT_OPERATION_KEY } }),
      null
    );
    // claim + release round-trips back to no active claim.
    assert.equal(await store.claim(wallet), true);
    await store.release();
    assert.equal(
      await prisma.toolSideEffect.findUnique({ where: { operationKey: ALERT_OPERATION_KEY } }),
      null
    );
  });

  await test('runAgentCardOrgWalletMonitor is disabled without alert config', async () => {
    const prevPhone = process.env.AGENTCARD_ORG_LOW_BALANCE_ALERT_PHONE;
    const prevUrl = process.env.AGENTCARD_ORG_WALLET_RELOAD_URL;
    delete process.env.AGENTCARD_ORG_LOW_BALANCE_ALERT_PHONE;
    delete process.env.AGENTCARD_ORG_WALLET_RELOAD_URL;
    try {
      const result = await runAgentCardOrgWalletMonitor();
      assert.equal(result.status, 'disabled');
    } finally {
      if (prevPhone !== undefined) process.env.AGENTCARD_ORG_LOW_BALANCE_ALERT_PHONE = prevPhone;
      if (prevUrl !== undefined) process.env.AGENTCARD_ORG_WALLET_RELOAD_URL = prevUrl;
    }
  });

  // ── sandbox-settlement real markPurchaseCleared transaction ──
  await test('settleAgentCardSandboxPayment clears the matched purchase in Postgres', async () => {
    const userId = await seedUser();
    const purchase = await prisma.purchaseSpend.create({
      data: {
        userId,
        fingerprint: `fp-${randomUUID()}`,
        merchant: 'Rose Labs Test Payment',
        lineItemsJson: { totalCents: 4396 },
        totalCents: 4396,
        status: PurchaseSpendStatus.HELD,
        cardId: `card-${randomUUID()}`,
        stripePaymentIntentId: `pi_${randomUUID()}`,
      },
    });
    await prisma.purchaseWalletFunding.create({
      data: {
        purchaseId: purchase.id,
        userId,
        amountCents: 4396,
        currency: 'usd',
        status: PurchaseWalletFundingStatus.FUNDED,
        providerTransferId: `owt_${randomUUID()}`,
        idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
      },
    });
    const result = await settleAgentCardSandboxPayment(
      { cardNumber: '4242424242420640', amountCents: 4396, merchant: 'Rose Labs Test Payment' },
      {
        findHeldPurchasesByTotal: async () => [
          {
            id: purchase.id,
            userId,
            cardId: purchase.cardId,
            stripePaymentIntentId: purchase.stripePaymentIntentId,
          },
        ],
        getCardPan: async () => '4242 4242 4242 0640',
        testCharge: async () => ({}),
        // Use the real markPurchaseCleared (default) to exercise the DB transaction.
      }
    );
    assert.equal(result.purchaseId, purchase.id);
    const cleared = await prisma.purchaseSpend.findUnique({ where: { id: purchase.id } });
    assert.equal(cleared?.status, PurchaseSpendStatus.CLEARED);
    const funding = await prisma.purchaseWalletFunding.findUnique({
      where: { purchaseId: purchase.id },
    });
    assert.equal(funding?.status, PurchaseWalletFundingStatus.CONSUMED);
  });

  await test('settleAgentCardSandboxPayment never overwrites already-reclaimed funding', async () => {
    const userId = await seedUser();
    const purchase = await prisma.purchaseSpend.create({
      data: {
        userId,
        fingerprint: `fp-${randomUUID()}`,
        merchant: 'Rose Labs Test Payment',
        lineItemsJson: { totalCents: 4396 },
        totalCents: 4396,
        status: PurchaseSpendStatus.HELD,
        cardId: `card-${randomUUID()}`,
        stripePaymentIntentId: `pi_${randomUUID()}`,
      },
    });
    // A concurrent abandonment cleanup already reclaimed the org-wallet transfer.
    await prisma.purchaseWalletFunding.create({
      data: {
        purchaseId: purchase.id,
        userId,
        amountCents: 4396,
        currency: 'usd',
        status: PurchaseWalletFundingStatus.RECLAIMED,
        providerTransferId: `owt_${randomUUID()}`,
        idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
        reclaimedAt: new Date(),
      },
    });
    await assert.rejects(
      () =>
        settleAgentCardSandboxPayment(
          { cardNumber: '4242424242420640', amountCents: 4396, merchant: 'Rose Labs Test Payment' },
          {
            findHeldPurchasesByTotal: async () => [
              {
                id: purchase.id,
                userId,
                cardId: purchase.cardId,
                stripePaymentIntentId: purchase.stripePaymentIntentId,
              },
            ],
            getCardPan: async () => '4242 4242 4242 0640',
            testCharge: async () => ({}),
            // Real claim + markPurchaseCleared to exercise the DB guard.
          }
        ),
      /already reclaimed or is missing/
    );
    // The reclaimed funding must be untouched (float not double-counted), and the purchase must NOT
    // be marked CLEARED.
    const funding = await prisma.purchaseWalletFunding.findUnique({
      where: { purchaseId: purchase.id },
    });
    assert.equal(funding?.status, PurchaseWalletFundingStatus.RECLAIMED);
    const settled = await prisma.purchaseSpend.findUnique({ where: { id: purchase.id } });
    assert.notEqual(settled?.status, PurchaseSpendStatus.CLEARED);
  });

  await test('settleAgentCardSandboxPayment rejects a matched purchase with no Stripe hold', async () => {
    const userId = await seedUser();
    await assert.rejects(
      () =>
        settleAgentCardSandboxPayment(
          { cardNumber: '4242424242420640', amountCents: 4396, merchant: 'Rose Labs Test Payment' },
          {
            findHeldPurchasesByTotal: async () => [
              { id: 'p-no-hold', userId, cardId: 'card-x', stripePaymentIntentId: null },
            ],
            getCardPan: async () => '4242424242420640',
            testCharge: async () => ({}),
          }
        ),
      /missing its Stripe hold/
    );
  });

  process.stdout.write(
    `\nAgentCard provider-extras unit tests: ${passed} passed, ${failures.length} failed\n`
  );
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

async function cleanup(): Promise<void> {
  await prisma.toolSideEffect.deleteMany({ where: { operationKey: ALERT_OPERATION_KEY } });
  for (const userId of createdUserIds) {
    await prisma.user.deleteMany({ where: { userId } });
  }
  await prisma.$disconnect();
}

main()
  .then(async () => {
    await cleanup();
    if (failures.length > 0) process.exit(1);
  })
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await cleanup();
    process.exit(1);
  });
