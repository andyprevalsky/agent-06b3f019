/** Browser session provenance and injection metadata, without provider I/O. */
import { EMPTY_BROWSER_BASELINE } from '../../providers/browser/checkpoint';
import type { ProxyGeoLocation } from '../../providers/geoip';
import type { BrowserGeoTargeting } from '../../providers/browser/types';

interface BrowserSessionMetadataInput {
  provider: string;
  providerSelection?: { requestedProvider: string; fallbackReason: string };
  geoTargeting?: BrowserGeoTargeting;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  profileId: string | null;
  profileSource: string;
}

interface BrowserSessionInjectionMetadataInput {
  cookies: { injected: boolean; cookieCount: number; authSource: string };
  localStorage: { originCount: number };
  indexedDB: { originCount: number };
  permissions: { grantCount: number };
  cacheStorage: { originCount: number };
}

export function buildBrowserSessionMetadata(
  session: BrowserSessionMetadataInput,
  injectionResult: BrowserSessionInjectionMetadataInput
) {
  return {
    provider: session.provider,
    // Benchmarks and the worker tell a real run on the requested provider from a fallback.
    requested_provider: session.providerSelection?.requestedProvider ?? session.provider,
    provider_fallback_reason: session.providerSelection?.fallbackReason ?? null,
    ...(session.geoTargeting !== undefined
      ? {
          geo_targeting: {
            requested: session.geoTargeting.requested,
            applied: session.geoTargeting.applied,
            requested_location: session.geoTargeting.requestedLocation,
            geo_applied: session.geoTargeting.geoApplied,
            geo_unsupported: session.geoTargeting.geoUnsupported,
          },
        }
      : {}),
    proxy_source: session.proxySource,
    proxy_location: session.proxyLocation,
    profile_id: session.profileId,
    profile_source: session.profileSource,
    auth_source: injectionResult.cookies.authSource,
    cookies_injected: injectionResult.cookies.injected,
    cookies_count: injectionResult.cookies.cookieCount,
    local_storage_origin_count: injectionResult.localStorage.originCount,
    indexed_db_origin_count: injectionResult.indexedDB.originCount,
    permission_grant_count: injectionResult.permissions.grantCount,
    cache_storage_origin_count: injectionResult.cacheStorage.originCount,
    ...(session.provider === 'steel'
      ? {
          steel_profile_id: session.profileId,
          steel_profile_source: session.profileSource,
        }
      : {}),
  };
}

// A logical browser is private only after it has a checkpoint or non-empty baseline.
export function logicalHasPrivateState(session: {
  logicalOwnerKey: string | null;
  checkpointRef: string | null;
  baselineCheckpointRef: string | null;
}): boolean {
  return (
    session.logicalOwnerKey !== null &&
    (session.checkpointRef !== null || session.baselineCheckpointRef !== EMPTY_BROWSER_BASELINE)
  );
}
