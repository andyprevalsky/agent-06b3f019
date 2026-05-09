/**
 * Steel session management — create, close, resume, validate.
 */

import Steel from 'steel-sdk';
import { prisma } from '../database';
import { logJson } from '../../utils/log';
import { type ProxyGeoLocation, DEFAULT_GEOLOCATION } from '../geoip';
import { SteelRateLimitError, type FingerprintData, log } from './types';

// Validate required environment variables
if (!process.env.STEEL_API_KEY) {
  throw new Error('STEEL_API_KEY environment variable is required');
}

export const steel = new Steel({
  steelAPIKey: process.env.STEEL_API_KEY,
});

// Max retries when session validation fails
const MAX_SESSION_RETRIES = 3;
const SESSION_VALIDATION_TIMEOUT = 10000; // 10 seconds

// WebSocket connection retry config
const WS_CONNECTION_RETRIES = 3;
const WS_BACKOFF_DELAYS = [100, 400, 800]; // ms

interface SteelSessionResult {
  id: string;
  debugUrl: string;
  profileId?: string | null;
}

/**
 * Sleep helper for backoff delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate that a Steel session's WebSocket connection actually works.
 * This catches cases where Steel.dev returns a session but the connection is broken.
 * Retries with exponential backoff: 100ms, 400ms, 800ms
 *
 * @param wsUrl - The CDP WebSocket URL to test
 * @returns true if connection works, false otherwise
 */
async function validateSessionConnection(wsUrl: string): Promise<boolean> {
  const { chromium } = await import('playwright');

  log.info(`  🔍 Validating session connection (up to ${WS_CONNECTION_RETRIES} attempts)...`);

  // eslint-disable-next-line no-restricted-syntax -- CDP connection validation manages browser object lifecycle (connect/close) per attempt
  for (let attempt = 1; attempt <= WS_CONNECTION_RETRIES; attempt++) {
    let browser;

    try {
      log.info(`    [WS] Attempt ${attempt}/${WS_CONNECTION_RETRIES}: Connecting to CDP...`);

      // Try to connect with a timeout
      browser = await Promise.race([
        chromium.connectOverCDP(wsUrl),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), SESSION_VALIDATION_TIMEOUT)
        ),
      ]);

      // Check that we can access the browser context
      const contexts = browser.contexts();
      if (!contexts || contexts.length === 0) {
        log.info(
          `    [WS] Attempt ${attempt}/${WS_CONNECTION_RETRIES}: ❌ No browser contexts available`
        );
        await browser.close().catch(() => {});

        if (attempt < WS_CONNECTION_RETRIES) {
          const delay = WS_BACKOFF_DELAYS[attempt - 1];
          log.info(`    [WS] Retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }
        return false;
      }

      // Try to get pages - this confirms the connection is working
      const pages = contexts[0].pages();
      log.info(
        `    [WS] Attempt ${attempt}/${WS_CONNECTION_RETRIES}: ✅ Connected (${contexts.length} context(s), ${pages.length} page(s))`
      );

      await browser.close().catch(() => {});
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      log.info(`    [WS] Attempt ${attempt}/${WS_CONNECTION_RETRIES}: ❌ ${errorMsg}`);

      if (browser) {
        await browser.close().catch(() => {});
      }

      if (attempt < WS_CONNECTION_RETRIES) {
        const delay = WS_BACKOFF_DELAYS[attempt - 1];
        log.info(`    [WS] Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  log.info(`  ❌ Session validation failed after ${WS_CONNECTION_RETRIES} attempts`);
  return false;
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
  startUrl?: string
): Promise<{ sessionId: string; debugUrl: string; taskId: string; wsUrl: string }> {
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

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_SESSION_RETRIES; attempt++) {
    log.info(`  📡 Session creation attempt ${attempt}/${MAX_SESSION_RETRIES}...`);

    try {
      // Create session in Steel with viewport adjusted for browser chrome
      // Steel's headful mode has ~91px chrome (toolbar). To get 1280x800 content area:
      // - Width: 1280 + 8 = 1288 (fine-tuned: was 1303→1295, need -15)
      // - Height: 800 + 91 = 891 (accounts for browser toolbar) ✓ working
      const session = (await steel.sessions.create({
        profileId: dbContext.contextId ?? undefined, // Use existing profile if available
        persistProfile: true, // Auto-persist browser state to profile on session close
        userAgent: userAgent || undefined, // Use user's real User-Agent from fingerprint
        useProxy: {
          geolocation: {
            country: geolocation.country,
            // Steel only supports state for US proxies
            ...(geolocation.country === 'US' && geolocation.state && { state: geolocation.state }),
            ...(geolocation.city && { city: geolocation.city }),
          },
        }, // Residential proxy based on user's location
        solveCaptcha: true, // Auto-solve CAPTCHAs
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

      // Steel provides debugUrl for unauthenticated live viewing (anyone with URL can view)
      // sessionViewerUrl requires Steel dashboard login - don't use that
      // Add ?interactive=true so users can interact with the browser
      const debugUrl = `${session.debugUrl}?interactive=false`;

      // IMPORTANT: Per Steel docs, CDP connection URL must include apiKey parameter
      // The session.websocketUrl does NOT include the apiKey, so we construct it manually
      // Format: wss://connect.steel.dev?apiKey=${STEEL_API_KEY}&sessionId=${session.id}
      const wsUrl = `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`;

      // VALIDATE: Test that the WebSocket connection actually works before proceeding
      const isValid = await validateSessionConnection(wsUrl);

      if (!isValid) {
        log.info(`  ⚠️ Session ${session.id} failed validation, releasing...`);
        try {
          await steel.sessions.release(session.id);
        } catch (releaseErr) {
          log.info(`  ⚠️ Failed to release invalid session: ${releaseErr}`);
        }
        lastError = new Error(`Session validation failed on attempt ${attempt}`);
        continue; // Retry
      }

      // If this was the first session for the user, claim the provider profile
      // atomically. Concurrent first sessions can each get a new Steel profile;
      // only one should become the persistent profile for future sessions.
      if (session.profileId && dbContext.contextId === null) {
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
            try {
              await steel.sessions.release(session.id);
            } catch (releaseErr) {
              log.info(`  ⚠️ Failed to release superseded session: ${releaseErr}`);
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

      return {
        sessionId: session.id,
        debugUrl,
        wsUrl,
        taskId: dbSession.id,
      };
    } catch (error) {
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
    await steel.sessions.release(sessionId);
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

/**
 * Resume a paused browser session by creating a NEW session with the same profile.
 * Validates the WebSocket connection works before returning.
 * If validation fails, retries up to MAX_SESSION_RETRIES times.
 *
 * @param taskId - The stable task ID (BrowserSession.id)
 * @returns Session info including saved URL to navigate back to
 */
export async function resumeSession(
  taskId: string
): Promise<{ debugUrl: string; sessionId: string; wsUrl: string; savedUrl?: string }> {
  log.info(`Resuming browser task ${taskId}...`);

  // Look up the old session to get context/profile
  const oldSession = await prisma.browserSession.findUnique({
    where: { id: taskId },
    include: { context: true },
  });

  if (!oldSession) {
    throw new Error(`Browser task not found: ${taskId}`);
  }

  log.info(`  Found old session with currentUrl: ${oldSession.currentUrl || 'NONE'}`);

  // Look up agent's proxy geolocation
  let proxyGeo = DEFAULT_GEOLOCATION;
  if (oldSession.agentId) {
    const agent = await prisma.agent.findUnique({
      where: { id: oldSession.agentId },
      select: { proxyCountry: true, proxyState: true, proxyCity: true },
    });
    if (agent?.proxyCountry) {
      proxyGeo = {
        country: agent.proxyCountry,
        ...(agent.proxyState && { state: agent.proxyState }),
        ...(agent.proxyCity && { city: agent.proxyCity }),
      };
    }
  }
  log.info(`  Using proxy location: ${proxyGeo.city}, ${proxyGeo.state}, ${proxyGeo.country}`);

  // Fetch user's fingerprint to get their User-Agent for Steel session
  const fingerprint = await prisma.integration.findUnique({
    where: { userId_name: { userId: oldSession.context.userId, name: 'browser_fingerprint' } },
  });
  const fp = (fingerprint?.config as { fingerprint?: FingerprintData } | null)?.fingerprint;
  const userAgent = fp?.navigator?.userAgent;
  if (userAgent) {
    log.info(`  Using user's fingerprint User-Agent: ${userAgent.substring(0, 60)}...`);
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_SESSION_RETRIES; attempt++) {
    log.info(`  📡 Resume session attempt ${attempt}/${MAX_SESSION_RETRIES}...`);

    try {
      // Create NEW Steel session with same profile
      // Dimensions adjusted for browser chrome (see createSessionWithContext comments)
      const session = await steel.sessions.create({
        profileId: oldSession.context.contextId ?? undefined,
        userAgent: userAgent || undefined, // Use user's real User-Agent from fingerprint
        useProxy: {
          geolocation: {
            country: proxyGeo.country,
            // Steel only supports state for US proxies
            ...(proxyGeo.country === 'US' && proxyGeo.state && { state: proxyGeo.state }),
            ...(proxyGeo.city && { city: proxyGeo.city }),
          },
        }, // Residential proxy based on user's location
        solveCaptcha: true,
        stealthConfig: {
          humanizeInteractions: false, // Disabled - we handle humanization with BrowserHumanizer
          skipFingerprintInjection: true, // We inject user's real fingerprint ourselves
        },
        timeout: 900000, // 15 minutes (hobby plan max)
        dimensions: {
          width: 1288, // 1280 + 8 for borders → 1280 viewport
          height: 891, // 800 + 91 for browser chrome → 800 viewport
        },
      });

      log.info(`  ✓ Created new Steel session: ${session.id}`);

      // Use debugUrl for unauthenticated live viewing (not sessionViewerUrl which requires login)
      const debugUrl = `${session.debugUrl}?interactive=false`;
      // IMPORTANT: Per Steel docs, CDP connection URL must include apiKey parameter
      const wsUrl = `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`;

      // VALIDATE: Test that the WebSocket connection actually works before proceeding
      const isValid = await validateSessionConnection(wsUrl);

      if (!isValid) {
        log.info(`  ⚠️ Session ${session.id} failed validation, releasing...`);
        try {
          await steel.sessions.release(session.id);
        } catch (releaseErr) {
          log.info(`  ⚠️ Failed to release invalid session: ${releaseErr}`);
        }
        lastError = new Error(`Session validation failed on attempt ${attempt}`);
        continue; // Retry
      }

      // Navigate to saved URL if available
      if (oldSession.currentUrl) {
        log.info(`  📍 Navigating session to saved URL: ${oldSession.currentUrl}`);
        try {
          const { chromium } = await import('playwright');
          const browser = await chromium.connectOverCDP(wsUrl);
          const context = browser.contexts()[0];
          const page = context.pages()[0];
          await page.goto(oldSession.currentUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
          log.info(`  ✅ Navigation complete`);
          await browser.close();
        } catch (navError) {
          log.error('Failed to navigate to saved URL', {
            error: navError instanceof Error ? navError.message : String(navError),
          });
        }
      }

      // Update DB record with NEW sessionId, debugUrl, and wsUrl
      await prisma.browserSession.update({
        where: { id: taskId },
        data: {
          sessionId: session.id,
          debugUrl,
          wsUrl,
          status: 'ACTIVE',
          closedAt: null,
        },
      });

      log.info(`✓ Task resumed with new session`);
      log.info(`  Task ID (stable): ${taskId}`);
      log.info(`  New session ID: ${session.id}`);
      log.info(`  Profile ID: ${oldSession.context.contextId}`);
      log.info(`  New debug URL: ${debugUrl}`);
      log.info(`  CDP WebSocket URL: ${wsUrl}`);

      return {
        debugUrl,
        sessionId: session.id,
        wsUrl,
        savedUrl: oldSession.currentUrl || oldSession.startUrl || undefined,
      };
    } catch (error) {
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
    }
  }

  // All retries exhausted
  throw new Error(
    `Failed to resume session after ${MAX_SESSION_RETRIES} attempts: ${lastError?.message}`
  );
}

/**
 * Get session info from database.
 */
export async function getSession(sessionId: string) {
  return await prisma.browserSession.findUnique({
    where: { sessionId },
    include: { context: true },
  });
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
