/**
 * Steel session management — create, close, resume, validate.
 */

import Steel from 'steel-sdk';
import type { Browser } from 'playwright';
import { prisma } from '../database';
import { logJson } from '../../utils/log';
import { type ProxyGeoLocation, DEFAULT_GEOLOCATION } from '../geoip';
import { retryWithBackoff } from '../retry';
import { SteelRateLimitError, type FingerprintData, log } from './types';
import { createLocalBrowserSession, connectValidatedBrowser } from './sessionConnection';
import { STEEL_API_BASE_URL, steelCdpUrl, steelDebugUrl } from './urls';
import { benchmarkIsolatedBrowserProfilesEnabled } from '../browser/benchmarkProfileIsolation';
export { resumeSession } from './sessionResume';
export {
  STEEL_API_BASE_URL,
  STEEL_CDP_BASE_URL,
  steelApiUrl,
  steelCdpConnectionUrl,
  steelCdpUrl,
  steelDebugUrl,
  steelSessionFileUrl,
  steelPublicCdpUrl,
} from './urls';

export const steel = new Steel({
  steelAPIKey: process.env.STEEL_API_KEY,
  baseURL: STEEL_API_BASE_URL,
});

// Max retries when session validation fails
export const MAX_SESSION_RETRIES = 3;

export class SteelSessionCleanupError extends Error {
  constructor(sessionId: string, cause: unknown) {
    super(
      `Failed to release Steel session ${sessionId} after bounded retries: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = 'SteelSessionCleanupError';
  }
}

const benchmarkAnonProfilesByAgent = new Map<string, string>();

export function envEnabled(name: string, defaultValue = true): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return !['0', 'false', 'no', 'off', 'disabled'].includes(raw.trim().toLowerCase());
}

function benchmarkAnonSteelProfileEnabled(): boolean {
  return (
    benchmarkIsolatedBrowserProfilesEnabled() ||
    ['1', 'true', 'yes'].includes(
      (process.env.BENCHMARK_ANON_STEEL_PROFILE ?? '').trim().toLowerCase()
    )
  );
}

export function resolveSteelProfileForSession(
  agentId: string | null,
  persistedProfileId: string | null
) {
  if (!envEnabled('BROWSER_AGENT_STEEL_PROFILE_ENABLED', true)) {
    return {
      profileId: undefined,
      profileSource: 'disabled',
    } as const;
  }

  if (!benchmarkAnonSteelProfileEnabled()) {
    return {
      profileId: persistedProfileId ?? undefined,
      profileSource: persistedProfileId ? 'user_persistent' : 'new_user_persistent',
    } as const;
  }

  const benchmarkProfileId =
    agentId === null ? undefined : benchmarkAnonProfilesByAgent.get(agentId);
  return {
    profileId: benchmarkProfileId,
    profileSource: benchmarkProfileId ? 'benchmark_anon_persistent' : 'benchmark_anon_fresh',
  } as const;
}

export function rememberBenchmarkAnonSteelProfile(
  agentId: string | null,
  profileId: string | null | undefined
) {
  if (agentId === null || !benchmarkAnonSteelProfileEnabled() || !profileId) return;
  if (!benchmarkAnonProfilesByAgent.has(agentId)) {
    benchmarkAnonProfilesByAgent.set(agentId, profileId);
    log.info(`  🧪 Captured benchmark anon Steel profileId for agent ${agentId}: ${profileId}`);
  }
}

interface SteelSessionResult {
  id: string;
  debugUrl: string;
  profileId?: string | null;
  proxySource?: string | null;
}

interface SteelSessionHealth {
  sessionId: string;
  status: string | null;
  createdAt: string | null;
  timeoutMs: number | null;
  expiresAt: string | null;
  ttlMs: number | null;
  profileId: string | null;
}

interface SteelSessionCookieSummary {
  sessionId: string;
  authRealm: string;
  cookieCount: number;
  checkedAt: string;
}

type SteelProxyConfig =
  | false
  | { server: string }
  // Steel Dedicated IPs: { type: 'fixed' } lets Steel pick one of our leased
  // IPs and — with persistProfile — pin it to the profile, so each user keeps a
  // stable egress IP across sessions. An explicit id pins a specific IP.
  | { type: 'fixed'; id?: string }
  | {
      geolocation: {
        country: string;
        state?: string;
        city?: string;
      };
    };

type SteelProxySettings = {
  config: SteelProxyConfig;
  source: 'none' | 'steel' | 'byop' | 'dedicated';
};

function redactProxyServerForLog(server: string): string {
  try {
    const url = new URL(server);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '<invalid proxy URL>';
  }
}

// Cities Steel has already rejected with "400 Invalid proxy configuration".
// Steel only has residential proxies in a subset of cities; without this cache
// every session for an affected user burns ~0.5-4s on a guaranteed-failing
// create attempt before the dropCity retry succeeds. The cache is per-process
// (re-learned after each deploy), so known-bad cities can be seeded via
// STEEL_REJECTED_PROXY_CITIES="US|CA|SAN FRANCISCO,US|NY|NEW YORK" to skip
// even the first-request penalty. Advisory only — it never drops country/state.
const rejectedProxyCities = new Set<string>(
  (process.env.STEEL_REJECTED_PROXY_CITIES ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.split('|').length === 3 && entry.split('|')[2] !== '')
);

export function proxyCityKey(geolocation: ProxyGeoLocation): string {
  return `${geolocation.country}|${geolocation.state ?? ''}|${geolocation.city ?? ''}`.toLowerCase();
}

export function isKnownRejectedProxyCity(geolocation: ProxyGeoLocation): boolean {
  return geolocation.city !== undefined && rejectedProxyCities.has(proxyCityKey(geolocation));
}

export function rememberRejectedProxyCity(geolocation: ProxyGeoLocation): void {
  if (geolocation.city === undefined || geolocation.city === '') return;
  rejectedProxyCities.add(proxyCityKey(geolocation));
  log.info(`  🌎 Remembering unsupported proxy city: ${proxyCityKey(geolocation)}`);
}

export function isInvalidSteelProxyConfiguration(error: unknown): boolean {
  const status =
    (error as Record<string, unknown>)?.status ?? (error as Record<string, unknown>)?.statusCode;
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return status === 400 || message.includes('invalid proxy configuration');
}

export function buildSteelProxySettings(
  geolocation: ProxyGeoLocation,
  dropCity = false,
  forceManagedRotation = false
): SteelProxySettings {
  const byopProxyServer = process.env.STEEL_PROXY_SERVER?.trim();
  if (byopProxyServer && !forceManagedRotation) {
    log.info(`  Using BYOP proxy server: ${redactProxyServerForLog(byopProxyServer)}`);
    return { config: { server: byopProxyServer }, source: 'byop' };
  }

  // Dedicated IPs: route through our leased Steel IP pool. With persistProfile +
  // a per-user profileId, Steel pins one IP to each user's profile on first use,
  // giving every user a stable egress identity (and making cf_clearance reuse
  // work). An explicit STEEL_DEDICATED_IP_ID pins one shared IP instead.
  if (!forceManagedRotation && envEnabled('BROWSER_AGENT_STEEL_DEDICATED_IP_ENABLED', false)) {
    const pinnedId = process.env.STEEL_DEDICATED_IP_ID?.trim();
    log.info(
      `  Using Steel dedicated IP${pinnedId ? ` (pinned ${pinnedId})` : ' (auto-pin to profile)'}`
    );
    return {
      config: { type: 'fixed', ...(pinnedId ? { id: pinnedId } : {}) },
      source: 'dedicated',
    };
  }

  const useSteelProxy =
    forceManagedRotation || envEnabled('BROWSER_AGENT_STEEL_PROXY_ENABLED', true);
  if (!useSteelProxy) {
    return { config: false, source: 'none' };
  }

  return {
    config: {
      geolocation: {
        country: geolocation.country,
        // Steel only supports state for US proxies
        ...(geolocation.country === 'US' && geolocation.state && { state: geolocation.state }),
        // City-level targeting is best-effort: Steel only has residential
        // proxies in a subset of cities and 400s ("Invalid proxy configuration")
        // for unsupported ones (e.g. SAN FRANCISCO). dropCity is set by the
        // session-create retry loop after such a rejection so we fall back to
        // country+state, which Steel always supports.
        ...(!dropCity && geolocation.city && { city: geolocation.city }),
      },
    },
    source: 'steel',
  };
}

/**
 * Get or create a persistent browser context for a user.
 * Steel uses "profiles" for persistent state (cookies, localStorage, etc.)
 *
 * Note: We don't pre-create Steel profiles. Instead, we use persistProfile=true
 * on session creation, and Steel will create/update the profile when the session closes.
 * The profileId is saved back to our DB after the first session.
 *
 * @returns The database ID (BrowserContext.id) for use as foreign key
 */
export async function getOrCreateContext(userId: string): Promise<string> {
  // Check DB for existing context
  const existing = await prisma.browserContext.findUnique({
    where: { userId },
  });

  if (existing) {
    log.info(
      `✓ Using existing context for user ${userId}: ${existing.contextId ?? '(no profile yet)'}`
    );
    return existing.id; // Return database ID (for foreign key)
  }

  // Create DB record - Steel profile will be created on first session with persistProfile=true
  log.info(`Creating new browser context for user ${userId}...`);
  const dbContext = await prisma.browserContext.create({
    data: {
      userId,
      contextId: null, // Will be populated after Steel creates a profile
    },
  });

  log.info(
    `✓ Created browser context: ${dbContext.id} (Steel profile will be created on first session)`
  );
  return dbContext.id; // Return database ID (for foreign key)
}

/**
 * Create a new browser session with persistent context.
 * Validates the WebSocket connection works before returning.
 * If validation fails, retries up to MAX_SESSION_RETRIES times.
 *
 * @param dbContextId - The database ID (BrowserContext.id) for the foreign key
 * @param agentId - The agent creating this session
 * @param geolocation - Proxy geolocation (defaults to Dallas, TX)
 */
export async function createSessionWithContext(
  dbContextId: string,
  agentId: string,
  geolocation: ProxyGeoLocation = DEFAULT_GEOLOCATION,
  startUrl?: string,
  options?: { keepValidationConnection?: boolean }
): Promise<{
  sessionId: string;
  debugUrl: string;
  taskId: string;
  wsUrl: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  steelProfileId: string | null;
  profileSource: string;
  validationBrowser: Browser | null;
}> {
  log.info(`Creating Steel browser session for context ${dbContextId}...`);
  log.info(
    `  Proxy geolocation: ${geolocation.city}, ${geolocation.state}, ${geolocation.country}`
  );

  // Look up the Steel profile ID from database
  let dbContext = await prisma.browserContext.findUnique({
    where: { id: dbContextId },
  });

  if (!dbContext) {
    throw new Error(`Browser context not found: ${dbContextId}`);
  }

  // Fetch user's fingerprint to get their User-Agent for Steel session
  const fingerprint = await prisma.integration.findUnique({
    where: { userId_name: { userId: dbContext.userId, name: 'browser_fingerprint' } },
  });
  const fp = (fingerprint?.config as { fingerprint?: FingerprintData } | null)?.fingerprint;
  const userAgent = fp?.navigator?.userAgent;
  if (userAgent) {
    log.info(`  Using user's fingerprint User-Agent: ${userAgent.substring(0, 60)}...`);
  }

  const localSession = await createLocalBrowserSession(dbContextId, agentId, startUrl);
  if (localSession) return { ...localSession, validationBrowser: null };

  let lastError: Error | null = null;
  // Set after Steel rejects a city-level proxy ("400 Invalid proxy
  // configuration") so the next attempt retries with country+state only.
  // Seeded from the process-wide rejection cache so repeat sessions for the
  // same location skip the guaranteed-failing city attempt entirely.
  let dropProxyCity = isKnownRejectedProxyCity(geolocation);

  for (let attempt = 1; attempt <= MAX_SESSION_RETRIES; attempt++) {
    log.info(`  📡 Session creation attempt ${attempt}/${MAX_SESSION_RETRIES}...`);

    let validationBrowser: Browser | null = null;
    try {
      // Create session in Steel with viewport adjusted for browser chrome
      // Steel's headful mode has ~91px chrome (toolbar). To get 1280x800 content area:
      // - Width: 1280 + 8 = 1288 (fine-tuned: was 1303→1295, need -15)
      // - Height: 800 + 91 = 891 (accounts for browser toolbar) ✓ working
      const proxySettings = buildSteelProxySettings(geolocation, dropProxyCity);
      const profile = resolveSteelProfileForSession(agentId, dbContext.contextId);
      const session = (await steel.sessions.create({
        profileId: profile.profileId, // Use existing profile if available
        persistProfile: envEnabled('BROWSER_AGENT_STEEL_PROFILE_ENABLED', true), // Auto-persist browser state to profile on session close
        userAgent:
          userAgent && envEnabled('BROWSER_AGENT_STEEL_USER_AGENT_ENABLED', true)
            ? userAgent
            : undefined, // Use user's real User-Agent from fingerprint
        useProxy: proxySettings.config,
        solveCaptcha: envEnabled('BROWSER_AGENT_STEEL_CAPTCHA_SOLVER_ENABLED', true), // Auto-solve CAPTCHAs
        debugConfig: {
          systemCursor: false, // Browser-agent recordings render the Rose cursor overlay from cursor events.
        },
        stealthConfig: {
          humanizeInteractions: false, // Disabled - we handle humanization with BrowserHumanizer
          skipFingerprintInjection: true, // We inject user's real fingerprint ourselves
        },
        timeout: 900000, // 15 minutes
        dimensions: {
          width: 1288, // 1280 + 8 for borders → 1280 viewport
          height: 891, // 800 + 91 for browser chrome → 800 viewport
        },
      })) as SteelSessionResult;

      log.info(`Steel Session: ${logJson(session)}`);
      rememberBenchmarkAnonSteelProfile(agentId, session.profileId);

      // Steel provides debugUrl for unauthenticated live viewing (anyone with URL can view)
      // sessionViewerUrl requires Steel dashboard login - don't use that
      // Keep the embedded trace viewer read-only.
      const debugUrl = steelDebugUrl(session.debugUrl);

      // Persist only the non-secret CDP locator. Connection helpers materialize
      // the API key inside the backend or worker process immediately before use.
      const wsUrl = steelCdpUrl(session.id);

      // VALIDATE: Test that the WebSocket connection actually works before
      // proceeding. The connection is kept open so injectUserData can reuse it
      // instead of paying a second 3-5s CDP handshake.
      validationBrowser = await connectValidatedBrowser(wsUrl);

      if (validationBrowser === null) {
        log.info(`  ⚠️ Session ${session.id} failed validation, releasing...`);
        try {
          await releaseSteelRemoteSession(session.id);
        } catch (releaseErr) {
          throw new SteelSessionCleanupError(session.id, releaseErr);
        }
        lastError = new Error(`Session validation failed on attempt ${attempt}`);
        continue; // Retry
      }

      // If this was the first session for the user, claim the provider profile
      // atomically. Concurrent first sessions can each get a new Steel profile;
      // only one should become the persistent profile for future sessions.
      if (benchmarkAnonSteelProfileEnabled()) {
        log.info(
          `  🧪 Benchmark anon profile mode active; not writing Steel profileId ${session.profileId || '(pending)'} to BrowserContext`
        );
      } else if (session.profileId && dbContext.contextId === null) {
        log.info(`  📝 Claiming new Steel profileId: ${session.profileId}`);
        const claim = await prisma.browserContext.updateMany({
          where: { id: dbContextId, contextId: null },
          data: { contextId: session.profileId },
        });
        if (claim.count === 0) {
          const winningContext = await prisma.browserContext.findUnique({
            where: { id: dbContextId },
          });
          if (winningContext?.contextId && winningContext.contextId !== session.profileId) {
            log.info(
              `  ⚠️ Concurrent profile init detected; releasing ${session.id} and retrying with ${winningContext.contextId}`
            );
            await validationBrowser.close().catch(() => {});
            validationBrowser = null;
            try {
              await releaseSteelRemoteSession(session.id);
            } catch (releaseErr) {
              log.info(`  ⚠️ Failed to release superseded session: ${releaseErr}`);
              throw new SteelSessionCleanupError(session.id, releaseErr);
            }
            dbContext = winningContext;
            lastError = new Error(
              'Concurrent Steel profile initialization; retrying with persisted profile'
            );
            continue;
          }
        } else {
          dbContext = { ...dbContext, contextId: session.profileId };
        }
      } else if (session.profileId && session.profileId !== dbContext.contextId) {
        log.info(`  📝 Saving updated Steel profileId: ${session.profileId}`);
        await prisma.browserContext.update({
          where: { id: dbContextId },
          data: { contextId: session.profileId },
        });
        dbContext = { ...dbContext, contextId: session.profileId };
      }

      // Save to DB
      const dbSession = await prisma.browserSession.create({
        data: {
          contextId: dbContextId,
          agentId,
          sessionId: session.id,
          debugUrl,
          wsUrl,
          status: 'ACTIVE',
          startUrl: startUrl || undefined,
        },
      });

      log.info(`✓ Created Steel session: ${session.id}`);
      log.info(`  Context (DB): ${dbContextId}`);
      log.info(`  Profile (Steel): ${session.profileId || 'will be created on release'}`);
      log.info(`  Live View URL: ${debugUrl}`);
      log.info(`  CDP WebSocket URL: ${wsUrl}`);

      if (!options?.keepValidationConnection) {
        await validationBrowser.close().catch(() => {});
        validationBrowser = null;
      }

      return {
        sessionId: session.id,
        debugUrl,
        wsUrl,
        taskId: dbSession.id,
        proxySource: session.proxySource ?? proxySettings.source,
        proxyLocation: geolocation,
        steelProfileId: session.profileId ?? null,
        profileSource: profile.profileSource,
        validationBrowser,
      };
    } catch (error) {
      if (validationBrowser !== null) {
        await validationBrowser.close().catch(() => {});
      }
      if (error instanceof SteelSessionCleanupError) throw error;
      // Steel 429 = concurrent session limit. Don't retry locally — bubble up so agent can backoff.
      const status =
        (error as Record<string, unknown>)?.status ??
        (error as Record<string, unknown>)?.statusCode;
      if (status === 429) {
        const msg = error instanceof Error ? error.message : 'Steel session rate limit exceeded';
        log.info(`  ⚠️ Steel rate limit (429): ${msg}`);
        throw new SteelRateLimitError(msg);
      }
      log.info(
        `  ❌ Attempt ${attempt} failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      lastError = error instanceof Error ? error : new Error('Unknown error');

      // Steel rejects city-level proxies it can't fulfill ("400 Invalid proxy
      // configuration"). Drop the city and retry with country+state, which Steel
      // always supports — otherwise every retry repeats the same bad config.
      if (!dropProxyCity && isInvalidSteelProxyConfiguration(error)) {
        dropProxyCity = true;
        rememberRejectedProxyCity(geolocation);
        log.info('  🌎 Dropping unsupported proxy city; retrying with country+state only');
      }
    }
  }

  // All retries exhausted
  throw new Error(
    `Failed to create valid Steel session after ${MAX_SESSION_RETRIES} attempts: ${lastError?.message}`
  );
}

/**
 * Close a browser session.
 * @param pause - If true, sets status to PAUSED (resumable). If false, sets to CLOSED (terminal).
 * @param currentUrl - Current page URL to save for resume (optional).
 */
export async function closeSession(
  sessionId: string,
  pause: boolean = false,
  currentUrl?: string
): Promise<void> {
  log.info(`${pause ? 'Pausing' : 'Closing'} Steel session ${sessionId}...`);

  try {
    // Release the Steel session
    await releaseSteelRemoteSession(sessionId);
  } catch (error) {
    log.error('Failed to close session in Steel', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Continue to update DB even if Steel call fails
  }

  // Update DB
  log.info(`📝 Updating DB with currentUrl: ${currentUrl || 'NONE'}`);
  await prisma.browserSession.update({
    where: { sessionId },
    data: {
      status: pause ? 'PAUSED' : 'CLOSED',
      closedAt: pause ? undefined : new Date(),
      currentUrl: currentUrl || undefined,
    },
  });

  log.info(`✓ Session ${pause ? 'paused (resumable)' : 'closed (terminal)'}`);
  if (currentUrl) {
    log.info(`  ✅ Saved current URL to DB: ${currentUrl}`);
  } else {
    log.info(`  ⚠️ No currentUrl to save`);
  }
}

/** Release only the remote Steel browser without mutating BrowserSession. */
export async function releaseSteelRemoteSession(sessionId: string): Promise<void> {
  await retryWithBackoff(
    async () => {
      try {
        await steel.sessions.release(sessionId);
      } catch (error) {
        const status =
          (error as Record<string, unknown>)?.status ??
          (error as Record<string, unknown>)?.statusCode;
        if (status === 404) return;
        throw error;
      }
    },
    {
      maxRetries: 3,
      fixedDelays: [250, 500],
      isRetryable: () => true,
      component: 'Steel session release',
    }
  );
}

/**
 * Resume a paused browser session by creating a NEW session with the same profile.
 * Validates the WebSocket connection works before returning.
 * If validation fails, retries up to MAX_SESSION_RETRIES times.
 *
 * @param taskId - The stable task ID (BrowserSession.id)
 * @returns Session info including saved URL to navigate back to
 */
/**
 * Get session info from database.
 */
export async function getSession(sessionId: string) {
  return await prisma.browserSession.findUnique({
    where: { sessionId },
    include: { context: true },
  });
}

export async function getSteelSessionHealth(sessionId: string): Promise<SteelSessionHealth> {
  const remote = (await steel.sessions.retrieve(sessionId)) as {
    id?: string;
    status?: string;
    createdAt?: string;
    timeout?: number;
    profileId?: string | null;
  };
  const createdAtMs =
    remote.createdAt !== undefined ? new Date(remote.createdAt).getTime() : Number.NaN;
  const timeoutMs = typeof remote.timeout === 'number' ? remote.timeout : null;
  const expiresAtMs =
    Number.isFinite(createdAtMs) && timeoutMs !== null ? createdAtMs + timeoutMs : Number.NaN;
  return {
    sessionId: remote.id ?? sessionId,
    status: remote.status ?? null,
    createdAt: remote.createdAt ?? null,
    timeoutMs,
    expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
    ttlMs: Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - Date.now()) : null,
    profileId: remote.profileId ?? null,
  };
}

export async function getSteelSessionCookieSummary(
  sessionId: string,
  authRealm: string
): Promise<SteelSessionCookieSummary> {
  const context = (await steel.sessions.context(sessionId)) as {
    cookies?: Array<{ domain?: string; expires?: number }>;
  };
  const normalizedRealm = authRealm.toLowerCase().replace(/^\./, '');
  const nowSeconds = Date.now() / 1000;
  const cookieCount = (context.cookies ?? []).filter((cookie) => {
    const domain = (cookie.domain ?? '').toLowerCase().replace(/^\./, '');
    const domainMatches = domain === normalizedRealm || domain.endsWith(`.${normalizedRealm}`);
    const expires = cookie.expires;
    const live = expires === undefined || expires <= 0 || expires > nowSeconds;
    return domainMatches && live;
  }).length;
  return {
    sessionId,
    authRealm: normalizedRealm,
    cookieCount,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Close all active browser sessions (for cleanup).
 */
export async function closeAllActiveSessions(): Promise<number> {
  log.info('🌐 Finding all active browser sessions...');

  const activeSessions = await prisma.browserSession.findMany({
    where: { status: 'ACTIVE' },
    select: { sessionId: true, agentId: true },
  });

  log.info(`   Found ${activeSessions.length} active session(s)`);

  if (activeSessions.length === 0) {
    return 0;
  }

  let closedCount = 0;

  for (const session of activeSessions) {
    try {
      log.info(`   Closing session ${session.sessionId} (agent: ${session.agentId})...`);
      await closeSession(session.sessionId);
      closedCount++;
    } catch (error) {
      log.error(`Failed to close session ${session.sessionId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.info(`✅ Closed ${closedCount}/${activeSessions.length} session(s)`);

  return closedCount;
}
