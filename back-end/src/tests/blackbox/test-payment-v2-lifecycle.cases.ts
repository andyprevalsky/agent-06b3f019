import assert from 'node:assert/strict';
import { PurchaseSpendStatus } from '@prisma/client';
import {
  settleAgentCardSandboxPayment,
  AgentCardSandboxSettlementError,
  findHeldPurchasesByTotal,
} from '../../providers/agentcard/sandbox-settlement';
import { classifyLifecycleError } from '../../domains/test-payment/lifecycle-errors';
import { getTestPaymentLifecycle } from '../../domains/test-payment/lifecycle';
import { AgentCardV2Error, type AgentCardV2Request } from '../../providers/agentcard/api-v2';
import { AgentCardProviderError } from '../../providers/card-provider';
import { prisma } from '../../providers/database';

const at = new Date('2026-11-09T00:00:00Z');
const transfer = {
  object: 'company_wallet_transfer',
  id: 'owt_v2',
  status: 'consumed',
  user_id: 'usr_own',
  card_id: 'card_v2',
  amount_cents: 4396,
  transferred_cents: 4396,
  released_cents: 0,
  livemode: false,
  created_at: at.toISOString(),
};
const card = {
  object: 'card',
  id: 'card_v2',
  user_id: 'usr_own',
  status: 'closed',
  balance_cents: 0,
  spend_limit_cents: 4396,
  created_at: at.toISOString(),
};
const purchase = {
  id: 'p-v2',
  userId: 'rose-user',
  agentId: 'a-v2',
  status: PurchaseSpendStatus.HELD,
  merchant: 'Rose Labs Test Payment',
  totalCents: 4396,
  cardId: card.id,
  stripePaymentIntentId: 'pi-v2',
  stripeLivemode: false,
  createdAt: at,
  walletFunding: {
    status: 'FUNDED',
    amountCents: 4396,
    providerTransferId: transfer.id,
    reclaimProviderTransferId: null,
    metadata: { apiVersion: 2 },
  },
};
const forbidden = async () => {
  throw new Error('LEGACY_MCP_MUST_NOT_BE_USED_FOR_V2');
};
const owner = async () => 'usr_own';

export async function assertV2SandboxSettlementContract(): Promise<void> {
  let posts = 0;
  let cleared = 0;
  let released = 0;
  let walletLive: unknown = false;
  let nativeTransfer: Record<string, unknown> = transfer;
  let transactionStatus = 'cleared';
  let embeddedOwner: string | null | undefined = 'usr_own';
  let embeddedCardId = card.id;
  let throwAfterPost = false;
  let throwAfterClear = false;
  const api: AgentCardV2Request = async (method, path, body, key) => {
    if (path === '/api/v2/company_wallet') return { livemode: walletLive };
    if (path === '/api/v2/company_wallet/transfers/owt_v2') return nativeTransfer;
    if (method === 'GET' && path === '/api/v2/cards/card_v2')
      return { ...card, status: 'open', balance_cents: 4396 };
    assert.equal(method, 'POST');
    assert.equal(path, '/api/v2/cards/card_v2/test_charge');
    assert.deepEqual(body, {
      amount_cents: 4396,
      merchant: 'Rose Labs Test Payment',
    });
    assert.equal(key, undefined, 'non-idempotent test_charge must not opt into transport replay');
    posts += 1;
    if (throwAfterPost) throw new Error('response lost after charge');
    return {
      object: 'test_transaction',
      id: 'txn-own',
      card_id: card.id,
      amount_cents: 4396,
      simulated: true,
      status: transactionStatus,
      card: { ...card, id: embeddedCardId, user_id: embeddedOwner },
    };
  };
  const run = (override: Record<string, unknown> = {}) =>
    settleAgentCardSandboxPayment(
      {
        cardNumber: '4242424242420640',
        amountCents: 4396,
        merchant: 'Rose Labs Test Payment',
      },
      {
        findHeldPurchasesByTotal: async () => [{ ...purchase, ...override }],
        findClearedPurchasesByTotal: async () => [],
        getCardPan: async () => '4242424242420640',
        claimHeldPurchaseForCharge: async () => true,
        releaseHeldPurchaseClaim: async () => {
          released += 1;
        },
        markPurchaseCleared: async () => {
          if (throwAfterClear) throw new Error('database response lost');
          cleared += 1;
        },
        v2Request: api,
        getV2OwnerId: owner,
      } as never
    );
  assert.equal((await run()).purchaseId, purchase.id);
  assert.equal(posts, 1);
  assert.equal(cleared, 1);
  for (const optionalOwner of [null, undefined]) {
    embeddedOwner = optionalOwner;
    await run();
  }
  embeddedOwner = 'usr_foreign';
  await assert.rejects(() => run(), /card.user_id/);
  embeddedOwner = 'usr_own';
  embeddedCardId = 'card_foreign';
  await assert.rejects(() => run(), /card.id/);
  embeddedCardId = card.id;
  const acceptedPosts = posts;
  const acceptedClears = cleared;
  for (const mode of [true, undefined, 'false']) {
    walletLive = mode;
    await assert.rejects(
      () => run(),
      (error) => error instanceof AgentCardSandboxSettlementError && error.statusCode === 409
    );
  }
  walletLive = false;
  await assert.rejects(() => run({ stripeLivemode: true }), AgentCardSandboxSettlementError);
  for (const changed of [
    { user_id: 'usr_foreign' },
    { card_id: 'card_foreign' },
    { amount_cents: 4397 },
    { livemode: true },
    { livemode: undefined },
  ]) {
    nativeTransfer = { ...transfer, ...changed };
    await assert.rejects(() => run(), AgentCardSandboxSettlementError);
  }
  nativeTransfer = transfer;
  assert.equal(posts, acceptedPosts, 'wrong ownership, amount or mode must fail before any write');
  for (const status of ['authorized', 'voided', 'refunded']) {
    transactionStatus = status;
    const releasedBefore = released;
    await assert.rejects(() => run(), AgentCardSandboxSettlementError);
    assert.equal(
      released,
      releasedBefore,
      'ambiguous/non-cleared charge must not rearm the non-idempotent POST'
    );
  }
  assert.equal(cleared, acceptedClears, 'only the provider cleared status may clear the purchase');
  transactionStatus = 'cleared';
  throwAfterPost = true;
  const releasedBefore = released;
  await assert.rejects(() => run(), AgentCardSandboxSettlementError);
  assert.equal(released, releasedBefore, 'lost charge response must retain the purchase claim');
  throwAfterPost = false;
  throwAfterClear = true;
  const beforeClearFailure = released;
  await assert.rejects(() => run(), /database response lost/);
  assert.equal(
    released,
    beforeClearFailure,
    'confirmed charge followed by DB failure must never rearm test_charge'
  );
  console.log(
    'PASS v2 sandbox settlement uses owned REST transaction with strict mode/status and no ambiguous replay'
  );
  await assertV2SandboxLedgerRecoveryContract();
}

async function assertV2SandboxLedgerRecoveryContract(): Promise<void> {
  let cleared = 0;
  let posts = 0;
  let status: PurchaseSpendStatus = PurchaseSpendStatus.CHARGING;
  const paid = {
    object: 'transaction',
    id: 'txn_paid',
    source: 'issued',
    status: 'cleared',
    amount: 4396,
    currency: null,
    merchant: 'Rose Labs Test Payment',
    user_id: 'usr_own',
    card_id: card.id,
  };
  let rows: unknown[] = [paid];
  let hasMore = false;
  let providerUnavailable = false;
  const run = () =>
    settleAgentCardSandboxPayment(
      { cardNumber: '4242424242420640', amountCents: 4396, merchant: paid.merchant },
      {
        findHeldPurchasesByTotal: async () => [{ ...purchase, status }],
        findClearedPurchasesByTotal: async () => [],
        getCardPan: async () => {
          throw new AgentCardProviderError('closed', 409, undefined, 'card_closed');
        },
        getPurchaseCardLast4Hint: async () => '0640',
        getV2OwnerId: owner,
        claimHeldPurchaseForCharge: async () => {
          status = PurchaseSpendStatus.CHARGING;
          return true;
        },
        releaseHeldPurchaseClaim: async () => {
          throw new Error('must never rearm a possibly charged card');
        },
        markPurchaseCleared: async () => {
          cleared += 1;
        },
        v2Request: async (method, path) => {
          if (method !== 'GET') {
            posts += 1;
            throw new Error('recovery must never charge');
          }
          if (providerUnavailable) throw new AgentCardV2Error('read unavailable', 503);
          if (path === '/api/v2/company_wallet') return { livemode: false };
          if (path === '/api/v2/company_wallet/transfers/owt_v2') return transfer;
          if (path === '/api/v2/cards/card_v2') return card;
          const url = new URL(path, 'https://fixture.invalid');
          assert.equal(url.pathname, '/api/v2/transactions');
          assert.equal(url.searchParams.get('card_id'), card.id);
          assert.equal(url.searchParams.get('user_id'), 'usr_own');
          assert.equal(url.searchParams.get('status'), 'cleared');
          return { object: 'list', data: rows, has_more: hasMore, cursor: null };
        },
      }
    );
  await run();
  assert.equal(
    cleared,
    1,
    'an exact authoritative cleared charge must recover CHARGING without a second POST'
  );
  status = PurchaseSpendStatus.HELD;
  await run();
  assert.equal(cleared, 2, 'a closed HELD card with exact ledger proof may settle');
  for (const bad of [
    [],
    [{ ...paid, status: 'authorized' }],
    [{ ...paid, amount: 4395 }],
    [{ ...paid, user_id: 'usr_foreign' }],
    [{ ...paid, card_id: 'card_foreign' }],
    [{ ...paid, merchant: 'Other merchant' }],
    [paid, paid],
    [{ ...paid, source: 'vault' }],
  ]) {
    status = PurchaseSpendStatus.CHARGING;
    rows = bad;
    await assert.rejects(run, AgentCardSandboxSettlementError);
    assert.equal(
      cleared,
      2,
      'absent, unconfirmed, partial, duplicated or foreign ledger must remain pending'
    );
  }
  rows = [paid];
  hasMore = true;
  await assert.rejects(run, AgentCardSandboxSettlementError);
  hasMore = false;
  providerUnavailable = true;
  await assert.rejects(run);
  assert.equal(cleared, 2);
  assert.equal(posts, 0, 'every recovery arm is read-only at the provider');
}

export async function assertV2SandboxLedgerDatabaseContract(): Promise<void> {
  const host = new URL(process.env.DATABASE_URL ?? '').hostname;
  assert.ok(
    ['localhost', '127.0.0.1', '::1'].includes(host),
    'database regression requires local blackbox DB'
  );
  const userId = `sandbox-ledger-${crypto.randomUUID()}`;
  await prisma.user.create({ data: { userId } });
  try {
    const stored = await prisma.purchaseSpend.create({
      data: {
        userId,
        fingerprint: userId,
        merchant: 'Rose Labs Test Payment',
        totalCents: 4396,
        lineItemsJson: [],
        status: PurchaseSpendStatus.CHARGING,
        cardId: card.id,
        stripePaymentIntentId: 'pi_fixture',
        stripeLivemode: false,
        walletFunding: {
          create: {
            userId,
            amountCents: 4396,
            idempotencyKey: userId,
            status: 'FUNDED',
            providerTransferId: transfer.id,
            metadata: { apiVersion: 2 },
          },
        },
      },
      include: { walletFunding: true },
    });
    assert.ok(
      (await findHeldPurchasesByTotal(4396)).some(
        (candidate) => candidate.id === stored.id && candidate.status === 'CHARGING'
      ),
      'the production candidate query must retain ambiguous CHARGING cards for ledger recovery'
    );
    let rows: unknown[] = [
      {
        object: 'transaction',
        id: 'txn_owned',
        source: 'issued',
        status: 'cleared',
        amount: 4396,
        currency: null,
        merchant: stored.merchant,
        user_id: 'usr_own',
        card_id: card.id,
      },
    ];
    const run = () =>
      settleAgentCardSandboxPayment(
        { cardNumber: '4242424242420640', amountCents: 4396, merchant: stored.merchant },
        {
          findHeldPurchasesByTotal: async () => [stored],
          findClearedPurchasesByTotal: async () => [],
          getCardPan: async () => {
            throw new AgentCardProviderError('closed', 409, undefined, 'card_closed');
          },
          getPurchaseCardLast4Hint: async () => '0640',
          getV2OwnerId: owner,
          v2Request: async (method, path) => {
            assert.equal(method, 'GET', 'database recovery never makes a vendor write');
            if (path === '/api/v2/company_wallet') return { livemode: false };
            if (path.includes('/company_wallet/transfers/')) return transfer;
            if (path === '/api/v2/cards/card_v2') return card;
            assert.ok(path.startsWith('/api/v2/transactions?'));
            return { object: 'list', data: rows, has_more: false, cursor: null };
          },
        }
      );
    await run();
    let actual = await prisma.purchaseSpend.findUniqueOrThrow({
      where: { id: stored.id },
      include: { walletFunding: true },
    });
    assert.equal(actual.status, 'CLEARED');
    assert.equal(actual.walletFunding?.status, 'CONSUMED');
    await prisma.purchaseSpend.update({ where: { id: stored.id }, data: { status: 'CHARGING' } });
    await prisma.purchaseWalletFunding.update({
      where: { purchaseId: stored.id },
      data: { status: 'FUNDED' },
    });
    rows = [];
    await assert.rejects(run, AgentCardSandboxSettlementError);
    actual = await prisma.purchaseSpend.findUniqueOrThrow({
      where: { id: stored.id },
      include: { walletFunding: true },
    });
    assert.equal(actual.status, 'CHARGING');
    assert.equal(actual.walletFunding?.status, 'FUNDED');
    rows = [
      {
        object: 'transaction',
        id: 'txn_owned',
        source: 'issued',
        status: 'cleared',
        amount: 4396,
        currency: null,
        merchant: stored.merchant,
        user_id: 'usr_own',
        card_id: card.id,
      },
    ];
    for (const fundingStatus of ['RECLAIMING', 'RECLAIMED'] as const) {
      await prisma.purchaseWalletFunding.update({
        where: { purchaseId: stored.id },
        data: { status: fundingStatus },
      });
      await assert.rejects(run, AgentCardSandboxSettlementError);
      actual = await prisma.purchaseSpend.findUniqueOrThrow({
        where: { id: stored.id },
        include: { walletFunding: true },
      });
      assert.equal(
        actual.status,
        'CHARGING',
        'failed funding transition rolls back purchase clear'
      );
      assert.equal(
        actual.walletFunding?.status,
        fundingStatus,
        'in-flight/completed reclaim must not be overwritten'
      );
    }
  } finally {
    await prisma.user.delete({ where: { userId } });
  }
}

export async function assertV2LifecycleContract(): Promise<void> {
  const requests: string[] = [];
  let nativeCard: Record<string, unknown> = card;
  let nativeTransfer: Record<string, unknown> = transfer;
  let cycle = false;
  const api: AgentCardV2Request = async (method, path) => {
    assert.equal(method, 'GET', 'lifecycle reads must never mutate');
    requests.push(path);
    if (path === '/api/v2/cards/card_v2') return nativeCard;
    if (path === '/api/v2/company_wallet/transfers/owt_v2') return nativeTransfer;
    const url = new URL(`https://provider.invalid${path}`);
    assert.equal(url.searchParams.get('user_id'), 'usr_own');
    assert.equal(url.searchParams.get('limit'), '100');
    if (url.pathname === '/api/v2/cards') {
      return { data: [card], has_more: cycle, cursor: cycle ? 'same' : null };
    }
    assert.equal(url.pathname, '/api/v2/company_wallet/transfers');
    if (!url.searchParams.has('cursor'))
      return {
        data: [{ ...transfer, id: 'owt-orphan', card_id: null }],
        has_more: true,
        cursor: 'next+opaque',
      };
    assert.equal(url.searchParams.get('cursor'), 'next+opaque');
    return { data: [transfer], has_more: false, cursor: null };
  };
  const dependencies = {
    findPurchase: async () => ({
      ...purchase,
      status: PurchaseSpendStatus.CLEARED,
    }),
    findPurchaseLifecycleIntegrity: async () => ({
      purchaseCount: 1,
      walletFundingCount: 1,
      stripePaymentIntentCount: 1,
      cardCount: 1,
    }),
    findAttentionRequests: async () => [],
    getOrgCardholderId: forbidden,
    getCardSummary: forbidden,
    listOrgCards: forbidden,
    listOrgTransfers: forbidden,
    retrieveStripeHold: async () => ({
      id: 'pi-v2',
      status: 'succeeded',
      amount: 4396,
      amount_received: 4396,
      amount_capturable: 0,
      livemode: false,
    }),
    listStripeRefunds: async () => ({ data: [] }),
    searchStripeHolds: async () => ({ data: [{ id: 'pi-v2' }] }),
    v2Request: api,
    getV2OwnerId: owner,
  };
  const result = await getTestPaymentLifecycle('a-v2', dependencies as never);
  assert.equal(result.agentCard?.status, 'closed');
  assert.equal(result.agentCard?.balanceCents, 0);
  assert.equal(result.orgTransfer?.id, 'owt_v2');
  assert.equal(result.orgTransfer?.status, 'consumed');
  assert.equal(result.integrity.agentCardProviderCardCount, 1);
  assert.equal(result.integrity.agentCardProviderTransferCount, 2);
  assert.equal(
    result.integrity.agentCardProviderUnlinkedTransferCount,
    1,
    'unlinked transfers must remain visible'
  );
  assert.ok(requests.includes('/api/v2/company_wallet/transfers/owt_v2'));
  for (const changed of [
    { user_id: 'usr-foreign' },
    { livemode: true },
    { livemode: undefined },
    { amount_cents: 4397 },
    { status: 'released' },
  ]) {
    nativeTransfer = { ...transfer, ...changed };
    await assert.rejects(() => getTestPaymentLifecycle('a-v2', dependencies as never));
  }
  nativeTransfer = { ...transfer, status: 'pending', released_cents: 0 };
  assert.equal(
    (await getTestPaymentLifecycle('a-v2', dependencies as never)).orgTransfer?.status,
    'pending'
  );
  nativeTransfer = transfer;
  nativeCard = { ...card, status: 'closing', balance_cents: 17 };
  const closing = await getTestPaymentLifecycle('a-v2', dependencies as never);
  assert.equal(closing.agentCard?.status, 'closing');
  assert.equal(closing.agentCard?.balanceCents, 17);
  cycle = true;
  await assert.rejects(
    () => getTestPaymentLifecycle('a-v2', dependencies as never),
    /pagination did not advance/
  );
  cycle = false;
  await assert.rejects(
    () =>
      getTestPaymentLifecycle('a-v2', {
        ...dependencies,
        v2Request: async () => {
          throw new AgentCardV2Error('provider unavailable', 503, 'balance_unavailable');
        },
      } as never),
    AgentCardV2Error
  );
  const mappedError = classifyLifecycleError(
    new AgentCardV2Error('provider unavailable', 503, 'balance_unavailable'),
    'fallback'
  );
  assert.equal(mappedError.status, 503);
  assert.equal(mappedError.body.code, 'balance_unavailable');
  console.log(
    'PASS v2 lifecycle exact transfer, structured card, user-scoped cursor integrity and native pending states'
  );
}
