import { initLegacySession } from './service.init-legacy';
import { closeBrowserSession } from './service.close';
import { resumeOwnedBrowserSession } from './service.control';
import { getTaskInfo } from './service.task-info';
import { ensureLogicalBrowser } from '../../providers/browser/logicalSession';
import { EMPTY_BROWSER_BASELINE } from '../../providers/browser/checkpoint';
import {
  initializeLogicalBrowser,
  waitForBrowserInitialization,
} from '../../providers/browser/initialization';
/**
 * Browser-session domain service — business logic, no req/res.
 */

import type { Browser } from 'playwright';
import { createLogger } from '../../providers/logger';
import {
  getSession,
  injectUserData,
  uploadSessionFile,
  listFiles as listProviderFiles,
  readSessionFile,
  resizeSessionViewport,
  captureScreenshot,
  pressSessionKeys,
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
import { buildBrowserSessionMetadata } from './service.metadata';
import { validateBrowserKeySymbols } from './service.browser-input';
import { validateSessionFilePath } from './service.file-path';
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
export { buildBrowserSessionMetadata } from './service.metadata';

const log = createLogger('BrowserSession');

async function requireSessionOwner(sessionId: string, userId?: string): Promise<void> {
  if (userId === undefined) return;
  const session = await repo.findSessionBySessionId(sessionId);
  if (session === null || session.context.userId !== userId) throw new SessionNotFoundError();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A logical browser holds private state only once it has its own checkpoint or
 * a non-empty Home baseline. Until then it is a new browser and follows the
 * normal init contract: provider profile, saved realm credentials, full metadata.
 */
function logicalHasPrivateState(session: {
  logicalOwnerKey: string | null;
  checkpointRef: string | null;
  baselineCheckpointRef: string | null;
}): boolean {
  return (
    session.logicalOwnerKey !== null &&
    (session.checkpointRef !== null || session.baselineCheckpointRef !== EMPTY_BROWSER_BASELINE)
  );
}

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

  const [authOptions, storedPasswords, passkeys, onCookiesReady] = await Promise.all([
    getAuthOptions(userId, authRealm, {
      steelContextId: session.provider === 'steel' ? (session.providerProfileId ?? null) : null,
    }),
    repo.findPasswords(userId),
    repo.reservePasskeysForRealm(userId, authRealm),
    // Browser-template fork (A6): recorded once injection has chosen the account.
    prepareWorldStateFork(session, userId, targetUrl),
  ]);

  const credentialPayload = buildSessionCredentialPayload(
    authRealm,
    authOptions,
    storedPasswords,
    passkeys
  );
  if (logicalHasPrivateState(session)) {
    return {
      ...credentialPayload,
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
  if (session.provider === 'tilion' && options.browser === undefined) {
    // The agent worker holds Tilion's only CDP socket: hand it the state to apply.
    // The world-state fork needs a backend CDP context, so it is not recorded here.
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
    () => injectUserData(sessionId, userId, targetUrl, { ...options, onCookiesReady }),
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

/* c8 ignore start -- initSession, closeBrowserSession, resumeBrowserSession require Steel SDK */
export async function initSession(userId: string, agentId: string, startUrl: string, id?: string) {
  let logical = await ensureLogicalBrowser(userId, agentId);
  if (id !== undefined && id !== logical.id) {
    const result = await initLegacySession(userId, agentId, startUrl, id, {
      prepare: prepareSessionCredentials,
      metadata: buildBrowserSessionMetadata,
    });
    return {
      ...result,
      releaseOnDisconnect: () => closeBrowserSession(result.session_id, false),
    };
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
        prepare: prepareSessionCredentials,
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

export async function getContext(userId: string) {
  return repo.findContextByUserId(userId);
}

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

// ---------------------------------------------------------------------------
// Get session by Steel ID
// ---------------------------------------------------------------------------

/* c8 ignore start -- getSessionById, uploadFile, listFiles require Steel SDK */
export async function getSessionById(sessionId: string) {
  return getSession(sessionId);
}

// ---------------------------------------------------------------------------
// Upload file
// ---------------------------------------------------------------------------

export async function uploadFile(
  sessionId: string,
  buffer: Buffer,
  originalname: string,
  mimetype: string,
  options: { directory?: string } = {}
) {
  log.info('Uploading file to session', {
    sessionId,
    originalname,
    sizeBytes: buffer.length,
    directory: options.directory,
  });

  const result = await uploadSessionFile(sessionId, buffer, originalname, mimetype, options);

  return {
    path: result.path,
    size: result.size,
    filename: originalname,
  };
}

// ---------------------------------------------------------------------------
// List files
// ---------------------------------------------------------------------------

export async function listFiles(sessionId: string) {
  log.info('Listing files for session', { sessionId });

  const files = await listProviderFiles(sessionId);

  return {
    session_id: sessionId,
    files,
    count: files.length,
  };
}

export async function downloadFile(sessionId: string, filePath: string, userId?: string) {
  await requireSessionOwner(sessionId, userId);
  validateSessionFilePath(filePath);
  const content = await readSessionFile(sessionId, filePath);
  const filename = filePath.split('/').pop();
  return {
    content,
    filename: filename !== undefined && filename !== '' ? filename : 'download',
  };
}

export async function takeScreenshot(sessionId: string, userId?: string) {
  await requireSessionOwner(sessionId, userId);
  return captureScreenshot(sessionId);
}

export async function pressKeys(sessionId: string, keys: string[], userId: string) {
  await requireSessionOwner(sessionId, userId);
  validateBrowserKeySymbols(keys);
  return pressSessionKeys(sessionId, keys);
}
/* c8 ignore stop */
