/**
 * Browser-backed grant minter.
 *
 * Turns a stored account session into a fresh compute grant, in the cloud, with
 * no user present. This is the production implementation of `GrantMinter`;
 * everything upstream of it is provider-agnostic.
 *
 * WHY A BROWSER AT ALL
 * --------------------
 * Anthropic mints a `setup-token` through an OAuth consent screen that requires
 * a claude.ai SESSION, not a human. So the cloud holds the session and drives
 * the consent itself. This is why re-mint never needs the dying token: the
 * connection is the credential, and the grant is disposable.
 *
 * WHY STEEL AND NOT E2B
 * ---------------------
 * Steel already provides remote browsers with cookie injection, which is exactly
 * the shape of this problem. E2B is a code sandbox -- it has no browser -- so it
 * is the wrong tool despite being the obvious one to reach for.
 *
 * The CDP transport is deliberately abstract (`openCdp`): a local headless Chrome
 * satisfies it in tests, a Steel session satisfies it in production, and the
 * mint logic in `claude-cloud-remint.ts` is identical either way.
 */

import { createLogger } from '../../providers/logger';
import type { GrantMinter } from '../../providers/computeGrantRemint';
import { cloudRemint, type CdpCookie } from '../../providers/browser/claudeGrantMint';
import { getConnectionSession } from './repo';

const log = createLogger('ComputeGrants');

/**
 * Opens a browser and returns its CDP base URL plus a disposer.
 *
 * Injected so this module never imports the Steel provider directly -- keeping
 * the compute-grants domain free of browser-infrastructure dependencies, and
 * letting tests drive a local Chrome.
 */
export interface CdpProvider {
  open(): Promise<{ cdpBase: string; release: () => Promise<void> }>;
}

export interface CloudMinterOptions {
  cdp: CdpProvider;
}

/**
 * Parse a stored session blob into CDP cookies.
 *
 * Stored as the JSON array captured from a real browser, so shape drift here
 * shows up as a mint failure rather than a silent no-cookie session that would
 * bounce to the login page and look like a dead account.
 */
function parseCookies(raw: string): CdpCookie[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('stored account session is not valid JSON; reconnect the account');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('stored account session contains no cookies; reconnect the account');
  }
  return parsed as CdpCookie[];
}

export function createCloudMinter(opts: CloudMinterOptions): GrantMinter {
  return {
    async mint(userId, provider, accountId) {
      if (provider !== 'claude') {
        // Codex has no setup-token equivalent below Enterprise; it re-mints via
        // its own device flow. Fail loudly rather than silently minting nothing.
        throw new Error(`cloud minting is not implemented for provider "${provider}"`);
      }

      const session = await getConnectionSession(userId, provider, accountId);
      if (session === null || session.length === 0) {
        // Phrased so the reminter classifies this as a dead CONNECTION and
        // flips the account to needs_reconnect instead of retrying forever.
        throw new Error('no stored account session (cookie) for this connection');
      }
      const cookies = parseCookies(session);

      const { cdpBase, release } = await opts.cdp.open();
      try {
        const result = await cloudRemint(cdpBase, cookies);
        log.info('grant.minted', {
          account_id: accountId,
          expires_in: result.expiresIn,
          scope: result.scope,
          click_attempts: result.clickAttempts,
        });
        return { accessToken: result.accessToken };
      } finally {
        // Always release: a leaked remote browser costs money for as long as it
        // lives, and mint failures are exactly when leaks would accumulate.
        await release().catch((err: unknown) => {
          log.error('grant.minter_release_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    },
  };
}

/**
 * CDP provider backed by an already-running Chrome (tests, local verification).
 *
 * Production supplies a Steel-backed provider instead; see
 * `REQUIRED_CHROME_FLAGS` in claude-cloud-remint.ts for the launch flags the
 * browser MUST have, or Cloudflare never renders the consent screen.
 */
export function localCdpProvider(cdpBase: string): CdpProvider {
  return {
    async open() {
      return { cdpBase, release: async () => {} };
    },
  };
}
