import { prisma, runTransactionWithRetry } from './database';
import { canonicalAuthRealm } from './authRealm';
import { SSO_REALMS } from './browserCookies';
import { preferredBrowserPasswords } from './browserPasswords';
import { INVALIDATED_STEEL_PROFILE_SOURCE } from './browser/profileBinding';
import { primitiveDomain } from './primitive';

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

/** One saved login per origin+username across browser sources and profiles. */
export async function findBrowserPasswords(userId: string) {
  return preferredBrowserPasswords(await prisma.browserPassword.findMany({ where: { userId } }));
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
/**
 * Every inbox the one-time-code poller reads for this user, with the
 * credentials it reads them with. The poller and every list of readable
 * inboxes come from here, so neither can name an inbox the other does not.
 *
 *   connected Gmail (valid tokens) ──► read through Gmail
 *   minted inbox / connected inbox on our mail domain ──► read through Primitive
 */
export async function findReadableInboxes(userId: string) {
  const [credentials, mintedAccounts] = await Promise.all([
    prisma.emailIntegrationCredential.findMany({
      where: {
        userId,
        provider: 'GMAIL',
        state: { not: 'needs_reconnect' },
        integration: { name: 'gmail', status: 'CONNECTED' },
      },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.mintedAccount.findMany({
      where: { userId, disabledAt: null, accountLabel: { contains: '@' } },
      select: { accountLabel: true },
    }),
  ]);
  const withTokens = credentials.filter(
    (row) =>
      row.accessToken !== null &&
      row.accessToken !== '' &&
      row.refreshToken !== null &&
      row.refreshToken !== ''
  );
  // An inbox on our own mail domain has no Google token to read with; the
  // mail provider that hosts it is read instead.
  const ownDomain = `@${primitiveDomain().toLowerCase()}`;
  const isOwnDomain = (email: string | null) => (email ?? '').toLowerCase().endsWith(ownDomain);
  const unique = (emails: Array<string | null>) => [
    ...new Set(emails.map((email) => (email ?? '').toLowerCase()).filter((email) => email !== '')),
  ];
  const gmailCredentials = withTokens.filter((row) => !isOwnDomain(row.email));
  /** The user's own connected inboxes, whatever mail provider hosts them. */
  const userInboxEmails = unique(withTokens.map((row) => row.email));
  /** The agent's minted inboxes. */
  const mintedInboxEmails = unique(mintedAccounts.map((row) => row.accountLabel));
  /** Inboxes read through Primitive rather than Gmail. */
  const primitiveInboxEmails = unique([
    ...mintedInboxEmails,
    ...userInboxEmails.filter((email) => isOwnDomain(email)),
  ]);
  return { gmailCredentials, primitiveInboxEmails, userInboxEmails, mintedInboxEmails };
}

/** Full addresses of the user's own inboxes whose one-time codes reach the agent. */
export async function findReadableInboxEmails(userId: string): Promise<string[]> {
  return (await findReadableInboxes(userId)).userInboxEmails;
}

/**
 * First writer wins: when two callers mint an inbox for the same user at once,
 * both get the row that landed first, never two different identities.
 */
export async function createAgentIdentityEmailIfAbsent(userId: string, email: string) {
  await prisma.agentIdentity.createMany({ data: [{ userId, email }], skipDuplicates: true });
  return prisma.agentIdentity.findUniqueOrThrow({ where: { userId } });
}

/**
 * Saves the password the agent created an account with. A login the user's
 * browser synced for the same site and username is theirs and is never
 * replaced: each statement below carries that condition itself, so a sync that
 * lands between them cannot be overwritten.
 */
export async function upsertSignupPassword(params: {
  userId: string;
  origin: string;
  username: string;
  encryptedPassword: string;
  browserSource: string;
  nowMs: number;
}): Promise<{ saved: boolean }> {
  const now = BigInt(params.nowMs);
  const key = { userId: params.userId, origin: params.origin, username: params.username };
  const updateOwnRow = () =>
    prisma.browserPassword.updateMany({
      where: { ...key, browserSource: params.browserSource },
      data: { encryptedPassword: params.encryptedPassword, dateLastUsed: now },
    });
  if ((await updateOwnRow()).count > 0) return { saved: true };
  // Saved logins are unique per browser source and profile, so the unique key
  // alone no longer blocks this row beside the user's own synced login for the
  // same site and username; the insert carries that condition itself. A sync
  // committing concurrently can still land beside it, and readers then prefer
  // the user-synced row (providers/browserPasswords).
  const created = await prisma.$executeRaw`
    INSERT INTO "BrowserPassword"
      (id, "userId", origin, username, "encryptedPassword", "dateLastUsed", "dateCreated",
       "browserSource", "browserProfile", "syncedAt")
    SELECT gen_random_uuid(), ${key.userId}, ${key.origin}, ${key.username},
      ${params.encryptedPassword}, ${now}, ${now}, ${params.browserSource}, '', NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "BrowserPassword"
      WHERE "userId" = ${key.userId} AND origin = ${key.origin} AND username = ${key.username}
    )
    ON CONFLICT ("userId", origin, username, "browserSource", "browserProfile") DO NOTHING
  `;
  if (created > 0) return { saved: true };
  // The login was taken between the two statements: by a concurrent save of
  // this same sign-up (update it) or by the user's own synced login (keep it).
  return { saved: (await updateOwnRow()).count > 0 };
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
