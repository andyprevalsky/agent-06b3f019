#!/usr/bin/env tsx
/**
 * Unit tests for the rotate_ip building blocks that need no DB or Kernel SDK:
 *  - the mobile proxy-candidate builder (geo relaxation + type-prefixed keys)
 *  - the deterministic Kernel residential → mobile → Steel ladder
 */
import assert from 'node:assert';
import type Kernel from '@onkernel/sdk';
import { rotateProxySchema } from '../../domains/browser-session/types';
import {
  getOrCreateKernelProxy,
  kernelProxyCandidates,
  selectReusableKernelProxy,
} from '../../providers/browser/kernelProxy';
import { ROTATION_CAP, selectRotationStep } from '../../providers/browser/rotation';
import { prisma } from '../../providers/database';
import {
  isSteelProvisioningOutage,
  isSteelSessionRateLimited,
} from '../blackbox/browser-provider-rotation.support';

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
    provider: 'steel',
    proxyType: 'residential',
    recoveryAction: 'ip_rotated',
  });

  // A run that starts on Steel stays on Steel; provider rotation is one-way.
  assert.deepStrictEqual(selectRotationStep(1, 'steel'), {
    provider: 'steel',
    proxyType: 'residential',
    recoveryAction: 'ip_rotated',
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

async function main(): Promise<void> {
  testMobileCandidates();
  testResidentialUnchanged();
  testRestoredProxyReuse();
  await testPaginatedProxyReuseAndConcurrentOwnership();
  testRotationTierLadder();
  testRotationRequestSchema();
  testSteelOutageDetector();
  process.stdout.write('PASS rotate_ip mobile candidates + escalation ladder\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
