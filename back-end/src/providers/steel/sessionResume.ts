import type SteelSDK from 'steel-sdk';
import type { Browser } from 'playwright';
import { prisma } from '../database';
import { type ProxyGeoLocation, DEFAULT_GEOLOCATION } from '../geoip';
import { getProviderProfile, rememberProviderProfile } from '../browser/context';
import { INVALIDATED_STEEL_PROFILE_SOURCE } from '../browser/profileBinding';
import type { BrowserProviderName } from '../browser/types';
import { SteelRateLimitError, type FingerprintData, log } from './types';
import {
  MAX_SESSION_RETRIES,
  SteelSessionCleanupError,
  buildSteelProxySettings,
  envEnabled,
  isInvalidSteelProxyConfiguration,
  isKnownRejectedProxyCity,
  releaseSteelRemoteSession,
  rememberRejectedProxyCity,
  rememberBenchmarkAnonSteelProfile,
  resolveSteelProfileForSession,
  steel,
  steelCdpUrl,
  steelDebugUrl,
} from './session';
import { validateSessionConnection } from './sessionConnection';
import { steelCdpConnectionUrl } from './urls';

function hasValue(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== '';
}

/**
 * The recorded provider profile id that Steel may legitimately reload.
 *
 * Only a prior STEEL session's recorded profile is a valid Steel profile id.
 * On a provider switch (e.g. the rotate ladder's Kernel → Steel rung) the
 * recorded providerProfileId belongs to the other provider — a non-UUID Kernel
 * profile — which Steel rejects with "400 profileId must be a valid UUID".
 * Returns null for any non-Steel-origin or unrecorded profile so the caller
 * falls back to the context's Steel-native persisted profile (or none).
 */
export function reusableSteelRecordedProfileId(oldSession: {
  provider: string;
  providerProfileId?: string | null;
  providerProfileSource?: string | null;
}): string | null {
  const wasSteel = oldSession.provider !== 'kernel';
  return wasSteel &&
    oldSession.providerProfileSource !== INVALIDATED_STEEL_PROFILE_SOURCE &&
    typeof oldSession.providerProfileId === 'string' &&
    oldSession.providerProfileId !== ''
    ? oldSession.providerProfileId
    : null;
}

class ConcurrentSessionReplacementError extends Error {
  constructor(taskId: string) {
    super(`Browser session changed concurrently while recreating task ${taskId}`);
    this.name = 'ConcurrentSessionReplacementError';
  }
}

async function proxyLocationForAgent(agentId: string | null): Promise<ProxyGeoLocation> {
  if (!hasValue(agentId)) return DEFAULT_GEOLOCATION;

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { proxyCountry: true, proxyState: true, proxyCity: true },
  });
  if (!hasValue(agent?.proxyCountry)) return DEFAULT_GEOLOCATION;

  return {
    country: agent.proxyCountry,
    ...(hasValue(agent.proxyState) ? { state: agent.proxyState } : {}),
    ...(hasValue(agent.proxyCity) ? { city: agent.proxyCity } : {}),
  };
}

async function fingerprintUserAgent(userId: string): Promise<string | undefined> {
  const fingerprint = await prisma.integration.findUnique({
    where: { userId_name: { userId, name: 'browser_fingerprint' } },
  });
  const fp = (fingerprint?.config as { fingerprint?: FingerprintData } | null)?.fingerprint;
  return hasValue(fp?.navigator?.userAgent) ? fp.navigator.userAgent : undefined;
}

async function connectSteelBrowser(wsUrl: string): Promise<Browser> {
  const { chromium } = await import('playwright');
  return chromium.connectOverCDP(steelCdpConnectionUrl(wsUrl));
}

export async function navigateToSavedUrl(
  wsUrl: string,
  savedUrl: string | undefined,
  connectBrowser: (url: string) => Promise<Browser> = connectSteelBrowser
): Promise<void> {
  if (!hasValue(savedUrl)) return;

  log.info(`  Navigating session to saved URL: ${savedUrl}`);
  let browser: Browser | undefined;
  try {
    browser = await connectBrowser(wsUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(savedUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    log.info('  Navigation complete');
  } catch (navError) {
    log.error('Failed to navigate to saved URL', {
      error: navError instanceof Error ? navError.message : String(navError),
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export interface RecreatedSteelSession {
  debugUrl: string;
  sessionId: string;
  wsUrl: string;
  savedUrl?: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  steelProfileId: string | null;
  profileSource: string;
  previousSessionId: string;
  previousProvider: BrowserProviderName;
}

export interface SteelSessionReplacementDependencies {
  createSession: (input: SteelSDK.SessionCreateParams) => Promise<{
    id: string;
    debugUrl: string;
    profileId?: string | null;
    proxySource?: string | null;
  }>;
  validateConnection: (wsUrl: string) => Promise<boolean>;
  releaseSession?: (sessionId: string) => Promise<void>;
}

const defaultReplacementDependencies: SteelSessionReplacementDependencies = {
  createSession: async (input) => steel.sessions.create(input),
  validateConnection: validateSessionConnection,
};

export async function recreateSession(
  taskId: string,
  options: { forceManagedRotation: boolean; forceFreshProfile?: boolean },
  dependencies: SteelSessionReplacementDependencies = defaultReplacementDependencies
): Promise<RecreatedSteelSession> {
  const operation = options.forceManagedRotation ? 'Rotating' : 'Resuming';
  log.info(`${operation} browser task ${taskId} on Steel...`);
  const oldSession = await prisma.browserSession.findUnique({
    where: { id: taskId },
    include: { context: true },
  });

  if (oldSession === null) throw new Error(`Browser task not found: ${taskId}`);

  const previousProvider: BrowserProviderName =
    oldSession.provider === 'kernel' ? 'kernel' : 'steel';
  const savedUrl = hasValue(oldSession.currentUrl)
    ? oldSession.currentUrl
    : hasValue(oldSession.startUrl)
      ? oldSession.startUrl
      : undefined;
  log.info(`  Found old session with saved URL: ${savedUrl ?? 'NONE'}`);
  const proxyGeo = await proxyLocationForAgent(oldSession.agentId);
  log.info(`  Using proxy location: ${proxyGeo.city}, ${proxyGeo.state}, ${proxyGeo.country}`);
  const userAgent = await fingerprintUserAgent(oldSession.context.userId);
  const steelRecordedProfileId = options.forceFreshProfile
    ? null
    : reusableSteelRecordedProfileId(oldSession);
  const persistedProfileId =
    steelRecordedProfileId ??
    (options.forceFreshProfile ? null : await getProviderProfile(oldSession.contextId, 'steel'));
  const boundProfile =
    steelRecordedProfileId !== null
      ? {
          profileId: steelRecordedProfileId,
          profileSource: oldSession.providerProfileSource ?? 'session_bound',
          persistProfile: oldSession.providerProfilePersist ?? true,
        }
      : undefined;
  let dropProxyCity = isKnownRejectedProxyCity(proxyGeo);

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_SESSION_RETRIES; attempt++) {
    log.info(`  Steel session attempt ${attempt}/${MAX_SESSION_RETRIES}...`);
    let createdSessionId: string | null = null;
    let committed = false;
    try {
      const proxySettings = buildSteelProxySettings(
        proxyGeo,
        dropProxyCity,
        options.forceManagedRotation
      );
      const profile = resolveSteelProfileForSession(
        options.forceFreshProfile ? null : oldSession.agentId,
        persistedProfileId,
        null,
        boundProfile
      );
      const session = await dependencies.createSession({
        profileId: profile.profileId,
        persistProfile: profile.persistProfile,
        userAgent:
          userAgent !== undefined && envEnabled('BROWSER_AGENT_STEEL_USER_AGENT_ENABLED', true)
            ? userAgent
            : undefined,
        useProxy: proxySettings.config,
        solveCaptcha: envEnabled('BROWSER_AGENT_STEEL_CAPTCHA_SOLVER_ENABLED', true),
        debugConfig: { systemCursor: false },
        stealthConfig: { humanizeInteractions: false, skipFingerprintInjection: true },
        timeout: 900000,
        dimensions: { width: 1288, height: 891 },
      });
      createdSessionId = session.id;

      if (profile.profileId !== undefined && session.profileId !== profile.profileId) {
        throw new Error(
          `Steel loaded profile ${session.profileId ?? 'NONE'} instead of bound profile ${profile.profileId}`
        );
      }

      log.info(`  Created new Steel session: ${session.id}`);
      if (profile.profileSource.startsWith('benchmark_anon')) {
        rememberBenchmarkAnonSteelProfile(oldSession.agentId, session.profileId);
      }
      const debugUrl = steelDebugUrl(session.debugUrl);
      const wsUrl = steelCdpUrl(session.id);

      if (!(await dependencies.validateConnection(wsUrl))) {
        throw new Error(`Session validation failed on attempt ${attempt}`);
      }

      await navigateToSavedUrl(wsUrl, savedUrl);
      const replaced = await prisma.browserSession.updateMany({
        where: { id: taskId, sessionId: oldSession.sessionId },
        data: {
          sessionId: session.id,
          debugUrl,
          wsUrl,
          status: 'ACTIVE',
          closedAt: null,
          provider: 'steel',
          providerProfileId: session.profileId ?? profile.profileId ?? null,
          providerProfileSource: profile.profileSource,
          providerProfilePersist: profile.persistProfile,
          ...(options.forceManagedRotation ? { proxyTier: 'residential' } : {}),
        },
      });
      if (replaced.count !== 1) throw new ConcurrentSessionReplacementError(taskId);
      committed = true;

      if (
        profile.persistProfile &&
        session.profileId &&
        !profile.profileSource.startsWith('benchmark_anon')
      ) {
        await rememberProviderProfile(oldSession.contextId, 'steel', session.profileId).catch(
          (profileError) => {
            log.warn('Failed to persist Steel provider profile after session replacement', {
              taskId,
              profileId: session.profileId,
              error: profileError instanceof Error ? profileError.message : String(profileError),
            });
          }
        );
      }

      log.info(`Task moved to Steel session ${session.id}`);
      return {
        debugUrl,
        sessionId: session.id,
        wsUrl,
        savedUrl,
        proxySource:
          (session as { proxySource?: string | null }).proxySource ?? proxySettings.source,
        proxyLocation: proxyGeo,
        steelProfileId: session.profileId ?? profile.profileId ?? null,
        profileSource: profile.profileSource,
        previousSessionId: oldSession.sessionId,
        previousProvider,
      };
    } catch (error) {
      if (!committed && createdSessionId !== null) {
        const uncommittedSessionId = createdSessionId;
        try {
          await (dependencies.releaseSession ?? releaseSteelRemoteSession)(uncommittedSessionId);
          createdSessionId = null;
        } catch (releaseError) {
          throw new SteelSessionCleanupError(uncommittedSessionId, releaseError);
        }
      }
      if (error instanceof ConcurrentSessionReplacementError) throw error;

      const status =
        (error as Record<string, unknown>)?.status ??
        (error as Record<string, unknown>)?.statusCode;
      if (status === 429) {
        const message =
          error instanceof Error ? error.message : 'Steel session rate limit exceeded';
        throw new SteelRateLimitError(message);
      }
      lastError = error instanceof Error ? error : new Error('Unknown error');
      log.info(`  Steel session attempt ${attempt} failed: ${lastError.message}`);
      if (!dropProxyCity && isInvalidSteelProxyConfiguration(error)) {
        dropProxyCity = true;
        rememberRejectedProxyCity(proxyGeo);
        log.info('  Dropping unsupported Steel proxy city during replacement retry');
      }
    }
  }

  throw new Error(
    `Failed to create Steel replacement after ${MAX_SESSION_RETRIES} attempts: ${lastError?.message}`
  );
}

export async function resumeSession(
  taskId: string,
  options: { forceFreshProfile?: boolean } = {}
): Promise<RecreatedSteelSession> {
  return recreateSession(taskId, {
    forceManagedRotation: false,
    forceFreshProfile: options.forceFreshProfile,
  });
}

export async function rotateSession(taskId: string): Promise<RecreatedSteelSession> {
  return recreateSession(taskId, { forceManagedRotation: true });
}
