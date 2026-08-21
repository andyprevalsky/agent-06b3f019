/**
 * Steel proxy configuration.
 *
 * Split from session.ts to keep that file within its line budget. Everything
 * here is about WHICH egress IP a session gets -- managed rotation, Dedicated
 * IPs, and the rejected-city memo that stops us retrying geolocations Steel has
 * already refused.
 */

import { type ProxyGeoLocation } from '../geoip';
import { log } from './types';
import { envEnabled } from './profileBinding';

export type SteelProxyConfig =
  | false
  | { server: string }
  // Steel Dedicated IPs: { type: 'fixed' } lets Steel pick one of our leased
  // IPs and — with persistProfile — pin it to the profile, so each user keeps a
  // stable egress IP across sessions. An explicit id pins a specific IP.
  | { type: 'fixed'; id?: string }
  | {
      geolocation: {
        country: string;
        state?: string;
        city?: string;
      };
    };

export type SteelProxySettings = {
  config: SteelProxyConfig;
  source: 'none' | 'steel' | 'byop' | 'dedicated';
};

function redactProxyServerForLog(server: string): string {
  try {
    const url = new URL(server);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '<invalid proxy URL>';
  }
}

// Cities Steel has already rejected with "400 Invalid proxy configuration".
// Steel only has residential proxies in a subset of cities; without this cache
// every session for an affected user burns ~0.5-4s on a guaranteed-failing
// create attempt before the dropCity retry succeeds. The cache is per-process
// (re-learned after each deploy), so known-bad cities can be seeded via
// STEEL_REJECTED_PROXY_CITIES="US|CA|SAN FRANCISCO,US|NY|NEW YORK" to skip
// even the first-request penalty. Advisory only — it never drops country/state.
const rejectedProxyCities = new Set<string>(
  (process.env.STEEL_REJECTED_PROXY_CITIES ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.split('|').length === 3 && entry.split('|')[2] !== '')
);

export function proxyCityKey(geolocation: ProxyGeoLocation): string {
  return `${geolocation.country}|${geolocation.state ?? ''}|${geolocation.city ?? ''}`.toLowerCase();
}

export function isKnownRejectedProxyCity(geolocation: ProxyGeoLocation): boolean {
  return geolocation.city !== undefined && rejectedProxyCities.has(proxyCityKey(geolocation));
}

export function rememberRejectedProxyCity(geolocation: ProxyGeoLocation): void {
  if (geolocation.city === undefined || geolocation.city === '') return;
  rejectedProxyCities.add(proxyCityKey(geolocation));
  log.info(`  🌎 Remembering unsupported proxy city: ${proxyCityKey(geolocation)}`);
}

export function isInvalidSteelProxyConfiguration(error: unknown): boolean {
  const status =
    (error as Record<string, unknown>)?.status ?? (error as Record<string, unknown>)?.statusCode;
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return status === 400 || message.includes('invalid proxy configuration');
}

export function buildSteelProxySettings(
  geolocation: ProxyGeoLocation,
  dropCity = false,
  forceManagedRotation = false,
  forcedMode?: 'managed' | 'fixed'
): SteelProxySettings {
  const byopProxyServer = process.env.STEEL_PROXY_SERVER?.trim();
  if (byopProxyServer && !forceManagedRotation && forcedMode === undefined) {
    log.info(`  Using BYOP proxy server: ${redactProxyServerForLog(byopProxyServer)}`);
    return { config: { server: byopProxyServer }, source: 'byop' };
  }

  // Dedicated IPs: route through our leased Steel IP pool. With persistProfile +
  // a per-user profileId, Steel pins one IP to each user's profile on first use,
  // giving every user a stable egress identity (and making cf_clearance reuse
  // work). An explicit STEEL_DEDICATED_IP_ID pins one shared IP instead.
  if (
    forcedMode === 'fixed' ||
    (!forceManagedRotation &&
      forcedMode === undefined &&
      envEnabled('BROWSER_AGENT_STEEL_DEDICATED_IP_ENABLED', false))
  ) {
    const pinnedId = process.env.STEEL_DEDICATED_IP_ID?.trim();
    log.info(
      `  Using Steel dedicated IP${pinnedId ? ` (pinned ${pinnedId})` : ' (auto-pin to profile)'}`
    );
    return {
      config: { type: 'fixed', ...(pinnedId ? { id: pinnedId } : {}) },
      source: 'dedicated',
    };
  }

  const useSteelProxy =
    forceManagedRotation ||
    forcedMode === 'managed' ||
    envEnabled('BROWSER_AGENT_STEEL_PROXY_ENABLED', true);
  if (!useSteelProxy) {
    return { config: false, source: 'none' };
  }

  return {
    config: {
      geolocation: {
        country: geolocation.country,
        // Steel only supports state for US proxies
        ...(geolocation.country === 'US' && geolocation.state && { state: geolocation.state }),
        // City-level targeting is best-effort: Steel only has residential
        // proxies in a subset of cities and 400s ("Invalid proxy configuration")
        // for unsupported ones (e.g. SAN FRANCISCO). dropCity is set by the
        // session-create retry loop after such a rejection so we fall back to
        // country+state, which Steel always supports.
        ...(!dropCity && geolocation.city && { city: geolocation.city }),
      },
    },
    source: 'steel',
  };
}
