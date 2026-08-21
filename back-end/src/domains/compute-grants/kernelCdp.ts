/**
 * Kernel-backed CDP provider for cloud grant minting and account connect.
 *
 * Kernel is the DEFAULT provider for this domain; Steel remains available behind
 * `COMPUTE_GRANT_BROWSER_PROVIDER=steel` as a fallback.
 *
 * Isolated in its own file so the rest of the compute-grants domain never pulls
 * in the browser stack -- repo, service and orchestrator all stay runnable (and
 * testable) without any remote-browser dependency.
 *
 * THREE THINGS THIS FLOW DEPENDS ON
 * ---------------------------------
 * 1. THE BROWSER MUST NOT LOOK AUTOMATED. Vanilla headless Chrome is served
 *    Cloudflare's "Performing security verification" forever and the OAuth
 *    consent screen never renders. Kernel's stealth mode is what makes this
 *    viable, so `stealth` is forced on regardless of the global default, and
 *    headless is forced OFF -- a headless flag here reintroduces exactly the
 *    bot-detection failure this domain was built around.
 *
 * 2. CONNECT NEEDS AN *INTERACTIVE* LIVE VIEW. The rest of the codebase wraps
 *    live-view URLs in `readOnlyLiveView()`, which appends `readOnly=true`. That
 *    is right for observing an agent and WRONG here: the whole point is that a
 *    human types their credentials. We deliberately return the raw URL.
 *
 * 3. SESSIONS MUST BE RELEASED. A leaked remote browser bills for as long as it
 *    lives, and failures are exactly when leaks pile up -- so release is
 *    unconditional in the caller's `finally`, and never throws.
 */

import { createLogger } from '../../providers/logger';
import { DEFAULT_GEOLOCATION } from '../../providers/geoip';
import {
  createKernelRecoverySession,
  releaseKernelRemoteSession,
} from '../../providers/browser/kernel';
import type { CdpProvider } from './minter';
import { computeGrantBrowserProvider } from './config';

export { computeGrantBrowserProvider };

const log = createLogger('ComputeGrants');

/** Remove the read-only flag so the live view accepts keyboard/mouse input. */
export function interactiveLiveView(url: string | undefined): string {
  if (url === undefined || url === '') return '';
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('readOnly');
    return parsed.toString();
  } catch {
    return url;
  }
}

export interface KernelCdpSession {
  cdpBase: string;
  /** Interactive live view for the connect flow. Empty when the provider gave none. */
  liveViewUrl: string;
  sessionId: string;
  release: () => Promise<void>;
}

/**
 * Open a Kernel browser suitable for OAuth work.
 *
 * `omitManagedProxy` is used deliberately: the managed proxy pool has a history
 * of provider-blacklisted exits, and an OAuth consent page failing to load is
 * indistinguishable from a bot block -- which would be misdiagnosed as the
 * stealth problem above. A direct exit keeps the failure mode legible.
 */
export async function openKernelCdpSession(label: string): Promise<KernelCdpSession> {
  const session = await createKernelRecoverySession(`compute-grant-${label}`, DEFAULT_GEOLOCATION, {
    omitManagedProxy: true,
  });
  log.info('grant.browser_session_open', {
    provider: 'kernel',
    session_id: session.sessionId,
    label,
  });
  let released = false;
  return {
    cdpBase: session.wsUrl,
    // The shared session helpers hand back a live view already wrapped in
    // readOnlyLiveView() (`?readOnly=true`), which is right for WATCHING an
    // agent and fatal here: connect exists so a human can type credentials.
    // Strip the flag rather than re-deriving the URL, so any future change to
    // how Kernel builds live-view URLs still flows through.
    liveViewUrl: interactiveLiveView(session.debugUrl),
    sessionId: session.sessionId,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await releaseKernelRemoteSession(session.sessionId);
        log.info('grant.browser_session_released', {
          provider: 'kernel',
          session_id: session.sessionId,
        });
      } catch (error) {
        // Never let cleanup mask the original failure; a stuck session is a
        // billing problem, a thrown cleanup error is a debugging one.
        log.error('grant.browser_session_release_failed', {
          provider: 'kernel',
          session_id: session.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

/** CdpProvider used by the minter. */
export function kernelCdpProvider(): CdpProvider {
  return {
    async open() {
      const session = await openKernelCdpSession('mint');
      return { cdpBase: session.cdpBase, release: session.release };
    },
  };
}
