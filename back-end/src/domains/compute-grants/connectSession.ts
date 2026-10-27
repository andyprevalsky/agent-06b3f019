/**
 * Interactive "Connect account" flow.
 *
 * This is the ONE place a human is required. Everything downstream -- minting,
 * re-minting after revocation, rotation -- runs unattended from the session this
 * flow captures. The user signs in once, in a cloud browser, and the resulting
 * account session becomes the durable connection.
 *
 * WHY A CLOUD BROWSER AND NOT AN OAUTH REDIRECT
 * --------------------------------------------
 * We are not capturing an OAuth code here, we are capturing an account SESSION,
 * because that session is what mints grants later without the user present. A
 * normal OAuth redirect would hand us a single token and leave us unable to mint
 * again -- which is precisely the dead end the old design hit.
 *
 * The user drives Steel's live view; we poll for the session cookie and, the
 * moment it appears, store the connection and tear the browser down.
 *
 * BILLING: a leaked remote browser bills until it dies, and abandoned sign-ins
 * are the common case (user closes the tab). Every session therefore carries a
 * hard deadline and is released unconditionally.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../../providers/logger';
import { openComputeGrantBrowser } from './browserProvider';
import { seedForIntent } from './connectSession.seeding';
import { seedConnectPasskeys, waitForAuthorizePage } from './connectSession.grant';

import { buildAuthorizeUrl } from '../../providers/browser/claudeGrantMint';
import { buildCodexAuthorizeUrl } from '../../providers/browser/codexGrantMint';
import { attachCdp } from './cdp';
import { CAPTCHA_SOLVE_INDICATOR_SCRIPT } from '../../providers/browser/captchaSolveIndicator';
import { finish } from './connectSession.lifecycle';
import { pending } from './connectSession.state';
import {
  cancelPeerConnect,
  pollPeerConnect,
  pollResultFor,
  startSharedMirror,
  type ConnectPollResult,
} from './connectSession.shared';
import { startSignInWatcher } from './connectSession.watcher';
import type { ConnectProviderConfig, PendingConnect } from './connectSession.types';

export type { ConnectProviderConfig, ConnectStage, PendingConnect } from './connectSession.types';

const log = createLogger('ComputeGrants');

const SIGN_IN_POLL_MS = 2000; // how often the server checks the remote browser for sign-in.
const CONNECT_SESSION_TTL_MS = 10 * 60 * 1000; // sign-in abandoned > completed; never bill past this.

const PROVIDER_CONFIG: Record<string, ConnectProviderConfig> = {
  claude: {
    loginUrl: 'https://claude.ai/login',
    cookieUrls: ['https://claude.ai', 'https://platform.claude.com'],
    sessionCookie: 'sessionKey',
    profileUrl: 'https://claude.ai/settings/profile',
    authRealm: 'claude.ai',
  },
  codex: {
    loginUrl: 'https://auth.openai.com/oauth/authorize',
    cookieUrls: ['https://chatgpt.com', 'https://auth.openai.com'],
    sessionCookie: '__Secure-next-auth.session-token',
    profileUrl: 'https://chatgpt.com/',
    authRealm: 'auth.openai.com',
  },
};

export interface ConnectSessionHandle {
  connectId: string;
  provider: string;
  /** Live view -- null until the cloud browser has booted; the client polls. */
  liveViewUrl: string | null;
  expiresAt: string;
}

export { pending } from './connectSession.state';
export { reapExpiredConnectSessions } from './connectSession.lifecycle';

export class ConnectError extends Error {}

function providerConfig(provider: string) {
  const cfg = PROVIDER_CONFIG[provider];
  if (cfg === undefined) throw new ConnectError(`unsupported provider "${provider}"`);
  return cfg;
}

/** Open a cloud browser at the provider's login page and return its live view. */
export interface StartConnectOptions {
  /**
   * Reconnect a SPECIFIC account.
   *
   * Changes which cookies are injected. Without it we seed from the user's
   * locally-synced browser session, which is whichever account their Chrome
   * happens to be signed into -- fine for a first connect, wrong for
   * reconnecting a different account, and actively unhelpful when adding a
   * second one (you land already signed in as the account you already have).
   */
  accountId?: string;
}

function createPendingConnect(
  userId: string,
  provider: string,
  connectId: string,
  deadline: number
): PendingConnect {
  return {
    connectId,
    userId,
    provider,
    steelSessionId: null,
    cdpBase: null,
    liveViewUrl: null,
    release: null,
    cdp: null,
    deadline,
    stage: 'creating_browser',
    done: false,
  };
}

async function releaseFailedSetup(entry: PendingConnect, provider: string, connectId: string) {
  if (entry.release === null) return;
  try {
    await entry.release();
  } catch (releaseError) {
    log.warn('connect.setup_release_failed', {
      provider,
      connect_id: connectId,
      error: releaseError instanceof Error ? releaseError.message : String(releaseError),
    });
  }
}

export async function startConnectSession(
  userId: string,
  provider: string,
  options: StartConnectOptions = {}
): Promise<ConnectSessionHandle> {
  const cfg = providerConfig(provider);
  const connectId = `${provider}-${randomUUID()}`;
  const deadline = Date.now() + CONNECT_SESSION_TTL_MS;
  const entry = createPendingConnect(userId, provider, connectId, deadline);
  pending.set(connectId, entry);
  startSharedMirror(entry);

  // Provision, seed and navigate entirely OFF the request path.
  //
  // Returning a connectId before the browser exists is the whole point: the
  // client can start polling immediately, so every step of a ~30s provision is
  // reported as it happens instead of being inferred from a stopwatch.
  void (async () => {
    const t0 = Date.now();
    let tProvisioned = 0;

    try {
      const session = await openComputeGrantBrowser('connect');
      tProvisioned = Date.now();
      entry.steelSessionId = session.sessionId;
      entry.cdpBase = session.cdpBase;
      entry.liveViewUrl = session.liveViewUrl;
      entry.release = session.release;
      entry.stage = 'restoring_session';

      const cdp = await attachCdp(session.cdpBase);
      entry.cdp = cdp;
      {
        // Seed the cloud browser with whatever the user is ALREADY signed into
        // locally. When it works the login page redirects straight through and
        // the user types nothing. Cloud-custody passkeys are injected separately
        // below via a CDP virtual authenticator.
        const seeded = await seedForIntent(cdp, entry, cfg.cookieUrls, options.accountId);
        const tSeeded = Date.now();
        entry.passkeys = await seedConnectPasskeys(cdp, userId, provider, connectId, cfg.authRealm);
        entry.stage = 'loading_authorize';
        const auth =
          entry.provider === 'claude'
            ? { ...buildAuthorizeUrl(), redirectUri: undefined }
            : buildCodexAuthorizeUrl();
        entry.authVerifier = auth.verifier;
        entry.authState = auth.state;
        entry.authRedirectUri = auth.redirectUri;
        if (entry.provider === 'codex') {
          // Must be armed BEFORE navigation: OpenAI eventually redirects this
          // target to the Codex CLI's registered localhost callback. Pausing and
          // fulfilling that request is the only way to prevent Chromium from
          // painting ERR_CONNECTION_REFUSED in a remote browser.
          await cdp.armCodexCallback(auth.state);
        }
        await cdp.navigate(auth.url);
        // Install script is registered at Kernel/Steel session create; after
        // navigation re-run it so the telemetry flag listener is on this document.
        await cdp.evaluate(CAPTCHA_SOLVE_INDICATOR_SCRIPT).catch(() => undefined);
        // Log the destination host: routing a provider to the WRONG sign-in page
        // is invisible in every other signal (cookies still seed, stages still
        // advance) and presents as "the cookies didn't work".
        log.info('connect.navigated', {
          provider: entry.provider,
          host: new URL(auth.url).host,
          path: new URL(auth.url).pathname,
        });
        // Timing is load-bearing here: seeding used to cost one CDP round-trip
        // PER COOKIE to a remote browser, which is what made the login page take
        // ten-plus seconds to appear. Measure it so a regression is obvious.
        log.info('connect.timing', {
          provider,
          connect_id: connectId,
          cookies_seeded: seeded,
          provision_ms: tProvisioned - t0,
          seed_ms: tSeeded - tProvisioned,
          navigate_ms: Date.now() - tSeeded,
          total_ms: Date.now() - t0,
        });
      }
      await waitForAuthorizePage(cdp, entry.connectId, entry.provider);
      entry.stage = 'awaiting_human';
      startSignInWatcher(entry, cfg, SIGN_IN_POLL_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('connect.setup_failed', { provider, connect_id: connectId, error: message });
      entry.failed = message;
      // Never leave a browser billing because setup failed.
      await releaseFailedSetup(entry, provider, connectId);
    }
  })();

  log.info('connect.started', { provider, connect_id: connectId });
  return {
    connectId,
    provider,
    liveViewUrl: null,
    expiresAt: new Date(deadline).toISOString(),
  };
}

export type { ConnectPollResult, ConnectPollState } from './connectSession.shared';

/**
 * Status read. A session started on this instance is read from memory (it must
 * never touch the remote browser -- see `startSignInWatcher`); one started on
 * another instance is read from its shared snapshot.
 */
export async function pollConnectSession(
  userId: string,
  connectId: string
): Promise<ConnectPollResult> {
  const entry = pending.get(connectId);
  if (entry === undefined) return pollPeerConnect(userId, connectId);
  if (entry.userId !== userId) return { state: 'unknown' };
  const result = pollResultFor(entry);
  if (entry.failed !== undefined) pending.delete(connectId);
  return result;
}

/** Abandon a connect in progress (user cancelled / navigated away). */
export async function cancelConnectSession(userId: string, connectId: string): Promise<void> {
  const entry = pending.get(connectId);
  if (entry === undefined) {
    await cancelPeerConnect(userId, connectId);
    return;
  }
  if (entry.userId !== userId) return;
  await finish(entry);
}

/**
 * Release any connect session past its deadline.
 *
 * Abandoned sign-ins are the norm, and without this a closed browser tab leaves
 * a remote browser billing until someone notices.
 */

/** Test seam. */
export function _pendingCount(): number {
  return pending.size;
}
