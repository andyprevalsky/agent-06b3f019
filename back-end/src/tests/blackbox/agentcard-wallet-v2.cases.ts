import assert from 'node:assert/strict';
import { AgentCardV2Error, type AgentCardV2Request } from '../../providers/agentcard/api-v2';
import {
  AgentCardV2WalletFundingProvider,
  AgentCardWalletFundingRouter,
  getV2WalletOwnerId,
} from '../../providers/agentcard/wallet-v2';
import {
  createWalletFundingProvider,
  WalletFundingProviderError,
  type WalletFundingProvider,
} from '../../providers/wallet-funding';

/** Runs in the existing wallet unit and treasury pending-mints blackbox gates; no vendor writes. */
export async function assertV2WalletContract(): Promise<void> {
  const request = {
    userId: 'rose-user',
    purchaseId: 'purchase-old',
    amountCents: 100,
    currency: 'usd',
    idempotencyKey: 'purchase-wallet-reclaim:purchase-old',
    providerTransferId: 'owt-old',
    cardId: 'card-own',
    reason: 'agent_cleanup_unspent_card',
  };
  const transfer = {
    id: 'owt-old',
    user_id: 'usr-own',
    cardholder_id: 'ch-never-a-user',
    card_id: 'card-own',
    amount_cents: 100,
    transferred_cents: 100,
    released_cents: 0,
    status: 'consumed',
  };
  const resolveUser = async (id: string) => {
    assert.equal(id, 'rose-user');
    return 'usr-own';
  };
  const pending = (error: unknown) =>
    error instanceof WalletFundingProviderError &&
    error.code === 'agentcard_company_transfer_release_pending';
  const mismatch = (error: unknown) =>
    error instanceof WalletFundingProviderError &&
    error.code === 'agentcard_company_transfer_owner_mismatch';

  const retainedConfig = {
    v2UserId: 'usr-unscoped-must-not-authorize',
    v2Bindings: { 'client-current': 'usr-own', 'client-historical': 'usr-old-mode' },
  };
  let retainedReads = 0;
  const retainedRepo = {
    findTokenConfig: async (userId: string) => {
      retainedReads += 1;
      assert.equal(userId, request.userId);
      return retainedConfig;
    },
  };
  const retainedOwner = (userId: string) =>
    getV2WalletOwnerId(userId, retainedRepo, 'client-current');
  assert.equal(await retainedOwner(request.userId), 'usr-own');
  assert.equal(await getV2WalletOwnerId(request.userId, retainedRepo, 'other-client'), undefined);
  const disconnectedApi: AgentCardV2Request = async (method) => {
    assert.equal(method, 'GET', 'a confirmed release must never cause another recovery');
    return { ...transfer, status: 'reclaimed', released_cents: 100 };
  };
  const disconnectedWallet = new AgentCardV2WalletFundingProvider(disconnectedApi, retainedOwner, {
    attempts: 1,
    delayMs: 0,
  });
  const neverLegacy: WalletFundingProvider = {
    fundUserWallet: async () => ({}),
    confirmCollection: async () => {
      throw new Error('must not reconnect or use legacy');
    },
    reclaimUserWalletFunding: async () => {
      throw new Error('must not reconnect or use legacy');
    },
  };
  const disconnectedRouter = new AgentCardWalletFundingRouter(
    disconnectedApi,
    async () => undefined,
    neverLegacy,
    disconnectedWallet,
    neverLegacy,
    async () => undefined,
    retainedOwner
  );
  assert.equal(
    (await disconnectedRouter.fundUserWallet(request)).metadata,
    undefined,
    'retained cleanup ownership must not admit disconnected users to the v2 funding rail'
  );
  assert.equal(
    (await disconnectedRouter.reclaimUserWalletFunding(request)).metadata?.status,
    'release_confirmed',
    'disconnected retained ownership must still authorize exact-transfer cleanup'
  );
  assert.ok(retainedReads > 0);
  for (const config of [
    undefined,
    { v2UserId: 'usr-own' },
    { v2Bindings: { 'client-historical': 'usr-own' } },
    { v2Bindings: { 'client-current': '' } },
    { v2Bindings: ['usr-own'] },
  ]) {
    const unknownOwner = (userId: string) =>
      getV2WalletOwnerId(userId, { findTokenConfig: async () => config }, 'client-current');
    assert.equal(await unknownOwner(request.userId), undefined);
    await assert.rejects(
      () =>
        new AgentCardWalletFundingRouter(
          disconnectedApi,
          async () => undefined,
          neverLegacy,
          disconnectedWallet,
          neverLegacy,
          async () => undefined,
          unknownOwner
        ).reclaimUserWalletFunding(request),
      mismatch
    );
  }
  let disconnectedRecovered = false;
  const disconnectedRecoveryApi: AgentCardV2Request = async (method, path, body, key) => {
    if (method === 'POST') {
      assert.equal(path, '/api/v2/company_wallet/recoveries');
      assert.deepEqual(body, { user_id: 'usr-own', amount_cents: 100 });
      assert.equal(key, `${request.idempotencyKey}:recovery:owt-old`);
      disconnectedRecovered = true;
      return { status: 'requested' };
    }
    return {
      ...transfer,
      status: disconnectedRecovered ? 'reclaimed' : 'consumed',
      released_cents: disconnectedRecovered ? 100 : 0,
    };
  };
  const disconnectedRecovery = new AgentCardV2WalletFundingProvider(
    disconnectedRecoveryApi,
    retainedOwner,
    { attempts: 2, delayMs: 0 }
  );
  assert.equal(
    (await disconnectedRecovery.reclaimUserWalletFunding(request)).metadata?.status,
    'release_confirmed'
  );
  assert.ok(disconnectedRecovered, 'retained owner may recover without reconnecting');

  let reads = 0;
  const exactApi: AgentCardV2Request = async (method, path) => {
    assert.equal(method, 'GET');
    assert.equal(
      path,
      '/api/v2/company_wallet/transfers/owt-old',
      'older known transfers must never depend on a newest-100 list'
    );
    reads += 1;
    return { ...transfer, status: 'reclaimed', released_cents: 100 };
  };
  const exact = new AgentCardV2WalletFundingProvider(exactApi, resolveUser, {
    attempts: 1,
    delayMs: 0,
  });
  const exactResult = await exact.reclaimUserWalletFunding(request);
  assert.equal(exactResult.metadata?.status, 'release_confirmed');
  assert.equal(exactResult.metadata?.api_version, 'v2');
  assert.equal(reads, 1);
  await exact.fundUserWallet(request);
  assert.equal(reads, 1, 'the compatibility funding hook must never create another transfer');

  const collections: unknown[] = [];
  const collection = new AgentCardV2WalletFundingProvider(async (method, path, body, key) => {
    if (method === 'POST') {
      assert.equal(path, '/api/v2/company_wallet/transfers/owt-old/collection');
      collections.push({ body, key });
    } else assert.equal(path, '/api/v2/company_wallet/transfers/owt-old');
    return transfer;
  }, resolveUser);
  for (const outcome of ['succeeded', 'succeeded', 'failed'] as const) {
    const response = await collection.confirmCollection({ ...request, outcome });
    assert.equal(response.metadata?.outcome, outcome);
    assert.equal(response.metadata?.agentcard_user_id, 'usr-own');
  }
  assert.deepEqual(collections, [
    { body: { outcome: 'succeeded' }, key: request.idempotencyKey },
    { body: { outcome: 'succeeded' }, key: request.idempotencyKey },
    { body: { outcome: 'failed' }, key: request.idempotencyKey },
  ]);

  {
    const startedAt = Date.now();
    let now = startedAt;
    let expiredReads = 0;
    const api: AgentCardV2Request = async (method, _path, _body, _key, deadline) => {
      assert.equal(method, 'GET', 'observing release must not move money');
      assert.equal(typeof deadline, 'number');
      if (deadline! <= now) {
        expiredReads += 1;
        throw new DOMException('The request deadline expired', 'TimeoutError');
      }
      return transfer;
    };
    const provider = new AgentCardV2WalletFundingProvider(
      api,
      resolveUser,
      { attempts: 20, delayMs: 3_000 },
      async (ms) => {
        now += ms;
      },
      () => now
    );
    await assert.rejects(
      () => provider.reclaimUserWalletFunding({ ...request, cardId: undefined }),
      pending,
      'a transfer still awaiting release at the deadline must remain pending'
    );
    assert.equal(expiredReads, 0, 'polling must not issue a request after its shared deadline');
    assert.ok(now - startedAt <= 30_000, 'poll waits must fit the existing shared budget');
  }

  for (const failure of [
    new DOMException('Read timed out', 'TimeoutError'),
    new DOMException('Read aborted', 'AbortError'),
    new AgentCardV2Error('Authentication failed', 401, 'unauthorized'),
  ]) {
    let now = Date.now();
    const provider = new AgentCardV2WalletFundingProvider(
      async (_method, _path, _body, _key, deadline) => {
        now = deadline!;
        throw failure;
      },
      resolveUser,
      { attempts: 2, delayMs: 0 },
      async () => {},
      () => now
    );
    await assert.rejects(
      () => provider.reclaimUserWalletFunding(request),
      failure instanceof AgentCardV2Error
        ? (error: unknown) => error instanceof WalletFundingProviderError && error.status === 401
        : pending,
      'deadline expiry preserves pending reads without hiding authentication failures'
    );
  }

  for (const recoveryStatus of ['requested', 'completed']) {
    const recoveries: unknown[] = [];
    const deadlines = new Set<number | undefined>();
    const api: AgentCardV2Request = async (method, path, body, key, deadline) => {
      deadlines.add(deadline);
      if (method === 'GET') {
        assert.equal(path, '/api/v2/company_wallet/transfers/owt-old');
        return transfer;
      }
      assert.equal(path, '/api/v2/company_wallet/recoveries');
      recoveries.push({ body, key });
      return { id: 'rcv-own', user_id: 'usr-own', status: recoveryStatus, amount_cents: 100 };
    };
    const provider = new AgentCardV2WalletFundingProvider(api, resolveUser, {
      attempts: 3,
      delayMs: 0,
    });
    await assert.rejects(
      () => provider.reclaimUserWalletFunding(request),
      pending,
      'a recovery result cannot substitute for the exact transfer release'
    );
    assert.equal(deadlines.size, 1, 'all observations share one retry deadline');
    await assert.rejects(() => provider.reclaimUserWalletFunding(request), pending);
    assert.deepEqual(
      recoveries,
      [
        {
          body: { user_id: 'usr-own', amount_cents: 100 },
          key: `${request.idempotencyKey}:recovery:owt-old`,
        },
        {
          body: { user_id: 'usr-own', amount_cents: 100 },
          key: `${request.idempotencyKey}:recovery:owt-old`,
        },
      ],
      'retries must preserve one user, amount, transfer and recovery key, with at most one POST per observation window'
    );
  }

  let released = false;
  const settled = new AgentCardV2WalletFundingProvider(
    async (method) => {
      if (method === 'POST') {
        released = true;
        return { status: 'requested' };
      }
      return {
        ...transfer,
        status: released ? 'reclaimed' : 'consumed',
        released_cents: released ? 100 : 0,
      };
    },
    resolveUser,
    { attempts: 2, delayMs: 0 }
  );
  assert.equal(
    (await settled.reclaimUserWalletFunding(request)).metadata?.status,
    'release_confirmed'
  );

  for (const changed of [
    { user_id: 'usr-foreign' },
    { card_id: 'card-foreign' },
    { amount_cents: 101 },
    { id: 'owt-foreign' },
    { user_id: null },
  ]) {
    const provider = new AgentCardV2WalletFundingProvider(
      async (method) => {
        assert.equal(method, 'GET', 'mismatched intent must never recover another residual');
        return { ...transfer, ...changed };
      },
      resolveUser,
      { attempts: 2, delayMs: 0 }
    );
    await assert.rejects(() => provider.reclaimUserWalletFunding(request), mismatch);
  }
  for (const changed of [{ transferred_cents: 0 }, { released_cents: 50 }]) {
    const provider = new AgentCardV2WalletFundingProvider(
      async (method) => {
        assert.equal(method, 'GET', 'netted or partial intents must never sweep unrelated money');
        return { ...transfer, ...changed };
      },
      resolveUser,
      { attempts: 2, delayMs: 0 }
    );
    await assert.rejects(() => provider.reclaimUserWalletFunding(request), pending);
  }
  const spent = new AgentCardV2WalletFundingProvider(
    async () => ({ ...transfer, status: 'reclaimed', released_cents: 50 }),
    resolveUser,
    { attempts: 1, delayMs: 0 }
  );
  await assert.rejects(
    () => spent.reclaimUserWalletFunding(request),
    (error: unknown) =>
      error instanceof WalletFundingProviderError &&
      error.code === 'agentcard_company_transfer_consumed_during_reclaim'
  );
  const throttled = new AgentCardV2WalletFundingProvider(
    async () => {
      throw new AgentCardV2Error('throttled', 429, 'rate_limited');
    },
    resolveUser,
    { attempts: 2, delayMs: 0 }
  );
  await assert.rejects(() => throttled.reclaimUserWalletFunding(request), pending);

  const routed: string[] = [];
  const fake = (name: string): WalletFundingProvider => ({
    fundUserWallet: async () => {
      routed.push(name);
      return {};
    },
    confirmCollection: async () => {
      routed.push(name);
      return {};
    },
    reclaimUserWalletFunding: async () => {
      routed.push(name);
      return {};
    },
  });
  const router = (api: AgentCardV2Request, resolver = resolveUser) =>
    new AgentCardWalletFundingRouter(
      api,
      resolver,
      fake('legacy'),
      fake('v2'),
      fake('exact-legacy'),
      async () => 'ch-legacy-own',
      resolver
    );
  assert.ok(createWalletFundingProvider() instanceof AgentCardWalletFundingRouter);
  await router(async () => transfer).reclaimUserWalletFunding(request);
  await router(async () => ({ ...transfer, user_id: null })).reclaimUserWalletFunding(request);
  await router(async () => ({
    ...transfer,
    user_id: 'usr-before-enrollment',
    cardholder_id: 'ch-legacy-own',
  })).reclaimUserWalletFunding(request);
  await router(async () => {
    throw new AgentCardV2Error('old row', 404, 'transfer_not_found');
  }).confirmCollection({ ...request, outcome: 'succeeded' });
  await router(
    async () => {
      throw new AgentCardV2Error('no platform credential', 409, 'agentcard_setup_required');
    },
    async () => undefined
  ).reclaimUserWalletFunding(request);
  assert.deepEqual(routed, ['v2', 'exact-legacy', 'exact-legacy', 'legacy', 'legacy']);
  await assert.rejects(
    () =>
      router(async () => ({ ...transfer, user_id: 'usr-foreign' })).reclaimUserWalletFunding(
        request
      ),
    mismatch
  );
  await assert.rejects(
    () =>
      router(async () => {
        throw new AgentCardV2Error('auth failed', 401, 'unauthorized');
      }).reclaimUserWalletFunding(request),
    (error: unknown) => error instanceof WalletFundingProviderError && error.status === 401
  );
  assert.equal(
    routed.length,
    5,
    'ownership/auth errors must never fall through to legacy mutations'
  );
  console.log('PASS AgentCard v2 exact wallet identity, collection, recovery and legacy routing');
}
