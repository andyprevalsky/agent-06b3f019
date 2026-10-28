#!/usr/bin/env tsx
/**
 * Unit tests for the rotate_ip building blocks that need no DB or Kernel SDK:
 *  - the mobile proxy-candidate builder (geo relaxation + type-prefixed keys)
 *  - the deterministic Kernel residential → mobile → Steel → Browser Use ladder
 */
import assert from 'node:assert';
import type Kernel from '@onkernel/sdk';
import { rotateProxySchema } from '../../domains/browser-session/types';
import {
  createSessionOnKernelProxyLadder,
  getOrCreateKernelProxy,
  kernelProxyCandidates,
  selectReusableKernelProxy,
} from '../../providers/browser/kernelProxy';
import { ROTATION_CAP, selectRotationStep } from '../../providers/browser/rotation';
import { prisma } from '../../providers/database';
import {
  isSteelProvisioningOutage,
  isSteelSessionRateLimited,
  runCrossProviderRotationLadder,
} from '../blackbox/browser-provider-rotation.support';
import {
  withKernelProxyCache,
  withKernelProxyCreationTransaction,
} from '../blackbox/browser-provider-proxy-health.support';

function testMobileCandidates(): void {
  const candidates = kernelProxyCandidates(
    { country: 'US', state: 'TX', city: 'DALLAS' },
    'mobile'
  );

  // City → state → country relaxation, all tagged mobile.
  assert.strictEqual(candidates.length, 3, 'expected city/state/country candidates');
  assert.deepStrictEqual(
    candidates.map((c) => c.proxyKey),
    ['mobile:US:TX:dallas', 'mobile:US:TX', 'mobile:US'],
    'mobile proxyKeys must be type-prefixed and geo-relaxed'
  );
  assert.ok(
    candidates.every((c) => c.type === 'mobile'),
    'every mobile candidate must carry type=mobile'
  );
  assert.deepStrictEqual(
    candidates.map((c) => c.source),
    ['kernel_mobile_city', 'kernel_mobile_state', 'kernel_mobile_country'],
    'mobile sources must reflect the tier'
  );
  assert.strictEqual(candidates[0].name, 'rose-mobile-us-tx-dallas');
}

function testResidentialUnchanged(): void {
  // Default tier stays residential — no regression from the mobile generalization.
  const candidates = kernelProxyCandidates({ country: 'US', state: 'CA', city: 'SAN FRANCISCO' });
  assert.strictEqual(candidates[0].proxyKey, 'residential:US:CA:san_francisco');
  assert.strictEqual(candidates[0].type, 'residential');
  assert.strictEqual(candidates[0].source, 'kernel_residential_city');
}

function testBenchmarkProxyReuseRequiresSameLocationAndTier(): void {
  const candidate = kernelProxyCandidates({ country: 'US', state: 'CA', city: 'PALO ALTO' })[0];
  assert.strictEqual(
    selectReusableKernelProxy(
      [
        {
          status: 'available',
          id: 'wrong-tier',
          name: candidate.name,
          type: 'mobile',
          config: candidate.config,
        },
        {
          status: 'available',
          id: 'wrong-city',
          name: candidate.name,
          type: 'residential',
          config: { country: 'US', state: 'CA', city: 'san_francisco' },
        },
        {
          status: 'available',
          id: 'same-proxy',
          name: candidate.name,
          type: 'residential',
          config: { country: 'us', state: 'ca', city: 'palo_alto' },
        },
      ],
      candidate
    ),
    'same-proxy'
  );
  assert.strictEqual(
    selectReusableKernelProxy(
      [
        {
          status: 'available',
          id: 'different-name',
          name: 'another-proxy',
          type: 'residential',
          config: candidate.config,
        },
        {
          status: 'available',
          id: 'extra-setting',
          name: candidate.name,
          type: 'residential',
          config: { ...candidate.config, zip: '94301' },
        },
      ],
      candidate
    ),
    undefined
  );
}

function testRestoredProxyReuse(): void {
  const candidate = kernelProxyCandidates({ country: 'US', state: 'CA', city: 'PALO ALTO' })[0]!;
  const matching = {
    id: 'ready-proxy',
    name: candidate.name,
    type: candidate.type,
    status: 'available' as const,
    config: { country: 'us', state: 'ca', city: 'palo_alto' },
  };
  assert.strictEqual(selectReusableKernelProxy([matching], candidate), 'ready-proxy');
  assert.strictEqual(
    selectReusableKernelProxy([{ ...matching, bypass_hosts: ['example.com'] }], candidate),
    undefined,
    'a proxy that bypasses hosts cannot satisfy a geographic proxy candidate'
  );
  assert.strictEqual(
    selectReusableKernelProxy([{ ...matching, status: 'unavailable' }], candidate),
    undefined
  );
  assert.strictEqual(
    selectReusableKernelProxy(
      [{ ...matching, config: { ...matching.config, city: 'berkeley' } }],
      candidate
    ),
    undefined
  );
  const countryCandidate = kernelProxyCandidates({ country: 'US' })[0]!;
  assert.strictEqual(
    selectReusableKernelProxy(
      [
        {
          ...matching,
          name: countryCandidate.name,
          config: { country: ['US'] as unknown as string },
        },
      ],
      countryCandidate
    ),
    undefined,
    'a malformed array location must not match a geographic proxy candidate'
  );
  assert.strictEqual(
    selectReusableKernelProxy(
      [{ ...matching, name: countryCandidate.name, config: { country: 'US', state: 'CA' } }],
      countryCandidate
    ),
    undefined,
    'a state-restricted proxy must not satisfy a country-only candidate'
  );
}

async function testPaginatedProxyReuseAndConcurrentOwnership(): Promise<void> {
  const model = prisma.browserProviderProxy;
  const originalFind = model.findUnique;
  const originalCreate = model.create;
  const candidate = kernelProxyCandidates({ country: 'US' })[0]!;
  const matching = {
    id: 'proxy-on-second-page',
    name: candidate.name,
    type: candidate.type,
    status: 'available' as const,
    config: candidate.config,
  };
  let nextPageCalls = 0;
  let remoteCreateCalls = 0;
  let remoteDeleteCalls = 0;
  const lastPage = {
    items: [matching],
    hasNextPage: () => false,
  };
  const firstPage = {
    items: [],
    hasNextPage: () => true,
    getNextPage: async () => {
      nextPageCalls += 1;
      return lastPage;
    },
  };

  try {
    model.findUnique = (async () => null) as typeof model.findUnique;
    model.create = (async ({ data }: { data: { proxyKey: string; proxyId: string } }) =>
      data) as typeof model.create;
    const paginatedClient = {
      proxies: {
        list: async () => firstPage,
        create: async () => {
          remoteCreateCalls += 1;
          return { id: 'unexpected' };
        },
      },
    } as unknown as Kernel;
    const reused = await getOrCreateKernelProxy(paginatedClient, candidate);
    assert.strictEqual(reused.proxyId, matching.id);
    assert.strictEqual(nextPageCalls, 1);
    assert.strictEqual(remoteCreateCalls, 0, 'a later page must be searched before provisioning');

    let findCalls = 0;
    model.findUnique = (async () => {
      findCalls += 1;
      return findCalls === 1 ? null : { proxyId: 'new-proxy', proxyKey: candidate.proxyKey };
    }) as typeof model.findUnique;
    model.create = (async () => {
      throw new Error('unique conflict');
    }) as typeof model.create;
    const racingClient = {
      proxies: {
        list: async () => ({ items: [], hasNextPage: () => false }),
        create: async () => ({ id: 'new-proxy' }),
        delete: async () => {
          remoteDeleteCalls += 1;
        },
      },
    } as unknown as Kernel;
    const winner = await getOrCreateKernelProxy(racingClient, candidate);
    assert.strictEqual(winner.proxyId, 'new-proxy');
    assert.strictEqual(remoteDeleteCalls, 0, 'the winner may own the created proxy');

    model.findUnique = (async () => null) as typeof model.findUnique;
    await assert.rejects(() => getOrCreateKernelProxy(racingClient, candidate), /unique conflict/);
    assert.strictEqual(remoteDeleteCalls, 0, 'a pending winner may still be saving the proxy');
  } finally {
    model.findUnique = originalFind;
    model.create = originalCreate;
  }
}

function ladderClient(listedIds: Record<string, string>): {
  client: Kernel;
  created: string[];
} {
  const created: string[] = [];
  const client = {
    proxies: {
      list: async ({ query }: { query: string }) => ({
        items:
          listedIds[query] === undefined
            ? []
            : [
                {
                  id: listedIds[query],
                  name: query,
                  type: 'residential',
                  status: 'available',
                  config: kernelProxyCandidates({
                    country: 'US',
                    state: 'CA',
                    city: 'SAN FRANCISCO',
                  }).find((c) => c.name === query)?.config,
                },
              ],
        hasNextPage: () => false,
      }),
      create: async ({ name }: { name: string }) => {
        created.push(name);
        return { id: `created-${name}` };
      },
    },
  } as unknown as Kernel;
  return { client, created };
}

// Another run's cleanup (or Kernel) can delete a shared geo proxy after this
// database cached its ID. That proves the ID is stale, not that the city is out
// of inventory, so resume must keep the city instead of downgrading to state.
async function testDeletedCachedProxyKeepsLocation(): Promise<void> {
  const candidates = kernelProxyCandidates({ country: 'US', state: 'CA', city: 'SAN FRANCISCO' });
  const [city, state] = candidates;
  const rows = new Map([[city!.proxyKey, 'deleted-by-another-run']]);
  const { client, created } = ladderClient({ [city!.name]: 'live-city-proxy' });
  const relaxed: string[] = [];
  const attempted: string[] = [];

  const session = await withKernelProxyCache(rows, () =>
    createSessionOnKernelProxyLadder(
      client,
      candidates,
      async (proxy) => {
        attempted.push(proxy.proxyId);
        if (proxy.proxyId === 'deleted-by-another-run') {
          throw new Error('400 proxy not found');
        }
        return proxy;
      },
      { onRelax: (candidate) => relaxed.push(candidate.proxyKey) }
    )
  );

  assert.strictEqual(session.source, 'kernel_residential_city', 'resume lost the city proxy');
  assert.deepStrictEqual(session.location, city!.location);
  assert.strictEqual(session.proxyId, 'live-city-proxy');
  assert.deepStrictEqual(attempted, ['deleted-by-another-run', 'live-city-proxy']);
  assert.deepStrictEqual(relaxed, [], 'a stale proxy ID must not relax location specificity');
  assert.strictEqual(rows.get(city!.proxyKey), 'live-city-proxy', 'stale cache row was kept');
  assert.strictEqual(rows.has(state!.proxyKey), false);
  assert.deepStrictEqual(created, [], 'a listed live proxy must be reused, not re-created');

  // A refreshed ID that is also missing is refreshed once, then relaxes.
  const missingRows = new Map([[city!.proxyKey, 'deleted-by-another-run']]);
  const missing = ladderClient({});
  const relaxedAfterRefresh: string[] = [];
  const cityAttempts: string[] = [];
  const fallback = await withKernelProxyCache(missingRows, () =>
    createSessionOnKernelProxyLadder(
      missing.client,
      candidates,
      async (proxy) => {
        if (proxy.source === 'kernel_residential_city') {
          cityAttempts.push(proxy.proxyId);
          throw new Error('400 proxy not found');
        }
        return proxy;
      },
      { onRelax: (candidate) => relaxedAfterRefresh.push(candidate.proxyKey) }
    )
  );
  assert.deepStrictEqual(cityAttempts, ['deleted-by-another-run', `created-${city!.name}`]);
  assert.deepStrictEqual(relaxedAfterRefresh, [city!.proxyKey]);
  assert.strictEqual(fallback.source, 'kernel_residential_state');

  // A transport timeout does not prove the proxy is gone: keep the row, relax.
  const timeoutRows = new Map([[city!.proxyKey, 'healthy-city-proxy']]);
  const timeout = ladderClient({});
  const timedOut = await withKernelProxyCache(timeoutRows, () =>
    createSessionOnKernelProxyLadder(timeout.client, candidates, async (proxy) => {
      if (proxy.source === 'kernel_residential_city') throw new Error('Request timed out.');
      return proxy;
    })
  );
  assert.strictEqual(timedOut.source, 'kernel_residential_state');
  assert.strictEqual(timeoutRows.get(city!.proxyKey), 'healthy-city-proxy');
}

function testRotationTierLadder(): void {
  assert.strictEqual(ROTATION_CAP, 4);
  assert.deepStrictEqual(selectRotationStep(1, 'kernel'), {
    provider: 'kernel',
    proxyType: 'residential',
    recoveryAction: 'ip_rotated',
  });
  assert.deepStrictEqual(selectRotationStep(2, 'kernel'), {
    provider: 'kernel',
    proxyType: 'mobile',
    recoveryAction: 'ip_rotated',
  });
  assert.deepStrictEqual(selectRotationStep(3, 'kernel'), {
    provider: 'steel',
    proxyType: 'residential',
    recoveryAction: 'provider_switched',
  });
  assert.deepStrictEqual(selectRotationStep(4, 'steel'), {
    provider: 'browser-use',
    proxyType: 'residential',
    recoveryAction: 'provider_switched',
  });

  // A run that starts on Steel retries there before switching infrastructure.
  assert.deepStrictEqual(selectRotationStep(1, 'steel'), {
    provider: 'steel',
    proxyType: 'residential',
    recoveryAction: 'ip_rotated',
  });
  assert.deepStrictEqual(selectRotationStep(3, 'steel'), {
    provider: 'browser-use',
    proxyType: 'residential',
    recoveryAction: 'provider_switched',
  });
  assert.deepStrictEqual(selectRotationStep(1, 'browser-use'), {
    provider: 'browser-use',
    proxyType: 'residential',
    recoveryAction: 'ip_rotated',
  });
  assert.deepStrictEqual(selectRotationStep(4, 'steel', false), {
    provider: 'steel',
    proxyType: 'residential',
    recoveryAction: 'ip_rotated',
  });
  assert.deepStrictEqual(selectRotationStep(1, 'browser-use', false), {
    provider: 'steel',
    proxyType: 'residential',
    recoveryAction: 'provider_switched',
  });
  assert.throws(() => selectRotationStep(0, 'kernel'), RangeError);
  assert.throws(() => selectRotationStep(ROTATION_CAP + 1, 'steel'), RangeError);
}

function testRotationRequestSchema(): void {
  const taskId = '00000000-0000-4000-8000-000000000001';
  assert.deepStrictEqual(rotateProxySchema.parse({ task_id: taskId }), { task_id: taskId });
  assert.deepStrictEqual(
    rotateProxySchema.parse({ task_id: taskId, current_url: 'https://example.com/current' }),
    { task_id: taskId, current_url: 'https://example.com/current' }
  );
  assert.strictEqual(
    rotateProxySchema.safeParse({ task_id: taskId, current_url: '' }).success,
    false
  );
}

// The live provider-parity blackbox tolerates a Steel INFRA outage (skips the
// Steel legs while Kernel is healthy) but must still fail on real defects. This
// pins isSteelProvisioningOutage() to that exact boundary.
function testSteelOutageDetector(): void {
  // Genuine outage: 5xx + production's post-retry Steel-replacement failure + a
  // connectivity cause. This is the only shape that may skip.
  assert.ok(
    isSteelProvisioningOutage(
      new Error(
        '/rotate-proxy 500: {"error":"Failed to create Steel replacement after 3 attempts: Connection error."}'
      )
    ),
    'a 5xx Steel-replacement connectivity failure is an outage'
  );
  assert.ok(
    isSteelProvisioningOutage(
      new Error(
        '/rotate-proxy 502: {"error":"Failed to create Steel replacement after 3 attempts: fetch failed (ETIMEDOUT)"}'
      )
    ),
    'ETIMEDOUT/fetch-failed replacement failure is an outage'
  );

  // NOT outages — these must still fail the gate:
  assert.ok(
    !isSteelProvisioningOutage(
      new Error(
        '/rotate-proxy 500: {"error":"Failed to create Steel replacement after 3 attempts: 401 Unauthorized"}'
      )
    ),
    'a Steel AUTH rejection is a credential problem, not an outage'
  );
  assert.ok(
    !isSteelProvisioningOutage(
      new Error(
        '/rotate-proxy 500: {"error":"Failed to create Steel replacement after 3 attempts: 402 payment required (quota exceeded)"}'
      )
    ),
    'a Steel QUOTA rejection is not an outage'
  );
  assert.ok(
    !isSteelProvisioningOutage(
      new Error('call 3 expected Steel residential, got kernel/residential')
    ),
    'a rotation-logic assertion failure is never an outage'
  );
  assert.ok(
    !isSteelProvisioningOutage(
      new Error('/rotate-proxy 500: {"error":"internal error: Connection error"}')
    ),
    'a 5xx connectivity error WITHOUT the Steel-replacement signature is not tolerated'
  );
  assert.ok(
    !isSteelProvisioningOutage(
      new Error(
        '/rotate-proxy 409: {"error":"Failed to create Steel replacement after 3 attempts: Connection error."}'
      )
    ),
    'a non-5xx status is not a provisioning outage'
  );

  // Session rate-limit under parallel blackbox load is skippable (Kernel already
  // proved rotation) but is NOT classified as a provisioning outage shape.
  assert.ok(
    isSteelSessionRateLimited(
      new Error(
        '/rotate-proxy 429: {"error":"browser_provider_rate_limit","provider":"steel","message":"Browser session rate limit exceeded. Retry after delay."}'
      )
    ),
    'Steel session rate-limit 429 is skippable contention'
  );
  assert.ok(
    !isSteelSessionRateLimited(
      new Error('/rotate-proxy 429: {"error":"browser_provider_rate_limit","provider":"kernel"}')
    ),
    'Kernel rate-limit must not skip the Steel legs detector'
  );
  assert.ok(
    !isSteelSessionRateLimited(
      new Error('/rotate-proxy 401: {"error":"unauthorized","provider":"steel"}')
    ),
    'Steel AUTH rejection is not a session rate-limit skip'
  );
  assert.ok(
    !isSteelProvisioningOutage(
      new Error(
        '/rotate-proxy 429: {"error":"browser_provider_rate_limit","provider":"steel","message":"Browser session rate limit exceeded. Retry after delay."}'
      )
    ),
    'rate-limit is a separate skip path from provisioning outage'
  );
}

async function testCrossProviderLadderLabelsSteelExitIpReads(): Promise<void> {
  const responses = [
    {
      task_id: 'task-1',
      provider: 'steel',
      proxy_tier: 'residential',
      previous_provider: 'kernel',
      recovery_action: 'provider_switched',
      rotations_used: 3,
      rotations_remaining: 1,
      next_recovery: 'rotate_steel_residential_ip',
      saved_url: 'https://example.com/provider-switch-check',
      browser_session_metadata: { provider: 'steel', steel_profile_id: 'profile-1' },
      session_id: 'steel-session-1',
      ws_url: 'wss://steel/1',
    },
    {
      task_id: 'task-1',
      provider: 'steel',
      proxy_tier: 'residential',
      previous_provider: 'steel',
      recovery_action: 'ip_rotated',
      rotations_used: 4,
      rotations_remaining: 0,
      next_recovery: 'rotation_budget_exhausted',
      browser_session_metadata: { provider: 'steel', steel_profile_id: 'profile-1' },
      session_id: 'steel-session-2',
      ws_url: 'wss://steel/2',
    },
  ];
  const stages: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: 'proxy_rotation_exhausted', message: 'PROXY_ROTATION_EXHAUSTED' }),
      { status: 409 }
    );
  try {
    await runCrossProviderRotationLadder({
      baseUrl: 'http://ladder.test',
      headers: {},
      taskId: 'task-1',
      currentKernelSessionId: 'kernel-session-2',
      mobileIp: '10.0.0.2',
      post: async () => responses.shift()!,
      readDifferentExitIp: async (...args: unknown[]) => {
        stages.push(args[2]);
        return `10.0.1.${stages.length}`;
      },
      retrieveKernelBrowser: async () => ({ deleted_at: new Date() }),
      retrieveSteelBrowser: async () => ({ status: 'released', timeout: Number.MAX_SAFE_INTEGER }),
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepStrictEqual(
    stages,
    [
      'rotation3 steel, Steel session steel-session-1',
      'rotation4 steel, Steel session steel-session-2',
    ],
    'a Steel exit-IP failure must name the Steel session it read, not the evicted Kernel one'
  );
}

async function main(): Promise<void> {
  testMobileCandidates();
  testResidentialUnchanged();
  testBenchmarkProxyReuseRequiresSameLocationAndTier();
  testRestoredProxyReuse();
  await withKernelProxyCreationTransaction(testPaginatedProxyReuseAndConcurrentOwnership);
  await testDeletedCachedProxyKeepsLocation();
  testRotationTierLadder();
  testRotationRequestSchema();
  testSteelOutageDetector();
  await testCrossProviderLadderLabelsSteelExitIpReads();
  process.stdout.write('PASS rotate_ip mobile candidates + escalation ladder\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
