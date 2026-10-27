import { initLegacySession } from './service.init-legacy';
import { resumeOwnedBrowserSession } from './service.control';
import { ensureLogicalBrowser } from '../../providers/browser/logicalSession';
import { EMPTY_BROWSER_BASELINE } from '../../providers/browser/checkpoint';
import { BrowserSessionReclaimConflictError } from '../../providers/browser/sessionPersist';
/**
 * Browser-session domain service — business logic, no req/res.
 */

import type { Browser } from 'playwright';
import { type ProxyGeoLocation } from '../../providers/geoip';
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

const log = createLogger('BrowserSession');

async function requireSessionOwner(sessionId: string, userId?: string): Promise<void> {
  if (userId === undefined) return;
  const session = await repo.findSessionBySessionId(sessionId);
  if (session === null || session.context.userId !== userId) {
    throw new SessionNotFoundError();
  }
}

interface BrowserSessionMetadataInput {
  provider: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  profileId: string | null;
  profileSource: string;
}

interface BrowserSessionInjectionMetadataInput {
  cookies: { injected: boolean; cookieCount: number; authSource: string };
  localStorage: { originCount: number };
  indexedDB: { originCount: number };
  permissions: { grantCount: number };
  cacheStorage: { originCount: number };
}

export function buildBrowserSessionMetadata(
  session: BrowserSessionMetadataInput,
  injectionResult: BrowserSessionInjectionMetadataInput
) {
  return {
    provider: session.provider,
    proxy_source: session.proxySource,
    proxy_location: session.proxyLocation,
    profile_id: session.profileId,
    profile_source: session.profileSource,
    auth_source: injectionResult.cookies.authSource,
    cookies_injected: injectionResult.cookies.injected,
    cookies_count: injectionResult.cookies.cookieCount,
    local_storage_origin_count: injectionResult.localStorage.originCount,
    indexed_db_origin_count: injectionResult.indexedDB.originCount,
    permission_grant_count: injectionResult.permissions.grantCount,
    cache_storage_origin_count: injectionResult.cacheStorage.originCount,
    ...(session.provider === 'steel'
      ? {
          steel_profile_id: session.profileId,
          steel_profile_source: session.profileSource,
        }
      : {}),
  };
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
    ...buildSessionCredentialPayload('', {
      realm: '',
      steel_session: null,
      cookie_bundles: [],
      passwords: [],
      passkeys: [],
      email_otp: { available: false, connected_emails: [], match_for_site_account: null },
      readable_identifiers: [],
      minted: null,
    }, [], []),
    auth_credential_ref: null,
    cookies_injected: false,
    cookies_count: 0,
    auth_source: 'none' as const,
    browser_state_injection: {
      cookies: { injected: false, cookieCount: 0, authSource: 'none' as const, credentialRef: null },
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
  const logical = await ensureLogicalBrowser(userId, agentId);
  if (id !== undefined && id !== logical.id)
    return initLegacySession(userId, agentId, startUrl, id, {
      prepare: prepareInitialSessionCredentials,
      metadata: buildBrowserSessionMetadata,
    });
  await repo.updateLogicalSessionUrls(
    logical.id,
    logical.startUrl ?? startUrl,
    logical.currentUrl ?? startUrl
  );
  if (logical.sessionId === null && !logicalHasPrivateState(logical)) {
    // First materialization of an empty logical browser: initialize it bound to
    // its logical row. A concurrent first init that loses the row's binding race
    // follows the winner through the resume path instead of failing.
    try {
      return await initLegacySession(userId, agentId, startUrl, logical.id, {
        prepare: prepareInitialSessionCredentials,
        metadata: buildBrowserSessionMetadata,
      });
    } catch (error) {
      if (!(error instanceof BrowserSessionReclaimConflictError)) throw error;
    }
  }
  return resumeOwnedBrowserSession(logical.id, userId);
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
