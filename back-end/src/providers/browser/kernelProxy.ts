import Kernel, { APIConnectionTimeoutError } from '@onkernel/sdk';
import type { ProxyListResponse } from '@onkernel/sdk/resources/proxies';
import { prisma } from '../database';
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
  if (source === null && proxyTier === 'mobile') return { forceManagedProxyType: 'mobile' };
  return {};
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
      ([key, value]) => String(config?.[key] ?? '').toLowerCase() === value.toLowerCase()
    );
  })?.id;
}

export async function getOrCreateKernelProxy(
  client: Kernel,
  candidate: KernelProxyCandidate
): Promise<ResolvedKernelProxy> {
  const existing = await prisma.browserProviderProxy.findUnique({
    where: { provider_proxyKey: { provider: 'kernel', proxyKey: candidate.proxyKey } },
  });
  if (existing !== null) {
    return {
      proxyId: existing.proxyId,
      proxyKey: existing.proxyKey,
      proxyType: candidate.type,
      source: candidate.source,
      location: candidate.location,
    };
  }

  // Isolated benchmark databases and restored snapshots can lose the local row
  // while the project still owns this proxy. Reuse it instead of provisioning
  // another identical proxy (which can exceed browser-session init deadlines).
  let projectProxies = await client.proxies.list(
    { query: candidate.name, limit: 100 },
    { timeout: 10_000, maxRetries: 0 }
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

  try {
    const stored = await prisma.browserProviderProxy.create({
      data: {
        provider: 'kernel',
        proxyKey: candidate.proxyKey,
        proxyId: remoteId,
        proxyType: candidate.type,
        config: candidate.config,
      },
    });
    return {
      proxyId: stored.proxyId,
      proxyKey: stored.proxyKey,
      proxyType: candidate.type,
      source: candidate.source,
      location: candidate.location,
    };
  } catch (error) {
    const winner = await prisma.browserProviderProxy.findUnique({
      where: { provider_proxyKey: { provider: 'kernel', proxyKey: candidate.proxyKey } },
    });
    if (winner !== null) {
      return {
        proxyId: winner.proxyId,
        proxyKey: winner.proxyKey,
        proxyType: candidate.type,
        source: candidate.source,
        location: candidate.location,
      };
    }
    // Another caller may have listed this remote proxy and be about to save it.
    // Retain it for a later lookup rather than deleting a possibly referenced ID.
    throw error;
  }
}

export async function forgetKernelProxy(proxyKey: string): Promise<void> {
  await prisma.browserProviderProxy.deleteMany({
    where: { provider: 'kernel', proxyKey },
  });
}

export function isKernelProxyAvailabilityError(error: unknown): boolean {
  // SDK request timeouts (city proxy allocate / session create hung) are
  // transient location-capacity failures — fall back to a coarser geo key.
  if (error instanceof APIConnectionTimeoutError) return true;

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return [
    'no_peer',
    'no peer',
    'proxy unavailable',
    'proxy is unavailable',
    'proxy configuration validation failed',
    'invalid proxy',
    'no available',
    'location unavailable',
    'proxy not found',
    'request timed out',
    'timed out',
  ].some((fragment) => message.includes(fragment));
}
