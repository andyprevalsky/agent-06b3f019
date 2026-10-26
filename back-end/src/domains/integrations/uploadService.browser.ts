/* eslint-disable max-lines -- pre-existing: cookie sanitization + batch upsert logic is tightly coupled */
/**
 * Integrations upload service — browser data uploads
 * (cookies, localStorage, indexedDB, fingerprint, permissions, cacheStorage, passwords, apple passwords).
 * Split from uploadService.ts for max-lines compliance.
 */

import {
  type Prisma,
  type LocalStoragePayload,
  type IndexedDBPayload,
  type PermissionPayload,
  IntegrationType,
  IntegrationStatus,
  IndexedDBUploadPayloadTooLargeError,
} from './types';
import { createLogger } from '../../providers/logger';
import { authRealmFromCookieDomain } from '../../providers/authRealm';
import { VALID_BROWSERS } from './config';
import * as repo from './repo';
import { uploadRunProgress } from './service.uploadProgress';
const log = createLogger('Integrations');
const COOKIE_SNAPSHOT_SEPARATOR = '\u001f';

/**
 * Sanitize string: remove null bytes that PostgreSQL can't store.
 */
function sanitizeString(str: string): string {
  if (typeof str !== 'string') return str;
  // eslint-disable-next-line no-control-regex -- Intentionally removing null bytes and control chars for PostgreSQL compatibility
  return str.replace(/\u0000/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * Sanitize string for localStorage: also handles orphan Unicode surrogates.
 */
function sanitizeStringFull(str: string): string {
  if (typeof str !== 'string') return str;
  // eslint-disable-next-line no-control-regex -- Intentionally removing null bytes and control chars for PostgreSQL compatibility
  const sanitized = str.replace(/\u0000/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  const chars = [...sanitized];
  const filtered: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i].codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode = chars[i + 1]?.codePointAt(0);
      if (nextCode !== undefined && nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        filtered.push(chars[i], chars[i + 1]);
        i++;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate without preceding high - drop it
    } else {
      filtered.push(chars[i]);
    }
  }
  return filtered.join('');
}

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
  browserProfile?: { id?: string; path?: string } | string | null;
}

interface SanitizedCookie extends CookieInput {
  value: string;
  name: string;
  host_key: string;
  domain: string;
  path: string;
  top_frame_site_key: string;
  browserProfile: string;
}

function normalizeBrowserProfile(profile: CookieInput['browserProfile']): string {
  if (typeof profile === 'string') {
    const sanitized = sanitizeString(profile);
    return sanitized;
  }
  if (profile !== null && profile !== undefined && typeof profile === 'object') {
    return sanitizeString(String(profile.id ?? ''));
  }
  return '';
}

function cookieIdentity(cookie: {
  domain: string;
  name: string;
  path: string;
  top_frame_site_key?: string;
  topFrameSiteKey?: string;
  browserProfile?: string;
}): string {
  return [
    cookie.domain,
    cookie.name,
    cookie.path,
    cookie.top_frame_site_key ?? cookie.topFrameSiteKey ?? '',
    cookie.browserProfile ?? '',
  ].join(COOKIE_SNAPSHOT_SEPARATOR);
}

/** Deduplicate cookies within a batch, keeping the one with latest expiry. */
function dedupeBatch(batch: SanitizedCookie[]) {
  const cookiesByKey = new Map<string, SanitizedCookie>();
  let dupCount = 0;
  for (const cookie of batch) {
    const uniqueKey = cookieIdentity(cookie);
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
      cookie.expires_utc !== undefined && cookie.expires_utc !== null
        ? BigInt(cookie.expires_utc)
        : null,
      cookie.is_secure ?? false,
      cookie.is_httponly ?? false,
      browser,
      cookie.creation_utc !== undefined && cookie.creation_utc !== null
        ? BigInt(cookie.creation_utc)
        : null,
      cookie.top_frame_site_key,
      cookie.last_access_utc !== undefined && cookie.last_access_utc !== null
        ? BigInt(cookie.last_access_utc)
        : null,
      cookie.has_expires ?? true,
      cookie.is_persistent ?? true,
      cookie.priority ?? 1,
      cookie.samesite ?? -1,
      cookie.source_scheme ?? 0,
      cookie.source_port ?? -1,
      cookie.last_update_utc !== undefined && cookie.last_update_utc !== null
        ? BigInt(cookie.last_update_utc)
        : null,
      cookie.browserProfile
    );
  }
  return params;
}

function groupByProfileAndRealm(cookies: SanitizedCookie[]) {
  const groups = new Map<
    string,
    { authRealm: string; browserProfile: string; cookies: SanitizedCookie[] }
  >();
  for (const cookie of cookies) {
    const authRealm = authRealmFromCookieDomain(cookie.domain);
    if (authRealm === '') continue;
    const key = `${authRealm}\u0000${cookie.browserProfile}`;
    const existing = groups.get(key);
    if (existing) {
      existing.cookies.push(cookie);
    } else {
      groups.set(key, { authRealm, browserProfile: cookie.browserProfile, cookies: [cookie] });
    }
  }
  return [...groups.values()];
}

function groupByProfile(cookies: SanitizedCookie[]) {
  const groups = new Map<string, SanitizedCookie[]>();
  for (const cookie of cookies) {
    const existing = groups.get(cookie.browserProfile);
    if (existing) {
      existing.push(cookie);
    } else {
      groups.set(cookie.browserProfile, [cookie]);
    }
  }
  return [...groups.entries()].map(([browserProfile, profileCookies]) => ({
    browserProfile,
    cookies: profileCookies,
  }));
}

/** Every dot-suffix of a cookie host (`a.b.com` → a.b.com, b.com, com). */
function domainSuffixes(domain: string): string[] {
  const labels = domain.toLowerCase().replace(/^\.+/, '').split('.');
  return labels.map((_, i) => labels.slice(i).join('.'));
}

/**
 * Realm keys (`realm\0profile`) holding at least one of `rows`: the cookie's
 * canonical realm (how its bundle is keyed) plus every host suffix (how a
 * bundle's cookies are matched).
 */
function realmKeysTouchedBy(rows: Array<{ domain: string; browserProfile: string }>) {
  const keys = new Set<string>();
  for (const row of rows) {
    const realms = [authRealmFromCookieDomain(row.domain), ...domainSuffixes(row.domain)];
    for (const realm of realms) keys.add(`${realm}\u0000${row.browserProfile}`);
  }
  return keys;
}

/**
 * Process cookies upload.
 */
export async function processCookiesUpload(
  userId: string,
  cookies: Record<string, unknown>[],
  browser: string
) {
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
        domain: sanitizeString(
          (c.domain as string | undefined) ?? (c.host_key as string | undefined) ?? ''
        ),
        path: sanitizeString((c.path as string | undefined) ?? '/') || '/',
        top_frame_site_key: sanitizeString((c.top_frame_site_key as string | undefined) ?? ''),
        browserProfile: normalizeBrowserProfile(c.browserProfile),
      };
    })
    .filter((cookie): cookie is SanitizedCookie => cookie.name !== '' && cookie.value !== '');

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

  // Sync progress of the browser's row: cookies stored of cookies uploaded, at
  // each existing 100-cookie batch (best-effort; never fails the upload).
  const progress = uploadRunProgress({
    userId,
    run: `cookies-upload:${browser}`,
    unit: 'cookies',
    totals: new Map([[browser, sanitizedCookies.length]]),
  });
  await progress.start();
  await progress.step(async () => {
    if (sanitizedCookies.length > 0) {
      await upsertCookieBatches(userId, browser, sanitizedCookies, progress.advance);
    } else {
      await repo.deleteCookiesForBrowserSnapshot({ userId, browserSource: browser });
      await repo.deleteCookieBundlesForBrowserSnapshot({ userId, browserSource: browser });
    }
  });
  await progress.finish();

  return { cookieCount: sanitizedCookies.length, integration };
}

/**
 * After the snapshot replace, a profile's cookies are exactly the upload, so a
 * bundle is orphaned when no uploaded cookie host falls under its realm.
 */
async function deleteOrphanedCookieBundles(
  userId: string,
  browser: string,
  sanitizedCookies: SanitizedCookie[],
  browserProfiles: string[]
) {
  const liveKeys = realmKeysTouchedBy(sanitizedCookies);
  const bundles = await repo.findCookieBundlesForProfiles({
    userId,
    browserSource: browser,
    browserProfiles,
  });
  const orphaned = bundles.filter(
    (bundle) => !liveKeys.has(`${bundle.authRealm}\u0000${bundle.browserProfile}`)
  );
  await repo.deleteCookieBundlesById(
    userId,
    orphaned.map((bundle) => bundle.id)
  );
  return orphaned.length;
}

/**
 * Replace each uploaded profile's cookie snapshot in batches of 100.
 *
 * Unchanged cookies are not rewritten, and per-realm CookieBundle work is
 * set-based: the realms whose cookies were inserted, changed or deleted are
 * derived from the write statements themselves, so a steady-state re-upload
 * costs O(cookies / 100) statements and writes no rows, independent of how
 * many sites the browser holds.
 */
async function upsertCookieBatches(
  userId: string,
  browser: string,
  sanitizedCookies: SanitizedCookie[],
  onBatch: (cookiesDone: number) => Promise<unknown>
) {
  const BATCH_SIZE = 100;
  let processedCount = 0;
  const groups = groupByProfileAndRealm(sanitizedCookies);
  const profileGroups = groupByProfile(sanitizedCookies);
  const realmKey = (group: { authRealm: string; browserProfile: string }) =>
    `${group.authRealm}\u0000${group.browserProfile}`;

  const createdBundles = await repo.insertMissingCookieBundles({
    userId,
    browserSource: browser,
    bundles: groups.map(({ authRealm, browserProfile }) => ({ authRealm, browserProfile })),
  });
  const created = new Set(createdBundles.map(realmKey));

  const touched: Array<{ domain: string; browserProfile: string }> = [];
  for (const group of profileGroups) {
    const deleted = await repo.deleteCookiesMissingFromProfileSnapshot({
      userId,
      browserSource: browser,
      browserProfile: group.browserProfile,
      identities: group.cookies.map(cookieIdentity),
    });
    for (const row of deleted)
      touched.push({ domain: row.domain, browserProfile: group.browserProfile });
  }

  let newlyInserted = 0;
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
        const base = idx * 20;
        return `(gen_random_uuid(), $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::bigint, $${base + 7}::boolean, $${base + 8}::boolean, $${base + 9}, NOW(), $${base + 10}::bigint, $${base + 11}, $${base + 12}::bigint, $${base + 13}::boolean, $${base + 14}::boolean, $${base + 15}::int, $${base + 16}::int, $${base + 17}::int, $${base + 18}::int, $${base + 19}::bigint, $${base + 20})`;
      })
      .join(', ');

    const params = buildCookieParams(userId, browser, deduped);
    const changedRows = await repo.bulkUpsertCookies(values, params);
    touched.push(...changedRows);
    newlyInserted += changedRows.filter((row) => row.inserted).length;
    processedCount += deduped.length;
    await onBatch(i + batch.length);
  }

  const touchedKeys = realmKeysTouchedBy(touched);
  const changedBundles = groups.filter(
    (group) => touchedKeys.has(realmKey(group)) && !created.has(realmKey(group))
  );
  await repo.markCookieBundlesChanged({
    userId,
    browserSource: browser,
    bundles: changedBundles.map(({ authRealm, browserProfile }) => ({ authRealm, browserProfile })),
  });

  const bundlesRemoved = await deleteOrphanedCookieBundles(
    userId,
    browser,
    sanitizedCookies,
    profileGroups.map((group) => group.browserProfile)
  );

  log.info('Processed cookies', {
    browser,
    userId,
    total: processedCount,
    newlyInserted,
    changed: touched.length - newlyInserted,
    bundlesChanged: changedBundles.length,
    bundlesCreated: createdBundles.length,
    bundlesRemoved,
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
      .map(
        (_origin, i) =>
          `(gen_random_uuid(), $${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}::jsonb, $${i * 4 + 4}, NOW())`
      )
      .join(', ');

    const params: (string | object)[] = [];
    for (const origin of origins) {
      params.push(
        userId,
        origin,
        JSON.stringify(sanitizedByOrigin[origin]),
        localStorageData.hashes[origin] ?? ''
      );
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
 * Process IndexedDB upload from an already-parsed payload.
 *
 * Prefer {@link ingestIndexedDBUploadJson} on the HTTP ingest path — parsing a
 * multi-megabyte `databases` blob into a V8 object graph OOMs the production
 * process (Render crash loop 2026-08-12).
 */
export async function processIndexedDBUpload(userId: string, indexedDBData: IndexedDBPayload) {
  return ingestIndexedDBUploadJson(userId, JSON.stringify(indexedDBData));
}

/** Hard ceiling on decompressed IndexedDB upload JSON (UTF-8 bytes). */
export const MAX_INDEXEDDB_UPLOAD_JSON_BYTES = 64 * 1024 * 1024;

/**
 * Ingest an IndexedDB upload from raw JSON text without decoding `databases`
 * through V8's JSON codec. Postgres stages the document and upserts with
 * `e->'databases'` server-side — the same bound that fixed seed OOMs on 41MB rows.
 */
export async function ingestIndexedDBUploadJson(
  userId: string,
  jsonString: string
): Promise<{ batchIndex: number; totalBatches: number; originCount: number }> {
  const utf8Bytes = Buffer.byteLength(jsonString, 'utf8');
  if (utf8Bytes > MAX_INDEXEDDB_UPLOAD_JSON_BYTES) {
    throw new IndexedDBUploadPayloadTooLargeError(MAX_INDEXEDDB_UPLOAD_JSON_BYTES, utf8Bytes);
  }

  log.info('Received IndexedDB origins', {
    batchInfo: 'ingest',
    userId,
    bytes: utf8Bytes,
  });

  const result = await repo.ingestIndexedDBUploadJsonDocument(userId, jsonString);

  log.info('Upserted IndexedDB origins', {
    batchInfo: `batch ${result.batchIndex + 1}/${result.totalBatches}`,
    count: result.originCount,
    userId,
  });

  return result;
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
    config: {
      fingerprint: fingerprint as unknown as Prisma.InputJsonValue,
      uploadedAt: new Date().toISOString(),
    },
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
      .map(
        (_, i) =>
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
