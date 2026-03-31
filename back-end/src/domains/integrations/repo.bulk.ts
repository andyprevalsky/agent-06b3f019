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
    INSERT INTO "Cookie" (id, "userId", domain, name, path, value, "expiresUtc", "isSecure", "isHttpOnly", "browserSource", "syncedAt", "creationUtc", "topFrameSiteKey", "lastAccessUtc", "hasExpires", "isPersistent", priority, "sameSite", "sourceScheme", "sourcePort", "lastUpdateUtc")
    VALUES ${valuesClause}
    ON CONFLICT ("userId", domain, name, path, "topFrameSiteKey") DO UPDATE SET
      value = EXCLUDED.value,
      "expiresUtc" = EXCLUDED."expiresUtc",
      "isSecure" = EXCLUDED."isSecure",
      "isHttpOnly" = EXCLUDED."isHttpOnly",
      "browserSource" = EXCLUDED."browserSource",
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
    WHERE
      EXCLUDED."expiresUtc" > COALESCE("Cookie"."expiresUtc", 0)
      OR (EXCLUDED."expiresUtc" IS NOT NULL AND "Cookie"."expiresUtc" IS NULL)
  `,
    ...params
  );
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
    INSERT INTO "BrowserPassword" (id, "userId", origin, username, "encryptedPassword", "dateLastUsed", "dateCreated", "browserSource", "syncedAt")
    VALUES ${valuesClause}
    ON CONFLICT ("userId", origin, username) DO UPDATE SET
      "encryptedPassword" = EXCLUDED."encryptedPassword",
      "dateLastUsed" = EXCLUDED."dateLastUsed",
      "browserSource" = EXCLUDED."browserSource",
      "syncedAt" = NOW()
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

export async function findIntegrationById(integrationId: string) {
  return prisma.integration.findUnique({
    where: { id: integrationId },
  });
}
