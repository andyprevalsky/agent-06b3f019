/** Same-site URL, preferred-config, and live-session key helpers for challenge recovery. */

import type { ProxyGeoLocation } from '../geoip';
import type { KernelRecoveryProxySpecificity } from './kernel';
import type { KernelProxyType } from './kernelProxy';
import type { BrowserProviderName } from './types';
import type { TilionRecoveryProxyType } from './challengeRecoveryCandidates';

export interface PreferredBrowserConfig {
  version: 1;
  provider: BrowserProviderName;
  proxyMode: string;
  kernelProxyType?: KernelProxyType;
  kernelSpecificity?: KernelRecoveryProxySpecificity;
  steelProxyMode?: 'managed' | 'fixed';
  tilionProxyType?: TilionRecoveryProxyType;
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
    tilionProxyType?: TilionRecoveryProxyType;
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
    ...(config.tilionProxyType ? { tilionProxyType: config.tilionProxyType } : {}),
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
  if (
    candidate.version !== 1 ||
    !['kernel', 'steel', 'browser-use', 'tilion'].includes(String(candidate.provider))
  ) {
    return null;
  }
  const learnedLocation = candidate.proxyLocation;
  if (!learnedLocation || learnedLocation.country !== requestedLocation.country) return null;
  if (learnedLocation.state && learnedLocation.state !== requestedLocation.state) return null;
  if (learnedLocation.city && learnedLocation.city !== requestedLocation.city) return null;
  if (candidate.provider === 'kernel' && !candidate.kernelProxyType) return null;
  if (candidate.provider === 'steel' && !candidate.steelProxyMode) return null;
  if (
    candidate.provider === 'tilion' &&
    candidate.tilionProxyType !== 'residential' &&
    candidate.tilionProxyType !== 'mobile' &&
    candidate.tilionProxyType !== 'direct'
  ) {
    return null;
  }
  return candidate as PreferredBrowserConfig;
}

export {
  raceProbeAbort,
  recoveryConfigKeyForSession,
  sameSiteNavigationUrl,
} from './challengeRecoveryShared';

/** Close the Playwright validation CDP client without failing remote release. */
export async function closeValidationBrowser(session: {
  validationBrowser?: { close?: () => Promise<unknown> | unknown } | null;
}): Promise<void> {
  try {
    await session.validationBrowser?.close?.();
  } catch {
    // Closing the CDP client must never block remote session release.
  }
}
