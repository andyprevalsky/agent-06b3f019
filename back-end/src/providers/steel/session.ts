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
import {
  createLocalBrowserSession,
  steelStartupProbe,
  validateBrowserConnection,
} from './sessionConnection';
import { installCaptchaSolveIndicator } from '../browser/captchaSolveIndicator';
import { persistBrowserSessionRow } from '../browser/sessionPersist';
import { STEEL_API_BASE_URL, steelCdpUrl, steelDebugUrl } from './urls';
import {
  envEnabled,
  rememberBenchmarkAnonSteelProfile,
  resolveSteelProfileForSession,
  shouldWriteSteelProfileToBrowserContext,
} from './profileBinding';
import { MAX_SESSION_RETRIES, sleepBeforeSteelRetry } from './sessionRetry';
import { steelSessionTimeoutMs } from './sessionLifetime';
import {
  withSteelLifecycleClaim,
  type SteelNativeEffect,
  type SteelLifecycleMutation,
} from './lifecycleClaim';
import { announceBrowserSessionBinding } from '../browser/sessionBindingAnnounce';
import {
  newOwnedSteelSessionId,
  registerInFlightSteelSession,
  unregisterInFlightSteelSession,
} from './sessionIdentity';
import {
  buildSteelProxySettings,
  isInvalidSteelProxyConfiguration,
  isKnownRejectedProxyCity,
  rememberRejectedProxyCity,
} from './sessionProxy';
export {
  buildSteelProxySettings,
  isInvalidSteelProxyConfiguration,
  isKnownRejectedProxyCity,
  proxyCityKey,
  rememberRejectedProxyCity,
  type SteelProxyConfig,
  type SteelProxySettings,
} from './sessionProxy';
export { resumeSession } from './sessionResume';
export {
  envEnabled,
  rememberBenchmarkAnonSteelProfile,
  resolveSteelProfileForSession,
  shouldWriteSteelProfileToBrowserContext,
} from './profileBinding';
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
export { MAX_SESSION_RETRIES } from './sessionRetry';

export const steel = new Steel({
  steelAPIKey: process.env.STEEL_API_KEY,
  baseURL: STEEL_API_BASE_URL,
});

export class SteelSessionCleanupError extends Error {
  constructor(sessionId: string, cause: unknown) {
    super(
      `Failed to release Steel session ${sessionId} after bounded retries: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = 'SteelSessionCleanupError';
  }
}

interface SteelSessionResult {
  id: string;
  debugUrl: string;
  profileId?: string | null;
  proxySource?: string | null;
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
  options?: {
    keepValidationConnection?: boolean;
    proxyMode?: 'managed' | 'fixed';
    requiredSteelProfileId?: string;
    taskId?: string;
  }
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
    where: {
      userId_name_accountId: {
        userId: dbContext.userId,
        name: 'browser_fingerprint',
        accountId: '',
      },
    },
  });
  const fp = (fingerprint?.config as { fingerprint?: FingerprintData } | null)?.fingerprint;
  const userAgent = fp?.navigator?.userAgent;
  if (userAgent) {
    log.info(`  Using user's fingerprint User-Agent: ${userAgent.substring(0, 60)}...`);
  }

  const localSession =
    options?.requiredSteelProfileId === undefined
      ? await createLocalBrowserSession(dbContextId, agentId, startUrl, options?.taskId)
      : null;
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
      const proxySettings = buildSteelProxySettings(
        geolocation,
        dropProxyCity,
        false,
        options?.proxyMode
      );
      const profile = resolveSteelProfileForSession(
        agentId,
        dbContext.contextId,
        options?.requiredSteelProfileId ?? null
      );
      const session = (await steel.sessions.create({
        sessionId: newOwnedSteelSessionId(),
        profileId: profile.profileId, // Use existing profile if available
        persistProfile: profile.persistProfile,
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
        timeout: steelSessionTimeoutMs(),
        dimensions: {
          width: 1288, // 1280 + 8 for borders → 1280 viewport
          height: 891, // 800 + 91 for browser chrome → 800 viewport
        },
      })) as SteelSessionResult;
      await registerInFlightSteelSession(session.id);

      if (
        options?.requiredSteelProfileId !== undefined &&
        session.profileId !== options.requiredSteelProfileId
      ) {
        try {
          await releaseSteelRemoteSession(session.id);
        } catch (releaseError) {
          throw new SteelSessionCleanupError(session.id, releaseError);
        }
        throw new Error(
          `Steel loaded profile ${session.profileId ?? 'NONE'} instead of required authenticated profile ${options.requiredSteelProfileId}`
        );
      }

      log.info(`Steel Session: ${logJson(session)}`);
      if (profile.profileSource.startsWith('benchmark_anon')) {
        rememberBenchmarkAnonSteelProfile(agentId, session.profileId);
      }

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
      const validation = await validateBrowserConnection(wsUrl, {
        startupProbe: steelStartupProbe(session.id, (id) => steel.sessions.retrieve(id)),
      });

      if (validation.browser === null) {
        log.info(`  ⚠️ Session ${session.id} failed validation, releasing...`);
        try {
          await releaseSteelRemoteSession(session.id);
        } catch (releaseErr) {
          throw new SteelSessionCleanupError(session.id, releaseErr);
        }
        lastError = new Error(
          `Session validation failed on attempt ${attempt}: ${validation.failure}`
        );
        if (attempt < MAX_SESSION_RETRIES) {
          await sleepBeforeSteelRetry(attempt);
        }
        continue; // Retry
      }
      validationBrowser = validation.browser;

      // Visible live-view cue while Steel's native CAPTCHA solver runs.
      // Agent CDP attach re-installs this after the validation connection closes.
      await installCaptchaSolveIndicator(validationBrowser);

      // If this was the first session for the user, claim the provider profile
      // atomically. Concurrent first sessions can each get a new Steel profile;
      // only one should become the persistent profile for future sessions.
      if (!shouldWriteSteelProfileToBrowserContext(profile)) {
        log.info(
          `  🧪 Session-scoped Steel profile active; not writing profileId ${session.profileId || '(pending)'} to BrowserContext`
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
            if (attempt < MAX_SESSION_RETRIES) {
              await sleepBeforeSteelRetry(attempt);
            }
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

      // Save to DB (idempotent when taskId is preallocated for Temporal retries)
      const dbSession = await persistBrowserSessionRow({
        taskId: options?.taskId,
        contextId: dbContextId,
        agentId,
        sessionId: session.id,
        debugUrl,
        wsUrl,
        startUrl: startUrl || undefined,
        provider: 'steel',
        providerProfileId: session.profileId ?? profile.profileId ?? null,
        providerProfileSource: profile.profileSource,
        providerProfilePersist: profile.persistProfile,
        releaseRemoteSession: releaseSteelRemoteSession,
      });
      // The row now protects the session from the reaper; the in-flight entry
      // would otherwise shield an orphan whose cleanup skipped the release.
      await unregisterInFlightSteelSession(session.id);

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
      if (attempt < MAX_SESSION_RETRIES) {
        await sleepBeforeSteelRetry(attempt);
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
  if (sessionId.startsWith('local-')) {
    return closeSessionWithinClaim(sessionId, pause, currentUrl);
  }
  const session = await prisma.browserSession.findUnique({
    where: { sessionId },
    select: { id: true, providerProfileId: true, providerProfilePersist: true },
  });
  if (session === null) throw new Error(`Browser session not found: ${sessionId}`);
  await withSteelLifecycleClaim(session.id, async (assertTask, runTaskNative, mutateTask) => {
    const current = await prisma.browserSession.findUnique({
      where: { id: session.id },
      select: { sessionId: true },
    });
    if (current?.sessionId !== sessionId) {
      throw new Error(`Browser session changed before closing task ${session.id}`);
    }
    const close = (
      assertProfile?: () => Promise<void>,
      runProfileNative?: SteelNativeEffect,
      mutateProfile?: SteelLifecycleMutation
    ) =>
      closeSessionWithinClaim(
        sessionId,
        pause,
        currentUrl,
        async () => {
          await assertTask();
          await assertProfile?.();
        },
        async (id, effect, callback) =>
          runTaskNative(id, effect, () =>
            runProfileNative ? runProfileNative(id, effect, callback) : callback()
          ),
        (callback) =>
          mutateTask((transaction) =>
            mutateProfile ? mutateProfile(callback, transaction) : callback(transaction)
          )
      );
    if (session.providerProfileId && session.providerProfilePersist) {
      await withSteelLifecycleClaim(`profile:${session.providerProfileId}`, close);
    } else {
      await close();
    }
  });
}

async function closeSessionWithinClaim(
  sessionId: string,
  pause: boolean,
  currentUrl?: string,
  assertOwned?: () => Promise<void>,
  runOwnedNative?: SteelNativeEffect,
  mutateLifecycle?: SteelLifecycleMutation
): Promise<void> {
  log.info(`${pause ? 'Pausing' : 'Closing'} Steel session ${sessionId}...`);

  let releaseError: unknown = null;
  try {
    // Release the Steel session
    await assertOwned?.();
    await (runOwnedNative
      ? runOwnedNative(sessionId, 'release', () => releaseSteelRemoteSession(sessionId))
      : releaseSteelRemoteSession(sessionId));
  } catch (error) {
    releaseError = error;
    log.error('Failed to close session in Steel', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let releaseConfirmed = releaseError === null;
  let confirmedActive = false;
  if (releaseError !== null && !sessionId.startsWith('local-')) {
    const observed = await steel.sessions.retrieve(sessionId).catch(() => null);
    if (observed?.id === sessionId) {
      releaseConfirmed = observed.status === 'released';
      confirmedActive = observed.status === 'live';
    }
  }

  // Update DB
  log.info(`📝 Updating DB with currentUrl: ${currentUrl || 'NONE'}`);
  await assertOwned?.();
  const mutate: SteelLifecycleMutation = mutateLifecycle ?? (async (callback) => callback(prisma));
  await mutate((transaction) =>
    transaction.browserSession.update({
      where: { sessionId },
      data: {
        // ERROR means remote release is still owed. Terminal-agent reconciliation
        // will retry it; CLOSED must only mean billing is known to have stopped.
        status: releaseConfirmed
          ? pause
            ? 'PAUSED'
            : 'CLOSED'
          : pause && confirmedActive
            ? 'ACTIVE'
            : 'ERROR',
        closedAt: releaseConfirmed && !pause ? new Date() : null,
        currentUrl: currentUrl || undefined,
      },
    })
  );
  await announceBrowserSessionBinding({ sessionId });

  if (releaseError !== null) throw releaseError;

  log.info(`✓ Session ${pause ? 'paused (resumable)' : 'closed (terminal)'}`);
  if (currentUrl) {
    log.info(`  ✅ Saved current URL to DB: ${currentUrl}`);
  } else {
    log.info(`  ⚠️ No currentUrl to save`);
  }
}

/** Release only the remote Steel browser without mutating BrowserSession. */
export async function releaseSteelRemoteSession(sessionId: string): Promise<void> {
  // Local benchmark/browser sessions have no rented Steel resource to release.
  // Treating their synthetic IDs as remote turns a successful local close into
  // a permanent retry obligation.
  if (sessionId.startsWith('local-')) return;
  await unregisterInFlightSteelSession(sessionId);
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
