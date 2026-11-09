import { prisma, runTransactionWithRetry } from '../../providers/database';
import { saveMintedPasswordlessLogin } from '../../providers/mintedAccountPassword';
import {
  AUTH_TEST_SITE_BASE_PATH,
  AUTH_TEST_SITE_REALM_PREFIX,
  FIXTURE_INBOX_TOKEN,
  SAVED_PASSWORD_BROWSER_SOURCE,
} from './config';

/** Chrome stores cookie times as microseconds since 1601-01-01. */
const CHROMIUM_EPOCH_OFFSET_MS = 11644473600000n;

function chromiumMicros(unixMs: number): bigint {
  return (BigInt(unixMs) + CHROMIUM_EPOCH_OFFSET_MS) * 1000n;
}

export async function findUserName(userId: string): Promise<{ name: string | null } | null> {
  return prisma.user.findUnique({ where: { userId }, select: { name: true } });
}

/**
 * Connects an inbox for the user, the way linking a mail account does. The
 * address is on our own mail domain, so the site's mail to it is delivered and
 * read through that provider; the stored tokens are never used.
 */
export async function connectInbox(userId: string, email: string): Promise<void> {
  const integration =
    (await prisma.integration.findFirst({ where: { userId, name: 'gmail' } })) ??
    (await prisma.integration.create({
      data: { userId, name: 'gmail', type: 'TOOL_SETUP', status: 'CONNECTED', isActive: true },
    }));
  await prisma.emailIntegrationCredential.upsert({
    where: { userId_provider_email: { userId, provider: 'GMAIL', email } },
    create: {
      userId,
      integrationId: integration.id,
      provider: 'GMAIL',
      email,
      accessToken: FIXTURE_INBOX_TOKEN,
      refreshToken: FIXTURE_INBOX_TOKEN,
    },
    update: { state: 'connected' },
  });
}

/**
 * Upserts one saved browser password for the fixture origin. Rows are keyed by
 * the per-site origin, so a retried fixture call converges on the same rows
 * instead of duplicating them.
 */
export async function upsertSavedPassword(params: {
  userId: string;
  origin: string;
  username: string;
  encryptedPassword: string;
  dateLastUsedMs: number;
}): Promise<string> {
  const dateLastUsed = BigInt(params.dateLastUsedMs);
  const row = await prisma.browserPassword.upsert({
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
      dateLastUsed,
      dateCreated: dateLastUsed,
      browserSource: SAVED_PASSWORD_BROWSER_SOURCE,
    },
    update: {
      encryptedPassword: params.encryptedPassword,
      dateLastUsed,
      disabledAt: null,
      disabledReason: null,
    },
    select: { id: true },
  });
  return row.id;
}

/** Records the passwordless login production saves after a minted sign-in. */
export async function recordMintedPasswordlessLogin(params: {
  userId: string;
  origin: string;
  username: string;
  nowMs: number;
}): Promise<void> {
  await runTransactionWithRetry((tx) => saveMintedPasswordlessLogin(tx, params));
}

export async function findSavedPasswordId(userId: string, origin: string, username: string) {
  const row = await prisma.browserPassword.findUnique({
    where: { userId_origin_username: { userId, origin, username } },
    select: { id: true },
  });
  return row?.id ?? null;
}

export async function findSavedPasswordStates(ids: string[]) {
  if (ids.length === 0) return [];
  return prisma.browserPassword.findMany({
    where: { id: { in: ids } },
    select: { id: true, disabledAt: true, disabledReason: true },
  });
}

/**
 * Saves the user's browser session for the site: one session cookie on the
 * public host plus the bundle marker that ties it to the per-run realm. The
 * site id is the browser profile, so concurrent sites on one host never share
 * a bundle.
 */
export async function upsertSavedSession(params: {
  userId: string;
  realm: string;
  siteId: string;
  cookieDomain: string;
  cookiePath: string;
  cookieName: string;
  cookieValue: string;
  nowMs: number;
  lifetimeMs: number;
}): Promise<string> {
  const key = {
    userId: params.userId,
    domain: params.cookieDomain,
    name: params.cookieName,
    path: params.cookiePath,
    topFrameSiteKey: '',
    browserSource: SAVED_PASSWORD_BROWSER_SOURCE,
    browserProfile: params.siteId,
  };
  const times = {
    value: params.cookieValue,
    creationUtc: chromiumMicros(params.nowMs),
    lastAccessUtc: chromiumMicros(params.nowMs),
    lastUpdateUtc: chromiumMicros(params.nowMs),
    expiresUtc: chromiumMicros(params.nowMs + params.lifetimeMs),
  };
  await prisma.cookie.upsert({
    where: {
      userId_domain_name_path_topFrameSiteKey_browserSource_browserProfile: key,
    },
    create: { ...key, ...times, isHttpOnly: true, isSecure: false, sameSite: 1 },
    update: times,
  });
  const bundleKey = {
    userId: params.userId,
    authRealm: params.realm,
    browserSource: SAVED_PASSWORD_BROWSER_SOURCE,
    browserProfile: params.siteId,
  };
  const bundle = await prisma.cookieBundle.upsert({
    where: { userId_authRealm_browserSource_browserProfile: bundleKey },
    create: bundleKey,
    update: { disabledAt: null, disabledReason: null },
    select: { id: true },
  });
  return bundle.id;
}

export async function findSavedSessionState(id: string | null) {
  if (id === null) return null;
  return prisma.cookieBundle.findUnique({ where: { id }, select: { disabledAt: true } });
}

export async function createPasskey(params: {
  userId: string;
  realm: string;
  rpId: string;
  origin: string;
  credentialId: string;
  encryptedPrivateKey: string;
  userHandle: string;
}): Promise<string> {
  const row = await prisma.passkeyCredential.upsert({
    where: {
      userId_rpId_credentialId: {
        userId: params.userId,
        rpId: params.rpId,
        credentialId: params.credentialId,
      },
    },
    create: {
      userId: params.userId,
      authRealm: params.realm,
      rpId: params.rpId,
      origin: params.origin,
      credentialId: params.credentialId,
      encryptedPrivateKey: params.encryptedPrivateKey,
      userHandle: params.userHandle,
      browserSource: SAVED_PASSWORD_BROWSER_SOURCE,
    },
    update: { disabledAt: null, disabledReason: null },
    select: { id: true },
  });
  return row.id;
}

export async function findPasskeyState(id: string | null) {
  if (id === null) return null;
  return prisma.passkeyCredential.findUnique({
    where: { id },
    select: { disabledAt: true, signCount: true },
  });
}

/** Every row a site seeds is scoped by its siteId, so teardown needs no in-memory record. */
export function deleteFixtureRows(userId: string, siteId: string) {
  return deleteFixtureCredentials({
    userId,
    sitePath: `${AUTH_TEST_SITE_BASE_PATH}/${siteId}/`,
    realm: `${AUTH_TEST_SITE_REALM_PREFIX}${siteId}`,
    siteId,
  });
}

export async function deleteFixtureCredentials(params: {
  userId: string;
  /** The site's own path prefix, present in every one of its page URLs. */
  sitePath: string;
  realm: string;
  siteId: string;
}): Promise<{
  passwords: number;
  mintedAccounts: number;
  passkeys: number;
  cookies: number;
  cookieBundles: number;
}> {
  const fixtureProfile = {
    userId: params.userId,
    browserSource: SAVED_PASSWORD_BROWSER_SOURCE,
    browserProfile: params.siteId,
  };
  // Only this site's fixture inboxes (each address carries `.<siteId>@`): two
  // benches can run at once for one benchmark user, and tearing one down must
  // not take the other's email_otp option away mid-run.
  await prisma.emailIntegrationCredential.deleteMany({
    where: {
      userId: params.userId,
      accessToken: FIXTURE_INBOX_TOKEN,
      email: { contains: `.${params.siteId}@` },
    },
  });
  const [passwords, mintedAccounts, passkeys, cookies, cookieBundles] = await Promise.all([
    // Saved logins the fixture seeded, plus any the agent saved on one of this
    // site's pages during the run (a sign-up saves under the sign-up page's URL).
    prisma.browserPassword.deleteMany({
      where: { userId: params.userId, origin: { contains: params.sitePath } },
    }),
    prisma.mintedAccount.deleteMany({
      where: { userId: params.userId, authRealm: params.realm },
    }),
    prisma.passkeyCredential.deleteMany({
      where: { userId: params.userId, authRealm: params.realm },
    }),
    prisma.cookie.deleteMany({ where: fixtureProfile }),
    prisma.cookieBundle.deleteMany({ where: { ...fixtureProfile, authRealm: params.realm } }),
  ]);
  return {
    passwords: passwords.count,
    mintedAccounts: mintedAccounts.count,
    passkeys: passkeys.count,
    cookies: cookies.count,
    cookieBundles: cookieBundles.count,
  };
}

/**
 * Delivers a text to a mock agent phone number. On a benchmark stack the number
 * is fake and the SMS provider is faked too, so this table is the number's inbox.
 */
export async function deliverTextToMockPhone(params: {
  userId: string;
  externalId: string;
  from: string;
  to: string;
  body: string;
}): Promise<void> {
  await prisma.agentPhoneMessage.create({
    data: { ...params, channel: 'sms', receivedAt: new Date() },
  });
}

/** Only the dedicated phone scenario reads this account/device context. */
export async function findPhoneSmsOwner(userId: string) {
  const [user, device] = await Promise.all([
    prisma.user.findUnique({
      where: { userId },
      select: { userId: true, phone: true, isAnonymous: true },
    }),
    prisma.iPhoneDevice.findUnique({
      where: { userId },
      select: { enabled: true, providerDeviceId: true },
    }),
  ]);
  return { user, device };
}
