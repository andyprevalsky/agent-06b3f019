/**
 * Browser-session domain service — business logic, no req/res.
 */

import { type ProxyGeoLocation, DEFAULT_GEOLOCATION } from '../../providers/geoip';
import { createLogger } from '../../providers/logger';
import {
  getOrCreateContext,
  createSessionWithContext,
  closeSession,
  getSession,
  injectUserData,
  uploadSessionFile,
  listFiles as listProviderFiles,
  readSessionFile,
  resizeSessionViewport,
  captureScreenshot,
  type BrowserViewport,
  getFingerprintInjectionData,
} from '../../providers/browser';
import { resumeBrowserSession as resumeBrowserSessionProvider } from '../../providers/browserSessionResume';
import { canonicalAuthRealm } from '../../providers/authRealm';
import * as repo from './repo';
import {
  injectLocalStorage,
  SessionNoUserError,
  SessionNotFoundError,
} from './service.local-storage';
import { serializePasskeys, serializePasswords, toUserSettings } from './service.serializers';
export { getTaskInfo, getTaskOwnerUserId } from './service.task-info';
export { injectLocalStorage, SessionNotFoundError, SessionNoUserError };
export { CdpInjectionError, SessionNoWsUrlError } from './types';

const log = createLogger('BrowserSession');
const SAFE_ABSOLUTE_FILE_ROOTS = ['/tmp/downloads/', '/tmp/rose-uploads/', '/home/oai/share/'];

export class InvalidSessionFilePathError extends Error {
  constructor() {
    super('Invalid session file path');
    this.name = 'InvalidSessionFilePathError';
  }
}

async function requireSessionOwner(sessionId: string, userId?: string): Promise<void> {
  if (userId === undefined) return;
  const session = await repo.findSessionBySessionId(sessionId);
  if (session === null || session.context.userId !== userId) {
    throw new SessionNotFoundError();
  }
}

function validateSessionFilePath(filePath: string): void {
  const canonical = filePath.replace(/\\/g, '/');
  if (
    canonical.includes('\0') ||
    canonical.split('/').includes('..') ||
    (canonical.startsWith('/') &&
      !SAFE_ABSOLUTE_FILE_ROOTS.some((root) => canonical.startsWith(root)))
  ) {
    throw new InvalidSessionFilePathError();
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

/* c8 ignore start -- initSession, closeBrowserSession, resumeBrowserSession require Steel SDK */
export async function initSession(userId: string, agentId: string, startUrl: string) {
  log.info('Initializing browser session', {
    userId,
    agentId,
    startUrl: startUrl !== '' ? startUrl : 'none',
  });

  // Phase 1: All independent queries in parallel. The passkey reservation is a
  // mutation (atomic signCount block reserve) keyed on the start_url's realm; it
  // returns nothing for sites without a stored passkey.
  const realm = canonicalAuthRealm(startUrl);
  const [agent, contextId, user, fingerprintInjection, passwords, passkeys] = await Promise.all([
    repo.findAgentProxy(agentId),
    getOrCreateContext(userId),
    repo.findUserSettings(userId),
    getFingerprintInjectionData(userId),
    repo.findPasswords(userId),
    repo.reservePasskeysForRealm(userId, realm),
  ]);

  const proxyGeo: ProxyGeoLocation =
    agent !== null &&
    agent !== undefined &&
    agent.proxyCountry !== null &&
    agent.proxyCountry !== ''
      ? {
          country: agent.proxyCountry,
          ...(agent.proxyState !== null && agent.proxyState !== ''
            ? { state: agent.proxyState }
            : {}),
          ...(agent.proxyCity !== null && agent.proxyCity !== '' ? { city: agent.proxyCity } : {}),
        }
      : DEFAULT_GEOLOCATION;

  log.info('Using proxy location', {
    city: proxyGeo.city ?? 'unknown',
    state: proxyGeo.state ?? 'unknown',
    country: proxyGeo.country,
  });

  // Phase 2: Create session (needs agent proxy + context). Keep the validation
  // CDP connection open so injection can reuse it (a fresh handshake is 3-5s).
  const session = await createSessionWithContext(contextId, agentId, proxyGeo, startUrl, {
    keepValidationConnection: true,
  });

  // Phase 3: Inject user's cookies and fingerprint via CDP
  const injectionResult = await injectUserData(session.sessionId, userId, startUrl, {
    browser: session.validationBrowser ?? undefined,
  });

  const serializedPasswords = serializePasswords(passwords);
  const serializedPasskeys = serializePasskeys(passkeys);
  const userSettings = toUserSettings(user);

  log.info('Including passwords in init response', { count: serializedPasswords.length });
  if (serializedPasskeys.length > 0) {
    log.info('Including passkeys in init response', { count: serializedPasskeys.length, realm });
  }

  return {
    task_id: session.taskId,
    context_id: contextId,
    session_id: session.sessionId,
    debug_url: session.debugUrl,
    ws_url: session.wsUrl,
    browser_session_metadata: buildBrowserSessionMetadata(session, injectionResult),
    cookies_injected: injectionResult.cookies.injected,
    cookies_count: injectionResult.cookies.cookieCount,
    auth_source: injectionResult.cookies.authSource,
    auth_credential_ref: injectionResult.cookies.credentialRef,
    fingerprint_injected: injectionResult.fingerprint.injected,
    fingerprint_injection: fingerprintInjection,
    passwords: serializedPasswords,
    passkeys: serializedPasskeys,
    user_settings: userSettings,
  };
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

export async function closeBrowserSession(sessionId: string, pause: boolean, currentUrl?: string) {
  log.info(`${pause ? 'Pausing' : 'Closing'} browser session`, {
    sessionId,
    currentUrl: currentUrl !== undefined && currentUrl !== '' ? currentUrl : 'NULL/EMPTY',
  });

  await closeSession(sessionId, pause, currentUrl);

  return { status: pause ? ('PAUSED' as const) : ('CLOSED' as const) };
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

export const resumeBrowserSession = resumeBrowserSessionProvider;
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

  const provider = session.provider === 'kernel' ? 'kernel' : 'steel';
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
  mimetype: string
) {
  log.info('Uploading file to session', { sessionId, originalname, sizeBytes: buffer.length });

  const result = await uploadSessionFile(sessionId, buffer, originalname, mimetype);

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
/* c8 ignore stop */
