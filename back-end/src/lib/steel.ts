import Steel from 'steel-sdk';
import { prisma } from './prisma';

// Validate required environment variables
if (!process.env.STEEL_API_KEY) {
  throw new Error('STEEL_API_KEY environment variable is required');
}

const steel = new Steel({
  steelAPIKey: process.env.STEEL_API_KEY,
});

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
    where: { userId }
  });

  if (existing) {
    console.log(`✓ Using existing context for user ${userId}: ${existing.contextId || '(no profile yet)'}`);
    return existing.id;  // Return database ID (for foreign key)
  }

  // Create DB record - Steel profile will be created on first session with persistProfile=true
  console.log(`Creating new browser context for user ${userId}...`);
  const dbContext = await prisma.browserContext.create({
    data: {
      userId,
      contextId: ''  // Will be populated after first session releases
    }
  });

  console.log(`✓ Created browser context: ${dbContext.id} (Steel profile will be created on first session)`);
  return dbContext.id;  // Return database ID (for foreign key)
}

/**
 * Create a new browser session with persistent context.
 *
 * @param dbContextId - The database ID (BrowserContext.id) for the foreign key
 * @param agentId - The agent creating this session
 */
export async function createSessionWithContext(
  dbContextId: string,
  agentId: string
): Promise<{ sessionId: string; debugUrl: string; taskId: string; wsUrl: string }> {
  console.log(`Creating Steel browser session for context ${dbContextId}...`);

  // Look up the Steel profile ID from database
  const dbContext = await prisma.browserContext.findUnique({
    where: { id: dbContextId }
  });

  if (!dbContext) {
    throw new Error(`Browser context not found: ${dbContextId}`);
  }

  // Create session in Steel with viewport adjusted for browser chrome
  // Steel's headful mode has ~91px chrome (toolbar). To get 1280x800 content area:
  // - Width: 1280 + 8 = 1288 (fine-tuned: was 1303→1295, need -15)
  // - Height: 800 + 91 = 891 (accounts for browser toolbar) ✓ working
  const session = await steel.sessions.create({
    profileId: dbContext.contextId || undefined,  // Use existing profile if available
    persistProfile: true,  // Auto-persist browser state to profile on session close
    useProxy: true,  // Enable Steel's proxy network
    solveCaptcha: true,  // Auto-solve CAPTCHAs
    timeout: 900000,  // 15 minutes
    dimensions: {
      width: 1288,  // 1280 + 8 for borders → 1280 viewport
      height: 891,  // 800 + 91 for browser chrome → 800 viewport
    },
  });

  console.log('📺 Steel Session:', JSON.stringify(session, null, 2));

  // Steel provides debugUrl for unauthenticated live viewing (anyone with URL can view)
  // sessionViewerUrl requires Steel dashboard login - don't use that
  // Add ?interactive=true so users can interact with the browser
  const debugUrl = `${session.debugUrl}?interactive=false`;

  // IMPORTANT: Per Steel docs, CDP connection URL must include apiKey parameter
  // The session.websocketUrl does NOT include the apiKey, so we construct it manually
  // Format: wss://connect.steel.dev?apiKey=${STEEL_API_KEY}&sessionId=${session.id}
  const wsUrl = `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`;

  // If this was the first session (no profileId existed), Steel created one - save it
  if (session.profileId && session.profileId !== dbContext.contextId) {
    console.log(`  📝 Saving new Steel profileId: ${session.profileId}`);
    await prisma.browserContext.update({
      where: { id: dbContextId },
      data: { contextId: session.profileId }
    });
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
    }
  });

  console.log(`✓ Created Steel session: ${session.id}`);
  console.log(`  Context (DB): ${dbContextId}`);
  console.log(`  Profile (Steel): ${session.profileId || 'will be created on release'}`);
  console.log(`  Live View URL: ${debugUrl}`);
  console.log(`  CDP WebSocket URL: ${wsUrl}`);

  return {
    sessionId: session.id,
    debugUrl,
    wsUrl,
    taskId: dbSession.id,
  };
}

/**
 * Close a browser session.
 * @param pause - If true, sets status to PAUSED (resumable). If false, sets to CLOSED (terminal).
 * @param currentUrl - Current page URL to save for resume (optional).
 */
export async function closeSession(sessionId: string, pause: boolean = false, currentUrl?: string): Promise<void> {
  console.log(`${pause ? 'Pausing' : 'Closing'} Steel session ${sessionId}...`);

  try {
    // Release the Steel session
    await steel.sessions.release(sessionId);
  } catch (error) {
    console.error(`Failed to close session in Steel:`, error);
    // Continue to update DB even if Steel call fails
  }

  // Update DB
  console.log(`📝 Updating DB with currentUrl: ${currentUrl || 'NONE'}`);
  await prisma.browserSession.update({
    where: { sessionId },
    data: {
      status: pause ? 'PAUSED' : 'CLOSED',
      closedAt: pause ? undefined : new Date(),
      currentUrl: currentUrl || undefined,
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
 * Resume a paused browser session by creating a NEW session with the same profile.
 * @param taskId - The stable task ID (BrowserSession.id)
 * @returns Session info including saved URL to navigate back to
 */
export async function resumeSession(taskId: string): Promise<{ debugUrl: string; sessionId: string; wsUrl: string; savedUrl?: string }> {
  console.log(`Resuming browser task ${taskId}...`);

  // Look up the old session to get context/profile
  const oldSession = await prisma.browserSession.findUnique({
    where: { id: taskId },
    include: { context: true }
  });

  if (!oldSession) {
    throw new Error(`Browser task not found: ${taskId}`);
  }

  console.log(`  Found old session with currentUrl: ${oldSession.currentUrl || 'NONE'}`);

  // Create NEW Steel session with same profile
  // Dimensions adjusted for browser chrome (see createSessionWithContext comments)
  const session = await steel.sessions.create({
    profileId: oldSession.context.contextId,
    useProxy: true,
    solveCaptcha: true,
    timeout: 900000,  // 15 minutes (hobby plan max)
    dimensions: {
      width: 1288,  // 1280 + 8 for borders → 1280 viewport
      height: 891,  // 800 + 91 for browser chrome → 800 viewport
    },
  });

  console.log(`  ✓ Created new Steel session: ${session.id}`);

  // Use debugUrl for unauthenticated live viewing (not sessionViewerUrl which requires login)
  const debugUrl = `${session.debugUrl}?interactive=false`;
  // IMPORTANT: Per Steel docs, CDP connection URL must include apiKey parameter
  const wsUrl = `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`;

  // Navigate to saved URL if available
  if (oldSession.currentUrl) {
    console.log(`  📍 Navigating session to saved URL: ${oldSession.currentUrl}`);
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.connectOverCDP(wsUrl);
      const context = browser.contexts()[0];
      const page = context.pages()[0];
      await page.goto(oldSession.currentUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
      console.log(`  ✅ Navigation complete`);
    } catch (navError) {
      console.error(`  ⚠️ Failed to navigate to saved URL:`, navError);
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
    }
  });

  console.log(`✓ Task resumed with new session`);
  console.log(`  Task ID (stable): ${taskId}`);
  console.log(`  New session ID: ${session.id}`);
  console.log(`  Profile ID: ${oldSession.context.contextId}`);
  console.log(`  New debug URL: ${debugUrl}`);
  console.log(`  CDP WebSocket URL: ${wsUrl}`);

  return {
    debugUrl,
    sessionId: session.id,
    wsUrl,
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
 *
 * @param sessionId - The Steel session ID
 * @param userId - The user's ID to fetch cookies for
 * @returns Object with injected count and whether cookies were found
 */
export async function injectUserCookies(
  sessionId: string,
  userId: string
): Promise<{ injected: boolean; cookieCount: number }> {
  console.log(`🍪 Checking for stored cookies for user ${userId}...`);

  // Fetch user's chrome_cookies integration
  const integration = await prisma.integration.findUnique({
    where: {
      userId_name: {
        userId,
        name: 'chrome_cookies',
      },
    },
  });

  if (!integration || !integration.config) {
    console.log(`  No chrome_cookies integration found for user`);
    return { injected: false, cookieCount: 0 };
  }

  const config = integration.config as { cookies?: StoredCookie[] };
  if (!config.cookies || !Array.isArray(config.cookies) || config.cookies.length === 0) {
    console.log(`  No cookies stored in integration`);
    return { injected: false, cookieCount: 0 };
  }

  console.log(`  Found ${config.cookies.length} stored cookies, injecting...`);

  try {
    // Get session info to get WebSocket URL
    const dbSession = await prisma.browserSession.findUnique({
      where: { sessionId }
    });

    if (!dbSession?.wsUrl) {
      throw new Error('No WebSocket URL found for session');
    }

    // Connect via Playwright
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(dbSession.wsUrl);
    const context = browser.contexts()[0];

    // Transform cookies to Playwright format
    const playwrightCookies = config.cookies.map((cookie: StoredCookie) => {
      const CHROME_EPOCH_OFFSET = 11644473600;
      let expires: number | undefined;

      if (cookie.expires_utc && cookie.expires_utc > 0) {
        expires = Math.floor(cookie.expires_utc / 1000000) - CHROME_EPOCH_OFFSET;
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
        sameSite: 'Lax' as const,
      };
    });

    // Filter out invalid cookies
    const validCookies = playwrightCookies.filter(c => c.name && c.value);

    // Inject cookies in batches
    const BATCH_SIZE = 100;
    let injectedCount = 0;

    for (let i = 0; i < validCookies.length; i += BATCH_SIZE) {
      const batch = validCookies.slice(i, i + BATCH_SIZE);
      try {
        await context.addCookies(batch);
        injectedCount += batch.length;
      } catch (batchError) {
        console.error(`  ⚠️ Failed to inject cookie batch ${i}-${i + batch.length}:`, batchError);
      }
    }

    console.log(`  ✅ Injected ${injectedCount}/${validCookies.length} cookies`);

    return { injected: true, cookieCount: injectedCount };
  } catch (error) {
    console.error(`  ❌ Failed to inject cookies:`, error);
    return { injected: false, cookieCount: 0 };
  }
}

/**
 * Upload a file to an active Steel session.
 *
 * @param sessionId - The Steel session ID
 * @param fileBuffer - The file content as a Buffer
 * @param filename - The original filename
 * @param mimeType - The MIME type of the file
 * @returns The remote path where the file is available in the session
 */
export async function uploadFileToSession(
  sessionId: string,
  fileBuffer: Buffer,
  filename: string,
  mimeType: string = 'application/octet-stream'
): Promise<{ path: string; size: number }> {
  console.log(`📎 Uploading file '${filename}' to Steel session ${sessionId}...`);

  try {
    // Steel SDK expects a File or Blob object, NOT a Node.js Readable stream
    // Using File (available in Node.js 20+) which includes filename metadata
    const file = new File([fileBuffer], filename, { type: mimeType });

    const uploadedFile = await steel.sessions.files.upload(sessionId, {
      file: file,
    });

    console.log(`  ✅ Uploaded ${filename} -> ${uploadedFile.path} (${uploadedFile.size} bytes)`);

    return {
      path: uploadedFile.path,
      size: uploadedFile.size || fileBuffer.length
    };
  } catch (error) {
    console.error(`  ❌ Failed to upload file '${filename}':`, error);
    throw error;
  }
}

/**
 * File info returned by Steel's files.list() API
 */
export interface SteelFileInfo {
  path: string;
  size: number;
  lastModified?: string;
}

/**
 * List all files in a Steel browser session.
 * This includes files downloaded by the browser and any uploaded files.
 *
 * @param sessionId - The Steel session ID
 * @returns Array of file info objects
 */
export async function listSessionFiles(sessionId: string): Promise<SteelFileInfo[]> {
  console.log(`📂 Listing files in Steel session ${sessionId}...`);

  try {
    const filesResponse = await steel.sessions.files.list(sessionId);

    // Steel SDK returns an object with data or files array, extract it
    const files = (filesResponse as any).data || (filesResponse as any).files || (filesResponse as unknown as any[]) || [];

    console.log(`  ✅ Found ${files.length} file(s)`);
    for (const file of files) {
      console.log(`    - ${file.path} (${file.size} bytes)`);
    }

    return files.map((f: any) => ({
      path: f.path,
      size: f.size || 0,
      lastModified: f.lastModified,
    }));
  } catch (error) {
    console.error(`  ❌ Failed to list files:`, error);
    // Return empty array on error (session may have no files)
    return [];
  }
}

/**
 * Close all active browser sessions (for cleanup).
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
    }
  }

  console.log(`✅ Closed ${closedCount}/${activeSessions.length} session(s)`);

  return closedCount;
}
