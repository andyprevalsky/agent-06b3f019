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
import { upsertAccountConnection } from './repo';
import {
  persistFirstGrant,
  seedConnectPasskeys,
  waitForAuthorizePage,
} from './connectSession.grant';

import {
  READ_CODE,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
} from '../../providers/browser/claudeGrantMint';
import {
  READ_CODEX_CALLBACK,
  buildCodexAuthorizeUrl,
  exchangeCodexAuthorizationCode,
  parseCodexCallbackUrl,
} from '../../providers/browser/codexGrantMint';
import { type CdpClient, attachCdp } from './cdp';
import { finish, releaseBrowser } from './connectSession.lifecycle';
import type { PasskeySeed } from './cdp.passkeys';

const log = createLogger('ComputeGrants');

const SIGN_IN_POLL_MS = 2000; // how often the server checks the remote browser for sign-in.
const CONNECT_SESSION_TTL_MS = 10 * 60 * 1000; // sign-in abandoned > completed; never bill past this.

/** Where each provider's session lives, and how we recognise "signed in". */
const PROVIDER_CONFIG: Record<
  string,
  {
    loginUrl: string;
    cookieUrls: string[];
    sessionCookie: string;
    profileUrl: string;
    authRealm: string;
  }
> = {
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

export interface PendingConnect {
  stage: ConnectStage;
  connectId: string;
  userId: string;
  provider: string;
  /** Populated once provisioning finishes; null while the browser is booting. */
  steelSessionId: string | null;
  cdpBase: string | null;
  liveViewUrl: string | null;
  /** Provider-agnostic teardown, captured at open time so cancel/complete
   *  release the browser that was actually opened (Kernel or Steel). */
  release: (() => Promise<void>) | null;
  /**
   * Long-lived CDP client.
   *
   * Re-attaching per poll opened a fresh websocket to a REMOTE browser every
   * couple of seconds; measured, those attaches hung and the HTTP poll stopped
   * responding entirely (server logged 2 requests while the client saw 30s
   * timeouts). One connection is opened during setup and reused.
   */
  cdp: CdpClient | null;
  /** Decrypted passkeys, loaded once, re-seeded onto new targets each tick. */
  passkeys?: PasskeySeed[];
  authVerifier?: string;
  authState?: string;
  authRedirectUri?: string;
  accountId?: string;
  accountEmail?: string;
  deadline: number;
  done: boolean;
  /** Set when provisioning fails, so the poll can report it instead of hanging. */
  failed?: string;
  /** When a SUCCESSFUL connect released its browser but is held for the FE to
   *  observe `connected`. The reaper deletes held entries after a grace window. */
  finishedAt?: number;
}

export const pending = new Map<string, PendingConnect>();
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

export async function startConnectSession(
  userId: string,
  provider: string,
  options: StartConnectOptions = {}
): Promise<ConnectSessionHandle> {
  const cfg = providerConfig(provider);
  const connectId = `${provider}-${randomUUID()}`;
  const deadline = Date.now() + CONNECT_SESSION_TTL_MS;

  const entry: PendingConnect = {
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
  pending.set(connectId, entry);

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
      startSignInWatcher(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('connect.setup_failed', { provider, connect_id: connectId, error: message });
      entry.failed = message;
      // Never leave a browser billing because setup failed.
      if (entry.release !== null) await entry.release();
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

export type ConnectPollState = 'pending' | 'connected' | 'expired' | 'unknown';

/**
 * Fine-grained progress for the connect modal.
 *
 * Only the server knows which step it is on, so the stage is reported rather
 * than guessed client-side -- a single spinner covering ~10s of setup plus an
 * unbounded human wait is what made a working flow read as a hang.
 */
export type ConnectStage =
  | 'creating_browser'
  | 'restoring_session'
  | 'loading_authorize'
  | 'awaiting_human'
  | 'capturing'
  | 'minting'
  | 'connected';

export interface ConnectPollResult {
  stage?: ConnectStage;
  /** Sent once the cloud browser has booted; null while still provisioning. */
  liveViewUrl?: string | null;
  state: ConnectPollState;
  accountEmail?: string;
  accountId?: string;
  reason?: string;
}

/**
 * Has the user finished signing in?
 *
 * On success this captures the cookies, stores the connection, and releases the
 * browser -- so a completed connect never keeps billing.
 */
/**
 * Watch for sign-in and finish the connection.
 *
 * ALL remote-browser I/O lives here, deliberately. Doing it inside the HTTP poll
 * meant every client tick opened a CDP call to a remote browser; measured, those
 * calls hung and the endpoint stopped responding entirely -- the server logged 2
 * requests while the client saw repeated 30s timeouts. The HTTP poll is now a
 * pure in-memory read (~1ms) and this loop owns the browser.
 */

function startSignInWatcher(entry: PendingConnect): void {
  const cfg = providerConfig(entry.provider);
  // A provider code is single-use. setInterval does not wait for an async tick,
  // so without this guard a slow exchange starts twice and the second request
  // reports invalid_grant even while the first one is succeeding.
  let pollInFlight = false;
  const timer = setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    void (async () => {
      try {
        if (entry.done || entry.failed !== undefined) {
          clearInterval(timer);
          return;
        }
        if (Date.now() > entry.deadline) {
          clearInterval(timer);
          entry.failed = 'sign-in window elapsed';
          await finish(entry);
          return;
        }
        const cdp = entry.cdp;
        if (cdp === null || entry.cdpBase === null) return;

        // Watch for the CODE the user's own Authorize click produces. We
        // navigated to the consent screen with entry.authVerifier, so the code
        // on screen belongs to that PKCE pair -- re-minting here would mint a
        // fresh pair and strand it.
        if (entry.accountEmail === undefined) {
          // claude.ai renders "Logged in as <email>" on the consent screen.
          const seen = await cdp.evaluate<string>(
            `(document.body.innerText.match(/[\\w.+-]+@[\\w.-]+\\.\\w+/)||[''])[0]`
          );
          if (seen !== undefined && seen.length > 0) entry.accountEmail = seen;
        }

        let minted: {
          accessToken: string;
          expiresIn: number;
          accountId?: string;
          accountEmail?: string;
          idToken?: string;
          refreshToken?: string;
        };
        if (entry.provider === 'claude') {
          // The code can land on a different window than we attached to (a
          // "Continue with Google" sign-in), so scan every page target.
          const code = await cdp.evaluateAnyTarget<string>(READ_CODE);
          if (code === undefined || code.length === 0) return;
          entry.stage = 'capturing';
          minted = await exchangeAuthorizationCode(
            code,
            entry.authVerifier ?? '',
            entry.authState ?? ''
          );
        } else {
          // The Codex CLI redirect is localhost. In a remote browser that request
          // cannot connect, but CDP still exposes the requested target URL. Read
          // both the document and TargetInfo so Chromium's error page cannot hide
          // the one-time code.
          let callbackUrl = cdp.getCapturedCodexCallbackUrl();
          if (callbackUrl === undefined || callbackUrl.length === 0) {
            callbackUrl = await cdp.evaluateAnyTarget<string>(READ_CODEX_CALLBACK);
          }
          if (callbackUrl === undefined || callbackUrl.length === 0) {
            callbackUrl = (await cdp.getPageUrls()).find((url) =>
              /^http:\/\/localhost:(1455|1457)\/auth\/callback(?:\?|$)/.test(url)
            );
          }
          if (callbackUrl === undefined || callbackUrl.length === 0) return;
          entry.stage = 'capturing';
          const code = parseCodexCallbackUrl(callbackUrl, entry.authState ?? '');
          // The registered Codex CLI redirect is localhost. A cloud browser has
          // no listener there, so replace Chromium's connection-refused page as
          // soon as we have safely captured the one-time code. Presentation is
          // best-effort and must never delay or invalidate the token exchange.
          void cdp.showFinishingPage(callbackUrl).catch((error: unknown) => {
            log.warn('connect.callback_page_failed', {
              connect_id: entry.connectId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
          minted = await exchangeCodexAuthorizationCode(
            code,
            entry.authVerifier ?? '',
            entry.authRedirectUri
          );
        }

        entry.stage = 'minting';
        const cookies = await cdp.getCookies(cfg.cookieUrls);
        const email = minted.accountEmail ?? entry.accountEmail;
        const accountId = minted.accountId;
        if (accountId === undefined || accountId.length === 0) {
          throw new Error(`${entry.provider} OAuth response did not identify the account`);
        }
        const sessionCookie = cookies.find((c) => c.name === cfg.sessionCookie);
        const expires =
          sessionCookie?.expires !== undefined && sessionCookie.expires > 0
            ? new Date(sessionCookie.expires * 1000)
            : undefined;

        const connection = await upsertAccountConnection({
          userId: entry.userId,
          provider: entry.provider,
          accountId,
          accountEmail: email !== undefined && email.length > 0 ? email : undefined,
          session: JSON.stringify(cookies),
          sessionExpiresAt: expires,
        });

        await persistFirstGrant({
          userId: entry.userId,
          provider: entry.provider === 'claude' ? 'claude' : 'codex',
          accountId,
          email,
          mintedToken: minted.accessToken,
          mintedExpiresIn: minted.expiresIn,
          idToken: minted.idToken,
          refreshToken: minted.refreshToken,
          poolingEnabled: connection.poolingEnabled,
          poolingEnabledOverride: connection.poolingEnabledOverride,
        });

        entry.accountId = accountId;
        entry.accountEmail = email;
        entry.stage = 'connected';
        entry.done = true;
        clearInterval(timer);
        log.info('connect.completed', {
          provider: entry.provider,
          account_id: accountId,
          session_expires_at: expires?.toISOString(),
        });
        // Release the browser (stop billing) but KEEP the entry so the FE's next
        // poll sees `connected`. Deleting it here -- as finish() does -- made the
        // poll return `unknown`, which the FE showed as "Sign-in window closed"
        // even though the connect had succeeded.
        await releaseBrowser(entry);
      } catch (err) {
        log.warn('connect.watch_failed', {
          connect_id: entry.connectId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        pollInFlight = false;
      }
    })();
  }, SIGN_IN_POLL_MS);
}

/**
 * Pure in-memory status read.
 *
 * Must never touch the remote browser -- see `startSignInWatcher`.
 */
export function pollConnectSession(userId: string, connectId: string): ConnectPollResult {
  const entry = pending.get(connectId);
  if (entry === undefined || entry.userId !== userId) return { state: 'unknown' };
  if (entry.done) {
    return { state: 'connected', accountEmail: entry.accountEmail, accountId: entry.accountId };
  }
  if (entry.failed !== undefined) {
    pending.delete(connectId);
    return { state: 'unknown', reason: entry.failed };
  }
  if (Date.now() > entry.deadline) {
    return { state: 'expired', reason: 'sign-in window elapsed' };
  }
  return {
    state: 'pending',
    stage: entry.stage,
    liveViewUrl: entry.liveViewUrl,
    // Known as soon as the seeded session identifies itself, so the modal can
    // show WHICH account is being connected while the user is still working.
    accountEmail: entry.accountEmail,
  };
}

/** Abandon a connect in progress (user cancelled / navigated away). */
export async function cancelConnectSession(userId: string, connectId: string): Promise<void> {
  const entry = pending.get(connectId);
  if (entry === undefined || entry.userId !== userId) return;
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
