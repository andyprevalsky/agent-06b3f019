/** Same-site URL, preferred-config, and live-session key helpers for challenge recovery. */

import type { ProxyGeoLocation } from '../geoip';
import type { KernelRecoveryProxySpecificity } from './kernel';
import type { KernelProxyType } from './kernelProxy';
import type { BrowserProviderName } from './types';

export interface PreferredBrowserConfig {
  version: 1;
  provider: BrowserProviderName;
  proxyMode: string;
  kernelProxyType?: KernelProxyType;
  kernelSpecificity?: KernelRecoveryProxySpecificity;
  steelProxyMode?: 'managed' | 'fixed';
  proxyLocation: ProxyGeoLocation;
  learnedAt: string;
}

export function buildPreferredBrowserConfig(
  config: {
    provider: BrowserProviderName;
    proxyMode: string;
    kernelProxyType?: KernelProxyType;
    kernelSpecificity?: KernelRecoveryProxySpecificity;
    steelProxyMode?: 'managed' | 'fixed';
  },
  proxyLocation: ProxyGeoLocation
): PreferredBrowserConfig {
  return {
    version: 1,
    provider: config.provider,
    proxyMode: config.proxyMode,
    ...(config.kernelProxyType ? { kernelProxyType: config.kernelProxyType } : {}),
    ...(config.kernelSpecificity ? { kernelSpecificity: config.kernelSpecificity } : {}),
    ...(config.steelProxyMode ? { steelProxyMode: config.steelProxyMode } : {}),
    proxyLocation,
    learnedAt: new Date().toISOString(),
  };
}

export function compatiblePreferredBrowserConfig(
  raw: unknown,
  requestedLocation: ProxyGeoLocation
): PreferredBrowserConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Partial<PreferredBrowserConfig>;
  if (candidate.version !== 1 || !['kernel', 'steel'].includes(String(candidate.provider))) {
    return null;
  }
  const learnedLocation = candidate.proxyLocation;
  if (!learnedLocation || learnedLocation.country !== requestedLocation.country) return null;
  if (learnedLocation.state && learnedLocation.state !== requestedLocation.state) return null;
  if (learnedLocation.city && learnedLocation.city !== requestedLocation.city) return null;
  if (candidate.provider === 'kernel' && !candidate.kernelProxyType) return null;
  if (candidate.provider === 'steel' && !candidate.steelProxyMode) return null;
  return candidate as PreferredBrowserConfig;
}

function registrableHost(hostname: string | null | undefined): string {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** Same-site settled URL for follow-up probe / resume navigations. */
export function sameSiteNavigationUrl(
  targetUrl: string,
  settledUrl: string | null | undefined
): string | null {
  const settled = String(settledUrl || '').trim();
  if (!settled.startsWith('http://') && !settled.startsWith('https://')) return null;
  let targetHost = '';
  let settledHost = '';
  try {
    targetHost = registrableHost(new URL(targetUrl).hostname);
    settledHost = registrableHost(new URL(settled).hostname);
  } catch {
    return null;
  }
  if (!targetHost || !settledHost || targetHost !== settledHost) return null;
  return settled;
}

/** Map a live session's provider + proxyTier back to a recovery candidate key. */
export function recoveryConfigKeyForSession(
  provider: string | null | undefined,
  proxyTier: string | null | undefined
): string | undefined {
  const tier = (proxyTier || '').trim().toLowerCase();
  if ((provider || '').toLowerCase() === 'steel') {
    if (tier === 'fixed') return 'steel_fixed';
    if (tier === 'managed' || tier === '') return 'steel_managed';
    return undefined;
  }
  if ((provider || '').toLowerCase() === 'kernel') {
    if (tier === 'none') return 'kernel_direct';
    if (tier.startsWith('isp')) return 'kernel_isp';
    if (tier.startsWith('mobile')) return 'kernel_mobile';
    if (tier.includes('residential_state') || tier === 'residential_state') {
      return 'kernel_residential_state';
    }
    if (tier.includes('residential_city') || tier === 'residential_city') {
      return 'kernel_residential_city';
    }
    if (tier.includes('residential_country') || tier === 'residential_country') {
      return 'kernel_residential_country';
    }
    if (tier.startsWith('residential')) return 'kernel_residential_city';
  }
  return undefined;
}

/** Reject promptly when a sibling lane claims the winner mid-probe. */
export async function raceProbeAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) throw new Error('lane_aborted');
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('lane_aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}
