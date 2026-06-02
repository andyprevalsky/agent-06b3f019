import { prisma } from '../../providers/database';

export async function findSteelSessionAuth(userId: string, authRealm: string) {
  const rows = await prisma.steelSessionAuth.findMany({
    where: { userId, authRealm },
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
  reason: string
) {
  return prisma.$transaction(async (tx) => {
    const auth = await tx.steelSessionAuth.findFirst({
      where: { id: steelSessionAuthId, userId },
      select: { id: true, contextId: true, authRealm: true },
    });
    if (auth === null) return null;

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

    return {
      id: auth.id,
      authRealm: auth.authRealm,
      disabledAt: now,
      disabledReason: reason,
    };
  });
}
