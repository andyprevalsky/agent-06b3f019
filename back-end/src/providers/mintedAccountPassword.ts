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

import { canonicalAuthRealm } from './authRealm';
import { createHmac } from './crypto';
import { encryptPasswordForStorage } from './credentialEnvelope';
import { createLogger } from './logger';
import * as repo from './authOptionsStore';

const log = createLogger('MintedAccountPassword');

export const MINTED_NEW_PASSWORD_REF = 'pwd:new';
/** Saved-login rows created at sign-up carry this source, like "chrome" for synced ones. */
export const MINTED_PASSWORD_BROWSER_SOURCE = 'agent_signup';

function derivationKey(): string {
  return process.env.BACKEND_API_KEY?.trim() ?? '';
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
  await repo.upsertSignupPassword({
    userId,
    origin,
    username,
    encryptedPassword: encryptPasswordForStorage(password),
    browserSource: MINTED_PASSWORD_BROWSER_SOURCE,
    nowMs: Date.now(),
  });
  log.info('Saved minted account password', { userId, realm, username });
  return { saved: true, username };
}
