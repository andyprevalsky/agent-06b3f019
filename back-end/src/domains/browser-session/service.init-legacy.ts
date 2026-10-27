import type { Browser } from 'playwright';
import type { BrowserProviderSession } from '../../providers/browser/types';
import type { SessionCredentialPayload } from './service.credential-error';
/** Compatibility for pre-patch in-flight browser activities retaining their task ID. */
import { type ProxyGeoLocation, DEFAULT_GEOLOCATION } from '../../providers/geoip';
import { createLogger } from '../../providers/logger';
import {
  getOrCreateContext,
  getFingerprintInjectionData,
  createSessionWithContext,
  closeSession,
} from '../../providers/browser';
import { resolveExitGeoLocale } from '../../providers/browser/exitGeoLocale';
import {
  findRequiredSteelProfileForStart,
  steelProfileForSelectedProvider,
} from './service.profile-binding';
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

interface LegacyCredentials extends SessionCredentialPayload {
  cookies_injected: boolean;
  cookies_count: number;
  auth_source: string;
  auth_credential_ref: unknown;
  browser_state_injection: { fingerprint: { injected: boolean } };
}

interface LegacyInitDependencies<Credentials extends LegacyCredentials, Metadata> {
  prepare: (
    sessionId: string,
    userId: string,
    targetUrl: string,
    options: { browser?: Browser }
  ) => Promise<Credentials>;
  metadata: (
    session: BrowserProviderSession,
    injection: Credentials['browser_state_injection']
  ) => Metadata;
}

/** The credential step: reuses the validation socket and cleans up on failure. */
async function prepareLegacyCredentials<Credentials extends LegacyCredentials>(
  session: BrowserProviderSession,
  userId: string,
  startUrl: string,
  prepare: LegacyInitDependencies<Credentials, unknown>['prepare']
): Promise<Credentials> {
  // Tilion accepts one CDP client: free the validation socket before the
  // response (and before close's harvest) so the next attach is not refused with 4409.
  const releaseTilionValidationSocket = async () => {
    if (session.provider === 'tilion') {
      await session.validationBrowser?.close().catch(() => undefined);
    }
  };
  try {
    return await prepare(session.sessionId, userId, startUrl, {
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

export async function initLegacySession<Credentials extends LegacyCredentials, Metadata>(
  userId: string,
  agentId: string,
  startUrl: string,
  id: string,
  dependencies: LegacyInitDependencies<Credentials, Metadata>
) {
  log.info('Initializing browser session', {
    agentId,
    startUrl: startUrl !== '' ? startUrl : 'none',
  });
  // Phase 1: Fetch session-independent data in parallel. Realm-scoped
  // credentials are collected by the same preparation boundary used for JIT
  // navigation after the provider session exists.
  const [agent, contextId, user, fingerprintInjection, steelBoundProfileId] = await Promise.all([
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

  // A sign-in bound to a Steel profile is shared with the selected provider
  // (harvested once into the provider-neutral stores) instead of forcing Steel.
  const requiredSteelProfileId = await steelProfileForSelectedProvider(
    userId,
    startUrl,
    steelBoundProfileId
  );

  // Phase 2: Create the session while retaining its validation CDP connection.
  const session = await createSessionWithContext(contextId, agentId, proxyGeo, startUrl, {
    keepValidationConnection: true,
    taskId: id,
    ...(requiredSteelProfileId !== null ? { requiredSteelProfileId } : {}),
  });

  const credentials = await prepareLegacyCredentials(
    session,
    userId,
    startUrl,
    dependencies.prepare
  );
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
    // Tilion never localises its exit: the user's zone if it is in the exit country, else the country's.
    ...(session.provider === 'tilion'
      ? (({ fingerprint, exitGeoLocale }) => ({
          fingerprint_injection: fingerprint,
          exit_geo_locale: exitGeoLocale,
        }))(resolveExitGeoLocale(fingerprintInjection, proxyGeo.country))
      : { fingerprint_injection: fingerprintInjection }),
    passwords: credentials.passwords,
    passkeys: credentials.passkeys,
    user_settings: userSettings,
  };
}
