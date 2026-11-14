import { buildBrowserSessionMetadata, logicalHasPrivateState } from './service.metadata';
export { buildBrowserSessionMetadata } from './service.metadata';
import { initLegacySession } from './service.init-legacy';
import { closeBrowserSession } from './service.close';
import { resumeOwnedBrowserSession } from './service.control';
import { getTaskInfo } from './service.task-info';
import { ensureLogicalBrowser } from '../../providers/browser/logicalSession';
import {
  initializeLogicalBrowser,
  waitForBrowserInitialization,
} from '../../providers/browser/initialization';
/**
 * Browser-session domain service — business logic, no req/res.
 */

import type { Browser } from 'playwright';
import {
  injectUserData,
  resizeSessionViewport,
  type BrowserViewport,
} from '../../providers/browser';
import {
  rotateBrowserProxy,
  ProxyRotationExhaustedError,
  RotationSessionNotFoundError,
} from '../../providers/browserSessionResume';
import { canonicalAuthRealm } from '../../providers/authRealm';
import { prepareWorldStateFork } from './service.world-fork';
import { getAuthOptions } from '../../providers/authOptions';
import * as repo from './repo';
import { storedBrowserProvider } from '../../providers/browser/types';
import {
  injectLocalStorage,
  SessionNoUserError,
  SessionNotFoundError,
} from './service.local-storage';
import {
  buildSessionCredentialPayload,
  preserveSessionCredentialPayload,
} from './service.credential-error';
import { buildTilionWorkerApplyPayload } from './service.worker-apply';
export { SessionCredentialInjectionError } from './service.credential-error';
export type { SessionCredentialPayload } from './service.credential-error';
export { getTaskInfo, getTaskOwnerUserId } from './service.task-info';
export {
  BrowserControlUnavailableError,
  getBrowserControlState,
  resumeOwnedBrowserSession as resumeBrowserSession,
  setBrowserControlState,
} from './service.control';
export { injectLocalStorage, SessionNotFoundError, SessionNoUserError };
export { InvalidSessionFilePathError } from './service.file-path';
export { CdpInjectionError, SessionNoWsUrlError } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A logical browser holds private state only once it has its own checkpoint or
 * a non-empty Home baseline. Until then it is a new browser and follows the
 * normal init contract: provider profile, saved realm credentials, full metadata.
 */

export async function prepareSessionCredentials(
  sessionId: string,
  userId: string,
  targetUrl: string,
  options: { browser?: Browser; restoreBrowserState?: boolean } = {}
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

  const creds = buildSessionCredentialPayload(authRealm, authOptions, storedPasswords, passkeys);
  if (options.restoreBrowserState === false || logicalHasPrivateState(session)) {
    return {
      ...creds,
      auth_credential_ref: null,
      cookies_injected: false,
      cookies_count: 0,
      auth_source: 'none' as const,
      browser_state_injection: {
        cookies: {
          injected: false,
          cookieCount: 0,
          authSource: 'none' as const,
          credentialRef: null,
        },
        fingerprint: { injected: false },
        indexedDB: { injected: false, originCount: 0 },
        localStorage: { injected: false, originCount: 0 },
        permissions: { injected: false, grantCount: 0 },
        cacheStorage: { injected: false, originCount: 0 },
      },
    };
  }
  // Inventory refresh must not replace an in-flight authentication transaction.
  const onCookiesReady = prepareWorldStateFork(session, userId, targetUrl);
  if (session.provider === 'tilion' && options.browser === undefined) {
    // The agent worker holds Tilion's only CDP socket: hand it the state to apply.
    // The world-state fork needs a backend CDP context, so it is not recorded here.
    const { payload, injection } = await buildTilionWorkerApplyPayload(userId, targetUrl);
    return {
      ...creds,
      auth_credential_ref: injection.cookies.credentialRef,
      cookies_injected: false,
      cookies_count: injection.cookies.cookieCount,
      auth_source: injection.cookies.authSource,
      browser_state_injection: injection,
      worker_apply: payload,
    };
  }
  const injection = await preserveSessionCredentialPayload(
    () => injectUserData(sessionId, userId, targetUrl, { ...options, onCookiesReady }),
    creds
  );

  return {
    ...creds,
    auth_credential_ref: injection.cookies.credentialRef,
    cookies_injected: injection.cookies.injected,
    cookies_count: injection.cookies.cookieCount,
    auth_source: injection.cookies.authSource,
    browser_state_injection: injection,
  };
}

/** A blank initial page has no authentication realm or origin storage. */
async function prepareInitialSessionCredentials(
  sessionId: string,
  userId: string,
  targetUrl: string,
  options: { browser?: Browser }
) {
  if (targetUrl !== 'about:blank') {
    return prepareSessionCredentials(sessionId, userId, targetUrl, options);
  }
  // Navigation prepares the real target realm through the existing JIT path.
  // Do not query, reserve or inject a site's credentials into an opaque page.
  return {
    ...buildSessionCredentialPayload(
      '',
      {
        realm: '',
        steel_session: null,
        cookie_bundles: [],
        passwords: [],
        passkeys: [],
        email_otp: { available: false, connected_emails: [], match_for_site_account: null },
        readable_identifiers: [],
        minted: null,
      },
      [],
      []
    ),
    auth_credential_ref: null,
    cookies_injected: false,
    cookies_count: 0,
    auth_source: 'none' as const,
    browser_state_injection: {
      cookies: {
        injected: false,
        cookieCount: 0,
        authSource: 'none' as const,
        credentialRef: null,
      },
      fingerprint: { injected: false },
      indexedDB: { injected: false, originCount: 0 },
      localStorage: { injected: false, originCount: 0 },
      permissions: { injected: false, grantCount: 0 },
      cacheStorage: { injected: false, originCount: 0 },
    },
  };
}

/* c8 ignore start -- initSession, closeBrowserSession, resumeBrowserSession require Steel SDK */
export async function initSession(userId: string, agentId: string, startUrl: string, id?: string) {
  let logical = await ensureLogicalBrowser(userId, agentId);
  if (id !== undefined && id !== logical.id) {
    const result = await initLegacySession(userId, agentId, startUrl, id, {
      prepare: prepareInitialSessionCredentials,

      metadata: buildBrowserSessionMetadata,
    });
    return { ...result, releaseOnDisconnect: () => closeBrowserSession(result.session_id, false) };
  }
  await waitForBrowserInitialization(logical.id, userId);
  await repo.updateLogicalSessionUrls(
    logical.id,
    logical.startUrl ?? startUrl,
    logical.currentUrl ?? startUrl
  );
  if (logical.sessionId === null && !logicalHasPrivateState(logical)) {
    const initialized = await initializeLogicalBrowser(logical.id, userId, () =>
      initLegacySession(userId, agentId, startUrl, logical.id, {
        prepare: prepareInitialSessionCredentials,

        metadata: buildBrowserSessionMetadata,
      })
    );
    if (initialized !== null) return { ...initialized, releaseOnDisconnect: undefined };
  }
  // Both an already materialized caller and a joined initializer must use the
  // binding after the durable readiness boundary, not the earlier snapshot.
  const currentLogical = await repo.findSessionByTaskId(logical.id);
  if (currentLogical === null || currentLogical.context.userId !== userId)
    throw new Error('Logical browser owner changed before reattachment');
  logical = currentLogical;
  if (logical.sessionId !== null && logical.status === 'ACTIVE') {
    const existing = await getTaskInfo(logical.id, { validateLive: true });
    if (existing?.same_session_available === true && existing.session_id !== null) {
      const current = await repo.findSessionByTaskId(logical.id);
      if (
        current?.sessionId !== existing.session_id ||
        current.status !== 'ACTIVE' ||
        current.context.userId !== userId
      )
        throw new Error('Logical browser binding changed before reattachment');
      if (
        current.controlState !== 'AGENT' &&
        (current.controlLeaseExpiresAt === null ||
          current.controlLeaseExpiresAt.getTime() > Date.now())
      )
        throw new Error('Browser init cannot reattach a session under user control');
      return { ...existing, session_id: existing.session_id, releaseOnDisconnect: undefined };
    }
  }
  return {
    ...(await resumeOwnedBrowserSession(logical.id, userId)),
    releaseOnDisconnect: undefined,
  };
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

export { closeBrowserSession } from './service.close';

// rotate_ip tool — swap the browser session's outbound IP (see
// providers/browserSessionResume.ts and docs/plans/active/rotate-ip-tool.md).
export { rotateBrowserProxy, ProxyRotationExhaustedError, RotationSessionNotFoundError };
/* c8 ignore stop */

// ---------------------------------------------------------------------------
// Get context
// ---------------------------------------------------------------------------

export { findContextByUserId as getContext } from './repo';

export async function resizeBrowserViewport(
  taskId: string,
  viewport: BrowserViewport,
  userId?: string
) {
  const session = await repo.findSessionByTaskId(taskId);
  if (session === null || (userId !== undefined && session.context.userId !== userId)) {
    throw new SessionNotFoundError();
  }

  const provider = storedBrowserProvider(session.provider);
  if (session.sessionId === null) throw new SessionNotFoundError();
  return resizeSessionViewport(session.sessionId, viewport, provider);
}

export {
  getSessionById,
  uploadFile,
  listFiles,
  downloadFile,
  takeScreenshot,
  pressKeys,
} from './service.session-io';
