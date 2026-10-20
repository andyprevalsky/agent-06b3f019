/**
 * Seeds what the user "has" for the site into the same tables the agent's auth
 * options and browser session read: saved passwords, a saved browser session
 * (cookie + bundle), and a passkey.
 */

import { generateKeyPairSync, randomBytes } from '../../providers/crypto';
import { encryptPasswordForStorage } from '../../providers/credentialEnvelope';
import * as repo from './repo';
import { AUTH_TEST_SITE_BASE_PATH, SAVED_SESSION_LIFETIME_MS, SESSION_COOKIE_NAME } from './config';
import type { ScenarioPlan } from './serviceScenarios';
import { startSession } from './serviceSignIn';
import type { AuthTestSite, SavedPasswordRecord } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function seedSavedPasswords(
  site: AuthTestSite,
  plan: ScenarioPlan,
  nowMs: number
): Promise<SavedPasswordRecord[]> {
  const records: SavedPasswordRecord[] = [];
  for (const seed of plan.savedPasswords) {
    const id = await repo.upsertSavedPassword({
      userId: site.userId,
      origin: site.entryUrl,
      username: seed.username,
      encryptedPassword: encryptPasswordForStorage(seed.password),
      dateLastUsedMs: nowMs - seed.lastUsedDaysAgo * DAY_MS,
    });
    const account = plan.accounts.find((candidate) => candidate.email === seed.username);
    records.push({
      id,
      username: seed.username,
      matchesAccount: account !== undefined && account.password === seed.password,
    });
  }
  return records;
}

/**
 * Records the minted identity's existing account through the same writer a
 * successful minted sign-in uses, so the fixture is a state production makes.
 */
export async function seedMintedLogin(
  site: AuthTestSite,
  plan: ScenarioPlan,
  nowMs: number
): Promise<SavedPasswordRecord[]> {
  if (plan.mintedLogin === null || plan.mintedLogin === '') return [];
  const username = plan.mintedLogin;
  await repo.recordMintedPasswordlessLogin({
    userId: site.userId,
    origin: site.entryUrl,
    username,
    nowMs,
  });
  const id = await repo.findSavedPasswordId(site.userId, site.entryUrl, username);
  if (id === null) throw new Error('the minted passwordless login was not recorded');
  return [{ id, username, matchesAccount: true }];
}

/**
 * Saves a browser session for the site. A valid one is a live site session; an
 * expired one is a token the site remembers only well enough to say it expired.
 */
export async function seedSavedSession(
  site: AuthTestSite,
  plan: ScenarioPlan,
  nowMs: number
): Promise<void> {
  if (plan.savedSession === null) return;
  site.savedSessionEmail = plan.savedSession.email;
  let token: string;
  if (plan.savedSession.state === 'valid') {
    token = startSession(site, plan.savedSession.email, 'saved_session', true);
  } else {
    token = randomBytes(24).toString('base64url');
    site.staleSessionTokens.push(token);
  }
  site.savedSessionBundleId = await repo.upsertSavedSession({
    userId: site.userId,
    realm: site.realm,
    siteId: site.siteId,
    cookieDomain: new URL(site.publicOrigin).hostname,
    cookiePath: `${AUTH_TEST_SITE_BASE_PATH}/${site.siteId}`,
    cookieName: SESSION_COOKIE_NAME,
    cookieValue: token,
    nowMs,
    lifetimeMs: SAVED_SESSION_LIFETIME_MS,
  });
}

/**
 * Creates a passkey the way the Mac app enrolls one: a P-256 key whose private
 * half is stored encrypted for the agent's virtual authenticator, and whose
 * public half the site keeps to verify assertions.
 */
export async function seedPasskey(site: AuthTestSite, plan: ScenarioPlan): Promise<void> {
  if (plan.passkeyEmail === null) return;
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = randomBytes(32);
  const rpId = new URL(site.publicOrigin).hostname;
  site.passkey = {
    credentialId: credentialId.toString('base64url'),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    email: plan.passkeyEmail,
    rpId,
  };
  site.passkeyRowId = await repo.createPasskey({
    userId: site.userId,
    realm: site.realm,
    rpId,
    origin: site.publicOrigin,
    credentialId: credentialId.toString('base64'),
    encryptedPrivateKey: encryptPasswordForStorage(
      privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    ),
    userHandle: Buffer.from(plan.passkeyEmail).toString('base64'),
  });
}
