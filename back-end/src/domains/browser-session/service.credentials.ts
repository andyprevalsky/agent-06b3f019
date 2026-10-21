/**
 * Realm-scoped credential preparation for a browser session (init and JIT).
 *
 * Tilion: the agent worker holds the session's only CDP socket, so a JIT
 * prepare (no validation browser) returns `worker_apply` instead of injecting,
 * and init frees its validation socket before responding.
 */
import type { Browser } from 'playwright';
import { canonicalAuthRealm } from '../../providers/authRealm';
import { getAuthOptions } from '../../providers/authOptions';
import { closeSession, injectUserData } from '../../providers/browser';
import type { BrowserProviderSession } from '../../providers/browser/types';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import {
  buildSessionCredentialPayload,
  preserveSessionCredentialPayload,
} from './service.credential-error';
import { SessionNotFoundError } from './service.local-storage';
import { buildTilionWorkerApplyPayload } from './service.worker-apply';

const log = createLogger('BrowserSession');

export async function prepareSessionCredentials(
  sessionId: string,
  userId: string,
  targetUrl: string,
  options: { browser?: Browser } = {}
) {
  const session = await repo.findSessionBySessionId(sessionId);
  if (session === null || session.context.userId !== userId) {
    throw new SessionNotFoundError();
  }

  const authRealm = canonicalAuthRealm(targetUrl);
  if (authRealm === '') {
    throw new Error('Target URL must have an authentication realm');
  }

  const [authOptions, storedPasswords, passkeys] = await Promise.all([
    getAuthOptions(userId, authRealm, {
      steelContextId: session.provider === 'steel' ? (session.providerProfileId ?? null) : null,
    }),
    repo.findPasswords(userId),
    repo.reservePasskeysForRealm(userId, authRealm),
  ]);

  const credentialPayload = buildSessionCredentialPayload(
    authRealm,
    authOptions,
    storedPasswords,
    passkeys
  );
  if (session.provider === 'tilion' && options.browser === undefined) {
    // The agent worker holds Tilion's only CDP socket: hand it the state to apply.
    const { payload, injection } = await buildTilionWorkerApplyPayload(userId, targetUrl);
    return {
      ...credentialPayload,
      auth_credential_ref: injection.cookies.credentialRef,
      cookies_injected: false,
      cookies_count: injection.cookies.cookieCount,
      auth_source: injection.cookies.authSource,
      browser_state_injection: injection,
      worker_apply: payload,
    };
  }
  const injectionResult = await preserveSessionCredentialPayload(
    () => injectUserData(sessionId, userId, targetUrl, options),
    credentialPayload
  );

  return {
    ...credentialPayload,
    auth_credential_ref: injectionResult.cookies.credentialRef,
    cookies_injected: injectionResult.cookies.injected,
    cookies_count: injectionResult.cookies.cookieCount,
    auth_source: injectionResult.cookies.authSource,
    browser_state_injection: injectionResult,
  };
}

/** initSession's credential step: reuses the validation socket, cleans up on failure. */
export async function prepareInitSessionCredentials(
  session: BrowserProviderSession,
  userId: string,
  startUrl: string
): Promise<Awaited<ReturnType<typeof prepareSessionCredentials>>> {
  // Tilion accepts one CDP client: free the validation socket before the
  // response (and before close's harvest) so the next attach is not refused with 4409.
  const releaseTilionValidationSocket = async () => {
    if (session.provider === 'tilion') {
      await session.validationBrowser?.close().catch(() => undefined);
    }
  };
  try {
    return await prepareSessionCredentials(session.sessionId, userId, startUrl, {
      browser: session.validationBrowser ?? undefined,
    });
  } catch (error) {
    await releaseTilionValidationSocket();
    await closeSession(session.sessionId, false).catch((cleanupError) => {
      log.error('Failed to clean up browser after credential preparation error', {
        sessionId: session.sessionId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    });
    throw error;
  } finally {
    await releaseTilionValidationSocket();
  }
}
