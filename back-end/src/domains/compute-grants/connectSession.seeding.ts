/**
 * Cookie-seeding strategy for a connect session.
 *
 * Split from connectSession.ts because "which identity do we replay?" is its own
 * decision with its own failure modes, and the caller only needs the count.
 */

import { createLogger } from '../../providers/logger';
import type { CdpClient } from './cdp';
import { hasConnectedAccountFor, seedLocalCookies, seedStoredSession } from './cookieSeeding';

const log = createLogger('ComputeGrants');

export interface SeedTarget {
  userId: string;
  provider: string;
}

/**
 * Choose which cookies to inject, based on what the user is actually doing.
 *
 *  - reconnecting a known account -> replay ITS stored session, so the right
 *    identity comes back even if the local browser is signed into another one
 *  - adding an account when one is already connected -> seed NOTHING, so the
 *    user gets a clean login instead of being handed the same account again
 *    (seeding here is why adding a second account kept returning the first)
 *  - otherwise -> the local session, which usually redirects straight through
 */
export async function seedForIntent(
  cdp: CdpClient,
  entry: SeedTarget,
  cookieUrls: string[],
  accountId: string | undefined
): Promise<number> {
  if (accountId !== undefined) {
    return seedStoredSession(cdp, entry.userId, entry.provider, accountId);
  }
  if (await hasConnectedAccountFor(entry.userId, entry.provider, cookieUrls)) {
    // Skip the PROVIDER session (so you are not handed the account you already
    // have) but keep the SSO cookies, otherwise the account chooser is gone and
    // adding a second account needs a password.
    const sso = await seedLocalCookies(cdp, entry.userId, entry.provider, cookieUrls, true);
    log.info('connect.seeded_sso_only', {
      provider: entry.provider,
      sso_cookies: sso,
      reason: 'account already connected; showing the chooser instead of a session',
    });
    return sso;
  }
  return seedLocalCookies(cdp, entry.userId, entry.provider, cookieUrls);
}

