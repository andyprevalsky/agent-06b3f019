/**
 * Integrations domain repo — bulk upsert operations for browser data sync.
 * Split from repo.ts for max-lines compliance.
 */

import { prisma } from '../../providers/database';

// Cookie operations

/** A Cookie row the snapshot inserted, changed or deleted. */
export interface CookieRowChange {
  domain: string;
  browserProfile: string;
  inserted: boolean;
}

/**
 * Upsert one cookie batch. Rows whose stored content already equals the
 * incoming cookie are skipped (no new tuple, `syncedAt` keeps the time the
 * content last changed), mirroring the LocalStorage/IndexedDB hash guard.
 * Returns only the rows actually inserted or changed.
 */
export async function bulkUpsertCookies(
  valuesClause: string,
  params: (string | number | bigint | boolean | null)[]
) {
  return prisma.$queryRawUnsafe<CookieRowChange[]>(
    `
    INSERT INTO "Cookie" (id, "userId", domain, name, path, value, "expiresUtc", "isSecure", "isHttpOnly", "browserSource", "syncedAt", "creationUtc", "topFrameSiteKey", "lastAccessUtc", "hasExpires", "isPersistent", priority, "sameSite", "sourceScheme", "sourcePort", "lastUpdateUtc", "browserProfile")
    VALUES ${valuesClause}
    ON CONFLICT ("userId", domain, name, path, "topFrameSiteKey", "browserSource", "browserProfile") DO UPDATE SET
      value = EXCLUDED.value,
      "expiresUtc" = EXCLUDED."expiresUtc",
      "isSecure" = EXCLUDED."isSecure",
      "isHttpOnly" = EXCLUDED."isHttpOnly",
      "syncedAt" = NOW(),
      "creationUtc" = EXCLUDED."creationUtc",
      "lastAccessUtc" = EXCLUDED."lastAccessUtc",
      "hasExpires" = EXCLUDED."hasExpires",
      "isPersistent" = EXCLUDED."isPersistent",
      priority = EXCLUDED.priority,
      "sameSite" = EXCLUDED."sameSite",
      "sourceScheme" = EXCLUDED."sourceScheme",
      "sourcePort" = EXCLUDED."sourcePort",
      "lastUpdateUtc" = EXCLUDED."lastUpdateUtc"
    WHERE (
      "Cookie".value, "Cookie"."expiresUtc", "Cookie"."isSecure", "Cookie"."isHttpOnly",
      "Cookie"."creationUtc", "Cookie"."lastAccessUtc", "Cookie"."hasExpires", "Cookie"."isPersistent",
      "Cookie".priority, "Cookie"."sameSite", "Cookie"."sourceScheme", "Cookie"."sourcePort",
      "Cookie"."lastUpdateUtc"
    ) IS DISTINCT FROM (
      EXCLUDED.value, EXCLUDED."expiresUtc", EXCLUDED."isSecure", EXCLUDED."isHttpOnly",
      EXCLUDED."creationUtc", EXCLUDED."lastAccessUtc", EXCLUDED."hasExpires", EXCLUDED."isPersistent",
      EXCLUDED.priority, EXCLUDED."sameSite", EXCLUDED."sourceScheme", EXCLUDED."sourcePort",
      EXCLUDED."lastUpdateUtc"
    )
    RETURNING domain, "browserProfile", (xmax = 0) AS inserted
  `,
    ...params
  );
}

/** Create any missing CookieBundle markers for the snapshot's realms in one statement. */
export async function insertMissingCookieBundles(params: {
  userId: string;
  browserSource: string;
  bundles: Array<{ authRealm: string; browserProfile: string }>;
}) {
  if (params.bundles.length === 0) return [];
  return prisma.$queryRaw<Array<{ authRealm: string; browserProfile: string }>>`
    INSERT INTO "CookieBundle" (id, "userId", "authRealm", "browserSource", "browserProfile", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${params.userId}, realm, ${params.browserSource}, profile, NOW(), NOW()
    FROM unnest(${params.bundles.map((b) => b.authRealm)}::text[], ${params.bundles.map((b) => b.browserProfile)}::text[]) AS t(realm, profile)
    ON CONFLICT ("userId", "authRealm", "browserSource", "browserProfile") DO NOTHING
    RETURNING "authRealm", "browserProfile"
  `;
}

/** Changed cookie content re-enables the realm's bundle (one statement for all changed realms). */
export async function markCookieBundlesChanged(params: {
  userId: string;
  browserSource: string;
  bundles: Array<{ authRealm: string; browserProfile: string }>;
}) {
  if (params.bundles.length === 0) return 0;
  return prisma.$executeRaw`
    UPDATE "CookieBundle" bundle
    SET "updatedAt" = NOW(), "disabledAt" = NULL, "disabledReason" = NULL
    FROM unnest(${params.bundles.map((b) => b.authRealm)}::text[], ${params.bundles.map((b) => b.browserProfile)}::text[]) AS t(realm, profile)
    WHERE bundle."userId" = ${params.userId}
      AND bundle."browserSource" = ${params.browserSource}
      AND bundle."authRealm" = t.realm
      AND bundle."browserProfile" = t.profile
  `;
}

export async function deleteCookiesMissingFromProfileSnapshot(params: {
  userId: string;
  browserSource: string;
  browserProfile: string;
  identities: string[];
}) {
  return prisma.$queryRaw<Array<{ domain: string }>>`
    DELETE FROM "Cookie"
    WHERE "userId" = ${params.userId}
      AND "browserSource" = ${params.browserSource}
      AND "browserProfile" = ${params.browserProfile}
      AND NOT (
        domain || CHR(31) || name || CHR(31) || path || CHR(31) || "topFrameSiteKey" || CHR(31) || COALESCE("browserProfile", '')
        = ANY(${params.identities})
      )
    RETURNING domain
  `;
}

export async function deleteCookiesForBrowserSnapshot(params: {
  userId: string;
  browserSource: string;
}) {
  return prisma.cookie.deleteMany({
    where: {
      userId: params.userId,
      browserSource: params.browserSource,
    },
  });
}

export async function deleteCookieBundlesForBrowserSnapshot(params: {
  userId: string;
  browserSource: string;
}) {
  return prisma.cookieBundle.deleteMany({
    where: {
      userId: params.userId,
      browserSource: params.browserSource,
    },
  });
}

export async function findCookieBundlesForProfiles(params: {
  userId: string;
  browserSource: string;
  browserProfiles: string[];
}) {
  return prisma.cookieBundle.findMany({
    where: {
      userId: params.userId,
      browserSource: params.browserSource,
      browserProfile: { in: params.browserProfiles },
    },
    select: { id: true, authRealm: true, browserProfile: true },
  });
}

export async function deleteCookieBundlesById(userId: string, ids: string[]) {
  if (ids.length === 0) return { count: 0 };
  return prisma.cookieBundle.deleteMany({ where: { userId, id: { in: ids } } });
}

// LocalStorage operations

export async function bulkUpsertLocalStorage(valuesClause: string, params: (string | object)[]) {
  return prisma.$executeRawUnsafe(
    `
    INSERT INTO "LocalStorageOrigin" (id, "userId", origin, entries, hash, "updatedAt")
    VALUES ${valuesClause}
    ON CONFLICT ("userId", origin) DO UPDATE SET
      entries = EXCLUDED.entries,
      hash = EXCLUDED.hash,
      "updatedAt" = NOW()
    WHERE "LocalStorageOrigin".hash IS DISTINCT FROM EXCLUDED.hash
  `,
    ...params
  );
}

// IndexedDB operations

export async function bulkUpsertIndexedDB(valuesClause: string, params: (string | object)[]) {
  return prisma.$executeRawUnsafe(
    `
    INSERT INTO "IndexedDBOrigin" (id, "userId", origin, databases, hash, "updatedAt")
    VALUES ${valuesClause}
    ON CONFLICT ("userId", origin) DO UPDATE SET
      databases = EXCLUDED.databases,
      hash = EXCLUDED.hash,
      "updatedAt" = NOW()
    WHERE "IndexedDBOrigin".hash IS DISTINCT FROM EXCLUDED.hash
  `,
    ...params
  );
}

// Permission operations

export async function bulkUpsertPermissions(valuesClause: string, params: (string | number)[]) {
  return prisma.$executeRawUnsafe(
    `
    INSERT INTO "BrowserPermission" (id, "userId", origin, permission, setting, "syncedAt")
    VALUES ${valuesClause}
    ON CONFLICT ("userId", origin, permission) DO UPDATE SET
      setting = EXCLUDED.setting,
      "syncedAt" = NOW()
  `,
    ...params
  );
}

// Password operations

export async function bulkUpsertPasswords(
  valuesClause: string,
  params: (string | number | null)[]
) {
  return prisma.$executeRawUnsafe(
    `
    INSERT INTO "BrowserPassword" (id, "userId", origin, username, "encryptedPassword", "dateLastUsed", "dateCreated", "browserSource", "browserProfile", "syncedAt", "disabledAt", "disabledReason")
    VALUES ${valuesClause}
    ON CONFLICT ("userId", origin, username) DO UPDATE SET
      "encryptedPassword" = EXCLUDED."encryptedPassword",
      "dateLastUsed" = EXCLUDED."dateLastUsed",
      "dateCreated" = EXCLUDED."dateCreated",
      "browserSource" = EXCLUDED."browserSource",
      "browserProfile" = EXCLUDED."browserProfile",
      "syncedAt" = NOW(),
      "disabledAt" = NULL,
      "disabledReason" = NULL
  `,
    ...params
  );
}

// Passkey operations

export async function bulkUpsertPasskeys(valuesClause: string, params: (string | number | null)[]) {
  return prisma.$executeRawUnsafe(
    `
    INSERT INTO "PasskeyCredential" (id, "userId", "authRealm", "rpId", "credentialId", "encryptedPrivateKey", "userHandle", "signCount", origin, "browserSource", "createdAt", "updatedAt", "disabledAt", "disabledReason")
    VALUES ${valuesClause}
    ON CONFLICT ("userId", "rpId", "credentialId") DO UPDATE SET
      "encryptedPrivateKey" = EXCLUDED."encryptedPrivateKey",
      "userHandle" = EXCLUDED."userHandle",
      "signCount" = EXCLUDED."signCount",
      origin = EXCLUDED.origin,
      "browserSource" = EXCLUDED."browserSource",
      "updatedAt" = NOW(),
      "disabledAt" = NULL,
      "disabledReason" = NULL
  `,
    ...params
  );
}

// CacheStorage operations

export async function bulkUpsertCacheStorage(valuesClause: string, params: (string | object)[]) {
  return prisma.$executeRawUnsafe(
    `
    INSERT INTO "CacheStorageOrigin" (id, "userId", origin, caches, hash, "updatedAt")
    VALUES ${valuesClause}
    ON CONFLICT ("userId", origin) DO UPDATE SET
      caches = EXCLUDED.caches,
      hash = EXCLUDED.hash,
      "updatedAt" = NOW()
    WHERE "CacheStorageOrigin".hash IS DISTINCT FROM EXCLUDED.hash
  `,
    ...params
  );
}

// User operations

export async function findUserById(userId: string) {
  return prisma.user.findUnique({
    where: { userId },
    select: { name: true, phone: true, onboardingCompletedAt: true },
  });
}

/**
 * Account-level policy: does this account want every compute credential it
 * syncs to be pool-eligible? Unknown users fall back to the schema default.
 */
export async function findUserPoolTokensByDefault(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { poolTokensByDefault: true },
  });
  return user?.poolTokensByDefault ?? false;
}

/**
 * Current pool state of a credential integration: the materialized effective
 * value plus the explicit per-integration override (null = inherit account).
 */
export async function findIntegrationPoolingState(
  userId: string,
  name: string,
  accountId?: string | null
) {
  const normalizedAccountId = accountId?.trim() ?? '';
  const select = { poolingEnabled: true, poolingEnabledOverride: true } as const;
  const exact = await prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name, accountId: normalizedAccountId } },
    select,
  });
  if (exact !== null || normalizedAccountId === '') return exact;
  return prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name, accountId: '' } },
    select,
  });
}

export async function findIntegrationById(integrationId: string) {
  return prisma.integration.findUnique({
    where: { id: integrationId },
  });
}
