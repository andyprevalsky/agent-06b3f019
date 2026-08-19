import { type Prisma, IntegrationType, IntegrationStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';

const log = createLogger('Integrations');
import {
  AUTH_COOKIE_PATTERNS,
  FALSE_POSITIVE_COOKIES,
  AD_TRACKING_DOMAINS,
  CHROME_EPOCH_OFFSET_MICROSECONDS,
  AUTH_DOMAINS_CACHE_TTL_MS,
} from './config';

// Cache authenticated domains per user (5 min TTL)
const authDomainsCache = new Map<string, { domains: string[]; expiresAt: number }>();

export async function findIntegrationsByUser(userId: string) {
  return prisma.integration.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    include: {
      // Scoped to genuinely-connected accounts so callers can derive the
      // connected-address list from the source of truth in this one query
      // (no per-integration follow-up). An abandoned OAuth flow leaves a
      // null-email, tokenless row, which must never surface as an account.
      emailCredentials: {
        where: { email: { not: null }, accessToken: { not: null } },
        select: { email: true },
      },
    },
  });
}

export async function getAuthenticatedDomains(userId: string): Promise<string[]> {
  const cached = authDomainsCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.domains;
  }

  const authRegex = AUTH_COOKIE_PATTERNS.join('|');
  const falsePositiveRegex = FALSE_POSITIVE_COOKIES.map((p) =>
    p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('|');
  const adDomainRegex = AD_TRACKING_DOMAINS.map((d) => d.replace(/\./g, '\\.')).join('|');
  const nowMicroseconds = BigInt(Date.now()) * 1000n + CHROME_EPOCH_OFFSET_MICROSECONDS;

  const domainRows = await prisma
    .$queryRawUnsafe<{ domain: string }[]>(
      `SELECT DISTINCT
       CASE
         WHEN array_length(string_to_array(LTRIM(domain, '.'), '.'), 1) >= 2
         THEN (string_to_array(LTRIM(domain, '.'), '.'))[array_length(string_to_array(LTRIM(domain, '.'), '.'), 1) - 1]
           || '.' || (string_to_array(LTRIM(domain, '.'), '.'))[array_length(string_to_array(LTRIM(domain, '.'), '.'), 1)]
         ELSE LTRIM(domain, '.')
       END AS domain
     FROM "Cookie"
     WHERE "userId" = $1
       AND name ~* $2
       AND NOT name ~* $3
       AND NOT domain ~* $4
       AND ("expiresUtc" IS NULL OR "expiresUtc" <= 0 OR "expiresUtc" >= $5)`,
      userId,
      authRegex,
      falsePositiveRegex,
      adDomainRegex,
      nowMicroseconds
    )
    .catch((err) => {
      log.error('Domains query failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [] as { domain: string }[];
    });

  const domains = domainRows.map((r) => r.domain).sort();
  authDomainsCache.set(userId, {
    domains,
    expiresAt: Date.now() + AUTH_DOMAINS_CACHE_TTL_MS,
  });
  return domains;
}

export function isAuthDomainsCached(userId: string): boolean {
  const cached = authDomainsCache.get(userId);
  return !!cached && cached.expiresAt > Date.now();
}

export async function upsertIntegration(params: {
  userId: string;
  name: string;
  type: IntegrationType;
  config?: Prisma.InputJsonValue;
  status?: IntegrationStatus;
  isActive?: boolean;
  lastSyncAt?: Date;
  lastSuccessfulSyncAt?: Date;
}) {
  return prisma.integration.upsert({
    where: {
      userId_name: {
        userId: params.userId,
        name: params.name,
      },
    },
    create: {
      userId: params.userId,
      name: params.name,
      type: params.type,
      config: params.config ?? {},
      status: params.status ?? IntegrationStatus.NOT_CONNECTED,
      ...(params.isActive !== undefined && { isActive: params.isActive }),
      ...(params.lastSyncAt !== undefined && { lastSyncAt: params.lastSyncAt }),
      ...(params.lastSuccessfulSyncAt !== undefined && {
        lastSuccessfulSyncAt: params.lastSuccessfulSyncAt,
      }),
    },
    update: {
      type: params.type,
      config: params.config ?? {},
      ...(params.status !== undefined && { status: params.status }),
      ...(params.isActive !== undefined && { isActive: params.isActive }),
      ...(params.lastSyncAt !== undefined && { lastSyncAt: params.lastSyncAt }),
      ...(params.lastSuccessfulSyncAt !== undefined && {
        lastSuccessfulSyncAt: params.lastSuccessfulSyncAt,
      }),
    },
  });
}

export async function upsertIntegrationRaw(params: {
  userId: string;
  name: string;
  type: IntegrationType;
  config?: Prisma.InputJsonValue;
  status?: IntegrationStatus;
  isActive?: boolean;
  lastSyncAt?: Date;
  lastSuccessfulSyncAt?: Date;
  /**
   * Effective pool eligibility for this sync. Written on create AND update so a
   * re-sync materializes the account policy; callers resolve it from the
   * account default + any explicit per-integration override.
   */
  poolingEnabled?: boolean;
  updateExtra?: Record<string, unknown>;
}) {
  return prisma.integration.upsert({
    where: {
      userId_name: {
        userId: params.userId,
        name: params.name,
      },
    },
    create: {
      userId: params.userId,
      name: params.name,
      type: params.type,
      config: params.config ?? {},
      status: params.status ?? IntegrationStatus.NOT_CONNECTED,
      ...(params.isActive !== undefined && { isActive: params.isActive }),
      ...(params.poolingEnabled !== undefined && { poolingEnabled: params.poolingEnabled }),
      ...(params.lastSyncAt !== undefined && { lastSyncAt: params.lastSyncAt }),
      ...(params.lastSuccessfulSyncAt !== undefined && {
        lastSuccessfulSyncAt: params.lastSuccessfulSyncAt,
      }),
    },
    update: {
      type: params.type,
      config: params.config ?? {},
      ...(params.status !== undefined && { status: params.status }),
      ...(params.isActive !== undefined && { isActive: params.isActive }),
      ...(params.poolingEnabled !== undefined && { poolingEnabled: params.poolingEnabled }),
      ...(params.lastSyncAt !== undefined && { lastSyncAt: params.lastSyncAt }),
      ...(params.lastSuccessfulSyncAt !== undefined && {
        lastSuccessfulSyncAt: params.lastSuccessfulSyncAt,
      }),
      ...params.updateExtra,
    },
  });
}

export async function upsertIntegrationForUpload(params: {
  userId: string;
  name: string;
  config: Prisma.InputJsonValue;
}) {
  return prisma.integration.upsert({
    where: {
      userId_name: {
        userId: params.userId,
        name: params.name,
      },
    },
    create: {
      userId: params.userId,
      name: params.name,
      type: IntegrationType.DATA_SOURCE,
      status: IntegrationStatus.SYNCING,
      config: params.config,
    },
    update: {
      status: IntegrationStatus.SYNCING,
      config: params.config,
    },
  });
}

/**
 * Reserve the integration row for an OAuth flow that is only just STARTING.
 *
 * Deliberately not `upsertIntegrationForUpload`: that helper REPLACES `config`
 * wholesale, so merely opening the Google consent screen destroyed the
 * `connectedEmails` the UI renders its account chips from. A user who then
 * abandoned the flow never reached the callback that rewrites them, so a
 * still-connected account silently lost its chips (prod, 2026-08-18).
 *
 * Nothing is known about the new grant yet, so this must be purely additive:
 * merge the flow marker over existing config, and never downgrade a healthy
 * integration's status — no credential has changed at this point.
 */
export async function upsertIntegrationForOAuthStart(params: {
  userId: string;
  name: string;
  config: Record<string, unknown>;
}) {
  const existing = await prisma.integration.findUnique({
    where: { userId_name: { userId: params.userId, name: params.name } },
    select: { id: true, config: true, status: true },
  });

  if (existing === null) {
    return prisma.integration.create({
      data: {
        userId: params.userId,
        name: params.name,
        type: IntegrationType.DATA_SOURCE,
        status: IntegrationStatus.SYNCING,
        config: params.config as Prisma.InputJsonValue,
      },
    });
  }

  const existingConfig =
    typeof existing.config === 'object' &&
    existing.config !== null &&
    !Array.isArray(existing.config)
      ? (existing.config as Record<string, unknown>)
      : {};

  return prisma.integration.update({
    where: { id: existing.id },
    data: {
      config: { ...existingConfig, ...params.config } as Prisma.InputJsonValue,
    },
  });
}

export async function updateIntegrationStatus(
  integrationId: string,
  status: IntegrationStatus,
  extra?: {
    isActive?: boolean;
    lastSyncAt?: Date;
    lastSuccessfulSyncAt?: Date;
    lastFailedSyncAt?: Date;
    failureReason?: string;
    config?: Prisma.InputJsonValue;
  }
) {
  return prisma.integration.update({
    where: { id: integrationId },
    data: {
      status,
      ...extra,
    },
  });
}

export async function findIntegrationByUserAndName(userId: string, name: string) {
  return prisma.integration.findUnique({
    where: {
      userId_name: {
        userId,
        name,
      },
    },
  });
}

export async function updateIntegration(
  integrationId: string,
  data: Prisma.IntegrationUpdateInput
) {
  return prisma.integration.update({
    where: { id: integrationId },
    data,
  });
}

export async function deleteIntegration(integrationId: string) {
  return prisma.integration.delete({
    where: { id: integrationId },
  });
}

// Email credential operations — split for max-lines compliance
export {
  createEmailCredential,
  findCredentialByState,
  findExistingCredential,
  deleteEmailCredential,
  updateEmailCredential,
  findConnectedEmailCredentials,
  findGmailIntegrationsWithCredentials,
  findGmailCredentialForSend,
  findGmailCredentialForDisconnect,
  findAvailableGmailEmails,
  findMintedAccountEmails,
  updateEmailCredentialToken,
} from './repo.email';

// Bulk operations and misc queries — split for max-lines compliance
export {
  getCookieCount,
  bulkUpsertCookies,
  cookieBundleSnapshotChanged,
  upsertCookieBundle,
  deleteCookiesMissingFromProfileSnapshot,
  deleteCookiesForBrowserSnapshot,
  deleteCookieBundlesForBrowserSnapshot,
  deleteCookieBundlesWithoutCookiesForProfile,
  bulkUpsertLocalStorage,
  bulkUpsertIndexedDB,
  bulkUpsertPermissions,
  bulkUpsertPasswords,
  bulkUpsertPasskeys,
  bulkUpsertCacheStorage,
  findUserById,
  findUserPoolTokensByDefault,
  findIntegrationPoolingState,
  findIntegrationById,
} from './repo.bulk';

export { ingestIndexedDBUploadJsonDocument } from './repo.indexeddbUpload';
