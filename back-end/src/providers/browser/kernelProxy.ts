import Kernel, { APIConnectionTimeoutError, BadRequestError } from '@onkernel/sdk';
import type { Prisma } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProxyListResponse } from '@onkernel/sdk/resources/proxies';
import { prisma, runTransactionWithRetry } from '../database';
import type { ProxyGeoLocation } from '../geoip';

export type KernelProxyType = 'residential' | 'mobile' | 'isp';
export type KernelProxySpecificity = 'city' | 'state' | 'country';

/** Preserve the last resolved managed proxy when a paused session resumes. */
export function managedKernelProxyFromSource(
  source: string | null
): { type: KernelProxyType; specificity: KernelProxySpecificity } | undefined {
  const match = /^kernel_(residential|mobile|isp)_(city|state|country)$/.exec(source ?? '');
  if (match === null) return undefined;
  return {
    type: match[1] as KernelProxyType,
    specificity: match[2] as KernelProxySpecificity,
  };
}

export function kernelRecreateProxySelection(
  source: string | null,
  proxyTier: string | null,
  rotationType?: KernelProxyType
): {
  forceManagedProxyType?: KernelProxyType;
  exactManagedProxy?: { type: KernelProxyType; specificity: KernelProxySpecificity };
} {
  if (rotationType !== undefined) return { forceManagedProxyType: rotationType };
  const recorded = managedKernelProxyFromSource(source);
  if (recorded !== undefined) return { exactManagedProxy: recorded };
  // Rows predating kernelProxySource retain only the tier, not the fallback geo.
  if (source === null && (proxyTier === 'mobile' || proxyTier === 'residential')) {
    return { forceManagedProxyType: proxyTier };
  }
  return {};
}

/**
 * The location a cached managed proxy was resolved for, read back from its key
 * (`<type>:<COUNTRY>[:<STATE>[:<city>]]`). A rotation moves the session to
 * another state, so a later resume cannot recompute that location from the
 * agent's own geolocation; it has to come from the proxy the session used.
 */
export function kernelProxyLocationFromKey(proxyKey: string): ProxyGeoLocation | undefined {
  const [type, country, state, city, ...rest] = proxyKey.split(':');
  if (rest.length > 0 || !type || !country || !/^[A-Z]{2}$/.test(country)) return undefined;
  if (type !== 'residential' && type !== 'mobile' && type !== 'isp') return undefined;
  return {
    country,
    ...(state !== undefined && state !== '' ? { state } : {}),
    ...(city !== undefined && city !== '' ? { city } : {}),
  };
}

/** The location a Kernel proxy's config pins (country required; state/city when set). */
export function kernelProxyLocationFromConfig(config: unknown): ProxyGeoLocation | undefined {
  if (config === null || typeof config !== 'object') return undefined;
  const { country, state, city } = config as Record<string, unknown>;
  if (typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country)) return undefined;
  return {
    country: country.toUpperCase(),
    ...(typeof state === 'string' && state !== '' ? { state } : {}),
    ...(typeof city === 'string' && city !== '' ? { city } : {}),
  };
}

/**
 * Location of the managed proxy the previous Kernel session actually used, so a
 * resume lands on the same proxy even after a rotation moved it away from the
 * agent's home location. Undefined when it cannot be established (the browser
 * is gone from the provider, the proxy row was forgotten); the caller then
 * falls back to the agent's location, which is what every resume did before.
 */
export async function recordedKernelProxyLocation(
  client: Kernel,
  sessionId: string | null
): Promise<ProxyGeoLocation | undefined> {
  if (sessionId === null || sessionId === '') return undefined;
  try {
    const browser = await client.browsers.retrieve(
      sessionId,
      { include_deleted: true },
      { timeout: 10_000, maxRetries: 0 }
    );
    const proxyId = browser.proxy_id;
    if (proxyId === undefined || proxyId === null || proxyId === '') return undefined;
    // The proxy object itself is the authority on where it points; the cache
    // row is only a fallback (it can have been re-pointed or forgotten since).
    const fromProvider = await client.proxies
      .retrieve(proxyId, { timeout: 10_000, maxRetries: 0 })
      .then((proxy) => kernelProxyLocationFromConfig(proxy.config))
      .catch(() => undefined);
    if (fromProvider !== undefined) return fromProvider;
    const row = await prisma.browserProviderProxy.findFirst({
      where: { provider: 'kernel', proxyId },
      select: { proxyKey: true },
    });
    return row === null ? undefined : kernelProxyLocationFromKey(row.proxyKey);
  } catch {
    return undefined;
  }
}

/**
 * Kernel's SDK defaults (`timeout=60_000`, `maxRetries=2`) multiply a slow
 * `proxies.create` / `browsers.create` into ~180s of silence before surfacing
 * `APIConnectionTimeoutError` ("Request timed out."). Session init must fail
 * fast enough to relax city→state→country within one request instead of
 * burning the browser-smoke budget on one hung city allocation.
 */
export const KERNEL_CREATE_REQUEST_OPTIONS = {
  timeout: 45_000,
  maxRetries: 0,
} as const;

export interface KernelProxyCandidate {
  proxyKey: string;
  name: string;
  type: KernelProxyType;
  config: {
    country: string;
    state?: string;
    city?: string;
  };
  location: ProxyGeoLocation;
  // `kernel_<type>_<city|state|country>` — the geo-specificity level that resolved.
  source: string;
}

export type KernelProxyMode = { kind: 'explicit'; proxyId: string } | { kind: 'managed' };

export interface ResolvedKernelProxy {
  proxyId: string;
  proxyKey: string;
  proxyType: KernelProxyType;
  source: KernelProxyCandidate['source'];
  location: ProxyGeoLocation;
}

export function resolveKernelProxyMode(
  explicitProxyId = process.env.KERNEL_PROXY_ID
): KernelProxyMode {
  const proxyId = explicitProxyId?.trim();
  return proxyId !== undefined && proxyId !== ''
    ? { kind: 'explicit', proxyId }
    : { kind: 'managed' };
}

function normalizeCity(city: string | undefined): string | undefined {
  const normalized = city
    ?.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized !== undefined && normalized !== '' ? normalized : undefined;
}

export function kernelProxyCandidates(
  location: ProxyGeoLocation,
  proxyType: KernelProxyType = 'residential'
): KernelProxyCandidate[] {
  const country = location.country.trim().toUpperCase();
  if (country === '') throw new Error('Kernel proxy country is required');

  const state =
    country === 'US' && location.state !== undefined && location.state.trim() !== ''
      ? location.state.trim().toUpperCase().slice(0, 2)
      : undefined;
  const city = normalizeCity(location.city);
  const candidates: KernelProxyCandidate[] = [];

  if (city !== undefined) {
    const config = { country, ...(state !== undefined ? { state } : {}), city };
    const proxyKey = [proxyType, country, state, city].filter(Boolean).join(':');
    candidates.push({
      proxyKey,
      name: `rose-${proxyKey.toLowerCase().replace(/:/g, '-')}`,
      type: proxyType,
      config,
      location: { country, ...(state !== undefined ? { state } : {}), city },
      source: `kernel_${proxyType}_city`,
    });
  }

  if (state !== undefined) {
    const proxyKey = `${proxyType}:${country}:${state}`;
    candidates.push({
      proxyKey,
      name: `rose-${proxyKey.toLowerCase().replace(/:/g, '-')}`,
      type: proxyType,
      config: { country, state },
      location: { country, state },
      source: `kernel_${proxyType}_state`,
    });
  }

  const proxyKey = `${proxyType}:${country}`;
  candidates.push({
    proxyKey,
    name: `rose-${proxyKey.toLowerCase().replace(/:/g, '-')}`,
    type: proxyType,
    config: { country },
    location: { country },
    source: `kernel_${proxyType}_country`,
  });

  return candidates;
}

export function selectReusableKernelProxy(
  proxies: ProxyListResponse[],
  candidate: KernelProxyCandidate
): string | undefined {
  return proxies.find((proxy) => {
    if (!proxy.id || proxy.name !== candidate.name || proxy.type !== candidate.type) return false;
    if (proxy.status !== 'available') return false;
    if (proxy.bypass_hosts?.length) return false;
    const config = proxy.config as Record<string, unknown> | undefined;
    if (!config || Object.keys(config).length !== Object.keys(candidate.config).length)
      return false;
    return Object.entries(candidate.config).every(
      ([key, value]) =>
        typeof config[key] === 'string' && config[key].toLowerCase() === value.toLowerCase()
    );
  })?.id;
}

const inFlightProxyConfigs = new Map<string, Promise<ResolvedKernelProxy>>();
const PROXY_REUSE_WAIT_MS = KERNEL_CREATE_REQUEST_OPTIONS.timeout;

export async function getOrCreateKernelProxy(
  client: Kernel,
  candidate: KernelProxyCandidate
): Promise<ResolvedKernelProxy> {
  const pending = inFlightProxyConfigs.get(candidate.proxyKey);
  if (pending !== undefined) {
    const resolved = await pending;
    return { ...resolved, source: candidate.source, location: candidate.location };
  }
  const work = resolveKernelProxy(client, candidate);
  inFlightProxyConfigs.set(candidate.proxyKey, work);
  try {
    return await work;
  } finally {
    inFlightProxyConfigs.delete(candidate.proxyKey);
  }
}

async function resolveKernelProxy(
  client: Kernel,
  candidate: KernelProxyCandidate
): Promise<ResolvedKernelProxy> {
  const deadline = Date.now() + PROXY_REUSE_WAIT_MS;
  while (Date.now() < deadline) {
    const existing = await prisma.browserProviderProxy.findUnique({
      where: { provider_proxyKey: { provider: 'kernel', proxyKey: candidate.proxyKey } },
    });
    if (existing !== null) return resolvedProxy(candidate, existing);

    // Serialize rare cache fills database-wide: at most ONE transaction holds a
    // connection during remote I/O, even when many different geo keys miss.
    // A blocking advisory lock would occupy the entire pool with waiters.
    // Try-lock losers commit immediately and sleep without a DB connection.
    const resolved = await runTransactionWithRetry(
      async (tx) => {
        const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(187003377, 1) AS acquired
      `;
        if (!lock?.acquired) return undefined;
        const cached = await tx.browserProviderProxy.findUnique({
          where: { provider_proxyKey: { provider: 'kernel', proxyKey: candidate.proxyKey } },
        });
        if (cached !== null) return resolvedProxy(candidate, cached);
        return provisionKernelProxy(client, candidate, tx.browserProviderProxy);
      },
      { maxWait: 2_000, timeout: 10_000 + KERNEL_CREATE_REQUEST_OPTIONS.timeout + 5_000 }
    );
    if (resolved !== undefined) return resolved;
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new KernelProxyReuseTimeoutError(
    `Timed out waiting for Kernel proxy configuration reuse: ${candidate.proxyKey}`
  );
}

function resolvedProxy(
  candidate: KernelProxyCandidate,
  row: { proxyId: string; proxyKey: string }
): ResolvedKernelProxy {
  return {
    proxyId: row.proxyId,
    proxyKey: row.proxyKey,
    proxyType: candidate.type,
    source: candidate.source,
    location: candidate.location,
  };
}

async function provisionKernelProxy(
  client: Kernel,
  candidate: KernelProxyCandidate,
  cache: Prisma.TransactionClient['browserProviderProxy']
): Promise<ResolvedKernelProxy> {
  // Isolated benchmark databases and restored snapshots can lose the local row
  // while the project still owns this proxy. Reuse it instead of provisioning
  // another identical proxy (which can exceed browser-session init deadlines).
  let projectProxies = await client.proxies.list(
    { query: candidate.name, limit: 100 },
    { timeout: 10_000, maxRetries: 0, signal: AbortSignal.timeout(10_000) }
  );
  let reusableId: string | undefined;
  while (true) {
    reusableId = selectReusableKernelProxy(projectProxies.items, candidate);
    if (reusableId !== undefined || !projectProxies.hasNextPage()) break;
    projectProxies = await projectProxies.getNextPage();
  }
  const remote = reusableId
    ? null
    : await client.proxies.create(
        {
          type: candidate.type,
          name: candidate.name,
          config: candidate.config,
        },
        KERNEL_CREATE_REQUEST_OPTIONS
      );
  const remoteId = reusableId ?? remote?.id;
  if (remoteId === undefined || remoteId === '') {
    throw new Error(`Kernel proxy creation returned no ID for ${candidate.proxyKey}`);
  }

  // A pre-lock rollout worker can still win the unique insert. Native upsert
  // preserves that winner without aborting this PostgreSQL transaction.
  const stored = await cache.upsert({
    where: { provider_proxyKey: { provider: 'kernel', proxyKey: candidate.proxyKey } },
    update: { proxyType: candidate.type },
    create: {
      provider: 'kernel',
      proxyKey: candidate.proxyKey,
      proxyId: remoteId,
      proxyType: candidate.type,
      config: candidate.config,
    },
  });
  return resolvedProxy(candidate, stored);
}

/** Drop the cache row only while it still names the failed proxy, not a concurrent replacement. */
export async function forgetKernelProxy(proxyKey: string, proxyId: string): Promise<void> {
  await prisma.browserProviderProxy.deleteMany({
    where: { provider: 'kernel', proxyKey, proxyId },
  });
}

/**
 * Kernel health-checks a managed proxy while creating a browser on it, records
 * the verdict on the proxy, and rejects the request with a 400 when it fails.
 * The rejection text differs between the failing check and later requests, so
 * the recorded status, not the message, says whether this proxy caused the 400.
 */
async function kernelRejectedUnhealthyProxy(
  client: Kernel,
  error: unknown,
  proxyId: string
): Promise<boolean> {
  if (!(error instanceof BadRequestError)) return false;
  const proxy = await client.proxies
    .retrieve(proxyId, { timeout: 10_000, maxRetries: 0 })
    .catch(() => undefined);
  return proxy?.status === 'unavailable';
}

const STICKY_PROXY_ERRORS = ['proxy not found', 'invalid proxy', 'no_peer', 'no peer'];

export interface KernelProxyLadderEvents {
  onRefresh?: (candidate: KernelProxyCandidate, error: unknown) => void;
  onRelax?: (candidate: KernelProxyCandidate, error: unknown) => void;
}

/**
 * Create a session on the most specific managed proxy that works, relaxing
 * city → state → country only when a location is unavailable.
 *
 * Geo proxies are shared project-wide, so a cached ID can be deleted by another
 * actor. `proxy not found` proves the ID is stale, not that the location lacks
 * inventory: the same candidate is re-resolved once before relaxing. A proxy
 * Kernel marked unavailable is no longer cached and its location is relaxed.
 */
export async function createSessionOnKernelProxyLadder<T>(
  client: Kernel,
  candidates: readonly KernelProxyCandidate[],
  createSession: (proxy: ResolvedKernelProxy) => Promise<T>,
  events: KernelProxyLadderEvents = {}
): Promise<T> {
  for (const [index, candidate] of candidates.entries()) {
    for (let refreshed = false; ; refreshed = true) {
      let resolved: ResolvedKernelProxy | undefined;
      try {
        resolved = await getOrCreateKernelProxy(client, candidate);
        return await createSession(resolved);
      } catch (error) {
        // Only drop a cache row when the error proves this proxy_id is bad.
        // A browsers.create transport timeout does not mean the remote proxy is
        // gone — forgetting it would recreate orphans for the same geo key.
        const message =
          error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        if (isKernelProxyPermissionError(error)) throw error;
        const unhealthy =
          resolved !== undefined &&
          (await kernelRejectedUnhealthyProxy(client, error, resolved.proxyId));
        if (
          resolved !== undefined &&
          (unhealthy || STICKY_PROXY_ERRORS.some((f) => message.includes(f)))
        ) {
          await forgetKernelProxy(resolved.proxyKey, resolved.proxyId).catch(() => {});
        }
        if (resolved !== undefined && !refreshed && message.includes('proxy not found')) {
          events.onRefresh?.(candidate, error);
          continue;
        }
        if (!(unhealthy || isKernelProxyAvailabilityError(error)) || index + 1 >= candidates.length)
          throw error;
        events.onRelax?.(candidate, error);
        break;
      }
    }
  }
  throw new Error('Kernel proxy ladder needs at least one candidate');
}

function isKernelProxyPermissionError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message : String(error);
  return (
    status === 401 ||
    status === 403 ||
    /\b(?:401|403)\b|permission|forbidden|unauthori[sz]ed|access denied/i.test(message)
  );
}

export class KernelProxyReuseTimeoutError extends Error {}

export function isKernelProxyAvailabilityError(error: unknown): boolean {
  if (error instanceof KernelProxyReuseTimeoutError) return false;
  if (isKernelProxyPermissionError(error)) return false;
  // SDK request timeouts (city proxy allocate / session create hung) are
  // transient location-capacity failures — fall back to a coarser geo key.
  if (error instanceof APIConnectionTimeoutError) return true;

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return [
    'no_peer',
    'no peer',
    'proxy configuration validation failed',
    'invalid proxy',
    'no available',
    'location unavailable',
    'proxy not found',
    'request timed out',
    'timed out',
  ].some((fragment) => message.includes(fragment));
}
