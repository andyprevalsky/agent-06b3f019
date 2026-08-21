/**
 * Turning a captured account session into the FIRST usable grant.
 *
 * Split from connectSession so the connect state machine stays readable: this
 * file owns identity resolution and grant persistence, connectSession owns the
 * browser lifecycle and polling.
 */

import { createLogger } from '../../providers/logger';
import { AUTHORIZE_PAGE_READY, cloudRemint } from '../../providers/browser/claudeGrantMint';
import type { CdpClient, CdpCookie } from './cdp';
import { createPrismaGrantStore, materializeGrantAsIntegration } from './repo';

const log = createLogger('ComputeGrants');

/**
 * Identify the account behind a freshly minted grant.
 *
 * Read from the OAuth profile endpoint rather than scraping claude.ai, because
 * in-page API calls from a remote browser are intercepted by Cloudflare's
 * challenge ("Just a moment...") and the settings DOM carries no stable email.
 * The account uuid is what keeps two connected accounts distinct -- without it
 * both collapse onto one row and the second silently overwrites the first.
 */
async function identifyClaudeAccount(
  accessToken: string
): Promise<{ accountId: string; accountEmail?: string } | null> {
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'claude-cli/2.1.88 (external, cli)',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { account?: { uuid?: string; email?: string } };
    const uuid = body.account?.uuid;
    if (uuid === undefined || uuid.length === 0) return null;
    return { accountId: uuid, accountEmail: body.account?.email };
  } catch {
    return null;
  }
}

export interface MintedFirstGrant {
  mintedToken: string | undefined;
  mintedExpiresIn: number;
  identity: { accountId: string; accountEmail?: string } | null;
}

/**
 * Mint the first grant using the session we just captured.
 *
 * Two reasons to do it here: it yields a trustworthy account identity, and it
 * proves the session can ACTUALLY mint before we report the account connected
 * -- otherwise a user can "connect" an account that silently never works.
 *
 * Returns 'mint_failed' so the caller can keep the session pending and retry,
 * rather than recording a connection that cannot produce tokens.
 */
export async function mintFirstGrant(
  provider: string,
  cdpBase: string,
  cookies: CdpCookie[]
): Promise<MintedFirstGrant | 'mint_failed'> {
  if (provider !== 'claude') {
    return { mintedToken: undefined, mintedExpiresIn: 31_536_000, identity: null };
  }
  try {
    // USER-INITIATED: never click Authorize for them. They are watching the
    // live view, and the consent screen frequently serves a bot-check ("drag the
    // shape into its outline") that an auto-clicker cannot solve. We only watch
    // for the resulting code, with a longer window because a human is involved.
    const minted = await cloudRemint(cdpBase, cookies, { autoClick: false });
    return {
      mintedToken: minted.accessToken,
      mintedExpiresIn: minted.expiresIn,
      // Prefer the identity the exchange already gave us; the profile endpoint
      // rejects an inference-only grant, so it is only a fallback.
      identity:
        minted.accountId !== undefined
          ? { accountId: minted.accountId, accountEmail: minted.accountEmail }
          : await identifyClaudeAccount(minted.accessToken),
    };
  } catch (error) {
    log.warn('connect.mint_at_connect_failed', {
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'mint_failed';
  }
}

/**
 * Persist the grant we just proved works, in BOTH places:
 *  - ComputeGrant: history + the re-mint path's store of record
 *  - Integration:  the shape every agent already reads, so a connected account
 *                  is immediately usable without touching fetchComputeTokenForUser
 */
export async function persistFirstGrant(input: {
  userId: string;
  provider: 'claude' | 'codex';
  accountId: string;
  email: string | undefined;
  mintedToken: string;
  mintedExpiresIn: number;
  idToken?: string;
  refreshToken?: string;
  poolingEnabled: boolean;
  poolingEnabledOverride: boolean | null;
}): Promise<void> {
  try {
    await createPrismaGrantStore('cloud').saveGrant({
      userId: input.userId,
      provider: input.provider,
      accountId: input.accountId,
      accessToken: input.mintedToken,
    });
    await materializeGrantAsIntegration({
      userId: input.userId,
      provider: input.provider,
      accountId: input.accountId,
      accountEmail: input.email,
      accessToken: input.mintedToken,
      idToken: input.idToken,
      refreshToken: input.refreshToken,
      expiresInSeconds: input.mintedExpiresIn,
      // Mirror the exact connection. Re-deriving this from another Integration
      // row could make the connection say pooled while its usable token did not.
      poolingEnabled: input.poolingEnabled,
      poolingEnabledOverride: input.poolingEnabledOverride,
    });
  } catch (error) {
    log.warn('connect.first_grant_save_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Present the user's cloud-custody passkeys (target realm + SSO realms) in the
 * connect browser. Best-effort: a passkey failure must never block cookie-based
 * sign-in, so it is logged and swallowed.
 */
export async function seedConnectPasskeys(
  cdp: CdpClient,
  userId: string,
  provider: string,
  connectId: string,
  authRealm: string
): Promise<PasskeySeed[]> {
  try {
    const passkeys = await loadConnectPasskeys(userId, authRealm);
    const injected = await cdp.seedPasskeys(passkeys);
    if (injected > 0) {
      log.info('connect.passkeys_seeded', { provider, connect_id: connectId, injected });
    }
    return passkeys;
  } catch (err) {
    log.warn('connect.passkey_seed_failed', {
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

import { retryWithBackoff } from '../../providers/retry';

const CODEX_AUTHORIZE_PAGE_READY = `(function(){
  if (document.readyState === 'loading' || !document.body) return false;
  return location.hostname === 'auth.openai.com' || location.hostname === 'chatgpt.com';
})()`;

export async function waitForAuthorizePage(
  cdp: CdpClient,
  connectId: string,
  provider: string = 'claude'
): Promise<void> {
  await retryWithBackoff(
    async () => {
      const ready = await cdp.evaluate<boolean>(
        provider === 'codex' ? CODEX_AUTHORIZE_PAGE_READY : AUTHORIZE_PAGE_READY
      );
      if (ready !== true) throw new Error('authorize page not interactive yet');
      return true;
    },
    { maxRetries: 12, component: 'ComputeGrants', isRetryable: () => true }
  ).catch(() => {
    log.info('connect.authorize_ready_timeout', { connect_id: connectId });
  });
}

import { findPasskeys } from '../../providers/authOptionsStore';
import { decryptCredentialEnvelope } from '../../providers/claudeCredentials';
import { passkeyDecryptionKeyB64 } from './config';
import type { PasskeySeed } from './cdp.passkeys';

/**
 * Cloud-custody passkeys for a connect session, decrypted and ready to inject.
 * Reuses findPasskeys' SSO-realm widening and the backend credential key.
 */
export async function loadConnectPasskeys(
  userId: string,
  authRealm: string
): Promise<PasskeySeed[]> {
  const rows = await findPasskeys(userId, authRealm, { includeSso: true });
  if (rows.length === 0) return [];
  let key: string;
  try {
    key = passkeyDecryptionKeyB64();
  } catch {
    // Passkey decryption key not provisioned on this surface -- skip rather than
    // fail the whole connect (cookies still work).
    log.warn('connect.passkey_key_missing', { authRealm });
    return [];
  }
  const out: PasskeySeed[] = [];
  for (const row of rows) {
    if (row.disabledAt !== null) continue;
    const privateKey = decryptCredentialEnvelope(row.encryptedPrivateKey, key);
    if (privateKey === null || privateKey === '') continue;
    out.push({
      credentialId: row.credentialId,
      privateKey,
      rpId: row.rpId,
      signCount: Number(row.signCount),
      userHandle: row.userHandle,
    });
  }
  return out;
}
