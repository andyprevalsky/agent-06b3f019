/**
 * Browser-session domain service — business logic, no req/res.
 */

import type { Browser } from 'playwright';
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
import {
  rotateBrowserProxy,
  ProxyRotationExhaustedError,
  RotationSessionNotFoundError,
} from '../../providers/browserSessionResume';
import { canonicalAuthRealm } from '../../providers/authRealm';
import { getAuthOptions } from '../../providers/authOptions';
import * as repo from './repo';
import { validateSessionFilePath } from './service.file-path';
import { findRequiredSteelProfileForStart } from './service.profile-binding';
import {
  injectLocalStorage,
  SessionNoUserError,
  SessionNotFoundError,
} from './service.local-storage';
import { serializePasskeys, serializePasswords, toUserSettings } from './service.serializers';
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

  const enabledPasswordIds = new Set(
    authOptions.passwords.filter((password) => !password.disabled).map((password) => password.id)
  );
  const passwords = storedPasswords.filter((password) => enabledPasswordIds.has(password.id));
  const returnedPasswordIds = new Set(passwords.map((password) => password.id));
  const missingPasswordIds = [...enabledPasswordIds].filter((id) => !returnedPasswordIds.has(id));

  const enabledPasskeyIds = new Set(
    authOptions.passkeys.filter((passkey) => !passkey.disabled).map((passkey) => passkey.id)
  );
  const returnedPasskeyIds = new Set(passkeys.map((passkey) => passkey.id));
  const missingPasskeyIds = [...enabledPasskeyIds].filter((id) => !returnedPasskeyIds.has(id));

  if (missingPasswordIds.length > 0 || missingPasskeyIds.length > 0) {
    throw new Error(
      `Credential payload incomplete for ${authRealm}: ` +
        `missing passwords [${missingPasswordIds.join(', ')}], ` +
        `missing passkeys [${missingPasskeyIds.join(', ')}]`
    );
  }

  const injectionResult = await injectUserData(sessionId, userId, targetUrl, options);

  return {
    auth_realm: authRealm,
    auth_options: authOptions,
    auth_credential_ref: injectionResult.cookies.credentialRef,
    cookies_injected: injectionResult.cookies.injected,
    cookies_count: injectionResult.cookies.cookieCount,
    auth_source: injectionResult.cookies.authSource,
    browser_state_injection: injectionResult,
    passwords: serializePasswords(passwords),
    passkeys: serializePasskeys(passkeys),
  };
}

/* c8 ignore start -- initSession, closeBrowserSession, resumeBrowserSession require Steel SDK */
export async function initSession(userId: string, agentId: string, startUrl: string) {
  log.info('Initializing browser session', {
    userId,
    agentId,
    startUrl: startUrl !== '' ? startUrl : 'none',
  });

  // Phase 1: Fetch session-independent data in parallel. Realm-scoped
  // credentials are collected by the same preparation boundary used for JIT
  // navigation after the provider session exists.
  const [agent, contextId, user, fingerprintInjection, requiredSteelProfileId] = await Promise.all([
    repo.findAgentProxy(agentId),
    getOrCreateContext(userId),
    repo.findUserSettings(userId),
    getFingerprintInjectionData(userId),
    findRequiredSteelProfileForStart(userId, startUrl),
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
    ...(requiredSteelProfileId !== null ? { requiredSteelProfileId } : {}),
  });

  // Phase 3: Resolve and inject every credential/state type for the start realm.
  let credentials: Awaited<ReturnType<typeof prepareSessionCredentials>>;
  try {
    credentials = await prepareSessionCredentials(session.sessionId, userId, startUrl, {
      browser: session.validationBrowser ?? undefined,
    });
  } catch (error) {
    await closeSession(session.sessionId, false).catch((cleanupError) => {
      log.error('Failed to clean up browser after credential preparation error', {
        sessionId: session.sessionId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    });
    throw error;
  }
  const userSettings = toUserSettings(user);

  log.info('Including passwords in init response', { count: credentials.passwords.length });
  if (credentials.passkeys.length > 0) {
    log.info('Including passkeys in init response', {
      count: credentials.passkeys.length,
      realm: credentials.auth_realm,
    });
  }

  return {
    task_id: session.taskId,
    context_id: contextId,
    session_id: session.sessionId,
    debug_url: session.debugUrl,
    ws_url: session.wsUrl,
    browser_session_metadata: buildBrowserSessionMetadata(
      session,
      credentials.browser_state_injection
    ),
    cookies_injected: credentials.cookies_injected,
    cookies_count: credentials.cookies_count,
    auth_source: credentials.auth_source,
    auth_credential_ref: credentials.auth_credential_ref,
    auth_options: credentials.auth_options,
    auth_realm: credentials.auth_realm,
    fingerprint_injected: credentials.browser_state_injection.fingerprint.injected,
    fingerprint_injection: fingerprintInjection,
    passwords: credentials.passwords,
    passkeys: credentials.passkeys,
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
/* c8 ignore stop */
