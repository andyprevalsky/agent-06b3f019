/**
 * Steel-backed CDP provider for cloud grant minting.
 *
 * Isolated in its own file so the rest of the compute-grants domain never pulls
 * in the browser stack -- the repo, service and orchestrator all stay runnable
 * (and testable) without Steel.
 *
 * Two things the mint flow depends on, both proven the hard way:
 *
 * 1. THE BROWSER MUST NOT LOOK AUTOMATED. Vanilla headless Chrome is served
 *    Cloudflare's "Performing security verification" indefinitely and the OAuth
 *    consent screen never renders. Steel's stealth browser is what makes this
 *    viable at all; a plain remote Chrome is not a drop-in substitute.
 *
 * 2. SESSIONS MUST BE RELEASED. A leaked remote browser bills for as long as it
 *    lives, and mint failures are exactly when leaks would pile up -- so release
 *    is unconditional in the caller's `finally`.
 */

import { createLogger } from '../../providers/logger';
import { DEFAULT_GEOLOCATION } from '../../providers/geoip';
import {
  createSteelRecoverySession,
  releaseSteelRemoteSession,
} from '../../providers/steel/session';
import { REQUIRED_CHROME_FLAGS } from '../../providers/browser/claudeGrantMint';
import type { CdpProvider } from './minter';

const log = createLogger('ComputeGrants');

/**
 * User agent presented to claude.ai.
 *
 * Derived from the same list the local mint path uses, so the two environments
 * present an identical fingerprint and a failure in one reproduces in the other.
 */
function desktopUserAgent(): string {
  const flag = REQUIRED_CHROME_FLAGS.find((f) => f.startsWith('--user-agent='));
  return flag === undefined ? '' : flag.slice('--user-agent='.length);
}

export function steelCdpProvider(): CdpProvider {
  return {
    async open() {
      const session = await createSteelRecoverySession({
        proxyLocation: DEFAULT_GEOLOCATION,
        proxyMode: 'managed',
        userAgent: desktopUserAgent(),
      });
      log.info('grant.minter_session_open', { session_id: session.sessionId });
      return {
        // Steel hands back a ready websocket; `cloudRemint` accepts either that
        // or an HTTP debugging base.
        cdpBase: session.wsUrl,
        release: async () => {
          await releaseSteelRemoteSession(session.sessionId);
          log.info('grant.minter_session_released', { session_id: session.sessionId });
        },
      };
    },
  };
}
