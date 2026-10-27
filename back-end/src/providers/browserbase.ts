import { Browserbase } from '@browserbasehq/sdk';
import { prisma } from './database';
import { logJson } from '../utils/log';
import { createLogger } from './logger';

const log = createLogger('Browserbase');

// Validate required environment variables
if (!process.env.BROWSERBASE_API_KEY) {
  throw new Error('BROWSERBASE_API_KEY environment variable is required');
}

if (!process.env.BROWSERBASE_PROJECT_ID) {
  throw new Error('BROWSERBASE_PROJECT_ID environment variable is required');
}

const bb = new Browserbase({
  apiKey: process.env.BROWSERBASE_API_KEY,
});

const projectId = process.env.BROWSERBASE_PROJECT_ID;

/**
 * Get or create a persistent Steel context for a user.
 * Contexts store cookies, localStorage, etc. forever (no expiry).
 *
 * @returns The database ID (BrowserContext.id) for use as foreign key
 */
export async function getOrCreateContext(userId: string): Promise<string> {
  // Check DB for existing context
  const existing = await prisma.browserContext.findUnique({
    where: { userId },
  });

  if (existing) {
    log.info('Using existing context', { userId, contextId: existing.contextId });
    return existing.id; // ✅ Return database ID (for foreign key)
  }

  // Create new context in Steel
  log.info('Creating new context', { userId });
  const bbContext = await bb.contexts.create({ projectId });

  // Save to DB
  const dbContext = await prisma.browserContext.create({
    data: {
      userId,
      contextId: bbContext.id,
    },
  });

  log.info('Created new context', { contextId: bbContext.id });
  return dbContext.id; // ✅ Return database ID (for foreign key)
}

/**
 * Create a new browser session with persistent context.
 * Sessions are temporary and billed per minute.
 *
 * @param dbContextId - The database ID (BrowserContext.id) for the foreign key
 * @param agentId - The agent creating this session
 */
export async function createSessionWithContext(
  dbContextId: string,
  agentId: string
): Promise<{ sessionId: string; debugUrl: string; taskId: string; wsUrl: string }> {
  log.info('Creating browser session', { dbContextId });

  // Look up the Steel context ID from database
  const dbContext = await prisma.browserContext.findUnique({
    where: { id: dbContextId },
  });

  if (!dbContext) {
    throw new Error(`Browser context not found: ${dbContextId}`);
  }
  if (!dbContext.contextId) {
    throw new Error(`Browserbase context has no provider context ID: ${dbContextId}`);
  }

  // Create session in Steel using the Steel context ID
  // Create Steel session with context, proxies, and NYC geolocation
  // Documentation: https://docs.browserbase.com/features/proxies
  const session = await bb.sessions.create({
    projectId,
    browserSettings: {
      context: {
        id: dbContext.contextId, // ← Use Steel context ID
        persist: true, // Save state back to context on close
      },
      viewport: {
        width: 1280, // WXGA standard
        height: 800,
      },
    },
    proxies: [
      {
        type: 'browserbase',
        geolocation: {
          city: 'NEW_YORK', // Steel uses UPPER_CASE format
          state: 'NY',
          country: 'US',
        },
      },
    ],
    keepAlive: true, // Keep session alive - we'll close it explicitly when done
  });

  // Get the authenticated live view URLs (debugger, fullscreen, websocket)
  const liveUrls = await bb.sessions.debug(session.id);
  log.info('Live URLs', { liveUrls: logJson(liveUrls) });

  // Use debuggerFullscreenUrl for embedding (no Steel chrome, just the browser)
  const debugUrl = liveUrls.debuggerFullscreenUrl || liveUrls.debuggerUrl;

  // CDP WebSocket URL for browser-use/Playwright connection
  const wsUrl = liveUrls.wsUrl;

  // Save to DB with database context ID and wsUrl
  const dbSession = await prisma.browserSession.create({
    data: {
      contextId: dbContextId, // ← Use database context ID for foreign key
      agentId,
      sessionId: session.id,
      debugUrl,
      wsUrl, // ← Save for session retrieval
      status: 'ACTIVE',
    },
  });

  log.info('Created session', {
    sessionId: session.id,
    contextDb: dbContextId,
    contextBb: dbContext.contextId,
    debugUrl,
    wsUrl,
  });

  return {
    sessionId: session.id,
    debugUrl,
    wsUrl, // ← Return for agent to connect via CDP
    taskId: dbSession.id, // Stable ID for grouping browser actions
  };
}

/**
 * Close a browser session (stops billing, saves context state).
 * @param pause - If true, sets status to PAUSED (resumable). If false, sets to CLOSED (terminal).
 * @param currentUrl - Current page URL to save for resume (optional).
 */
export async function closeSession(
  sessionId: string,
  pause: boolean = false,
  currentUrl?: string
): Promise<void> {
  log.info(pause ? 'Pausing browser session' : 'Closing browser session', { sessionId });

  let releaseError: unknown = null;
  try {
    // Close in Steel by requesting release (saves context state, stops billing)
    await bb.sessions.update(sessionId, {
      projectId,
      status: 'REQUEST_RELEASE',
    });
  } catch (error) {
    releaseError = error;
    log.error('Failed to close session in Steel', {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    });
  }

  // Update DB
  log.info('Updating DB with currentUrl', { currentUrl: currentUrl || 'NONE' });
  await prisma.browserSession.update({
    where: { sessionId },
    data: {
      status: releaseError === null ? (pause ? 'PAUSED' : 'CLOSED') : pause ? 'ACTIVE' : 'ERROR',
      closedAt: releaseError === null && !pause ? new Date() : null,
      currentUrl: currentUrl || undefined, // Save URL if provided
    },
  });

  if (releaseError !== null) throw releaseError;

  log.info(pause ? 'Session paused (resumable)' : 'Session closed (terminal)', { sessionId });
  if (currentUrl) {
    log.info('Saved current URL to DB', { currentUrl });
  } else {
    log.warn('No currentUrl to save', { sessionId });
  }
}

/**
 * Resume a paused browser session by creating a NEW session with the same context.
 * The task ID stays the same, but we get a new Steel session ID.
 * @param taskId - The stable task ID (BrowserSession.id)
 * @returns Session info including saved URL to navigate back to
 */
export async function resumeSession(
  taskId: string
): Promise<{ debugUrl: string; sessionId: string; wsUrl: string; savedUrl?: string }> {
  log.info('Resuming browser task', { taskId });

  // Look up the old session to get context
  const oldSession = await prisma.browserSession.findUnique({
    where: { id: taskId },
    include: { context: true },
  });

  if (!oldSession) {
    throw new Error(`Browser task not found: ${taskId}`);
  }
  if (!oldSession.context.contextId) {
    throw new Error(`Browserbase context has no provider context ID: ${oldSession.context.id}`);
  }

  log.info('Found old session', { currentUrl: oldSession.currentUrl || 'NONE' });

  // Create NEW Steel session with same context, proxies, and NYC geolocation
  // Documentation: https://docs.browserbase.com/features/proxies
  const session = await bb.sessions.create({
    projectId,
    browserSettings: {
      context: {
        id: oldSession.context.contextId, // Same Steel context
        persist: true,
      },
      viewport: {
        width: 1280, // WXGA standard
        height: 800,
      },
    },
    proxies: [
      {
        type: 'browserbase',
        geolocation: {
          city: 'NEW_YORK', // Steel uses UPPER_CASE format
          state: 'NY',
          country: 'US',
        },
      },
    ],
    keepAlive: true,
  });

  log.info('Created new Steel session', { sessionId: session.id });

  // Get debug URLs for new session
  const liveUrls = await bb.sessions.debug(session.id);
  const debugUrl = liveUrls.debuggerFullscreenUrl || liveUrls.debuggerUrl;
  const wsUrl = liveUrls.wsUrl;

  // Navigate to saved URL so user can interact from where agent left off
  if (oldSession.currentUrl) {
    log.info('Navigating session to saved URL', { currentUrl: oldSession.currentUrl });
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.connectOverCDP(liveUrls.wsUrl);
      const context = browser.contexts()[0];
      const page = context.pages()[0];
      await page.goto(oldSession.currentUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
      log.info('Navigation complete', { currentUrl: oldSession.currentUrl });
      // Note: Not calling browser.close() - let connection drop naturally
      // Calling browser.close() causes Steel to terminate the session
    } catch (navError) {
      log.error('Failed to navigate to saved URL', {
        error: navError instanceof Error ? navError.message : String(navError),
        currentUrl: oldSession.currentUrl,
      });
      // Continue anyway - user can navigate manually
    }
  }

  // Update DB record with NEW sessionId, debugUrl, and wsUrl
  await prisma.browserSession.update({
    where: { id: taskId },
    data: {
      sessionId: session.id, // NEW Steel session ID
      debugUrl,
      wsUrl, // CDP WebSocket URL
      status: 'ACTIVE',
      closedAt: null,
    },
  });

  log.info('Task resumed with new session', {
    taskId,
    sessionId: session.id,
    contextId: oldSession.context.contextId,
    debugUrl,
    wsUrl,
  });

  // Return the saved URL to navigate back to
  return {
    debugUrl,
    sessionId: session.id,
    wsUrl, // CDP WebSocket URL for browser-use
    savedUrl: oldSession.currentUrl || oldSession.startUrl || undefined,
  };
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
 * Cookie data structure from mac-app
 */
interface StoredCookie {
  host_key: string;
  name: string;
  value: string;
  path: string;
  expires_utc: number;
  is_secure: boolean;
  is_httponly: boolean;
}

/**
 * Inject user's stored Chrome cookies into a browser session.
 * Should be called after session creation to restore authentication state.
 *
 * @param sessionId - The BrowserBase session ID
 * @param userId - The user's ID to fetch cookies for
 * @returns Object with injected count and whether cookies were found
 */
export async function injectUserCookies(
  sessionId: string,
  userId: string
): Promise<{ injected: boolean; cookieCount: number }> {
  log.info('Checking for stored cookies', { userId });

  // Fetch user's chrome_cookies integration
  const integration = await prisma.integration.findUnique({
    where: {
      userId_name_accountId: {
        userId,
        name: 'chrome_cookies',
        accountId: '',
      },
    },
  });

  if (!integration || !integration.config) {
    log.info('No chrome_cookies integration found for user', { userId });
    return { injected: false, cookieCount: 0 };
  }

  const config = integration.config as { cookies?: StoredCookie[] };
  if (!config.cookies || !Array.isArray(config.cookies) || config.cookies.length === 0) {
    log.info('No cookies stored in integration', { userId });
    return { injected: false, cookieCount: 0 };
  }

  log.info('Found stored cookies, injecting', { count: config.cookies.length });

  try {
    // Get the session's websocket URL
    const liveUrls = await bb.sessions.debug(sessionId);

    // Connect to the session via Playwright
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(liveUrls.wsUrl);
    const context = browser.contexts()[0];

    // Transform cookies to Playwright format
    // Playwright cookie format: https://playwright.dev/docs/api/class-browsercontext#browser-context-add-cookies
    const playwrightCookies = config.cookies.map((cookie: StoredCookie) => {
      // Chrome stores expiry as microseconds since Windows epoch (Jan 1, 1601)
      // Playwright expects Unix timestamp in seconds
      // Chrome epoch to Unix epoch offset: 11644473600 seconds
      // Chrome stores in microseconds, so divide by 1,000,000
      const CHROME_EPOCH_OFFSET = 11644473600;
      let expires: number | undefined;

      if (cookie.expires_utc && cookie.expires_utc > 0) {
        // Convert from Chrome's microseconds-since-1601 to Unix timestamp
        expires = Math.floor(cookie.expires_utc / 1000000) - CHROME_EPOCH_OFFSET;
        // If expiry is in the past, skip setting it (let it be a session cookie)
        if (expires < Date.now() / 1000) {
          expires = undefined;
        }
      }

      return {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.host_key,
        path: cookie.path || '/',
        expires,
        secure: cookie.is_secure,
        httpOnly: cookie.is_httponly,
        sameSite: 'Lax' as const, // Default to Lax for compatibility
      };
    });

    // Filter out cookies with empty names or values (invalid)
    const validCookies = playwrightCookies.filter((c) => c.name && c.value);

    // Inject cookies in batches to avoid overwhelming
    const BATCH_SIZE = 100;
    let injectedCount = 0;

    for (let i = 0; i < validCookies.length; i += BATCH_SIZE) {
      const batch = validCookies.slice(i, i + BATCH_SIZE);
      try {
        await context.addCookies(batch);
        injectedCount += batch.length;
      } catch (batchError) {
        log.error('Failed to inject cookie batch', {
          error: batchError instanceof Error ? batchError.message : String(batchError),
          batchStart: i,
          batchEnd: i + batch.length,
        });
        // Continue with other batches
      }
    }

    log.info('Injected cookies', { injectedCount, totalCount: validCookies.length });

    // Don't close browser - let connection drop naturally
    // Closing would terminate the Steel session

    return { injected: true, cookieCount: injectedCount };
  } catch (error) {
    log.error('Failed to inject cookies', {
      error: error instanceof Error ? error.message : String(error),
      userId,
    });
    return { injected: false, cookieCount: 0 };
  }
}

/**
 * Close all active browser sessions (for cleanup).
 * Returns count of sessions closed.
 */
export async function closeAllActiveSessions(): Promise<number> {
  log.info('Finding all active browser sessions');

  const activeSessions = await prisma.browserSession.findMany({
    where: { status: 'ACTIVE' },
    select: { sessionId: true, agentId: true },
  });

  log.info('Found active sessions', { count: activeSessions.length });

  if (activeSessions.length === 0) {
    return 0;
  }

  let closedCount = 0;

  for (const session of activeSessions) {
    if (session.sessionId === null) continue;
    try {
      log.info('Closing session', { sessionId: session.sessionId, agentId: session.agentId });
      await closeSession(session.sessionId);
      closedCount++;
    } catch (error) {
      log.error('Failed to close session', {
        error: error instanceof Error ? error.message : String(error),
        sessionId: session.sessionId,
      });
      // Continue with other sessions even if one fails
    }
  }

  log.info('Closed sessions', { closedCount, totalCount: activeSessions.length });

  return closedCount;
}
