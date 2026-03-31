/**
 * Integrations upload service — browser data uploads
 * (cookies, localStorage, indexedDB, fingerprint, permissions, cacheStorage, passwords, apple passwords).
 * Split from uploadService.ts for max-lines compliance.
 */

import { type Prisma, IntegrationType, IntegrationStatus } from '@prisma/client';
import { createLogger } from '../../providers/logger';
import type {
  LocalStoragePayload,
  IndexedDBPayload,
  PermissionPayload,
} from './types';
import { VALID_BROWSERS } from './config';
import * as repo from './repo';
import { sanitizeString, sanitizeStringFull } from './uploadService';

const log = createLogger('Integrations');

// ---------------------------------------------------------------------------
// Cookie types for typed processing
// ---------------------------------------------------------------------------
interface CookieInput {
  value?: string;
  name?: string;
  host_key?: string;
  domain?: string;
  path?: string;
  top_frame_site_key?: string;
  expires_utc?: string | number;
  creation_utc?: string | number;
  last_access_utc?: string | number;
  last_update_utc?: string | number;
  is_secure?: boolean;
  is_httponly?: boolean;
  has_expires?: boolean;
  is_persistent?: boolean;
  priority?: number;
  samesite?: number;
  source_scheme?: number;
  source_port?: number;
}

interface SanitizedCookie extends CookieInput {
  value: string;
  name: string;
  host_key: string;
  domain: string;
  path: string;
  top_frame_site_key: string;
}

/** Deduplicate cookies within a batch, keeping the one with latest expiry. */
function dedupeBatch(batch: SanitizedCookie[]) {
  const cookiesByKey = new Map<string, SanitizedCookie>();
  let dupCount = 0;
  for (const cookie of batch) {
    const uniqueKey = `${cookie.domain}|${cookie.name}|${cookie.path}|${cookie.top_frame_site_key}`;
    const existing = cookiesByKey.get(uniqueKey);
    if (existing !== undefined) {
      dupCount++;
      const existingExpiry = BigInt(existing.expires_utc ?? 0);
      const newExpiry = BigInt(cookie.expires_utc ?? 0);
      if (newExpiry > existingExpiry) {
        cookiesByKey.set(uniqueKey, cookie);
      }
    } else {
      cookiesByKey.set(uniqueKey, cookie);
    }
  }
  return { deduped: Array.from(cookiesByKey.values()), dupCount };
}

/** Build params array for cookie batch upsert. */
function buildCookieParams(
  userId: string,
  browser: string,
  dedupedBatch: SanitizedCookie[]
): (string | number | bigint | boolean | null)[] {
  const params: (string | number | bigint | boolean | null)[] = [];
  for (const cookie of dedupedBatch) {
    params.push(
      userId,
      cookie.domain,
      cookie.name,
      cookie.path,
      cookie.value,
      cookie.expires_utc !== undefined && cookie.expires_utc !== null ? BigInt(cookie.expires_utc) : null,
      cookie.is_secure ?? false,
      cookie.is_httponly ?? false,
      browser,
      cookie.creation_utc !== undefined && cookie.creation_utc !== null ? BigInt(cookie.creation_utc) : null,
      cookie.top_frame_site_key,
      cookie.last_access_utc !== undefined && cookie.last_access_utc !== null ? BigInt(cookie.last_access_utc) : null,
      cookie.has_expires ?? true,
      cookie.is_persistent ?? true,
      cookie.priority ?? 1,
      cookie.samesite ?? -1,
      cookie.source_scheme ?? 0,
      cookie.source_port ?? -1,
      cookie.last_update_utc !== undefined && cookie.last_update_utc !== null ? BigInt(cookie.last_update_utc) : null
    );
  }
  return params;
}

/**
 * Process cookies upload.
 */
export async function processCookiesUpload(userId: string, cookies: Record<string, unknown>[], browser: string) {
  if (!VALID_BROWSERS.includes(browser)) {
    throw new Error(`Invalid browser type: ${browser}. Valid types: ${VALID_BROWSERS.join(', ')}`);
  }

  const sanitizedCookies: SanitizedCookie[] = cookies
    .map((cookie) => {
      const c = cookie as CookieInput;
      return {
        ...c,
        value: sanitizeString((c.value as string | undefined) ?? ''),
        name: sanitizeString((c.name as string | undefined) ?? ''),
        host_key: sanitizeString((c.host_key as string | undefined) ?? ''),
        domain: sanitizeString((c.host_key as string | undefined) ?? ''),
        path: sanitizeString((c.path as string | undefined) ?? '/') || '/',
        top_frame_site_key: sanitizeString((c.top_frame_site_key as string | undefined) ?? ''),
      };
    })
    .filter((cookie): cookie is SanitizedCookie =>
      cookie.name !== '' && cookie.value !== ''
    );

  log.info('Received cookies', {
    browser,
    rawCount: cookies.length,
    sanitizedCount: sanitizedCookies.length,
    userId,
  });

  const integration = await repo.upsertIntegration({
    userId,
    name: browser,
    type: IntegrationType.DATA_SOURCE,
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
    config: { browser, cookieCount: sanitizedCookies.length, uploadedAt: new Date().toISOString() },
  });

  if (sanitizedCookies.length > 0) {
    await upsertCookieBatches(userId, browser, sanitizedCookies);
  }

  return { cookieCount: sanitizedCookies.length, integration };
}

/** Upsert cookies in batches of 100. */
async function upsertCookieBatches(userId: string, browser: string, sanitizedCookies: SanitizedCookie[]) {
  const BATCH_SIZE = 100;
  let processedCount = 0;
  const countBefore = await repo.getCookieCount(userId);

  for (let i = 0; i < sanitizedCookies.length; i += BATCH_SIZE) {
    const batch = sanitizedCookies.slice(i, i + BATCH_SIZE);
    const { deduped, dupCount } = dedupeBatch(batch);

    if (dupCount > 0) {
      log.info('Deduped cookie batch', {
        batchNum: Math.floor(i / BATCH_SIZE) + 1,
        before: batch.length,
        after: deduped.length,
        duplicatesRemoved: dupCount,
      });
    }

    const values = deduped
      .map((_, idx) => {
        const base = idx * 19;
        return `(gen_random_uuid(), $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::bigint, $${base + 7}::boolean, $${base + 8}::boolean, $${base + 9}, NOW(), $${base + 10}::bigint, $${base + 11}, $${base + 12}::bigint, $${base + 13}::boolean, $${base + 14}::boolean, $${base + 15}::int, $${base + 16}::int, $${base + 17}::int, $${base + 18}::int, $${base + 19}::bigint)`;
      })
      .join(', ');

    const params = buildCookieParams(userId, browser, deduped);
    await repo.bulkUpsertCookies(values, params);
    processedCount += deduped.length;
  }

  const countAfter = await repo.getCookieCount(userId);
  const newlyInserted = countAfter - countBefore;
  const conflictsResolved = processedCount - newlyInserted;

  log.info('Processed cookies', {
    browser,
    userId,
    total: processedCount,
    newlyInserted,
    conflictsResolved,
  });
}

/**
 * Process localStorage upload.
 */
export async function processLocalStorageUpload(
  userId: string,
  localStorageData: LocalStoragePayload
) {
  const batchInfo = `batch ${localStorageData.batchIndex + 1}/${localStorageData.totalBatches}`;

  const sanitizedByOrigin: Record<string, { key: string; value: string }[]> = {};
  let batchEntryCount = 0;

  for (const [origin, entries] of Object.entries(localStorageData.byOrigin)) {
    const sanitizedOrigin = sanitizeStringFull(origin);
    sanitizedByOrigin[sanitizedOrigin] = entries
      .map((entry: { key: string; value: string }) => ({
        key: sanitizeStringFull(entry.key),
        value: sanitizeStringFull(entry.value),
      }))
      .filter((entry: { key: string; value: string }) => entry.key !== '' && entry.value !== '');
    batchEntryCount += sanitizedByOrigin[sanitizedOrigin].length;
  }

  const batchOriginCount = Object.keys(sanitizedByOrigin).length;

  log.info('Received localStorage', {
    batchInfo,
    rawEntryCount: localStorageData.entryCount,
    rawOriginCount: localStorageData.originCount,
    sanitizedCount: batchEntryCount,
    userId,
  });

  const origins = Object.keys(sanitizedByOrigin);
  if (origins.length > 0) {
    const values = origins
      .map((_origin, i) =>
        `(gen_random_uuid(), $${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}::jsonb, $${i * 4 + 4}, NOW())`
      )
      .join(', ');

    const params: (string | object)[] = [];
    for (const origin of origins) {
      params.push(userId, origin, JSON.stringify(sanitizedByOrigin[origin]), localStorageData.hashes[origin] ?? '');
    }

    await repo.bulkUpsertLocalStorage(values, params);
  }

  log.info('Upserted localStorage', { batchInfo, originCount: batchOriginCount, userId });

  return {
    batchIndex: localStorageData.batchIndex,
    totalBatches: localStorageData.totalBatches,
    entryCount: batchEntryCount,
    originCount: batchOriginCount,
  };
}

/**
 * Process IndexedDB upload.
 */
export async function processIndexedDBUpload(userId: string, indexedDBData: IndexedDBPayload) {
  const batchInfo = `batch ${indexedDBData.batchIndex + 1}/${indexedDBData.totalBatches}`;

  log.info('Received IndexedDB origins', { batchInfo, count: indexedDBData.origins.length, userId });

  const origins = indexedDBData.origins.filter((o) => o.error === undefined || o.error === null);
  if (origins.length > 0) {
    const values = origins
      .map((_origin, i) =>
        `(gen_random_uuid(), $${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}::jsonb, $${i * 4 + 4}, NOW())`
      )
      .join(', ');

    const params: (string | object)[] = [];
    for (const origin of origins) {
      params.push(userId, origin.origin, JSON.stringify(origin.databases), indexedDBData.hashes[origin.origin] ?? '');
    }

    await repo.bulkUpsertIndexedDB(values, params);
  }

  log.info('Upserted IndexedDB origins', { batchInfo, count: origins.length, userId });

  return {
    batchIndex: indexedDBData.batchIndex,
    totalBatches: indexedDBData.totalBatches,
    originCount: origins.length,
  };
}

/**
 * Process fingerprint upload.
 */
export async function processFingerprintUpload(
  userId: string,
  fingerprint: Record<string, unknown>
) {
  if (
    fingerprint === null ||
    fingerprint === undefined ||
    (fingerprint as Record<string, unknown>).navigator === undefined ||
    (fingerprint as Record<string, unknown>).navigator === null ||
    (fingerprint as Record<string, unknown>).screen === undefined ||
    (fingerprint as Record<string, unknown>).screen === null
  ) {
    throw new Error('Invalid fingerprint payload: missing required fields');
  }

  const nav = fingerprint.navigator as Record<string, unknown> | undefined;
  const ua = typeof nav?.userAgent === 'string' ? nav.userAgent.substring(0, 50) : '';

  log.info('Received fingerprint', { userId, ua });

  const integration = await repo.upsertIntegration({
    userId,
    name: 'browser_fingerprint',
    type: IntegrationType.DATA_SOURCE,
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
    config: { fingerprint: fingerprint as unknown as Prisma.InputJsonValue, uploadedAt: new Date().toISOString() },
  });

  log.info('Stored fingerprint', { userId });

  return integration;
}

/**
 * Process permissions upload.
 */
export async function processPermissionsUpload(userId: string, permissionData: PermissionPayload) {
  log.info('Received permission grants', { count: permissionData.grants.length, userId });

  if (permissionData.grants.length > 0) {
    const values = permissionData.grants
      .map((_, i) =>
        `(gen_random_uuid(), $${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}::int, NOW())`
      )
      .join(', ');

    const params: (string | number)[] = [];
    for (const grant of permissionData.grants) {
      params.push(userId, grant.origin, grant.permission, grant.setting);
    }

    await repo.bulkUpsertPermissions(values, params);
  }

  log.info('Upserted permission grants', { count: permissionData.grants.length, userId });

  return { grantCount: permissionData.grants.length };
}
