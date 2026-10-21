import type { prepareSessionCredentials, buildBrowserSessionMetadata } from './service';
/** Compatibility for pre-patch in-flight browser activities retaining their task ID. */
import { type ProxyGeoLocation, DEFAULT_GEOLOCATION } from '../../providers/geoip';
import { createLogger } from '../../providers/logger';
import {
  getOrCreateContext,
  getFingerprintInjectionData,
  createSessionWithContext,
  closeSession,
} from '../../providers/browser';
import { findRequiredSteelProfileForStart } from './service.profile-binding';
import { toUserSettings } from './service.serializers';
import * as repo from './repo';
const log = createLogger('BrowserSessionLegacyInit');
function legacyProxyLocation(
  agent: Awaited<ReturnType<typeof repo.findAgentProxy>>
): ProxyGeoLocation {
  return agent !== null &&
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
}

export async function initLegacySession(
  userId: string,
  agentId: string,
  startUrl: string,
  id: string,
  dependencies: {
    prepare: typeof prepareSessionCredentials;
    metadata: typeof buildBrowserSessionMetadata;
  }
) {
  log.info('Initializing browser session', {
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

  const proxyGeo = legacyProxyLocation(agent);
  log.info('Using proxy location', {
    city: proxyGeo.city ?? 'unknown',
    state: proxyGeo.state ?? 'unknown',
    country: proxyGeo.country,
  });

  // Phase 2: Create the session while retaining its validation CDP connection.
  const session = await createSessionWithContext(contextId, agentId, proxyGeo, startUrl, {
    keepValidationConnection: true,
    taskId: id,
    ...(requiredSteelProfileId !== null ? { requiredSteelProfileId } : {}),
  });

  let credentials: Awaited<ReturnType<typeof dependencies.prepare>>;
  try {
    credentials = await dependencies.prepare(session.sessionId, userId, startUrl, {
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
    browser_session_metadata: dependencies.metadata(session, credentials.browser_state_injection),
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
