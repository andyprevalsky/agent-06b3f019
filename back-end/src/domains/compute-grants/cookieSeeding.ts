/**
 * Seed a cloud browser with the cookies the user is ALREADY signed in with locally.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * -----------------------------------
 * Without seeding, "connect" means typing a password into a remote browser. That
 * is bad UX, and for many accounts it is impossible: sign-in increasingly relies
 * on PASSKEYS, and WebAuthn is device-bound -- a cloud browser can never satisfy
 * a passkey held in the user's local secure enclave. No amount of automation
 * fixes that.
 *
 * Seeding sidesteps the whole problem. The mac-app already syncs local browser
 * cookies into the `Cookie` table, so if the user is signed into claude.ai in
 * Chrome, the cloud browser can start from that same session: the login page
 * redirects straight through, nothing is typed, and no passkey is needed.
 *
 * Seeding is BEST-EFFORT by design. Zero cookies is a completely normal state
 * (mac-app never run, cookies expired, different browser), and it must degrade
 * to "user signs in manually in the live view" rather than failing the connect.
 */

import { SSO_REALMS } from '../../providers/browserCookies';
import type { CdpCookieInput } from './cdp';
import { createLogger } from '../../providers/logger';
import {
  chromeSameSiteToCdp,
  findLocalCookiesForDomains,
  pickSingleProfile,
  type LocalCookieRow,
} from './repo';

const log = createLogger('ComputeGrants');

export interface CdpCookieSink {
  /** Returns how many cookies the browser ACCEPTED. */
  setCookies(cookies: CdpCookieInput[]): Promise<number>;
  /** Single-cookie fallback, so one malformed entry cannot cost the session. */
  setCookie(cookie: CdpCookieInput): Promise<number>;
}

/**
 * Registrable domains we accept cookies for.
 *
 * The provider's own domains PLUS the federated identity providers. Claude and
 * ChatGPT sign-in are both usually "Continue with Google", and the cookie that
 * proves which accounts you have lives on the IdP -- so seeding only the
 * provider domain lands the user on a Google login they have to type into, and
 * makes adding a SECOND account effectively impossible from a remote browser.
 */
export function cookieDomainsFor(cookieUrls: string[]): string[] {
  const provider = cookieUrls.map((u) => new URL(u).hostname.replace(/^www\./, ''));
  return [...new Set([...provider, ...SSO_REALMS])];
}

/** Chromium stores expiry as microseconds since 1601; CDP wants epoch seconds. */
export function chromeExpiryToEpochSeconds(expiresUtc: bigint | null): number | undefined {
  if (expiresUtc === null || expiresUtc === 0n) return undefined;
  const epochSeconds = Number(expiresUtc / 1_000_000n) - 11_644_473_600;
  return epochSeconds > 0 ? epochSeconds : undefined;
}

/**
 * Copy the user's locally-synced cookies for these domains into the cloud browser.
 * Returns how many were applied; 0 means the user signs in by hand.
 */
/**
 * Identity providers carried alongside the provider's own cookies.
 *
 * Nearly every sign-in wall is federated: without these the cloud browser lands
 * on a "Continue with Google" button it cannot get past, because the cookie
 * proving which accounts exist lives on the IdP, not the site.
 */
export const SSO_COOKIE_DOMAINS = [
  'google.com',
  'accounts.google.com',
  'facebook.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'live.com',
  'github.com',
];

export async function seedLocalCookies(
  sink: CdpCookieSink,
  userId: string,
  provider: string,
  cookieUrls: string[],
  /**
   * Skip the provider's OWN cookies and seed only the identity providers.
   *
   * Used when adding a SECOND account: replaying the provider session would
   * silently sign you back in as the account you already have, but dropping SSO
   * too leaves you unable to pick a different one without a password. This keeps
   * the account chooser working while forcing a real choice.
   */
  ssoOnly = false
): Promise<number> {
  const domains = ssoOnly
    ? SSO_COOKIE_DOMAINS
    : [...cookieDomainsFor(cookieUrls), ...SSO_COOKIE_DOMAINS];
  let rows: LocalCookieRow[];
  try {
    rows = await findLocalCookiesForDomains(userId, domains);
  } catch (error) {
    log.warn('connect.cookie_seed_query_failed', {
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }

  // Never mix profiles: a session is only valid as a complete set.
  const chosen = pickSingleProfile(rows);
  log.info('connect.cookie_profile', {
    provider,
    profile: chosen.profile,
    kept: chosen.rows.length,
    discarded: chosen.total - chosen.rows.length,
  });
  const batch = chosen.rows.map((row) => ({
    name: row.name,
    value: row.value,
    domain: row.domain,
    path: row.path,
    secure: row.isSecure,
    httpOnly: row.isHttpOnly,
    expires: chromeExpiryToEpochSeconds(row.expiresUtc),
    sameSite: chromeSameSiteToCdp(row.sameSite ?? null),
  }));
  let applied = 0;
  try {
    await sink.setCookies(batch);
    applied = batch.length;
  } catch {
    // Fall back to one-at-a-time so a single malformed cookie cannot cost the
    // whole session -- partial seeding still usually carries the login.
    for (const cookie of batch) {
      try {
        applied += await sink.setCookie(cookie);
      } catch {
        // skip
      }
    }
  }
  // userId and domains are logged because a bare found/applied count is
  // ambiguous across users -- a zero here was twice mistaken for a broken
  // injection path when it was simply a different account's empty cookie jar.
  log.info('connect.cookie_seed', {
    provider,
    user_id: userId,
    domains: domains.join(','),
    found: rows.length,
    applied,
  });
  return applied;
}

/**
 * Replay a previously stored account session into the cloud browser.
 *
 * Used when RECONNECTING a specific account: the stored cookies identify that
 * account, whereas the local browser identifies whichever one the user happens
 * to be signed into. Without this, reconnecting hinavi while Chrome is signed
 * into roselabs would silently reconnect roselabs again.
 */
export async function seedStoredSession(
  sink: CdpCookieSink,
  userId: string,
  provider: string,
  accountId: string
): Promise<number> {
  const { getConnectionSession } = await import('./repo');
  const raw = await getConnectionSession(userId, provider, accountId);
  if (raw === null || raw.length === 0) {
    log.info('connect.stored_session_missing', { provider, account_id: accountId });
    return 0;
  }
  try {
    const cookies = JSON.parse(raw) as Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      secure: boolean;
      httpOnly: boolean;
      expires?: number;
    }>;
    await sink.setCookies(cookies);
    log.info('connect.stored_session_seeded', {
      provider,
      account_id: accountId,
      cookies: cookies.length,
    });
    return cookies.length;
  } catch (error) {
    log.warn('connect.stored_session_failed', {
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Is the locally-signed-in account for this provider ALREADY connected?
 *
 * Decides whether seeding local cookies would help or hurt. When the browser's
 * session belongs to an account we already hold, replaying it just hands the
 * user the same account again -- so we show a clean login instead, which is the
 * only way to add a second one.
 */
export async function hasConnectedAccountFor(
  userId: string,
  provider: string,
  cookieUrls: string[]
): Promise<boolean> {
  const { prisma } = await import('../../providers/database');
  const domains = cookieDomainsFor(cookieUrls);
  const [localCookies, connections] = await Promise.all([
    findLocalCookiesForDomains(userId, domains).catch(() => []),
    prisma.computeAccountConnection.count({ where: { userId, provider } }),
  ]);
  // Only meaningful when we have BOTH a local session to replay and at least one
  // account on file; otherwise seeding is either impossible or harmless.
  return localCookies.length > 0 && connections > 0;
}
