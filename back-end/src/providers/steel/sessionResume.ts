import type SteelSDK from 'steel-sdk';
import { prisma } from '../database';
import { type ProxyGeoLocation, DEFAULT_GEOLOCATION } from '../geoip';
import { getProviderProfile, rememberProviderProfile } from '../browser/context';
import type { BrowserProviderName } from '../browser/types';
import { SteelRateLimitError, type FingerprintData, log } from './types';
import {
  MAX_SESSION_RETRIES,
  buildSteelProxySettings,
  envEnabled,
  isInvalidSteelProxyConfiguration,
  isKnownRejectedProxyCity,
  releaseSteelRemoteSession,
  rememberRejectedProxyCity,
  rememberBenchmarkAnonSteelProfile,
  resolveSteelProfileForSession,
  steel,
} from './session';
import { validateSessionConnection } from './sessionConnection';

function hasValue(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== '';
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

async function navigateToSavedUrl(wsUrl: string, savedUrl: string | undefined): Promise<void> {
  if (!hasValue(savedUrl)) return;

  log.info(`  Navigating session to saved URL: ${savedUrl}`);
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(wsUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(savedUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    log.info('  Navigation complete');
    await browser.close();
  } catch (navError) {
    log.error('Failed to navigate to saved URL', {
      error: navError instanceof Error ? navError.message : String(navError),
    });
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
}

const defaultReplacementDependencies: SteelSessionReplacementDependencies = {
  createSession: async (input) => steel.sessions.create(input),
  validateConnection: validateSessionConnection,
};

export async function recreateSession(
  taskId: string,
  options: { forceManagedRotation: boolean },
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
  const persistedProfileId = await getProviderProfile(oldSession.contextId, 'steel');
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
      const profile = resolveSteelProfileForSession(oldSession.agentId, persistedProfileId);
      const session = await dependencies.createSession({
        profileId: profile.profileId,
        persistProfile: envEnabled('BROWSER_AGENT_STEEL_PROFILE_ENABLED', true),
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

      log.info(`  Created new Steel session: ${session.id}`);
      rememberBenchmarkAnonSteelProfile(oldSession.agentId, session.profileId);
      const debugUrl = `${session.debugUrl}?interactive=false`;
      const wsUrl = `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`;

      if (!(await dependencies.validateConnection(wsUrl))) {
        await releaseSteelRemoteSession(session.id).catch((releaseError) => {
          log.warn('Failed to release invalid Steel session', {
            sessionId: session.id,
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          });
        });
        createdSessionId = null;
        lastError = new Error(`Session validation failed on attempt ${attempt}`);
        continue;
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
          ...(options.forceManagedRotation ? { proxyTier: 'residential' } : {}),
        },
      });
      if (replaced.count !== 1) throw new ConcurrentSessionReplacementError(taskId);
      committed = true;

      if (session.profileId && !profile.profileSource.startsWith('benchmark_anon')) {
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
        await releaseSteelRemoteSession(createdSessionId).catch((releaseError) => {
          log.warn('Failed to release uncommitted Steel replacement session', {
            sessionId: createdSessionId,
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          });
        });
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

export async function resumeSession(taskId: string): Promise<RecreatedSteelSession> {
  return recreateSession(taskId, { forceManagedRotation: false });
}

export async function rotateSession(taskId: string): Promise<RecreatedSteelSession> {
  return recreateSession(taskId, { forceManagedRotation: true });
}
