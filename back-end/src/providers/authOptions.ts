/**
 * Scoped browser-auth option resolver.
 *
 * Browser agent spawn -> /api/auth-options?realm=<site>
 *   -> SteelSessionAuth, CookieBundle, BrowserPassword, EmailIntegrationCredential, MintedAccount
 *   -> single-realm auth_options block for the agent prompt.
 */

import { canonicalAuthRealm, hostnameFromRealmInput } from './authRealm';
import { benchmarkSavedBrowserAuthDisabled } from './benchmarkBrowserAuth';
import { primitiveDomain, createMintedInbox, findMintedInbox } from './primitive';
import { createAgentPhoneNumber, isAgentPhoneEmailFallbackSafe } from './agentPhone';
import { createLogger } from './logger';
import { passwordLastUsedMs } from './browserPasswords';
import { MINTED_PASSWORD_BROWSER_SOURCE, mintedNewPasswordOption } from './mintedAccountPassword';
import * as repo from './authOptionsStore';
import type { AuthOptionsResponse } from './authOptionsTypes';

const log = createLogger('AuthOptions');

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function emailUsesCurrentMintedDomain(email: string): boolean {
  const currentDomain = primitiveDomain().toLowerCase();
  return email.trim().toLowerCase().endsWith(`@${currentDomain}`);
}

function serializeBigInt(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

function passwordWasUsedWithinOneYear(value: bigint | null, nowMs = Date.now()): boolean {
  const lastUsedMs = passwordLastUsedMs(value);
  return lastUsedMs !== null && nowMs - lastUsedMs <= ONE_YEAR_MS;
}

function passwordRef(username: string, origin: string, duplicateUsernames: Set<string>): string {
  if (!duplicateUsernames.has(username)) return `pwd:${username}`;
  const host = hostnameFromRealmInput(origin);
  const shortDomain = host.replace(/^www\./, '').split('.')[0] || 'site';
  return `pwd:${username}@${shortDomain}`;
}

function passwordRefWithCollisionSuffix(
  baseRef: string,
  passwordId: string,
  baseRefCounts: Map<string, number>
): string {
  if ((baseRefCounts.get(baseRef) ?? 0) <= 1) return baseRef;
  return `${baseRef}#${passwordId}`;
}

export async function getAuthOptions(
  userId: string,
  realmInput: string,
  scope: { steelContextId?: string | null } = {}
): Promise<AuthOptionsResponse> {
  const realm = canonicalAuthRealm(realmInput);
  if (realm === '') {
    throw new Error('realm query parameter is required');
  }

  const [steelAuth, bundles, passwordsAll, passkeysAll, minted, agentIdentity, readableInboxes] =
    await Promise.all([
      repo.findSteelSessionAuth(userId, realm, scope.steelContextId),
      repo.findCookieBundles(userId, realm),
      repo.findBrowserPasswords(userId),
      repo.findPasskeys(userId, realm),
      repo.findMintedAccount(userId, realm),
      repo.findAgentIdentity(userId),
      repo.findReadableInboxes(userId),
    ]);

  const hideSavedBrowserAuth = benchmarkSavedBrowserAuthDisabled();
  const cookieBundles = await resolveCookieBundles(userId, realm, bundles, hideSavedBrowserAuth);
  const passwordOptions = resolvePasswordOptions(realm, passwordsAll, hideSavedBrowserAuth);
  // Passkeys are intentionally NOT hidden by hideSavedBrowserAuth: the passkey
  // benchmark strips cookies + passwords but must keep the passkey available.
  const passkeyOptions = passkeysAll.map((pk) => ({
    id: pk.id,
    rpId: pk.rpId,
    credentialId: pk.credentialId,
    disabled: pk.disabledAt !== null,
  }));
  // A code a site emails to one of the user's connected inboxes is read by the
  // one-time-code poller and handed to the agent, so those inboxes are a real
  // sign-in path and the agent has to know which addresses they are.
  const emailOtpEmails = hideSavedBrowserAuth ? [] : readableInboxes.userInboxEmails;
  const emailOtpAvailable = emailOtpEmails.length > 0;
  const enabledSteelSession =
    steelAuth !== null && steelAuth.disabledAt === null && !hideSavedBrowserAuth;
  const enabledCookieBundles = cookieBundles.filter((bundle) => !bundle.disabled);
  const enabledPasswordOptions = passwordOptions.filter((password) => !password.disabled);
  const enabledPasskeys = passkeyOptions.filter((pk) => !pk.disabled);
  // A login the agent saved while typing pwd:new on a sign-up form is the minted
  // account itself, recorded before the site confirmed the signup. It is offered
  // as a saved login, but it must not hide the minted email and pwd:new: if that
  // signup failed, the next run has to be able to sign up again.
  const confirmedPasswordOptions = enabledPasswordOptions.filter(
    (password) => password.browserSource !== MINTED_PASSWORD_BROWSER_SOURCE
  );
  const shouldExposeMinted =
    !enabledSteelSession &&
    enabledCookieBundles.length === 0 &&
    confirmedPasswordOptions.length === 0 &&
    enabledPasskeys.length === 0;
  const mintedIdentity = shouldExposeMinted
    ? await ensureMintedIdentity(userId, agentIdentity, minted)
    : agentIdentity;
  const mintedAccount = await resolveMintedAccount({
    userId,
    realm,
    shouldExposeMinted,
    mintedIdentity,
    minted,
  });

  return {
    realm,
    steel_session:
      steelAuth !== null && !hideSavedBrowserAuth
        ? {
            contextId: steelAuth.contextId,
            authenticatedAt: steelAuth.authenticatedAt.toISOString(),
            disabled: steelAuth.disabledAt !== null,
          }
        : null,
    cookie_bundles: cookieBundles,
    passwords: passwordOptions,
    passkeys: passkeyOptions,
    email_otp: {
      available: emailOtpAvailable,
      connected_emails: emailOtpEmails,
      match_for_site_account: null,
    },
    // The same inboxes the one-time-code poller reads, plus the agent's phone.
    readable_identifiers: [
      ...new Set([
        ...emailOtpEmails,
        ...readableInboxes.mintedInboxEmails,
        ...(mintedIdentity?.phoneProvider === 'agentphone' && mintedIdentity.phone
          ? [mintedIdentity.phone]
          : []),
      ]),
    ],
    minted:
      shouldExposeMinted && mintedAccount !== null
        ? {
            id: mintedAccount.id,
            accountLabel: mintedIdentity?.email ?? mintedAccount.accountLabel,
            email: mintedIdentity?.email ?? mintedAccount.accountLabel,
            phone: mintedIdentity?.phone ?? null,
            provider: 'primitive',
            phoneProvider: mintedIdentity?.phoneProvider === 'agentphone' ? 'agentphone' : null,
            disabled: mintedAccount.disabledAt !== null,
            newPassword: mintedNewPasswordOption(userId, realm),
          }
        : null,
  };
}

async function resolveCookieBundles(
  userId: string,
  realm: string,
  bundles: Awaited<ReturnType<typeof repo.findCookieBundles>>,
  hideSavedBrowserAuth: boolean
) {
  if (hideSavedBrowserAuth) return [];

  const cookieBundles = await Promise.all(
    bundles.map(async (bundle) => ({
      id: bundle.id,
      browserSource: bundle.browserSource,
      browserProfile: bundle.browserProfile === '' ? null : bundle.browserProfile,
      accountLabel: bundle.accountLabel,
      disabled: bundle.disabledAt !== null,
      freshestCookieUtc: serializeBigInt(
        await repo.freshestCookieUtcForBundle({
          userId,
          authRealm: realm,
          browserSource: bundle.browserSource,
          browserProfile: bundle.browserProfile,
        })
      ),
    }))
  );

  cookieBundles.sort((a, b) => {
    if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
    return (b.freshestCookieUtc ?? 0) - (a.freshestCookieUtc ?? 0);
  });

  return cookieBundles;
}

function resolvePasswordOptions(
  realm: string,
  passwordsAll: Awaited<ReturnType<typeof repo.findBrowserPasswords>>,
  hideSavedBrowserAuth: boolean
) {
  const scopedPasswords = hideSavedBrowserAuth
    ? []
    : passwordsAll.filter((password) => {
        const passwordRealm = canonicalAuthRealm(password.origin);
        return passwordRealm === realm && passwordWasUsedWithinOneYear(password.dateLastUsed);
      });
  scopedPasswords.sort((a, b) => {
    if ((a.disabledAt === null) !== (b.disabledAt === null)) {
      return a.disabledAt === null ? -1 : 1;
    }
    const aLastUsed = passwordLastUsedMs(a.dateLastUsed) ?? 0;
    const bLastUsed = passwordLastUsedMs(b.dateLastUsed) ?? 0;
    return bLastUsed - aLastUsed;
  });
  const usernameCounts = new Map<string, number>();
  for (const password of scopedPasswords) {
    usernameCounts.set(password.username, (usernameCounts.get(password.username) ?? 0) + 1);
  }
  const duplicateUsernames = new Set(
    [...usernameCounts.entries()].filter(([, count]) => count > 1).map(([username]) => username)
  );

  const baseRefs = scopedPasswords.map((password) =>
    passwordRef(password.username, password.origin, duplicateUsernames)
  );
  const baseRefCounts = new Map<string, number>();
  for (const ref of baseRefs) {
    baseRefCounts.set(ref, (baseRefCounts.get(ref) ?? 0) + 1);
  }

  return scopedPasswords.map((password, index) => ({
    id: password.id,
    origin: password.origin,
    username: password.username,
    ref: passwordRefWithCollisionSuffix(baseRefs[index], password.id, baseRefCounts),
    disabled: password.disabledAt !== null,
    browserSource: password.browserSource,
    dateLastUsed: serializeBigInt(password.dateLastUsed),
  }));
}

async function resolveMintedAccount({
  userId,
  realm,
  shouldExposeMinted,
  mintedIdentity,
  minted,
}: {
  userId: string;
  realm: string;
  shouldExposeMinted: boolean;
  mintedIdentity: Awaited<ReturnType<typeof repo.findAgentIdentity>>;
  minted: Awaited<ReturnType<typeof repo.findMintedAccount>>;
}) {
  if (
    !shouldExposeMinted ||
    mintedIdentity === null ||
    (minted !== null && minted.accountLabel === mintedIdentity.email)
  ) {
    return minted;
  }

  return repo.upsertMintedAccount({
    userId,
    authRealm: realm,
    accountLabel: mintedIdentity.email,
  });
}

type AgentIdentityRow = Awaited<ReturnType<typeof repo.findAgentIdentity>>;

/**
 * One in-flight mint per user in this process. Browser agents that start
 * together each ask for auth options at once; without this every one of them
 * minted its own inbox (and provisioned its own phone number), and each was
 * told a different identity than the one finally stored.
 */
const identityMints = new Map<string, Promise<AgentIdentityRow>>();

async function ensureMintedIdentity(
  userId: string,
  existingIdentity: AgentIdentityRow,
  existingMintedAccount: Awaited<ReturnType<typeof repo.findMintedAccount>>
): Promise<AgentIdentityRow> {
  // Callers that already hold a minted account label must not inherit a mint
  // that started without one, or the fresh inbox no longer matches their label.
  const key = `${userId}|${existingMintedAccount?.accountLabel ?? ''}`;
  const inFlight = identityMints.get(key);
  if (inFlight !== undefined) return inFlight;
  const mint = mintIdentity(userId, existingIdentity, existingMintedAccount).finally(() => {
    identityMints.delete(key);
  });
  identityMints.set(key, mint);
  return mint;
}

async function mintIdentity(
  userId: string,
  existingIdentity: AgentIdentityRow,
  existingMintedAccount: Awaited<ReturnType<typeof repo.findMintedAccount>>
): Promise<AgentIdentityRow> {
  const agentName = await repo.findUserAgentName(userId);
  // A caller that queued behind another mint read "no identity" before it landed.
  let identity = existingIdentity ?? (await repo.findAgentIdentity(userId));

  if (identity === null) {
    const existingEmail = existingMintedAccount?.accountLabel ?? null;
    if (existingEmail !== null) {
      identity = await repo.createAgentIdentityEmailIfAbsent(userId, existingEmail);
    } else {
      const inbox = await createMintedInbox({ userId, authRealm: 'agent-identity', agentName });
      if (inbox === null) return null;
      identity = await repo.createAgentIdentityEmailIfAbsent(userId, inbox.email);
    }
  } else {
    const hasCurrentMintedDomain = emailUsesCurrentMintedDomain(identity.email);
    const inbox = hasCurrentMintedDomain ? await findMintedInbox(identity.email) : null;
    if (!hasCurrentMintedDomain || inbox === null) {
      const replacement = await createMintedInbox({
        userId,
        authRealm: 'agent-identity',
        agentName,
      });
      if (replacement !== null) {
        identity = await repo.upsertAgentIdentityEmail(userId, replacement.email);
      }
    }
  }

  if (identity.phone === null) {
    try {
      const phone = await createAgentPhoneNumber({ userId, agentName });
      if (phone !== null) {
        identity = await repo.setAgentIdentityPhone({
          userId,
          phone: phone.phoneNumber,
          provider: 'agentphone',
          providerAgentId: phone.agentId,
          providerNumberId: phone.numberId,
        });
      }
    } catch (error) {
      if (!isAgentPhoneEmailFallbackSafe(error)) throw error;
      log.warn('AgentPhone provisioning failed; continuing with agent email only', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return identity;
}

export async function markSteelSessionAuthFailed(
  userId: string,
  steelSessionAuthId: string,
  reason: string,
  preserveBrowserSessionId?: string
) {
  const trimmedReason = reason.trim() || 'steel session auth failed';
  if (steelSessionAuthId.trim() === '') {
    throw new Error('Steel session auth id is required');
  }

  return repo.markSteelSessionAuthFailed(
    userId,
    steelSessionAuthId,
    trimmedReason,
    preserveBrowserSessionId
  );
}
