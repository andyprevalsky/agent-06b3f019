/**
 * Integrations domain repo — bulk upsert operations for browser data sync.
 * Split from repo.ts for max-lines compliance.
 */

import { prisma } from '../../providers/database';

// Cookie operations

export async function getCookieCount(userId: string) {
  return prisma.cookie.count({ where: { userId } });
}

export async function bulkUpsertCookies(
  valuesClause: string,
  params: (string | number | bigint | boolean | null)[]
) {
  return prisma.$executeRawUnsafe(
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
  `,
    ...params
  );
}

export async function cookieBundleSnapshotChanged(params: {
  userId: string;
  authRealm: string;
  browserSource: string;
  browserProfile: string;
  snapshot: Array<{ identity: string; signature: string }>;
  incomingCount: number;
}) {
  const existing = await prisma.$queryRaw<{ identity: string; signature: string }[]>`
    SELECT
      domain || CHR(31) || name || CHR(31) || path || CHR(31) || "topFrameSiteKey" || CHR(31) || COALESCE("browserProfile", '') AS identity,
      value || CHR(31) || COALESCE("expiresUtc"::text, '') || CHR(31) ||
        "isSecure"::text || CHR(31) || "isHttpOnly"::text || CHR(31) ||
        COALESCE("creationUtc"::text, '') || CHR(31) || COALESCE("lastAccessUtc"::text, '') || CHR(31) ||
        "hasExpires"::text || CHR(31) || "isPersistent"::text || CHR(31) ||
        priority::text || CHR(31) || "sameSite"::text || CHR(31) ||
        "sourceScheme"::text || CHR(31) || "sourcePort"::text || CHR(31) ||
        COALESCE("lastUpdateUtc"::text, '') AS signature
    FROM "Cookie"
    WHERE "userId" = ${params.userId}
      AND "browserSource" = ${params.browserSource}
      AND "browserProfile" = ${params.browserProfile}
      AND (
        LTRIM(domain, '.') = ${params.authRealm}
        OR LTRIM(domain, '.') LIKE ${`%.${params.authRealm}`}
      )
  `;
  if (existing.length !== params.incomingCount) return true;
  const existingSignatures = new Map(existing.map((row) => [row.identity, row.signature]));
  return params.snapshot.some(
    (cookie) => existingSignatures.get(cookie.identity) !== cookie.signature
  );
}

export async function upsertCookieBundle(params: {
  userId: string;
  authRealm: string;
  browserSource: string;
  browserProfile: string;
  clearDisabled: boolean;
}) {
  return prisma.$executeRaw`
    INSERT INTO "CookieBundle" (id, "userId", "authRealm", "browserSource", "browserProfile", "createdAt", "updatedAt", "disabledAt", "disabledReason")
    VALUES (gen_random_uuid(), ${params.userId}, ${params.authRealm}, ${params.browserSource}, ${params.browserProfile}, NOW(), NOW(), NULL, NULL)
    ON CONFLICT ("userId", "authRealm", "browserSource", "browserProfile") DO UPDATE SET
      "updatedAt" = NOW(),
      "disabledAt" = CASE WHEN ${params.clearDisabled} THEN NULL ELSE "CookieBundle"."disabledAt" END,
      "disabledReason" = CASE WHEN ${params.clearDisabled} THEN NULL ELSE "CookieBundle"."disabledReason" END
  `;
}

export async function deleteCookiesMissingFromProfileSnapshot(params: {
  userId: string;
  browserSource: string;
  browserProfile: string;
  identities: string[];
}) {
  return prisma.$executeRaw`
    DELETE FROM "Cookie"
    WHERE "userId" = ${params.userId}
      AND "browserSource" = ${params.browserSource}
      AND "browserProfile" = ${params.browserProfile}
      AND NOT (
        domain || CHR(31) || name || CHR(31) || path || CHR(31) || "topFrameSiteKey" || CHR(31) || COALESCE("browserProfile", '')
        = ANY(${params.identities})
      )
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

export async function deleteCookieBundlesWithoutCookiesForProfile(params: {
  userId: string;
  browserSource: string;
  browserProfile: string;
}) {
  return prisma.$executeRaw`
    DELETE FROM "CookieBundle" bundle
    WHERE bundle."userId" = ${params.userId}
      AND bundle."browserSource" = ${params.browserSource}
      AND bundle."browserProfile" = ${params.browserProfile}
      AND NOT EXISTS (
        SELECT 1
        FROM "Cookie" cookie
        WHERE cookie."userId" = bundle."userId"
          AND cookie."browserSource" = bundle."browserSource"
          AND cookie."browserProfile" = bundle."browserProfile"
          AND (
            LTRIM(cookie.domain, '.') = bundle."authRealm"
            OR LTRIM(cookie.domain, '.') LIKE CONCAT('%.', bundle."authRealm")
          )
      )
  `;
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
    ON CONFLICT ("userId", origin, username, "browserSource", "browserProfile") DO UPDATE SET
      "encryptedPassword" = EXCLUDED."encryptedPassword",
      "dateLastUsed" = EXCLUDED."dateLastUsed",
      "dateCreated" = EXCLUDED."dateCreated",
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
