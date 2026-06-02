import { prisma } from '../database';
import { type ProxyGeoLocation, DEFAULT_GEOLOCATION } from '../geoip';
import { SteelRateLimitError, type FingerprintData, log } from './types';
import {
  MAX_SESSION_RETRIES,
  buildSteelProxySettings,
  envEnabled,
  rememberBenchmarkAnonSteelProfile,
  resolveSteelProfileForSession,
  steel,
} from './session';
import { validateSessionConnection } from './sessionConnection';

function hasValue(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== '';
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

async function navigateToSavedUrl(wsUrl: string, savedUrl: string | null): Promise<void> {
  if (!hasValue(savedUrl)) return;

  log.info(`  Navigating session to saved URL: ${savedUrl}`);
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(wsUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    await page.goto(savedUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    log.info('  Navigation complete');
    await browser.close();
  } catch (navError) {
    log.error('Failed to navigate to saved URL', {
      error: navError instanceof Error ? navError.message : String(navError),
    });
  }
}

export async function resumeSession(taskId: string): Promise<{
  debugUrl: string;
  sessionId: string;
  wsUrl: string;
  savedUrl?: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  steelProfileId: string | null;
  profileSource: string;
}> {
  log.info(`Resuming browser task ${taskId}...`);
  const oldSession = await prisma.browserSession.findUnique({
    where: { id: taskId },
    include: { context: true },
  });

  if (oldSession === null) {
    throw new Error(`Browser task not found: ${taskId}`);
  }

  log.info(`  Found old session with currentUrl: ${oldSession.currentUrl ?? 'NONE'}`);
  const proxyGeo = await proxyLocationForAgent(oldSession.agentId);
  log.info(`  Using proxy location: ${proxyGeo.city}, ${proxyGeo.state}, ${proxyGeo.country}`);
  const userAgent = await fingerprintUserAgent(oldSession.context.userId);
  if (userAgent !== undefined) {
    log.info(`  Using user's fingerprint User-Agent: ${userAgent.substring(0, 60)}...`);
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_SESSION_RETRIES; attempt++) {
    log.info(`  Resume session attempt ${attempt}/${MAX_SESSION_RETRIES}...`);
    try {
      const proxySettings = buildSteelProxySettings(proxyGeo);
      const profile = resolveSteelProfileForSession(
        oldSession.agentId,
        oldSession.context.contextId
      );
      const session = await steel.sessions.create({
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

      log.info(`  Created new Steel session: ${session.id}`);
      rememberBenchmarkAnonSteelProfile(oldSession.agentId, session.profileId);
      const debugUrl = `${session.debugUrl}?interactive=false`;
      const wsUrl = `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`;

      if (!(await validateSessionConnection(wsUrl))) {
        log.info(`  Session ${session.id} failed validation, releasing...`);
        try {
          await steel.sessions.release(session.id);
        } catch (releaseErr) {
          log.info(`  Failed to release invalid session: ${releaseErr}`);
        }
        lastError = new Error(`Session validation failed on attempt ${attempt}`);
        continue;
      }

      await navigateToSavedUrl(wsUrl, oldSession.currentUrl);
      await prisma.browserSession.update({
        where: { id: taskId },
        data: { sessionId: session.id, debugUrl, wsUrl, status: 'ACTIVE', closedAt: null },
      });

      log.info(`Task resumed with new session ${session.id}`);
      const savedUrl = hasValue(oldSession.currentUrl)
        ? oldSession.currentUrl
        : hasValue(oldSession.startUrl)
          ? oldSession.startUrl
          : undefined;
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
      };
    } catch (error) {
      const status =
        (error as Record<string, unknown>)?.status ??
        (error as Record<string, unknown>)?.statusCode;
      if (status === 429) {
        const msg = error instanceof Error ? error.message : 'Steel session rate limit exceeded';
        log.info(`  Steel rate limit (429): ${msg}`);
        throw new SteelRateLimitError(msg);
      }
      log.info(
        `  Attempt ${attempt} failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      lastError = error instanceof Error ? error : new Error('Unknown error');
    }
  }

  throw new Error(
    `Failed to resume session after ${MAX_SESSION_RETRIES} attempts: ${lastError?.message}`
  );
}
