/** Remote-browser sign-in watcher for a pending compute connection. */

import { READ_CODE, exchangeAuthorizationCode } from '../../providers/browser/claudeGrantMint';
import {
  READ_CODEX_CALLBACK,
  exchangeCodexAuthorizationCode,
  parseCodexCallbackUrl,
} from '../../providers/browser/codexGrantMint';
import { createLogger } from '../../providers/logger';
import { getKernelCaptchaTelemetry } from '../../providers/browser/kernel';
import { getSteelCaptchaTelemetry } from '../../providers/steel/sessionInspect';
import { getTilionCaptchaTelemetry } from '../../providers/browser/tilion';
import {
  CAPTCHA_WIDGET_PRESENT_SCRIPT,
  captchaSolveIndicatorSetPhaseScript,
  emptyCaptchaIndicatorMemory,
  resolveCaptchaIndicatorPhase,
} from '../../providers/browser/captchaSolveIndicator';
import { computeGrantBrowserProvider } from './config';
import { persistFirstGrant } from './connectSession.grant';
import { autofillGooglePassword } from './connectSession.googlePassword';
import { finish, releaseBrowser } from './connectSession.lifecycle';
import { upsertAccountConnection } from './repo';
import type { ConnectProviderConfig, PendingConnect } from './connectSession.types';

const log = createLogger('ComputeGrants');

async function syncCaptchaSolveIndicator(entry: PendingConnect): Promise<void> {
  if (entry.cdp === null || entry.steelSessionId === null) return;
  const provider = computeGrantBrowserProvider();
  const telemetry =
    provider === 'kernel'
      ? await getKernelCaptchaTelemetry(entry.steelSessionId)
      : provider === 'steel'
        ? await getSteelCaptchaTelemetry(entry.steelSessionId)
        : provider === 'tilion'
          ? await getTilionCaptchaTelemetry(entry.steelSessionId)
          : {
              provider: 'browser-use' as const,
              telemetryEnabled: false,
              isSolving: null,
              activeTaskCount: null,
              pages: [],
              latestOutcome: null,
            };
  let kernelWidgets = false;
  if (
    telemetry.isSolving === null &&
    (telemetry.provider === 'kernel' || telemetry.provider === 'tilion')
  ) {
    kernelWidgets = (await entry.cdp.evaluate<boolean>(CAPTCHA_WIDGET_PRESENT_SCRIPT)) === true;
  }
  const memory = entry.captchaIndicatorMemory ?? emptyCaptchaIndicatorMemory();
  const resolved = resolveCaptchaIndicatorPhase(
    telemetry,
    { kernelChallengeWidgetsPresent: kernelWidgets },
    memory
  );
  entry.captchaIndicatorMemory = resolved.memory;
  await entry.cdp.evaluate(captchaSolveIndicatorSetPhaseScript(resolved.phase));
}
interface MintedCredentials {
  accessToken: string;
  expiresIn: number;
  accountId?: string;
  accountEmail?: string;
  idToken?: string;
  refreshToken?: string;
}

async function readAccountEmail(entry: PendingConnect): Promise<void> {
  if (entry.accountEmail !== undefined || entry.cdp === null) return;
  const seen = await entry.cdp.evaluate<string>(
    String.raw`(document.body.innerText.match(/[\w.+-]+@[\w.-]+\.\w+/)||[''])[0]`
  );
  if (seen !== undefined && seen.length > 0) entry.accountEmail = seen;
}

async function readCodexCallback(entry: PendingConnect): Promise<string | undefined> {
  if (entry.cdp === null) return undefined;
  let callbackUrl = entry.cdp.getCapturedCodexCallbackUrl();
  if (callbackUrl === undefined || callbackUrl.length === 0) {
    callbackUrl = await entry.cdp.evaluateAnyTarget<string>(READ_CODEX_CALLBACK);
  }
  if (callbackUrl === undefined || callbackUrl.length === 0) {
    callbackUrl = (await entry.cdp.getPageUrls()).find((url) =>
      /^http:\/\/localhost:(1455|1457)\/auth\/callback(?:\?|$)/.test(url)
    );
  }
  return callbackUrl;
}

async function mintCredentials(entry: PendingConnect): Promise<MintedCredentials | null> {
  const cdp = entry.cdp;
  if (cdp === null) return null;
  if (entry.provider === 'claude') {
    const code = await cdp.evaluateAnyTarget<string>(READ_CODE);
    if (code === undefined || code.length === 0) return null;
    entry.stage = 'capturing';
    return exchangeAuthorizationCode(code, entry.authVerifier ?? '', entry.authState ?? '');
  }
  const callbackUrl = await readCodexCallback(entry);
  if (callbackUrl === undefined || callbackUrl.length === 0) return null;
  entry.stage = 'capturing';
  const code = parseCodexCallbackUrl(callbackUrl, entry.authState ?? '');
  void cdp.showFinishingPage(callbackUrl).catch((error: unknown) => {
    log.warn('connect.callback_page_failed', {
      connect_id: entry.connectId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return exchangeCodexAuthorizationCode(code, entry.authVerifier ?? '', entry.authRedirectUri);
}

async function persistConnectedAccount(
  entry: PendingConnect,
  cfg: ConnectProviderConfig,
  minted: MintedCredentials,
  timer: NodeJS.Timeout
): Promise<void> {
  if (entry.cdp === null) return;
  entry.stage = 'minting';
  const cookies = await entry.cdp.getCookies(cfg.cookieUrls);
  const email = minted.accountEmail ?? entry.accountEmail;
  const accountId = minted.accountId;
  if (accountId === undefined || accountId.length === 0) {
    throw new Error(`${entry.provider} OAuth response did not identify the account`);
  }
  const sessionCookie = cookies.find((cookie) => cookie.name === cfg.sessionCookie);
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
  Object.assign(entry, { accountId, accountEmail: email, stage: 'connected', done: true });
  clearInterval(timer);
  log.info('connect.completed', {
    provider: entry.provider,
    account_id: accountId,
    session_expires_at: expires?.toISOString(),
  });
  await releaseBrowser(entry);
}

async function watchSignInTick(
  entry: PendingConnect,
  cfg: ConnectProviderConfig,
  timer: NodeJS.Timeout
): Promise<void> {
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
  if (entry.cdp === null || entry.cdpBase === null) return;
  await syncCaptchaSolveIndicator(entry).catch(() => undefined);
  await autofillGooglePassword(entry).catch(() => false);
  await readAccountEmail(entry);
  const minted = await mintCredentials(entry);
  if (minted === null) {
    // Still waiting on the user: explain a passkey prompt Rose cannot answer.
    // Read only after capture found nothing, so it can never delay a sign-in.
    entry.passkeyUnavailableFor = await entry.cdp
      .syncPasskeyCeremonies()
      .catch(() => entry.passkeyUnavailableFor);
    return;
  }
  await persistConnectedAccount(entry, cfg, minted, timer);
}

export function startSignInWatcher(
  entry: PendingConnect,
  cfg: ConnectProviderConfig,
  pollMs: number
): void {
  let pollInFlight = false;
  const timer = setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    void watchSignInTick(entry, cfg, timer)
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.warn('connect.watch_failed', {
          connect_id: entry.connectId,
          error: message,
        });
        // Before a code is captured, a transient CDP read can recover on the
        // next tick. Once exchange/persistence begins, however, retrying the
        // same one-time code cannot recover and leaves the user pending while a
        // remote browser bills until TTL. Surface that terminal failure and
        // release the browser immediately.
        if (entry.stage === 'capturing' || entry.stage === 'minting') {
          clearInterval(timer);
          entry.failed = message;
          await releaseBrowser(entry);
        }
      })
      .finally(() => {
        pollInFlight = false;
      });
  }, pollMs);
}
