import { prisma, runTransactionWithRetry } from './database';
import { canonicalAuthRealm } from './authRealm';
import { SSO_REALMS } from './browserCookies';
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

export async function findPasskeys(
  userId: string,
  authRealm: string,
  { includeSso = false }: { includeSso?: boolean } = {}
) {
  // SSO passkeys are opt-in. The browser AGENT path seeds per realm transition,
  // so it gets a "Sign in with Google" passkey when it actually lands on
  // google.com -- no need to eagerly load every SSO passkey into every agent
  // session. The CONNECT flow, by contrast, stays on the target realm while the
  // IdP opens in a separate popup, so it must load the SSO union up front and
  // passes includeSso: true.
  const realms = includeSso
    ? [...new Set([canonicalAuthRealm(authRealm), ...SSO_REALMS])]
    : [canonicalAuthRealm(authRealm)];
  return prisma.passkeyCredential.findMany({
    where: { userId, authRealm: { in: realms } },
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

/**
 * The user's connected inboxes whose mail the backend can read right now: the
 * same credentials the one-time-code poller fetches from. A code emailed to
 * any of these reaches the agent.
 */
export async function findReadableInboxEmails(userId: string): Promise<string[]> {
  const rows = await prisma.emailIntegrationCredential.findMany({
    where: {
      userId,
      provider: 'GMAIL',
      state: { not: 'needs_reconnect' },
      integration: { name: 'gmail', status: 'CONNECTED' },
    },
    select: { email: true, accessToken: true, refreshToken: true },
    orderBy: { updatedAt: 'desc' },
  });
  const readable = rows.filter(
    (row) =>
      row.email !== null &&
      row.email !== '' &&
      row.accessToken !== null &&
      row.accessToken !== '' &&
      row.refreshToken !== null &&
      row.refreshToken !== ''
  );
  return [...new Set(readable.map((row) => (row.email as string).toLowerCase()))];
}

/**
 * First writer wins: when two callers mint an inbox for the same user at once,
 * both get the row that landed first, never two different identities.
 */
export async function createAgentIdentityEmailIfAbsent(userId: string, email: string) {
  await prisma.agentIdentity.createMany({ data: [{ userId, email }], skipDuplicates: true });
  return prisma.agentIdentity.findUniqueOrThrow({ where: { userId } });
}

/** The login a sign-up created, saved the way a synced browser password is. */
export async function upsertSignupPassword(params: {
  userId: string;
  origin: string;
  username: string;
  encryptedPassword: string;
  browserSource: string;
  nowMs: number;
}) {
  const now = BigInt(params.nowMs);
  return prisma.browserPassword.upsert({
    where: {
      userId_origin_username: {
        userId: params.userId,
        origin: params.origin,
        username: params.username,
      },
    },
    create: {
      userId: params.userId,
      origin: params.origin,
      username: params.username,
      encryptedPassword: params.encryptedPassword,
      dateLastUsed: now,
      dateCreated: now,
      browserSource: params.browserSource,
    },
    update: { encryptedPassword: params.encryptedPassword, dateLastUsed: now },
    select: { id: true },
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
