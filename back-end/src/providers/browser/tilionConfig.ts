/**
 * Tilion session configuration: lifetime env vars, region lookup and the
 * residential geo ladder. Values come from the live probe of 2026-10-21.
 */
import type { ProxyGeoLocation } from '../geoip';
import { createLogger } from '../logger';
import type { KernelProxyType } from './kernelProxy';
import { tilionRequest } from './tilionClient';

const log = createLogger('Tilion');

/**
 * Exit tiers. `direct` is Tilion's datacenter egress (`residential: false`):
 * live 2026-10-21 residential exits refused CONNECT to payment hosts
 * (net::ERR_TUNNEL_CONNECTION_FAILED) while direct sessions reached them.
 */
export type TilionProxyType = 'residential' | 'mobile' | 'direct';

/**
 * New Tilion sessions start on datacenter egress (Tilion's own default and the
 * cheaper exit); residential is reached through the normal rotation/recovery.
 */
export const TILION_DEFAULT_PROXY_TYPE: TilionProxyType = 'direct';
export type GeoSpecificity = 'city' | 'state' | 'country';

/** The browser activity budget (30 min) plus the 5 min margin the plan requires. */
export const TILION_MIN_TTL_SECONDS = 35 * 60;
// Live probe 2026-10-21: an attached but quiet CDP session ends at idle_timeout,
// and ttl 43200 is accepted. Agents think between steps, so idle uses the maximum.
const DEFAULT_TTL_SECONDS = 14_400;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 3600;

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got ${raw}`);
  }
  return value;
}

export function tilionSessionLifetime(): { ttl: number; idleTimeout: number } {
  return {
    ttl: integerEnv(
      'TILION_SESSION_TTL_SECONDS',
      DEFAULT_TTL_SECONDS,
      TILION_MIN_TTL_SECONDS,
      43_200
    ),
    idleTimeout: integerEnv('TILION_IDLE_TIMEOUT_SECONDS', DEFAULT_IDLE_TIMEOUT_SECONDS, 1, 3600),
  };
}

let regionCache: { codes: Set<string>; fetchedAt: number } | null = null;
const REGION_CACHE_MS = 10 * 60_000;

export async function regionForCountry(country: string): Promise<string | undefined> {
  const code = country.trim().toLowerCase();
  if (regionCache === null || Date.now() - regionCache.fetchedAt > REGION_CACHE_MS) {
    try {
      const regions = await tilionRequest<Array<{ code: string }>>('/v1/regions', {
        retryOnTimeout: true,
      });
      regionCache = {
        codes: new Set(regions.map((r) => r.code.toLowerCase())),
        fetchedAt: Date.now(),
      };
    } catch (error) {
      // The residential geo still pins the exit country; only timezone/locale
      // placement is left to Tilion's nearest region.
      log.warn('Tilion region list unavailable; omitting region', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
  return regionCache.codes.has(code) ? code : undefined;
}

export function resetTilionRegionCacheForTests(): void {
  regionCache = null;
}

export function tilionProxyType(proxyType: KernelProxyType | 'direct'): TilionProxyType {
  if (proxyType === 'residential' || proxyType === 'mobile' || proxyType === 'direct') {
    return proxyType;
  }
  throw new Error(`Tilion has no ${proxyType} exit; expected residential, mobile or direct`);
}

/** The exit tier a Tilion row was created on (`proxyTier`), for resume/reattach. */
export function storedTilionProxyType(proxyTier: string | null | undefined): TilionProxyType {
  return proxyTier === 'mobile' || proxyTier === 'direct' ? proxyTier : 'residential';
}

export function geoSpecificities(location: ProxyGeoLocation): GeoSpecificity[] {
  if (location.city && location.state) return ['city', 'state', 'country'];
  if (location.state) return ['state', 'country'];
  return ['country'];
}

export function geoForSpecificity(location: ProxyGeoLocation, specificity: GeoSpecificity) {
  return {
    country: location.country.trim().toLowerCase(),
    ...(specificity !== 'country' && location.state
      ? { state: location.state.trim().toLowerCase() }
      : {}),
    ...(specificity === 'city' && location.city
      ? { city: location.city.trim().toLowerCase().replace(/\s+/g, '') }
      : {}),
  };
}

export function landedLocation(
  location: ProxyGeoLocation,
  specificity: GeoSpecificity
): ProxyGeoLocation {
  return {
    country: location.country,
    ...(specificity !== 'country' && location.state ? { state: location.state } : {}),
    ...(specificity === 'city' && location.city ? { city: location.city } : {}),
  };
}
