/**
 * Browser-session domain service — business logic, no req/res.
 */

import { type ProxyGeoLocation, DEFAULT_GEOLOCATION } from '../../providers/geoip';
import { createLogger } from '../../providers/logger';
import {
  getOrCreateContext,
  createSessionWithContext,
  closeSession as steelCloseSession,
  getSession as steelGetSession,
  injectUserData,
  uploadFileToSession as steelUploadFile,
  listSessionFiles as steelListFiles,
  getFingerprintInjectionData,
} from '../../providers/steel';
import { resumeBrowserSession as resumeBrowserSessionProvider } from '../../providers/browserSessionResume';
import * as repo from './repo';
import { serializePasswords, toUserSettings } from './service.serializers';
export { getTaskInfo, getTaskOwnerUserId } from './service.task-info';
export {
  injectLocalStorage,
  SessionNotFoundError,
  SessionNoUserError,
} from './service.local-storage';
export { CdpInjectionError, SessionNoWsUrlError } from './types';

const log = createLogger('BrowserSession');

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

  // Phase 1: All independent queries in parallel
  const [agent, contextId, user, fingerprintInjection, passwords] = await Promise.all([
    repo.findAgentProxy(agentId),
    getOrCreateContext(userId),
    repo.findUserSettings(userId),
    getFingerprintInjectionData(userId),
    repo.findPasswords(userId),
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

  // Phase 2: Create session (needs agent proxy + context)
  const session = await createSessionWithContext(contextId, agentId, proxyGeo, startUrl);

  // Phase 3: Inject user's cookies and fingerprint via CDP
  const injectionResult = await injectUserData(session.sessionId, userId, startUrl);

  const serializedPasswords = serializePasswords(passwords);
  const userSettings = toUserSettings(user);

  log.info('Including passwords in init response', { count: serializedPasswords.length });

  return {
    task_id: session.taskId,
    context_id: contextId,
    session_id: session.sessionId,
    debug_url: session.debugUrl,
    ws_url: session.wsUrl,
    browser_session_metadata: {
      provider: session.sessionId.startsWith('local-') ? 'local' : 'steel',
      proxy_source: session.proxySource,
      proxy_location: session.proxyLocation,
      steel_profile_id: session.steelProfileId,
      steel_profile_source: session.profileSource,
    },
    cookies_injected: injectionResult.cookies.injected,
    cookies_count: injectionResult.cookies.cookieCount,
    auth_source: injectionResult.cookies.authSource,
    auth_credential_ref: injectionResult.cookies.credentialRef,
    fingerprint_injected: injectionResult.fingerprint.injected,
    fingerprint_injection: fingerprintInjection,
    passwords: serializedPasswords,
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

  await steelCloseSession(sessionId, pause, currentUrl);

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

// ---------------------------------------------------------------------------
// Get session by Steel ID
// ---------------------------------------------------------------------------

/* c8 ignore start -- getSessionById, uploadFile, listFiles require Steel SDK */
export async function getSessionById(sessionId: string) {
  return steelGetSession(sessionId);
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

  const result = await steelUploadFile(sessionId, buffer, originalname, mimetype);

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

  const files = await steelListFiles(sessionId);

  return {
    session_id: sessionId,
    files,
    count: files.length,
  };
}
/* c8 ignore stop */
