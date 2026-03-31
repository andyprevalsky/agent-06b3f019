/**
 * Browser-session domain service — business logic, no req/res.
 */

import { type ProxyGeoLocation, DEFAULT_GEOLOCATION } from '../../providers/geoip';
import { createLogger } from '../../providers/logger';
import {
  getOrCreateContext,
  createSessionWithContext,
  closeSession as steelCloseSession,
  resumeSession as steelResumeSession,
  getSession as steelGetSession,
  injectUserData,
  uploadFileToSession as steelUploadFile,
  listSessionFiles as steelListFiles,
  getFingerprintInjectionData,
} from '../../providers/steel';
import * as repo from './repo';
import { SessionNoWsUrlError, type SerializedPassword, type UserSettings } from './types';
import { injectLocalStorageViaCdp } from './service.cdp';

const log = createLogger('BrowserSession');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize BigInt dateLastUsed to number for JSON.
 */
function serializePasswords(
  passwords: Array<{
    origin: string;
    username: string;
    encryptedPassword: string;
    dateLastUsed: bigint | null;
  }>
): SerializedPassword[] {
  return passwords.map((p) => ({
    origin: p.origin,
    username: p.username,
    encryptedPassword: p.encryptedPassword,
    dateLastUsed: p.dateLastUsed !== null ? Number(p.dateLastUsed) : null,
  }));
}

/**
 * Map a user DB row to UserSettings or null.
 */
function toUserSettings(
  user: {
    name: string | null;
    phone: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
    encryptedPaymentInformation: string | null;
    systemName: string | null;
    profilePicture: string | null;
    customSystemPrompt: string | null;
  } | null
): UserSettings | null {
  if (!user) return null;
  return {
    name: user.name,
    phone: user.phone,
    addressLine1: user.addressLine1,
    addressLine2: user.addressLine2,
    city: user.city,
    state: user.state,
    postalCode: user.postalCode,
    country: user.country,
    encryptedPaymentInformation: user.encryptedPaymentInformation,
    systemName: user.systemName,
    profilePicture: user.profilePicture,
    customSystemPrompt: user.customSystemPrompt,
  };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

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
    agent !== null && agent !== undefined && agent.proxyCountry !== null && agent.proxyCountry !== ''
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
    cookies_injected: injectionResult.cookies.injected,
    cookies_count: injectionResult.cookies.cookieCount,
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

export async function resumeBrowserSession(taskId: string) {
  log.info('Resuming browser task', { taskId });

  const result = await steelResumeSession(taskId);

  // Get user_id from the session's context
  const session = await repo.findSessionByTaskId(taskId);

  // Inject cookies and fingerprint into resumed session
  let injectionResult = {
    cookies: { injected: false, cookieCount: 0 },
    fingerprint: { injected: false },
  };
  let fingerprintInjection = null;
  if (
    session !== null &&
    session !== undefined &&
    session.context?.userId !== null &&
    session.context?.userId !== undefined
  ) {
    if (result.savedUrl !== null && result.savedUrl !== undefined && result.savedUrl !== '') {
      injectionResult = await injectUserData(
        result.sessionId,
        session.context.userId,
        result.savedUrl
      );
    }
    fingerprintInjection = await getFingerprintInjectionData(session.context.userId);
  }

  return {
    task_id: taskId,
    session_id: result.sessionId,
    debug_url: result.debugUrl,
    ws_url: result.wsUrl,
    saved_url: result.savedUrl,
    status: 'ACTIVE' as const,
    cookies_injected: injectionResult.cookies.injected,
    cookies_count: injectionResult.cookies.cookieCount,
    fingerprint_injected: injectionResult.fingerprint.injected,
    fingerprint_injection: fingerprintInjection,
  };
}

// ---------------------------------------------------------------------------
// Get task info
// ---------------------------------------------------------------------------

export async function getTaskInfo(taskId: string) {
  const session = await repo.findSessionByTaskId(taskId);

  if (!session) {
    return null;
  }

  let fingerprintInjection = null;
  let serializedPasswords: SerializedPassword[] = [];

  if (session.context?.userId) {
    fingerprintInjection = await getFingerprintInjectionData(session.context.userId);

    const passwords = await repo.findPasswords(session.context.userId);
    serializedPasswords = serializePasswords(passwords);
  }

  return {
    task_id: session.id,
    session_id: session.sessionId,
    debug_url: session.debugUrl,
    ws_url: session.wsUrl,
    status: session.status,
    fingerprint_injection: fingerprintInjection,
    passwords: serializedPasswords,
  };
}

// ---------------------------------------------------------------------------
// Get context
// ---------------------------------------------------------------------------

export async function getContext(userId: string) {
  return repo.findContextByUserId(userId);
}

// ---------------------------------------------------------------------------
// Get session by Steel ID
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Inject localStorage
// ---------------------------------------------------------------------------

export class SessionNotFoundError extends Error {
  constructor() {
    super('Session not found');
    this.name = 'SessionNotFoundError';
  }
}

export class SessionNoUserError extends Error {
  constructor() {
    super('Session has no associated user');
    this.name = 'SessionNoUserError';
  }
}

export { CdpInjectionError, SessionNoWsUrlError } from './types';

export async function injectLocalStorage(sessionId: string, origin: string) {
  log.info('Inject localStorage request', { sessionId, origin });

  // 1. Get session with context to find userId
  const session = await repo.findSessionBySessionId(sessionId);

  if (!session) {
    throw new SessionNotFoundError();
  }

  if (!session.context?.userId) {
    throw new SessionNoUserError();
  }

  const userId = session.context.userId;

  // 2. Get localStorage for this specific origin (O(1) indexed lookup)
  const originData = await repo.findLocalStorageOrigin(userId, origin);

  if (!originData) {
    log.info('No localStorage data for origin', { origin });
    return { injected: false, reason: 'no_data_for_origin' as const, count: 0 };
  }

  const entries = originData.entries as { key: string; value: string }[];
  const currentHash = originData.hash;

  if (entries.length === 0) {
    log.info('No localStorage entries for origin', { origin });
    return { injected: false, reason: 'no_data_for_origin' as const, count: 0 };
  }

  // 3. Check if already injected with same hash
  const injectedOrigins =
    (session.injectedOrigins as Record<string, string> | null) ?? {};
  const injectedHash: string | undefined = injectedOrigins[origin];

  if (injectedHash !== undefined && injectedHash === currentHash) {
    log.info('Origin already injected with same hash, skipping', { origin });
    return { injected: false, reason: 'already_injected' as const, count: entries.length };
  }

  // 4. Inject via CDP
  if (session.wsUrl === null || session.wsUrl === undefined || session.wsUrl === '') {
    throw new SessionNoWsUrlError();
  }

  await injectLocalStorageViaCdp(session.wsUrl, entries, origin);

  // 5. Update session with injected origin and hash
  const updatedInjectedOrigins = {
    ...injectedOrigins,
    [origin]: currentHash !== null && currentHash !== undefined && currentHash !== '' ? currentHash : 'unknown',
  };

  await repo.updateInjectedOrigins(sessionId, updatedInjectedOrigins);

  log.info('Updated session injectedOrigins', { origin });

  return {
    injected: true,
    reason: injectedHash ? ('data_changed' as const) : ('first_injection' as const),
    count: entries.length,
  };
}
