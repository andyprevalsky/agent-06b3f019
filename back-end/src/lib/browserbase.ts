import { Browserbase } from '@browserbasehq/sdk';
import { prisma } from './prisma';

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
 * Get or create a persistent Browserbase context for a user.
 * Contexts store cookies, localStorage, etc. forever (no expiry).
 * 
 * @returns The database ID (BrowserContext.id) for use as foreign key
 */
export async function getOrCreateContext(userId: string): Promise<string> {
  // Check DB for existing context
  const existing = await prisma.browserContext.findUnique({
    where: { userId }
  });
  
  if (existing) {
    console.log(`✓ Using existing context for user ${userId}: ${existing.contextId}`);
    return existing.id;  // ✅ Return database ID (for foreign key)
  }
  
  // Create new context in Browserbase
  console.log(`Creating new context for user ${userId}...`);
  const bbContext = await bb.contexts.create({ projectId });
  
  // Save to DB
  const dbContext = await prisma.browserContext.create({
    data: {
      userId,
      contextId: bbContext.id
    }
  });
  
  console.log(`✓ Created new context: ${bbContext.id}`);
  return dbContext.id;  // ✅ Return database ID (for foreign key)
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
): Promise<{ sessionId: string; debugUrl: string; taskId: string }> {
  console.log(`Creating browser session for context ${dbContextId}...`);
  
  // Look up the BrowserBase context ID from database
  const dbContext = await prisma.browserContext.findUnique({
    where: { id: dbContextId }
  });
  
  if (!dbContext) {
    throw new Error(`Browser context not found: ${dbContextId}`);
  }
  
  // Create session in BrowserBase using the BrowserBase context ID
  // Create BrowserBase session with context, proxies, and NYC geolocation
  // Documentation: https://docs.browserbase.com/features/proxies
  const session = await bb.sessions.create({
    projectId,
    browserSettings: {
      context: {
        id: dbContext.contextId,  // ← Use BrowserBase context ID
        persist: true, // Save state back to context on close
      },
      viewport: {
        width: 1288,  // ← Stagehand default for Computer Use models (Gemini 2.5)
        height: 711,  // ← Must match or coordinates will be misaligned
      },
    },
    proxies: [
      {
        type: "browserbase",
        geolocation: {
          city: "NEW_YORK",  // BrowserBase uses UPPER_CASE format
          state: "NY",
          country: "US"
        }
      }
    ],
    keepAlive: true, // Keep session alive - we'll close it explicitly when done
    timeout: 7200,  // 2 hours in seconds
  });
  
  // Get the authenticated live view URLs (debugger, fullscreen, websocket)
  const liveUrls = await bb.sessions.debug(session.id);
  console.log('📺 Live URLs:', JSON.stringify(liveUrls, null, 2));
  
  // Use debuggerFullscreenUrl for embedding (no BrowserBase chrome, just the browser)
  const debugUrl = liveUrls.debuggerFullscreenUrl || liveUrls.debuggerUrl;
  
  // Save to DB with database context ID
  const dbSession = await prisma.browserSession.create({
    data: {
      contextId: dbContextId,  // ← Use database context ID for foreign key
      agentId,
      sessionId: session.id,
      debugUrl,
      status: 'ACTIVE',
    }
  });
  
  console.log(`✓ Created session: ${session.id}`);
  console.log(`  Context (DB): ${dbContextId}`);
  console.log(`  Context (BB): ${dbContext.contextId}`);
  console.log(`  Live View URL: ${debugUrl}`);
  
  return {
    sessionId: session.id,
    debugUrl,
    taskId: dbSession.id,  // Stable ID for grouping browser actions
  };
}

/**
 * Close a browser session (stops billing, saves context state).
 * @param pause - If true, sets status to PAUSED (resumable). If false, sets to CLOSED (terminal).
 * @param currentUrl - Current page URL to save for resume (optional).
 */
export async function closeSession(sessionId: string, pause: boolean = false, currentUrl?: string): Promise<void> {
  console.log(`${pause ? 'Pausing' : 'Closing'} browser session ${sessionId}...`);
  
  try {
    // Close in Browserbase by requesting release (saves context state, stops billing)
    await bb.sessions.update(sessionId, {
      projectId,
      status: 'REQUEST_RELEASE'
    });
  } catch (error) {
    console.error(`Failed to close session in Browserbase:`, error);
    // Continue to update DB even if Browserbase call fails
  }
  
  // Update DB
  console.log(`📝 Updating DB with currentUrl: ${currentUrl || 'NONE'}`);
  await prisma.browserSession.update({
    where: { sessionId },
    data: {
      status: pause ? 'PAUSED' : 'CLOSED',
      closedAt: pause ? undefined : new Date(), // Only set closedAt for terminal close
      currentUrl: currentUrl || undefined,  // Save URL if provided
    }
  });
  
  console.log(`✓ Session ${pause ? 'paused (resumable)' : 'closed (terminal)'}`);
  if (currentUrl) {
    console.log(`  ✅ Saved current URL to DB: ${currentUrl}`);
  } else {
    console.log(`  ⚠️ No currentUrl to save`);
  }
}

/**
 * Resume a paused browser session by creating a NEW session with the same context.
 * The task ID stays the same, but we get a new BrowserBase session ID.
 * @param taskId - The stable task ID (BrowserSession.id)
 * @returns Session info including saved URL to navigate back to
 */
export async function resumeSession(taskId: string): Promise<{ debugUrl: string; sessionId: string; savedUrl?: string }> {
  console.log(`Resuming browser task ${taskId}...`);
  
  // Look up the old session to get context
  const oldSession = await prisma.browserSession.findUnique({
    where: { id: taskId },
    include: { context: true }
  });
  
  if (!oldSession) {
    throw new Error(`Browser task not found: ${taskId}`);
  }
  
  console.log(`  Found old session with currentUrl: ${oldSession.currentUrl || 'NONE'}`);
  
  // Create NEW BrowserBase session with same context, proxies, and NYC geolocation
  // Documentation: https://docs.browserbase.com/features/proxies
  const session = await bb.sessions.create({
    projectId,
    browserSettings: {
      context: {
        id: oldSession.context.contextId,  // Same BrowserBase context
        persist: true,
      },
      viewport: {
        width: 1288,
        height: 711,
      },
    },
    proxies: [
      {
        type: "browserbase",
        geolocation: {
          city: "NEW_YORK",  // BrowserBase uses UPPER_CASE format
          state: "NY",
          country: "US"
        }
      }
    ],
    keepAlive: true,
    timeout: 7200,  // 2 hours in seconds
  });
  
  console.log(`  ✓ Created new BrowserBase session: ${session.id}`);
  
  // Get debug URLs for new session
  const liveUrls = await bb.sessions.debug(session.id);
  const debugUrl = liveUrls.debuggerFullscreenUrl || liveUrls.debuggerUrl;
  
  // Navigate to saved URL so user can interact from where agent left off
  if (oldSession.currentUrl) {
    console.log(`  📍 Navigating session to saved URL: ${oldSession.currentUrl}`);
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.connectOverCDP(liveUrls.wsUrl);
      const context = browser.contexts()[0];
      const page = context.pages()[0];
      await page.goto(oldSession.currentUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
      console.log(`  ✅ Navigation complete`);
      // Note: Not calling browser.close() - let connection drop naturally
      // Calling browser.close() causes BrowserBase to terminate the session
    } catch (navError) {
      console.error(`  ⚠️ Failed to navigate to saved URL:`, navError);
      // Continue anyway - user can navigate manually
    }
  }
  
  // Update DB record with NEW sessionId and debugUrl
  await prisma.browserSession.update({
    where: { id: taskId },
    data: {
      sessionId: session.id,  // NEW BrowserBase session ID
      debugUrl,
      status: 'ACTIVE',
      closedAt: null,
    }
  });
  
  console.log(`✓ Task resumed with new session`);
  console.log(`  Task ID (stable): ${taskId}`);
  console.log(`  New session ID: ${session.id}`);
  console.log(`  Context ID: ${oldSession.context.contextId}`);
  console.log(`  New debug URL: ${debugUrl}`);
  
  // Return the saved URL to navigate back to
  return { 
    debugUrl, 
    sessionId: session.id, 
    savedUrl: oldSession.currentUrl || undefined 
  };
}

/**
 * Get session info from database.
 */
export async function getSession(sessionId: string) {
  return await prisma.browserSession.findUnique({
    where: { sessionId },
    include: { context: true }
  });
}

/**
 * Close all active browser sessions (for cleanup).
 * Returns count of sessions closed.
 */
export async function closeAllActiveSessions(): Promise<number> {
  console.log('🌐 Finding all active browser sessions...');
  
  const activeSessions = await prisma.browserSession.findMany({
    where: { status: 'ACTIVE' },
    select: { sessionId: true, agentId: true }
  });
  
  console.log(`   Found ${activeSessions.length} active session(s)`);
  
  if (activeSessions.length === 0) {
    return 0;
  }
  
  let closedCount = 0;
  
  for (const session of activeSessions) {
    try {
      console.log(`   Closing session ${session.sessionId} (agent: ${session.agentId})...`);
      await closeSession(session.sessionId);
      closedCount++;
    } catch (error) {
      console.error(`   ⚠️  Failed to close session ${session.sessionId}:`, error);
      // Continue with other sessions even if one fails
    }
  }
  
  console.log(`✅ Closed ${closedCount}/${activeSessions.length} session(s)`);
  
  return closedCount;
}

