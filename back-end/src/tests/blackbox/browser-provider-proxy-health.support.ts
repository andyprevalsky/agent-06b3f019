/**
 * Managed Kernel proxies carry a provider-owned health status. When Kernel
 * rejects a session because the proxy failed its health check, that status is
 * the authority on whether this location can serve the session — the error text
 * is not (it changed between the first and the retried rejection below).
 *
 * Captured from the failing live Kernel parity runs on 2026-10-20 (mobile
 * rotation onto `mobile:US:IL` at 23:04Z, `mobile:US:FL` at 23:14Z and
 * `mobile:US:WA` at 23:24Z): the first `browsers.create` failed its health check
 * and Kernel recorded `status: unavailable` with `last_checked` at that instant;
 * the refunded retry reused the same cached proxy and was rejected in ~80 ms.
 */

import { APIError, type Kernel } from '@onkernel/sdk';
import {
  createSessionOnKernelProxyLadder,
  kernelProxyCandidates,
  type ResolvedKernelProxy,
} from '../../providers/browser/kernelProxy';
import { prisma } from '../../providers/database';
import type { ProxyGeoLocation } from '../../providers/geoip';
import { assert } from './browser-provider.helpers';

const HEALTH_CHECK_FAILED =
  'Proxy health check failed: transport error: proxy connection failed: Get "https://public-ping-bucket-kernel.s3.us-east-1.amazonaws.com/index.html": context deadline exceeded (Client.Timeout exceeded while awaiting headers)';
const MARKED_UNAVAILABLE = 'Proxy is marked unavailable from the last health check';

type CachedProxyRow = { proxyKey: string; proxyId: string };

/** Run with `BrowserProviderProxy` backed by an in-memory proxyKey → proxyId map. */
export async function withKernelProxyCache<T>(
  rows: Map<string, string>,
  run: () => Promise<T>
): Promise<T> {
  const model = prisma.browserProviderProxy;
  const originalFind = model.findUnique;
  const originalCreate = model.create;
  const originalDeleteMany = model.deleteMany;
  model.findUnique = (async ({
    where,
  }: {
    where: { provider_proxyKey: { proxyKey: string } };
  }): Promise<CachedProxyRow | null> => {
    const proxyKey = where.provider_proxyKey.proxyKey;
    const proxyId = rows.get(proxyKey);
    return proxyId === undefined ? null : { proxyKey, proxyId };
  }) as unknown as typeof model.findUnique;
  model.create = (async ({ data }: { data: CachedProxyRow }) => {
    rows.set(data.proxyKey, data.proxyId);
    return data;
  }) as unknown as typeof model.create;
  model.deleteMany = (async ({ where }: { where: { proxyKey: string; proxyId?: string } }) => {
    const matches =
      rows.has(where.proxyKey) &&
      (where.proxyId === undefined || rows.get(where.proxyKey) === where.proxyId);
    return { count: matches && rows.delete(where.proxyKey) ? 1 : 0 };
  }) as unknown as typeof model.deleteMany;
  try {
    return await run();
  } finally {
    model.findUnique = originalFind;
    model.create = originalCreate;
    model.deleteMany = originalDeleteMany;
  }
}

type FakeProxy = {
  id: string;
  name: string;
  type: 'mobile';
  status: 'available' | 'unavailable';
  config: Record<string, string>;
};

function kernelError(status: number, message: string): APIError {
  return APIError.generate(status, { code: 'bad_request', message }, undefined, new Headers());
}

/**
 * A Kernel project whose `browsers.create` runs the proxy health check: a proxy
 * whose location pool is unreachable is marked unavailable and rejected, and an
 * already-unavailable proxy is rejected without a new check.
 */
function fakeKernelProject(proxies: FakeProxy[], unreachableNames: ReadonlySet<string>) {
  const byId = new Map(proxies.map((proxy) => [proxy.id, { ...proxy }]));
  const created: string[] = [];
  const client = {
    proxies: {
      list: async ({ query }: { query: string }) => ({
        items: [...byId.values()].filter((proxy) => proxy.name === query),
        hasNextPage: () => false,
      }),
      create: async ({ name, config }: { name: string; config: Record<string, string> }) => {
        const id = `created-${name}`;
        created.push(name);
        byId.set(id, { id, name, type: 'mobile', status: 'available', config });
        return { id };
      },
      retrieve: async (id: string) => {
        const proxy = byId.get(id);
        if (proxy === undefined) throw kernelError(404, 'proxy not found');
        return { ...proxy };
      },
    },
  } as unknown as Kernel;
  const createSession = async (proxy: ResolvedKernelProxy): Promise<ResolvedKernelProxy> => {
    const remote = byId.get(proxy.proxyId);
    if (remote === undefined) throw kernelError(400, 'proxy not found');
    if (remote.status === 'unavailable') throw kernelError(400, MARKED_UNAVAILABLE);
    if (unreachableNames.has(remote.name)) {
      remote.status = 'unavailable';
      throw kernelError(400, HEALTH_CHECK_FAILED);
    }
    return proxy;
  };
  return { client, byId, created, createSession };
}

async function runRotationOntoUnhealthyState(options: {
  stateProxyStatus: 'available' | 'unavailable';
  cachedStateRow: boolean;
}): Promise<void> {
  // The mobile rotation of the live parity test: another US state, no city.
  const rotationLocation: ProxyGeoLocation = { country: 'US', state: 'FL' };
  const candidates = kernelProxyCandidates(rotationLocation, 'mobile');
  const [state, country] = candidates;
  assert(
    state?.proxyKey === 'mobile:US:FL' && country?.proxyKey === 'mobile:US',
    `unexpected mobile candidates ${candidates.map((c) => c.proxyKey).join(',')}`
  );
  const kernel = fakeKernelProject(
    [
      {
        id: 'fl-mobile-proxy',
        name: state.name,
        type: 'mobile',
        status: options.stateProxyStatus,
        config: { country: 'us', state: 'fl' },
      },
    ],
    new Set([state.name])
  );
  const rows = new Map<string, string>(
    options.cachedStateRow ? [[state.proxyKey, 'fl-mobile-proxy']] : []
  );
  const relaxed: string[] = [];
  const label = `${options.stateProxyStatus} ${options.cachedStateRow ? 'cached' : 'listed'} state proxy`;

  const session = await withKernelProxyCache(rows, () =>
    createSessionOnKernelProxyLadder(kernel.client, candidates, kernel.createSession, {
      onRelax: (candidate) => relaxed.push(candidate.proxyKey),
    })
  );

  assert(
    session.source === 'kernel_mobile_country' && session.proxyKey === country.proxyKey,
    `${label}: rotation landed on ${session.source} ${session.proxyKey}, expected the country-level mobile proxy`
  );
  assert(
    JSON.stringify(relaxed) === JSON.stringify([state.proxyKey]),
    `${label}: expected one relaxation from ${state.proxyKey}, got ${JSON.stringify(relaxed)}`
  );
  assert(
    !rows.has(state.proxyKey),
    `${label}: the cache still points ${state.proxyKey} at proxy ${rows.get(state.proxyKey)} that Kernel marked unavailable`
  );
  assert(
    rows.get(country.proxyKey) === session.proxyId,
    `${label}: the country-level proxy was not cached`
  );
  assert(
    kernel.byId.get('fl-mobile-proxy') !== undefined,
    `${label}: the shared state proxy must not be deleted from the Kernel project`
  );
}

/** Another session replaced the dead row first: the failed attempt must not delete that replacement. */
async function assertConcurrentReplacementSurvivesForget(): Promise<void> {
  const candidates = kernelProxyCandidates({ country: 'US', state: 'FL' }, 'mobile');
  const [state] = candidates;
  const kernel = fakeKernelProject(
    [
      {
        id: 'fl-mobile-proxy',
        name: state!.name,
        type: 'mobile',
        status: 'unavailable',
        config: { country: 'us', state: 'fl' },
      },
    ],
    new Set()
  );
  const rows = new Map([[state!.proxyKey, 'fl-mobile-proxy']]);
  const session = await withKernelProxyCache(rows, () =>
    createSessionOnKernelProxyLadder(kernel.client, candidates, async (proxy) => {
      if (proxy.proxyId === 'fl-mobile-proxy') rows.set(state!.proxyKey, 'fresh-fl-proxy');
      return kernel.createSession(proxy);
    })
  );
  assert(session.source === 'kernel_mobile_country', `concurrent replacement: ${session.source}`);
  assert(
    rows.get(state!.proxyKey) === 'fresh-fl-proxy',
    `the failed attempt deleted a concurrent replacement row: ${rows.get(state!.proxyKey)}`
  );
}

/** A Kernel 400 about something other than a healthy proxy must not move the session. */
async function assertRejectionOnHealthyProxyKeepsLocation(): Promise<void> {
  const candidates = kernelProxyCandidates({ country: 'US', state: 'FL' }, 'mobile');
  const [state] = candidates;
  const kernel = fakeKernelProject(
    [
      {
        id: 'fl-mobile-proxy',
        name: state!.name,
        type: 'mobile',
        status: 'available',
        config: { country: 'us', state: 'fl' },
      },
    ],
    new Set()
  );
  const rows = new Map([[state!.proxyKey, 'fl-mobile-proxy']]);
  const relaxed: string[] = [];
  const rejection = kernelError(400, 'profile is in use by another browser');
  const outcome = await withKernelProxyCache(rows, () =>
    createSessionOnKernelProxyLadder(
      kernel.client,
      candidates,
      async () => {
        throw rejection;
      },
      { onRelax: (candidate) => relaxed.push(candidate.proxyKey) }
    ).then(
      () => undefined,
      (error: unknown) => error
    )
  );
  assert(outcome === rejection, `a non-proxy 400 was not surfaced: ${String(outcome)}`);
  assert(relaxed.length === 0, `a non-proxy 400 relaxed ${JSON.stringify(relaxed)}`);
  assert(
    rows.get(state!.proxyKey) === 'fl-mobile-proxy',
    'a non-proxy 400 dropped the healthy cached proxy'
  );
}

/** Missing health proof must preserve the original rejection and cached location. */
async function assertHealthProofControlsRelaxation(): Promise<void> {
  const candidates = kernelProxyCandidates({ country: 'US', state: 'FL' }, 'mobile');
  const [state] = candidates;
  for (const scenario of [
    { name: 'healthy despite unavailable text', status: 400, health: 'available' },
    { name: 'health lookup fails', status: 400, health: 'lookup-failure' },
    { name: 'non-400 unavailable proxy', status: 401, health: 'unavailable' },
    { name: 'unknown health', status: 400, health: undefined },
  ]) {
    const rows = new Map([[state!.proxyKey, 'state-proxy']]);
    let lookups = 0;
    const client = {
      proxies: {
        retrieve: async (id: string, options: { timeout: number; maxRetries: number }) => {
          lookups += 1;
          assert(id === 'state-proxy', `${scenario.name}: looked up the wrong proxy`);
          assert(
            options.timeout === 10_000 && options.maxRetries === 0,
            `${scenario.name}: health lookup must have a bounded, non-retried request`
          );
          if (scenario.health === 'lookup-failure') throw new Error('health lookup failed');
          return { status: scenario.health };
        },
      },
    } as unknown as Kernel;
    const rejection = kernelError(scenario.status, 'Proxy is unavailable');
    const relaxed: string[] = [];
    const outcome = await withKernelProxyCache(rows, () =>
      createSessionOnKernelProxyLadder(
        client,
        candidates,
        async () => {
          throw rejection;
        },
        { onRelax: (candidate) => relaxed.push(candidate.proxyKey) }
      ).catch((error: unknown) => error)
    );
    assert(outcome === rejection, `${scenario.name}: original rejection was replaced`);
    assert(relaxed.length === 0, `${scenario.name}: location was relaxed without health proof`);
    assert(rows.get(state!.proxyKey) === 'state-proxy', `${scenario.name}: cache row was lost`);
    assert(lookups === (scenario.status === 400 ? 1 : 0), `${scenario.name}: lookup count`);
  }
}

/** Exhausting the geo ladder still surfaces the provider failure, without retrying it. */
async function assertUnavailableFinalCandidateFails(): Promise<void> {
  const candidates = kernelProxyCandidates({ country: 'US' }, 'mobile');
  const [country] = candidates;
  const rows = new Map([[country!.proxyKey, 'country-proxy']]);
  const client = {
    proxies: { retrieve: async () => ({ status: 'unavailable' }) },
  } as unknown as Kernel;
  const rejection = kernelError(400, MARKED_UNAVAILABLE);
  let attempts = 0;
  let relaxations = 0;
  const outcome = await withKernelProxyCache(rows, () =>
    createSessionOnKernelProxyLadder(
      client,
      candidates,
      async () => {
        attempts += 1;
        throw rejection;
      },
      { onRelax: () => (relaxations += 1) }
    ).catch((error: unknown) => error)
  );
  assert(outcome === rejection, 'exhausted ladder did not surface the original provider error');
  assert(attempts === 1 && relaxations === 0, 'exhausted ladder retried or relaxed');
  assert(!rows.has(country!.proxyKey), 'exhausted ladder retained the unavailable proxy');
}

export async function assertKernelUnhealthyProxyRelaxesLocation(): Promise<void> {
  // First rotation onto the state: the health check fails during browsers.create.
  await runRotationOntoUnhealthyState({ stateProxyStatus: 'available', cachedStateRow: false });
  // The refunded retry: the cached row points at the proxy Kernel already marked unavailable.
  await runRotationOntoUnhealthyState({ stateProxyStatus: 'unavailable', cachedStateRow: true });
  await assertConcurrentReplacementSurvivesForget();
  await assertRejectionOnHealthyProxyKeepsLocation();
  await assertHealthProofControlsRelaxation();
  await assertUnavailableFinalCandidateFails();
}
