import { prisma, runTransactionWithRetry } from './database';
import { INVALIDATED_STEEL_PROFILE_SOURCE } from './browser/profileBinding';

export async function findSteelSessionAuth(
  userId: string,
  authRealm: string,
  contextId?: string | null
) {
  if (contextId === null) return null;
  const rows = await prisma.steelSessionAuth.findMany({
    where: {
      userId,
      authRealm,
      ...(contextId === undefined ? {} : { contextId }),
    },
  });
  rows.sort((a, b) => {
    if ((a.disabledAt === null) !== (b.disabledAt === null)) {
      return a.disabledAt === null ? -1 : 1;
    }
    return b.authenticatedAt.getTime() - a.authenticatedAt.getTime();
  });
  return rows[0] ?? null;
}

export async function findCookieBundles(userId: string, authRealm: string) {
  return prisma.cookieBundle.findMany({
    where: { userId, authRealm },
  });
}

export async function findBrowserPasswords(userId: string) {
  return prisma.browserPassword.findMany({
    where: { userId },
  });
}

export async function findPasskeys(userId: string, authRealm: string) {
  return prisma.passkeyCredential.findMany({
    where: { userId, authRealm },
  });
}

export async function findConnectedEmailCredentials(userId: string) {
  return prisma.emailIntegrationCredential.findMany({
    where: { userId, email: { not: null }, accessToken: { not: null } },
    select: { email: true },
  });
}

export async function findUserAgentName(userId: string) {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { systemName: true },
  });
  return user?.systemName ?? null;
}

export async function findAgentIdentity(userId: string) {
  return prisma.agentIdentity.findUnique({
    where: { userId },
  });
}

export async function upsertAgentIdentityEmail(userId: string, email: string) {
  return prisma.agentIdentity.upsert({
    where: { userId },
    create: { userId, email },
    update: { email },
  });
}

export async function setAgentIdentityPhone(params: {
  userId: string;
  phone: string;
  provider: string;
  providerAgentId: string;
  providerNumberId: string;
}) {
  return prisma.agentIdentity.update({
    where: { userId: params.userId },
    data: {
      phone: params.phone,
      phoneProvider: params.provider,
      phoneProviderAgentId: params.providerAgentId,
      phoneProviderNumberId: params.providerNumberId,
    },
  });
}

export async function findMintedAccount(userId: string, authRealm: string) {
  return prisma.mintedAccount.findUnique({
    where: { userId_authRealm: { userId, authRealm } },
  });
}

export async function upsertMintedAccount(params: {
  userId: string;
  authRealm: string;
  accountLabel: string;
}) {
  return prisma.mintedAccount.upsert({
    where: { userId_authRealm: { userId: params.userId, authRealm: params.authRealm } },
    create: {
      userId: params.userId,
      authRealm: params.authRealm,
      accountLabel: params.accountLabel,
    },
    update: {
      accountLabel: params.accountLabel,
    },
  });
}

export async function freshestCookieUtcForBundle(params: {
  userId: string;
  authRealm: string;
  browserSource: string;
  browserProfile: string;
}) {
  const rows = await prisma.$queryRaw<{ freshest: bigint | null }[]>`
    SELECT MAX("creationUtc") AS freshest
    FROM "Cookie"
    WHERE "userId" = ${params.userId}
      AND "browserSource" = ${params.browserSource}
      AND "browserProfile" = ${params.browserProfile}
      AND (
        LTRIM(domain, '.') = ${params.authRealm}
        OR LTRIM(domain, '.') LIKE ${`%.${params.authRealm}`}
      )
  `;
  return rows[0]?.freshest ?? null;
}

export async function markSteelSessionAuthFailed(
  userId: string,
  steelSessionAuthId: string,
  reason: string,
  preserveBrowserSessionId?: string
) {
  // runTransactionWithRetry, not a raw $transaction: it applies the shared
  // timeout and retries only a transaction that failed to START, so a partially
  // executed body is never replayed. Migrated off the hash-pinned legacy
  // exception, which went stale the moment this function was edited.
  return runTransactionWithRetry(async (tx) => {
    const auth = await tx.steelSessionAuth.findFirst({
      where: { id: steelSessionAuthId, userId },
      select: { id: true, contextId: true, authRealm: true },
    });
    if (auth === null) return null;
    if (preserveBrowserSessionId !== undefined) {
      const preserved = await tx.browserSession.findFirst({
        where: {
          id: preserveBrowserSessionId,
          provider: 'steel',
          providerProfileId: auth.contextId,
          context: { userId },
        },
        select: { id: true },
      });
      if (preserved === null) {
        throw new Error('Preserved browser session is not bound to the failed Steel profile');
      }
    }

    const now = new Date();
    await tx.steelSessionAuth.update({
      where: { id: auth.id },
      data: {
        disabledAt: now,
        disabledReason: reason,
      },
    });
    await tx.browserContext.updateMany({
      where: { userId, contextId: auth.contextId },
      data: { contextId: null },
    });
    await tx.browserProviderProfile.deleteMany({
      where: {
        provider: 'steel',
        profileId: auth.contextId,
        context: { userId },
      },
    });
    await tx.browserSession.updateMany({
      where: {
        provider: 'steel',
        providerProfileId: auth.contextId,
        context: { userId },
      },
      data: {
        providerProfileSource: INVALIDATED_STEEL_PROFILE_SOURCE,
      },
    });

    return {
      id: auth.id,
      authRealm: auth.authRealm,
      disabledAt: now,
      disabledReason: reason,
    };
  });
}
