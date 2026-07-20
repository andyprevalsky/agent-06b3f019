import type Kernel from '@onkernel/sdk';
import { prisma } from '../database';
import type { ProxyGeoLocation } from '../geoip';

export type KernelProxyType = 'residential' | 'mobile';

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

  const remote = await client.proxies.create({
    type: candidate.type,
    name: candidate.name,
    config: candidate.config,
  });
  if (remote.id === undefined || remote.id === '') {
    throw new Error(`Kernel proxy creation returned no ID for ${candidate.proxyKey}`);
  }

  try {
    const stored = await prisma.browserProviderProxy.create({
      data: {
        provider: 'kernel',
        proxyKey: candidate.proxyKey,
        proxyId: remote.id,
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
      await client.proxies.delete(remote.id).catch(() => {});
      return {
        proxyId: winner.proxyId,
        proxyKey: winner.proxyKey,
        proxyType: candidate.type,
        source: candidate.source,
        location: candidate.location,
      };
    }
    await client.proxies.delete(remote.id).catch(() => {});
    throw error;
  }
}

export async function forgetKernelProxy(proxyKey: string): Promise<void> {
  await prisma.browserProviderProxy.deleteMany({
    where: { provider: 'kernel', proxyKey },
  });
}

export function isKernelProxyAvailabilityError(error: unknown): boolean {
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
  ].some((fragment) => message.includes(fragment));
}
