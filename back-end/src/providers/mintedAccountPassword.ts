/**
 * The password a minted account is created with on a site, and saving it.
 *
 *   auth options (minted offered) ──► minted.newPassword { ref: "pwd:new", encrypted for the worker }
 *   agent types pwd:new into a sign-up form ──► POST /api/auth-options/minted-password
 *   ──► saved as a BrowserPassword for the realm ──► the next run signs in with it
 *
 * The password is derived, not stored, until it is typed. Every retry and resume
 * of one sign-up must type the same value, and a site the agent never signs up
 * on leaves no row behind. Once typed it is saved like any other saved login,
 * so the account stays reachable and the usual post-run bookkeeping applies.
 */

import type { Prisma } from '@prisma/client';
import { canonicalAuthRealm } from './authRealm';
import { createHmac } from './crypto';
import { encryptPasswordForStorage } from './credentialEnvelope';
import { createLogger } from './logger';
import * as repo from './authOptionsStore';

const log = createLogger('MintedAccountPassword');

export const MINTED_NEW_PASSWORD_REF = 'pwd:new';
/** Saved-login rows created at sign-up carry this source, like "chrome" for synced ones. */
export const MINTED_PASSWORD_BROWSER_SOURCE = 'agent_signup';
/** A minted identity that signed in on a site with no password (code or link sign-in). */
export const MINTED_PASSWORDLESS_BROWSER_SOURCE = 'agent_passwordless';

// A dedicated secret keeps minted passwords stable across API-key rotations and
// out of the shared service credential's blast radius; the API key remains the
// fallback until every environment carries the dedicated key.
function derivationKey(): string {
  return (
    process.env.MINTED_PASSWORD_DERIVATION_KEY?.trim() || process.env.BACKEND_API_KEY?.trim() || ''
  );
}

/** Deterministic per user and realm; null when this backend has no key to derive from. */
export function mintedAccountPassword(userId: string, realm: string): string | null {
  const key = derivationKey();
  if (key === '' || realm === '') return null;
  const digest = createHmac('sha256', key)
    .update(`minted-account-password:v1:${userId}:${realm}`)
    .digest('base64url');
  // Upper, lower, digit and symbol are always present, whatever the digest holds.
  return `${digest.slice(0, 20)}#7aQ`;
}

export function mintedNewPasswordOption(
  userId: string,
  realm: string
): { ref: string; encryptedPassword: string } | null {
  const password = mintedAccountPassword(userId, realm);
  if (password === null) return null;
  return { ref: MINTED_NEW_PASSWORD_REF, encryptedPassword: encryptPasswordForStorage(password) };
}

/**
 * Saves the minted account's password for the page it was typed on. Idempotent:
 * retried activities and repeated typing converge on one saved login.
 */
export async function saveMintedAccountPassword(
  userId: string,
  origin: string
): Promise<{ saved: boolean; username: string | null }> {
  const realm = canonicalAuthRealm(origin);
  const password = mintedAccountPassword(userId, realm);
  const [minted, identity] = await Promise.all([
    repo.findMintedAccount(userId, realm),
    repo.findAgentIdentity(userId),
  ]);
  const username = identity?.email ?? minted?.accountLabel ?? null;
  if (password === null || minted === null || minted.disabledAt !== null || username === null) {
    return { saved: false, username: null };
  }
  // A login the user synced from a browser for this site is theirs; typing
  // pwd:new on a page never changes the site's real password, so the write
  // refuses to replace that row.
  const { saved } = await repo.upsertSignupPassword({
    userId,
    origin,
    username,
    encryptedPassword: encryptPasswordForStorage(password),
    browserSource: MINTED_PASSWORD_BROWSER_SOURCE,
    nowMs: Date.now(),
  });
  if (!saved) {
    log.info("Kept the user's saved login instead of the minted password", { userId, realm });
    return { saved: false, username };
  }
  log.info('Saved minted account password', { userId, realm, username });
  return { saved: true, username };
}

/**
 * Records the exact identifier a minted identity signed in with as a saved
 * login without a password, once a run proved the site has that account. The
 * login then hides Minted for the site, like any confirmed saved login. A login
 * already saved for that username on the same realm is kept as it is.
 */
export async function saveMintedPasswordlessLogin(
  tx: Prisma.TransactionClient,
  params: { userId: string; origin: string; username: string; nowMs: number }
): Promise<{ saved: boolean }> {
  const realm = canonicalAuthRealm(params.origin);
  const username = params.username.trim();
  if (realm === '' || username === '') return { saved: false };
  const existing = await tx.browserPassword.findMany({
    where: { userId: params.userId, username },
    select: { origin: true },
  });
  if (existing.some((row) => canonicalAuthRealm(row.origin) === realm)) return { saved: false };
  const now = BigInt(params.nowMs);
  const created = await tx.browserPassword.createMany({
    data: [
      {
        userId: params.userId,
        origin: params.origin,
        username,
        encryptedPassword: encryptPasswordForStorage(''),
        dateLastUsed: now,
        dateCreated: now,
        browserSource: MINTED_PASSWORDLESS_BROWSER_SOURCE,
      },
    ],
    skipDuplicates: true,
  });
  if (created.count > 0)
    log.info('Saved passwordless minted login', { userId: params.userId, realm, username });
  return { saved: created.count > 0 };
}
