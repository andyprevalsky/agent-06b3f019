import Steel from 'steel-sdk';
import { prisma } from './prisma';
import { logJson } from './log';
import { ProxyGeoLocation, DEFAULT_GEOLOCATION } from './geoip';

// Validate required environment variables
if (!process.env.STEEL_API_KEY) {
  throw new Error('STEEL_API_KEY environment variable is required');
}

const steel = new Steel({
  steelAPIKey: process.env.STEEL_API_KEY,
});

// Max retries when session validation fails
const MAX_SESSION_RETRIES = 3;
const SESSION_VALIDATION_TIMEOUT = 10000; // 10 seconds

// WebSocket connection retry config
const WS_CONNECTION_RETRIES = 3;
const WS_BACKOFF_DELAYS = [100, 400, 800]; // ms

/**
 * Sleep helper for backoff delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

  console.log(`  🔍 Validating session connection (up to ${WS_CONNECTION_RETRIES} attempts)...`);

  for (let attempt = 1; attempt <= WS_CONNECTION_RETRIES; attempt++) {
    let browser;

    try {
      console.log(`    [WS] Attempt ${attempt}/${WS_CONNECTION_RETRIES}: Connecting to CDP...`);

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
        console.log(`    [WS] Attempt ${attempt}/${WS_CONNECTION_RETRIES}: ❌ No browser contexts available`);
        await browser.close().catch(() => {});

        if (attempt < WS_CONNECTION_RETRIES) {
          const delay = WS_BACKOFF_DELAYS[attempt - 1];
          console.log(`    [WS] Retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }
        return false;
      }

      // Try to get pages - this confirms the connection is working
      const pages = contexts[0].pages();
      console.log(`    [WS] Attempt ${attempt}/${WS_CONNECTION_RETRIES}: ✅ Connected (${contexts.length} context(s), ${pages.length} page(s))`);

      await browser.close().catch(() => {});
      return true;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.log(`    [WS] Attempt ${attempt}/${WS_CONNECTION_RETRIES}: ❌ ${errorMsg}`);

      if (browser) {
        await browser.close().catch(() => {});
      }

      if (attempt < WS_CONNECTION_RETRIES) {
        const delay = WS_BACKOFF_DELAYS[attempt - 1];
        console.log(`    [WS] Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  console.log(`  ❌ Session validation failed after ${WS_CONNECTION_RETRIES} attempts`);
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
  console.log(`Creating Steel browser session for context ${dbContextId}...`);
  console.log(`  Proxy geolocation: ${geolocation.city}, ${geolocation.state}, ${geolocation.country}`);

  // Look up the Steel profile ID from database
  const dbContext = await prisma.browserContext.findUnique({
    where: { id: dbContextId }
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
    console.log(`  Using user's fingerprint User-Agent: ${userAgent.substring(0, 60)}...`);
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_SESSION_RETRIES; attempt++) {
    console.log(`  📡 Session creation attempt ${attempt}/${MAX_SESSION_RETRIES}...`);

    try {
      // Create session in Steel with viewport adjusted for browser chrome
      // Steel's headful mode has ~91px chrome (toolbar). To get 1280x800 content area:
      // - Width: 1280 + 8 = 1288 (fine-tuned: was 1303→1295, need -15)
      // - Height: 800 + 91 = 891 (accounts for browser toolbar) ✓ working
      const session = await steel.sessions.create({
        profileId: dbContext.contextId || undefined,  // Use existing profile if available
        persistProfile: true,  // Auto-persist browser state to profile on session close
        userAgent: userAgent || undefined,  // Use user's real User-Agent from fingerprint
        useProxy: {
          geolocation: {
            country: geolocation.country,
            state: geolocation.state,
            city: geolocation.city,
          },
        },  // Residential proxy based on user's location
        solveCaptcha: true,  // Auto-solve CAPTCHAs
        stealthConfig: {
          humanizeInteractions: false,  // Disabled - we handle humanization with BrowserHumanizer
          skipFingerprintInjection: true,  // We inject user's real fingerprint ourselves
        },
        timeout: 900000,  // 15 minutes
        dimensions: {
          width: 1288,  // 1280 + 8 for borders → 1280 viewport
          height: 891,  // 800 + 91 for browser chrome → 800 viewport
        },
      });

      console.log('📺 Steel Session:', logJson(session));

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
        console.log(`  ⚠️ Session ${session.id} failed validation, releasing...`);
        try {
          await steel.sessions.release(session.id);
        } catch (releaseErr) {
          console.log(`  ⚠️ Failed to release invalid session: ${releaseErr}`);
        }
        lastError = new Error(`Session validation failed on attempt ${attempt}`);
        continue; // Retry
      }

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
          startUrl: startUrl || undefined,
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

    } catch (error) {
      console.log(`  ❌ Attempt ${attempt} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      lastError = error instanceof Error ? error : new Error('Unknown error');
    }
  }

  // All retries exhausted
  throw new Error(`Failed to create valid Steel session after ${MAX_SESSION_RETRIES} attempts: ${lastError?.message}`);
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
 * Validates the WebSocket connection works before returning.
 * If validation fails, retries up to MAX_SESSION_RETRIES times.
 *
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

  // Look up agent's proxy geolocation
  let proxyGeo = DEFAULT_GEOLOCATION;
  if (oldSession.agentId) {
    const agent = await prisma.agent.findUnique({
      where: { id: oldSession.agentId },
      select: { proxyCountry: true, proxyState: true, proxyCity: true }
    });
    if (agent?.proxyCountry) {
      proxyGeo = {
        country: agent.proxyCountry,
        state: agent.proxyState || DEFAULT_GEOLOCATION.state,
        city: agent.proxyCity || DEFAULT_GEOLOCATION.city,
      };
    }
  }
  console.log(`  Using proxy location: ${proxyGeo.city}, ${proxyGeo.state}, ${proxyGeo.country}`);

// Fetch user's fingerprint to get their User-Agent for Steel session
  const fingerprint = await prisma.integration.findUnique({
    where: { userId_name: { userId: oldSession.context.userId, name: 'browser_fingerprint' } },
  });
  const fp = (fingerprint?.config as { fingerprint?: FingerprintData } | null)?.fingerprint;
  const userAgent = fp?.navigator?.userAgent;
  if (userAgent) {
    console.log(`  Using user's fingerprint User-Agent: ${userAgent.substring(0, 60)}...`);
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_SESSION_RETRIES; attempt++) {
    console.log(`  📡 Resume session attempt ${attempt}/${MAX_SESSION_RETRIES}...`);

    try {
      // Create NEW Steel session with same profile
      // Dimensions adjusted for browser chrome (see createSessionWithContext comments)
      const session = await steel.sessions.create({
        profileId: oldSession.context.contextId,
        userAgent: userAgent || undefined,  // Use user's real User-Agent from fingerprint
        useProxy: {
          geolocation: {
            country: proxyGeo.country,
            state: proxyGeo.state,
            city: proxyGeo.city,
          },
        },  // Residential proxy based on user's location
        solveCaptcha: true,
        stealthConfig: {
          humanizeInteractions: false,  // Disabled - we handle humanization with BrowserHumanizer
          skipFingerprintInjection: true,  // We inject user's real fingerprint ourselves
        },
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

      // VALIDATE: Test that the WebSocket connection actually works before proceeding
      const isValid = await validateSessionConnection(wsUrl);

      if (!isValid) {
        console.log(`  ⚠️ Session ${session.id} failed validation, releasing...`);
        try {
          await steel.sessions.release(session.id);
        } catch (releaseErr) {
          console.log(`  ⚠️ Failed to release invalid session: ${releaseErr}`);
        }
        lastError = new Error(`Session validation failed on attempt ${attempt}`);
        continue; // Retry
      }

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
          await browser.close();
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
        savedUrl: oldSession.currentUrl || oldSession.startUrl || undefined
      };

    } catch (error) {
      console.log(`  ❌ Attempt ${attempt} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      lastError = error instanceof Error ? error : new Error('Unknown error');
    }
  }

  // All retries exhausted
  throw new Error(`Failed to resume session after ${MAX_SESSION_RETRIES} attempts: ${lastError?.message}`);
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
 * Fingerprint data structure from mac-app
 */
interface FingerprintData {
  navigator: {
    userAgent: string;
    platform: string;
    language: string;
    languages: string[];
    hardwareConcurrency: number;
    deviceMemory: number | null;
    maxTouchPoints: number;
    vendor: string;
    doNotTrack: string | null;
  };
  // Client Hints (navigator.userAgentData.getHighEntropyValues)
  userAgentData: {
    brands: Array<{ brand: string; version: string }>;
    mobile: boolean;
    platform: string;
    platformVersion: string;
    architecture: string;
    bitness: string;
    model: string;
    fullVersionList: Array<{ brand: string; version: string }>;
  } | null;
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelDepth: number;
    devicePixelRatio: number;
  };
  // Viewport dimensions (window.innerWidth/innerHeight)
  viewport: {
    innerWidth: number;
    innerHeight: number;
    outerWidth: number;
    outerHeight: number;
  };
  // Network Information API (navigator.connection)
  connection: {
    effectiveType: string;
    downlink: number;
    rtt: number;
    saveData: boolean;
  } | null;
  webgl: {
    vendor: string;
    renderer: string;
  };
  canvas: {
    hash: string;
  };
  audio: {
    hash: string;
  };
  timezone: string;
  // Timezone offset in minutes (for Date.getTimezoneOffset())
  timezoneOffset: number;
  fonts: string[];
  plugins: string[];
  collectedAt: string;
}

/**
 * Inject user's stored cookies and fingerprint into a browser session.
 * Uses a single CDP connection for both operations, then disconnects.
 *
 * @param sessionId - The Steel session ID
 * @param userId - The user's ID to fetch data for
 * @returns Object with injection results for both cookies and fingerprint
 */
export async function injectUserData(
  sessionId: string,
  userId: string,
  startUrl: string
): Promise<{
  cookies: { injected: boolean; cookieCount: number };
  fingerprint: { injected: boolean };
  indexedDB: { injected: boolean; originCount: number };
  localStorage: { injected: boolean; originCount: number };
  permissions: { injected: boolean; grantCount: number };
  cacheStorage: { injected: boolean; originCount: number };
}> {
  const startTime = Date.now();
  console.log(`🔐 [injectUserData] START for session ${sessionId}`);

  // Build cookie domain filter from start_url
  // Cookie domains use leading dots for subdomain matching (e.g. ".amazon.com" matches "www.amazon.com")
  // We need to query for both ".domain.com" and "domain.com" variants
  let url = startUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }
  const hostname = new URL(url).hostname;
  // Extract registrable domain (e.g. "www.amazon.com" → "amazon.com")
  const parts = hostname.split('.');
  const registrableDomain = parts.length > 2 ? parts.slice(-2).join('.') : hostname;
  // Match: exact domain, with leading dot, and registrable domain variants
  const domainVariants = [
    hostname,                    // "www.amazon.com"
    `.${hostname}`,              // ".www.amazon.com"
    registrableDomain,           // "amazon.com"
    `.${registrableDomain}`,     // ".amazon.com"
  ];
  const uniqueDomains = [...new Set(domainVariants)];
  const cookieDomainFilter = { userId, domain: { in: uniqueDomains } };
  console.log(`  [cookies] Filtering to domains for start_url "${startUrl}": ${uniqueDomains.join(', ')}`);

  // Fetch cookies, fingerprint, localStorage, IndexedDB, permissions, and cacheStorage in parallel
  console.log(`  [1/9] Fetching user data from DB...`);
  const [cookies, integration, localStorageOrigins, indexedDBOrigins, permissions, cacheStorageOrigins] = await Promise.all([
    prisma.cookie.findMany({ where: cookieDomainFilter }),
    prisma.integration.findUnique({
      where: { userId_name: { userId, name: 'browser_fingerprint' } },
    }),
    prisma.localStorageOrigin.findMany({ where: { userId } }),
    prisma.indexedDBOrigin.findMany({ where: { userId } }),
    prisma.browserPermission.findMany({ where: { userId } }),
    prisma.cacheStorageOrigin.findMany({ where: { userId } }),
  ]);
  console.log(`  [1/9] DB fetch complete (${Date.now() - startTime}ms)`);

  const hasCookies = cookies.length > 0;
  const fp = (integration?.config as { fingerprint?: FingerprintData } | null)?.fingerprint;
  const hasFingerprint = !!fp;
  const hasLocalStorage = localStorageOrigins.length > 0;
  const hasIndexedDB = indexedDBOrigins.length > 0;
  const hasPermissions = permissions.length > 0;
  const hasCacheStorage = cacheStorageOrigins.length > 0;

  console.log(`  Cookies: ${hasCookies ? cookies.length : 'none'}, Fingerprint: ${hasFingerprint ? 'yes' : 'no'}, localStorage: ${hasLocalStorage ? localStorageOrigins.length + ' origins' : 'none'}, IndexedDB: ${hasIndexedDB ? indexedDBOrigins.length + ' origins' : 'none'}, Permissions: ${hasPermissions ? permissions.length + ' grants' : 'none'}, CacheStorage: ${hasCacheStorage ? cacheStorageOrigins.length + ' origins' : 'none'}`);

  // Note: We always need CDP connection now to inject scrollbar CSS
  // (previously returned early when no cookies/fingerprint)

  // Get session info to get WebSocket URL
  console.log(`  [2/9] Fetching session wsUrl from DB...`);
  const dbSession = await prisma.browserSession.findUnique({
    where: { sessionId }
  });
  console.log(`  [2/9] Session fetch complete (${Date.now() - startTime}ms)`);

  if (!dbSession?.wsUrl) {
    throw new Error('No WebSocket URL found for session');
  }

  // Connect via Playwright (single connection for both operations)
  const { chromium } = await import('playwright');
  let browser;

  try {
    console.log(`  [3/9] Connecting to CDP...`);
    browser = await chromium.connectOverCDP(dbSession.wsUrl);
    const context = browser.contexts()[0];
    console.log(`  [3/9] CDP connected (${Date.now() - startTime}ms)`);

    let cookieResult = { injected: false, cookieCount: 0 };
    let fingerprintResult = { injected: false };
    let localStorageResult = { injected: false, originCount: 0 };
    let indexedDBResult = { injected: false, originCount: 0 };
    let permissionsResult = { injected: false, grantCount: 0 };
    let cacheStorageResult = { injected: false, originCount: 0 };

    // Run all injections in parallel for performance
    console.log(`  [4/5] Injecting browser state in parallel...`);
    const injectionPromises: Promise<void>[] = [];

    // 1. Inject cookies if available
    if (hasCookies) {
      injectionPromises.push((async () => {
        try {
          console.log(`  [cookies] Transforming ${cookies.length} cookies...`);
          const CHROME_EPOCH_OFFSET = 11644473600;
          const playwrightCookies = cookies.map((cookie) => {
            let expires: number | undefined;

            if (cookie.expiresUtc && cookie.expiresUtc > 0n) {
              expires = Math.floor(Number(cookie.expiresUtc) / 1000000) - CHROME_EPOCH_OFFSET;
              if (expires < Date.now() / 1000) {
                expires = undefined;
              }
            }

            return {
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path || '/',
              expires,
              secure: cookie.isSecure,
              httpOnly: cookie.isHttpOnly,
              sameSite: 'Lax' as const,
            };
          });

          const validCookies = playwrightCookies.filter(c => c.name && c.value);
          console.log(`  [cookies] Transform complete, ${validCookies.length} valid (${Date.now() - startTime}ms)`);

          // Inject all cookies in one CDP call
          console.log(`  [cookies] Injecting via CDP...`);
          await context.addCookies(validCookies);
          console.log(`  [cookies] ✅ Injected (${Date.now() - startTime}ms)`);
          cookieResult = { injected: true, cookieCount: validCookies.length };
        } catch (error) {
          console.error(`  [cookies] ❌ Failed to inject:`, error);
        }
      })());
    }

    // 2. Inject fingerprint via CDP + JS script if available
    if (hasFingerprint && fp) {
      injectionPromises.push((async () => {
        try {
          console.log(`  [fingerprint] Injecting via CDP and script...`);

          // Get the page for init script injection
          const page = context.pages()[0];
          if (!page) {
            console.error(`  [fingerprint] ❌ No page available for CDP session`);
            return;
          }

          // Create page-level CDP session for Client Hints override
          // (User-Agent is already set at Steel session creation level)
          const cdpSession = await context.newCDPSession(page);

          // IMPORTANT: Network.enable MUST be called before setUserAgentOverride
          // Without this, the userAgentMetadata won't affect HTTP headers
          await cdpSession.send('Network.enable');

          // 2a. Set Client Hints at HTTP header level via CDP
          // User-Agent is already set by Steel, we just need the metadata for Sec-CH-UA-* headers
          if (fp.userAgentData) {
            console.log(`  [fingerprint] Setting Client Hints via CDP...`);
            const userAgentOverrideParams: any = {
              userAgent: fp.navigator.userAgent,  // Must match what Steel set
              acceptLanguage: fp.navigator.languages.join(','),
              platform: fp.navigator.platform,
              userAgentMetadata: {
                brands: fp.userAgentData.brands,
                fullVersionList: fp.userAgentData.fullVersionList,
                platform: fp.userAgentData.platform,
                platformVersion: fp.userAgentData.platformVersion,
                architecture: fp.userAgentData.architecture,
                model: fp.userAgentData.model,
                mobile: fp.userAgentData.mobile,
                bitness: fp.userAgentData.bitness,
              },
            };
            await cdpSession.send('Network.setUserAgentOverride', userAgentOverrideParams);
            console.log(`  [fingerprint] ✅ Client Hints: platform=${fp.userAgentData.platform}, arch=${fp.userAgentData.architecture}`);
          }

          // 2b. Disable WebRTC IP leak (prevent real IP from being exposed)
          console.log(`  [fingerprint] Disabling WebRTC IP leak via CDP...`);
          try {
            // Use WebRTC IP handling policy to prevent leaks
            await cdpSession.send('Emulation.setAutomationOverride' as any, {
              enabled: false,
            });
          } catch (e) {
            // This CDP method may not be available in all Chrome versions
            console.log(`  [fingerprint] WebRTC leak prevention not available via CDP`);
          }

          // 2d. Inject comprehensive JS fingerprint spoofing script
          const fingerprintScript = `
            // Fingerprint spoofing script - injected to match user's real browser
            (function() {
              'use strict';

              const fp = ${JSON.stringify(fp)};

              // Override navigator properties
              const navigatorProps = {
                userAgent: { value: fp.navigator.userAgent },
                platform: { value: fp.navigator.platform },
                language: { value: fp.navigator.language },
                languages: { value: Object.freeze([...fp.navigator.languages]) },
                hardwareConcurrency: { value: fp.navigator.hardwareConcurrency },
                deviceMemory: { value: fp.navigator.deviceMemory },
                maxTouchPoints: { value: fp.navigator.maxTouchPoints },
                vendor: { value: fp.navigator.vendor },
                doNotTrack: { value: fp.navigator.doNotTrack },
              };

              for (const [prop, desc] of Object.entries(navigatorProps)) {
                try {
                  Object.defineProperty(Navigator.prototype, prop, {
                    get: () => desc.value,
                    configurable: true,
                  });
                } catch (e) {}
              }

              // Override navigator.webdriver (bot detection flag)
              try {
                Object.defineProperty(Navigator.prototype, 'webdriver', {
                  get: () => false,
                  configurable: true,
                });
              } catch (e) {}

              // Override navigator.plugins with user's plugins
              if (fp.plugins && fp.plugins.length > 0) {
                try {
                  const fakePlugins = {
                    length: fp.plugins.length,
                    item: (index) => fakePlugins[index] || null,
                    namedItem: (name) => {
                      for (let i = 0; i < fp.plugins.length; i++) {
                        if (fp.plugins[i] === name) return { name: fp.plugins[i] };
                      }
                      return null;
                    },
                    refresh: () => {},
                  };
                  for (let i = 0; i < fp.plugins.length; i++) {
                    fakePlugins[i] = { name: fp.plugins[i], description: '', filename: '', length: 0 };
                  }
                  Object.defineProperty(Navigator.prototype, 'plugins', {
                    get: () => fakePlugins,
                    configurable: true,
                  });
                } catch (e) {}
              }

              // Override navigator.connection (Network Information API)
              if (fp.connection) {
                try {
                  const fakeConnection = {
                    effectiveType: fp.connection.effectiveType,
                    downlink: fp.connection.downlink,
                    rtt: fp.connection.rtt,
                    saveData: fp.connection.saveData,
                    onchange: null,
                    addEventListener: () => {},
                    removeEventListener: () => {},
                    dispatchEvent: () => true,
                  };
                  Object.defineProperty(Navigator.prototype, 'connection', {
                    get: () => fakeConnection,
                    configurable: true,
                  });
                } catch (e) {}
              }

              // Override navigator.userAgentData (Client Hints in JS)
              if (fp.userAgentData) {
                try {
                  const fakeUserAgentData = {
                    brands: fp.userAgentData.brands,
                    mobile: fp.userAgentData.mobile,
                    platform: fp.userAgentData.platform,
                    getHighEntropyValues: async (hints) => {
                      const result = {
                        brands: fp.userAgentData.brands,
                        mobile: fp.userAgentData.mobile,
                        platform: fp.userAgentData.platform,
                      };
                      if (hints.includes('platformVersion')) result.platformVersion = fp.userAgentData.platformVersion;
                      if (hints.includes('architecture')) result.architecture = fp.userAgentData.architecture;
                      if (hints.includes('bitness')) result.bitness = fp.userAgentData.bitness;
                      if (hints.includes('model')) result.model = fp.userAgentData.model;
                      if (hints.includes('fullVersionList')) result.fullVersionList = fp.userAgentData.fullVersionList;
                      return result;
                    },
                    toJSON: () => ({
                      brands: fp.userAgentData.brands,
                      mobile: fp.userAgentData.mobile,
                      platform: fp.userAgentData.platform,
                    }),
                  };
                  Object.defineProperty(Navigator.prototype, 'userAgentData', {
                    get: () => fakeUserAgentData,
                    configurable: true,
                  });
                } catch (e) {}
              }

              // Override screen properties
              const screenProps = {
                width: fp.screen.width,
                height: fp.screen.height,
                availWidth: fp.screen.availWidth,
                availHeight: fp.screen.availHeight,
                colorDepth: fp.screen.colorDepth,
                pixelDepth: fp.screen.pixelDepth,
              };

              for (const [prop, value] of Object.entries(screenProps)) {
                try {
                  Object.defineProperty(Screen.prototype, prop, {
                    get: () => value,
                    configurable: true,
                  });
                } catch (e) {}
              }

              // Override devicePixelRatio
              try {
                Object.defineProperty(window, 'devicePixelRatio', {
                  get: () => fp.screen.devicePixelRatio,
                  configurable: true,
                });
              } catch (e) {}

              // Override viewport dimensions
              if (fp.viewport) {
                try {
                  Object.defineProperty(window, 'innerWidth', {
                    get: () => fp.viewport.innerWidth,
                    configurable: true,
                  });
                  Object.defineProperty(window, 'innerHeight', {
                    get: () => fp.viewport.innerHeight,
                    configurable: true,
                  });
                  Object.defineProperty(window, 'outerWidth', {
                    get: () => fp.viewport.outerWidth,
                    configurable: true,
                  });
                  Object.defineProperty(window, 'outerHeight', {
                    get: () => fp.viewport.outerHeight,
                    configurable: true,
                  });
                } catch (e) {}
              }

              // Override WebGL
              const getParameterProxyHandler = {
                apply: function(target, thisArg, args) {
                  const param = args[0];
                  const UNMASKED_VENDOR_WEBGL = 0x9245;
                  const UNMASKED_RENDERER_WEBGL = 0x9246;

                  if (param === UNMASKED_VENDOR_WEBGL) {
                    return fp.webgl.vendor;
                  }
                  if (param === UNMASKED_RENDERER_WEBGL) {
                    return fp.webgl.renderer;
                  }
                  return target.apply(thisArg, args);
                }
              };

              try {
                WebGLRenderingContext.prototype.getParameter = new Proxy(
                  WebGLRenderingContext.prototype.getParameter,
                  getParameterProxyHandler
                );
                WebGL2RenderingContext.prototype.getParameter = new Proxy(
                  WebGL2RenderingContext.prototype.getParameter,
                  getParameterProxyHandler
                );
              } catch (e) {}

              // Override timezone via Intl.DateTimeFormat
              const originalDateTimeFormat = Intl.DateTimeFormat;
              Intl.DateTimeFormat = function(...args) {
                const instance = new originalDateTimeFormat(...args);
                const originalResolvedOptions = instance.resolvedOptions.bind(instance);
                instance.resolvedOptions = function() {
                  const options = originalResolvedOptions();
                  options.timeZone = fp.timezone;
                  return options;
                };
                return instance;
              };
              Intl.DateTimeFormat.prototype = originalDateTimeFormat.prototype;
              Intl.DateTimeFormat.supportedLocalesOf = originalDateTimeFormat.supportedLocalesOf;

              // Override Date.prototype.getTimezoneOffset
              if (fp.timezoneOffset !== undefined) {
                const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
                Date.prototype.getTimezoneOffset = function() {
                  return fp.timezoneOffset;
                };
              }

              // Block WebRTC IP leak via JS
              try {
                // Override RTCPeerConnection to prevent IP leaks
                const originalRTCPeerConnection = window.RTCPeerConnection;
                if (originalRTCPeerConnection) {
                  window.RTCPeerConnection = function(config) {
                    // Force ICE candidate filtering
                    if (config && config.iceServers) {
                      // Keep STUN/TURN but they'll only see proxy IP
                    }
                    return new originalRTCPeerConnection(config);
                  };
                  window.RTCPeerConnection.prototype = originalRTCPeerConnection.prototype;
                }
              } catch (e) {}

              console.log('[Fingerprint] ✅ Comprehensive fingerprint spoofing injected');
            })();
          `;

          await context.addInitScript(fingerprintScript);
          console.log(`  [fingerprint] ✅ Injected (${Date.now() - startTime}ms)`);
          fingerprintResult = { injected: true };
        } catch (error) {
          console.error(`  [fingerprint] ❌ Failed to inject:`, error);
        }
      })());
    }

    // 3. Inject localStorage if available
    if (hasLocalStorage) {
      injectionPromises.push((async () => {
        try {
          console.log(`  [localStorage] Injecting for ${localStorageOrigins.length} origins...`);

          // Build origin -> entries map
          const localStorageByOrigin: Record<string, Array<{ key: string; value: string }>> = {};
          for (const origin of localStorageOrigins) {
            // Fix origin format if needed
            let cleanOrigin = origin.origin;
            if (cleanOrigin.startsWith('ttps://')) {
              cleanOrigin = 'https://' + cleanOrigin.slice(7);
            } else if (!cleanOrigin.startsWith('http')) {
              cleanOrigin = 'https://' + cleanOrigin;
            }
            // Handle partitioned storage format
            if (cleanOrigin.includes('/^0')) {
              cleanOrigin = cleanOrigin.split('/^0')[0];
            }
            localStorageByOrigin[cleanOrigin] = origin.entries as Array<{ key: string; value: string }>;
          }

          const localStorageScript = `
            (function() {
              const allLocalStorage = ${JSON.stringify(localStorageByOrigin)};
              const currentOrigin = window.location.origin;

              for (const [origin, entries] of Object.entries(allLocalStorage)) {
                // Check if current origin matches
                if (currentOrigin === origin ||
                    currentOrigin.endsWith(origin.replace('https://', '.')) ||
                    origin.includes(currentOrigin.replace('https://', ''))) {

                  for (const entry of entries) {
                    try {
                      localStorage.setItem(entry.key, entry.value);
                    } catch (e) {}
                  }
                  console.log('[localStorage] ✅ Injected', entries.length, 'entries for', currentOrigin);
                }
              }
            })();
          `;

          await context.addInitScript(localStorageScript);
          console.log(`  [localStorage] ✅ Injected (${Date.now() - startTime}ms)`);
          localStorageResult = { injected: true, originCount: localStorageOrigins.length };
        } catch (error) {
          console.error(`  [localStorage] ❌ Failed to inject:`, error);
        }
      })());
    }

    // 4. Inject IndexedDB if available
    if (hasIndexedDB) {
      injectionPromises.push((async () => {
        try {
          console.log(`  [indexedDB] Injecting for ${indexedDBOrigins.length} origins...`);

          // Build origin -> databases map
          interface IDBRecord { key: unknown; value: unknown }
          interface IDBObjectStore { name: string; records: IDBRecord[] }
          interface IDBDatabase { name: string; objectStores: IDBObjectStore[] }

          const indexedDBByOrigin: Record<string, IDBDatabase[]> = {};
          for (const origin of indexedDBOrigins) {
            indexedDBByOrigin[origin.origin] = origin.databases as unknown as IDBDatabase[];
          }

          // IndexedDB injection is more complex - we need to recreate databases, object stores, and records
          const indexedDBScript = `
            (function() {
              const allIndexedDB = ${JSON.stringify(indexedDBByOrigin)};
              const currentOrigin = window.location.origin;

              // Find matching data for current origin
              let matchingDatabases = null;
              for (const [origin, databases] of Object.entries(allIndexedDB)) {
                if (currentOrigin === origin ||
                    currentOrigin.includes(origin.replace('https://', '').replace('http://', ''))) {
                  matchingDatabases = databases;
                  break;
                }
              }

              if (!matchingDatabases) return;

              // Helper to inject data into a database
              async function injectDatabase(dbInfo) {
                return new Promise((resolve) => {
                  // First, try to open existing database to get version
                  const checkRequest = indexedDB.open(dbInfo.name);

                  checkRequest.onerror = () => {
                    console.warn('[IndexedDB] Failed to check database:', dbInfo.name);
                    resolve(false);
                  };

                  checkRequest.onsuccess = (e) => {
                    const existingDb = e.target.result;
                    const currentVersion = existingDb.version;
                    existingDb.close();

                    // Open with incremented version to trigger upgrade
                    const request = indexedDB.open(dbInfo.name, currentVersion + 1);

                    request.onerror = () => {
                      console.warn('[IndexedDB] Failed to open database:', dbInfo.name);
                      resolve(false);
                    };

                    request.onupgradeneeded = (e) => {
                      const db = e.target.result;

                      // Create object stores that don't exist
                      for (const store of dbInfo.objectStores) {
                        if (!db.objectStoreNames.contains(store.name)) {
                          try {
                            db.createObjectStore(store.name);
                          } catch (err) {}
                        }
                      }
                    };

                    request.onsuccess = (e) => {
                      const db = e.target.result;

                      // Add records to each object store
                      for (const store of dbInfo.objectStores) {
                        if (db.objectStoreNames.contains(store.name) && store.records && store.records.length > 0) {
                          try {
                            const tx = db.transaction(store.name, 'readwrite');
                            const objectStore = tx.objectStore(store.name);

                            for (const record of store.records) {
                              try {
                                objectStore.put(record.value, record.key);
                              } catch (e) {}
                            }
                          } catch (e) {}
                        }
                      }

                      db.close();
                      console.log('[IndexedDB] ✅ Injected database:', dbInfo.name);
                      resolve(true);
                    };
                  };

                  checkRequest.onblocked = () => {
                    console.warn('[IndexedDB] Database blocked:', dbInfo.name);
                    resolve(false);
                  };
                });
              }

              // Inject all databases
              (async () => {
                for (const dbInfo of matchingDatabases) {
                  await injectDatabase(dbInfo);
                }
              })();
            })();
          `;

          await context.addInitScript(indexedDBScript);
          console.log(`  [indexedDB] ✅ Injected (${Date.now() - startTime}ms)`);
          indexedDBResult = { injected: true, originCount: indexedDBOrigins.length };
        } catch (error) {
          console.error(`  [indexedDB] ❌ Failed to inject:`, error);
        }
      })());
    }

    // 5. Inject permissions if available
    // Uses JavaScript override for permission query checks
    if (hasPermissions) {
      injectionPromises.push((async () => {
        try {
          console.log(`  [permissions] Injecting ${permissions.length} permission grants...`);

          // Build permission data for JavaScript injection
          const permissionGrants = permissions.map(p => ({
            origin: p.origin,
            permission: p.permission,
            setting: p.setting,
          }));

          // JavaScript injection to override navigator.permissions.query
          const permissionScript = `
            (function() {
              'use strict';

              const grants = ${JSON.stringify(permissionGrants)};

              // Helper to match origin patterns
              function matchOrigin(pattern, origin) {
                // Exact match
                if (pattern === origin) return true;

                // Wildcard pattern: "[*.]example.com" matches "*.example.com"
                if (pattern.startsWith('[*.]')) {
                  const domain = pattern.slice(4);
                  const originHost = new URL(origin).hostname;
                  return originHost === domain || originHost.endsWith('.' + domain);
                }

                return false;
              }

              // Override navigator.permissions.query
              const originalQuery = navigator.permissions.query.bind(navigator.permissions);
              navigator.permissions.query = async function(descriptor) {
                const permName = descriptor.name;
                const currentOrigin = window.location.origin;

                // Find matching grant
                const grant = grants.find(g =>
                  g.permission === permName && matchOrigin(g.origin, currentOrigin)
                );

                if (grant) {
                  const state = grant.setting === 1 ? 'granted' : 'denied';
                  return {
                    state,
                    name: permName,
                    onchange: null,
                    addEventListener: function() {},
                    removeEventListener: function() {},
                    dispatchEvent: function() { return true; },
                  };
                }

                // Fall back to original for unmatched permissions
                return originalQuery(descriptor);
              };

              console.log('[Permissions] ✅ Permission overrides injected for', grants.length, 'grants');
            })();
          `;

          await context.addInitScript(permissionScript);
          console.log(`  [permissions] ✅ Injected (${Date.now() - startTime}ms)`);
          permissionsResult = { injected: true, grantCount: permissions.length };
        } catch (error) {
          console.error(`  [permissions] ❌ Failed to inject:`, error);
        }
      })());
    }

    // 6. Inject Cache Storage metadata if available
    // Pre-opens caches so sites that check for cache existence work correctly
    if (hasCacheStorage) {
      injectionPromises.push((async () => {
        try {
          console.log(`  [cacheStorage] Injecting metadata for ${cacheStorageOrigins.length} origins...`);

          // Build origin -> caches map
          const cachesByOrigin: Record<string, Array<{ name: string }>> = {};
          for (const origin of cacheStorageOrigins) {
            const caches = origin.caches as Array<{ name: string; size?: number }>;
            cachesByOrigin[origin.origin] = caches.map(c => ({ name: c.name }));
          }

          const cacheStorageScript = `
            (function() {
              'use strict';

              const cachesByOrigin = ${JSON.stringify(cachesByOrigin)};
              const currentOrigin = window.location.origin;

              // Find matching caches for current origin
              let matchingCaches = null;
              for (const [origin, caches] of Object.entries(cachesByOrigin)) {
                if (currentOrigin === origin ||
                    currentOrigin.includes(origin.replace('https://', '').replace('http://', ''))) {
                  matchingCaches = caches;
                  break;
                }
              }

              if (!matchingCaches || matchingCaches.length === 0) return;

              // Pre-open caches (doesn't add any data, just creates empty caches)
              (async function() {
                for (const cache of matchingCaches) {
                  try {
                    await caches.open(cache.name);
                    console.log('[CacheStorage] ✅ Opened cache:', cache.name);
                  } catch (e) {
                    console.warn('[CacheStorage] Failed to open cache:', cache.name, e);
                  }
                }
              })();
            })();
          `;

          await context.addInitScript(cacheStorageScript);
          console.log(`  [cacheStorage] ✅ Injected (${Date.now() - startTime}ms)`);
          cacheStorageResult = { injected: true, originCount: cacheStorageOrigins.length };
        } catch (error) {
          console.error(`  [cacheStorage] ❌ Failed to inject:`, error);
        }
      })());
    }

    // 7. Always inject scrollbar-hiding CSS to ensure viewport matches screenshot (1280x800)
    // This prevents coordinate mismatch where viewport reports 1265 (with scrollbar) but screenshot is 1280
    injectionPromises.push((async () => {
      try {
        const scrollbarHideScript = `
          (function() {
            const style = document.createElement('style');
            style.id = 'yutori-scrollbar-hide';
            style.textContent = \`
              /* Hide scrollbars on ALL elements for consistent 1280x800 viewport */
              *::-webkit-scrollbar {
                display: none !important;
                width: 0 !important;
                height: 0 !important;
              }
              * {
                -ms-overflow-style: none !important;
                scrollbar-width: none !important;
              }
            \`;
            if (document.head) {
              document.head.appendChild(style);
            } else {
              document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
            }
          })();
        `;
        await context.addInitScript(scrollbarHideScript);
        console.log(`  [scrollbar] ✅ CSS injected for consistent 1280x800 viewport (${Date.now() - startTime}ms)`);
      } catch (error) {
        console.error(`  [scrollbar] ⚠️ Failed to inject CSS:`, error);
      }
    })());

    // Wait for all injections to complete in parallel
    await Promise.all(injectionPromises);
    console.log(`  [4/5] ✅ All injections complete (${Date.now() - startTime}ms)`);
    return {
      cookies: cookieResult,
      fingerprint: fingerprintResult,
      indexedDB: indexedDBResult,
      localStorage: localStorageResult,
      permissions: permissionsResult,
      cacheStorage: cacheStorageResult,
    };
  } finally {
    // Always disconnect from the browser (doesn't close the Steel session)
    if (browser) {
      console.log(`  [5/5] Closing CDP connection...`);
      await browser.close();
      console.log(`🔐 [injectUserData] COMPLETE (${Date.now() - startTime}ms total)`);
    }
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
      path: filename,  // Preserve original filename instead of UUID
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
 * Get fingerprint injection data for a user.
 * Returns the data needed for the agent to apply CDP commands.
 *
 * @param userId - The user's ID
 * @returns Fingerprint data and init script for CDP injection, or null if not available
 */
export async function getFingerprintInjectionData(userId: string): Promise<{
  userAgentOverride: {
    userAgent: string;
    acceptLanguage: string;
    platform: string;
    userAgentMetadata?: {
      brands: Array<{ brand: string; version: string }>;
      fullVersionList: Array<{ brand: string; version: string }>;
      platform: string;
      platformVersion: string;
      architecture: string;
      model: string;
      mobile: boolean;
      bitness: string;
    };
  };
  initScript: string;
} | null> {
  const integration = await prisma.integration.findUnique({
    where: { userId_name: { userId, name: 'browser_fingerprint' } },
  });

  const fp = (integration?.config as { fingerprint?: FingerprintData } | null)?.fingerprint;
  if (!fp) {
    return null;
  }

  // Build the User-Agent override params for Network.setUserAgentOverride
  const userAgentOverride: any = {
    userAgent: fp.navigator.userAgent,
    acceptLanguage: fp.navigator.languages.join(','),
    platform: fp.navigator.platform,
  };

  if (fp.userAgentData) {
    userAgentOverride.userAgentMetadata = {
      brands: fp.userAgentData.brands,
      fullVersionList: fp.userAgentData.fullVersionList,
      platform: fp.userAgentData.platform,
      platformVersion: fp.userAgentData.platformVersion,
      architecture: fp.userAgentData.architecture,
      model: fp.userAgentData.model,
      mobile: fp.userAgentData.mobile,
      bitness: fp.userAgentData.bitness,
    };
  }

  // Build the fingerprint spoofing init script
  const initScript = `
    // Fingerprint spoofing script - injected to match user's real browser
    (function() {
      'use strict';

      const fp = ${JSON.stringify(fp)};

      // Override navigator properties
      const navigatorProps = {
        userAgent: { value: fp.navigator.userAgent },
        platform: { value: fp.navigator.platform },
        language: { value: fp.navigator.language },
        languages: { value: Object.freeze([...fp.navigator.languages]) },
        hardwareConcurrency: { value: fp.navigator.hardwareConcurrency },
        deviceMemory: { value: fp.navigator.deviceMemory },
        maxTouchPoints: { value: fp.navigator.maxTouchPoints },
        vendor: { value: fp.navigator.vendor },
        doNotTrack: { value: fp.navigator.doNotTrack },
      };

      for (const [prop, desc] of Object.entries(navigatorProps)) {
        try {
          Object.defineProperty(Navigator.prototype, prop, {
            get: () => desc.value,
            configurable: true,
          });
        } catch (e) {}
      }

      // Override navigator.webdriver (bot detection flag)
      try {
        Object.defineProperty(Navigator.prototype, 'webdriver', {
          get: () => false,
          configurable: true,
        });
      } catch (e) {}

      // Override navigator.plugins with user's plugins
      if (fp.plugins && fp.plugins.length > 0) {
        try {
          const fakePlugins = {
            length: fp.plugins.length,
            item: (index) => fakePlugins[index] || null,
            namedItem: (name) => {
              for (let i = 0; i < fp.plugins.length; i++) {
                if (fp.plugins[i] === name) return { name: fp.plugins[i] };
              }
              return null;
            },
            refresh: () => {},
          };
          for (let i = 0; i < fp.plugins.length; i++) {
            fakePlugins[i] = { name: fp.plugins[i], description: '', filename: '', length: 0 };
          }
          Object.defineProperty(Navigator.prototype, 'plugins', {
            get: () => fakePlugins,
            configurable: true,
          });
        } catch (e) {}
      }

      // Override navigator.connection (Network Information API)
      if (fp.connection) {
        try {
          const fakeConnection = {
            effectiveType: fp.connection.effectiveType,
            downlink: fp.connection.downlink,
            rtt: fp.connection.rtt,
            saveData: fp.connection.saveData,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => true,
          };
          Object.defineProperty(Navigator.prototype, 'connection', {
            get: () => fakeConnection,
            configurable: true,
          });
        } catch (e) {}
      }

      // Override navigator.userAgentData (Client Hints in JS)
      if (fp.userAgentData) {
        try {
          const fakeUserAgentData = {
            brands: fp.userAgentData.brands,
            mobile: fp.userAgentData.mobile,
            platform: fp.userAgentData.platform,
            getHighEntropyValues: async (hints) => {
              const result = {
                brands: fp.userAgentData.brands,
                mobile: fp.userAgentData.mobile,
                platform: fp.userAgentData.platform,
              };
              if (hints.includes('platformVersion')) result.platformVersion = fp.userAgentData.platformVersion;
              if (hints.includes('architecture')) result.architecture = fp.userAgentData.architecture;
              if (hints.includes('bitness')) result.bitness = fp.userAgentData.bitness;
              if (hints.includes('model')) result.model = fp.userAgentData.model;
              if (hints.includes('fullVersionList')) result.fullVersionList = fp.userAgentData.fullVersionList;
              return result;
            },
            toJSON: () => ({
              brands: fp.userAgentData.brands,
              mobile: fp.userAgentData.mobile,
              platform: fp.userAgentData.platform,
            }),
          };
          Object.defineProperty(Navigator.prototype, 'userAgentData', {
            get: () => fakeUserAgentData,
            configurable: true,
          });
        } catch (e) {}
      }

      // Override screen properties
      const screenProps = {
        width: fp.screen.width,
        height: fp.screen.height,
        availWidth: fp.screen.availWidth,
        availHeight: fp.screen.availHeight,
        colorDepth: fp.screen.colorDepth,
        pixelDepth: fp.screen.pixelDepth,
      };

      for (const [prop, value] of Object.entries(screenProps)) {
        try {
          Object.defineProperty(Screen.prototype, prop, {
            get: () => value,
            configurable: true,
          });
        } catch (e) {}
      }

      // Override devicePixelRatio
      try {
        Object.defineProperty(window, 'devicePixelRatio', {
          get: () => fp.screen.devicePixelRatio,
          configurable: true,
        });
      } catch (e) {}

      // NOTE: Viewport dimensions (innerWidth/Height, outerWidth/Height) are intentionally
      // NOT overridden. The agent's browser has its own viewport size that must match its
      // actual rendering dimensions for correct interaction.

      // Override WebGL
      const getParameterProxyHandler = {
        apply: function(target, thisArg, args) {
          const param = args[0];
          const UNMASKED_VENDOR_WEBGL = 0x9245;
          const UNMASKED_RENDERER_WEBGL = 0x9246;

          if (param === UNMASKED_VENDOR_WEBGL) {
            return fp.webgl.vendor;
          }
          if (param === UNMASKED_RENDERER_WEBGL) {
            return fp.webgl.renderer;
          }
          return target.apply(thisArg, args);
        }
      };

      try {
        WebGLRenderingContext.prototype.getParameter = new Proxy(
          WebGLRenderingContext.prototype.getParameter,
          getParameterProxyHandler
        );
        WebGL2RenderingContext.prototype.getParameter = new Proxy(
          WebGL2RenderingContext.prototype.getParameter,
          getParameterProxyHandler
        );
      } catch (e) {}

      // Override timezone via Intl.DateTimeFormat
      const originalDateTimeFormat = Intl.DateTimeFormat;
      Intl.DateTimeFormat = function(...args) {
        const instance = new originalDateTimeFormat(...args);
        const originalResolvedOptions = instance.resolvedOptions.bind(instance);
        instance.resolvedOptions = function() {
          const options = originalResolvedOptions();
          options.timeZone = fp.timezone;
          return options;
        };
        return instance;
      };
      Intl.DateTimeFormat.prototype = originalDateTimeFormat.prototype;
      Intl.DateTimeFormat.supportedLocalesOf = originalDateTimeFormat.supportedLocalesOf;

      // Override Date.prototype.getTimezoneOffset
      if (fp.timezoneOffset !== undefined) {
        const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
        Date.prototype.getTimezoneOffset = function() {
          return fp.timezoneOffset;
        };
      }

      // Block WebRTC IP leak via JS
      try {
        const originalRTCPeerConnection = window.RTCPeerConnection;
        if (originalRTCPeerConnection) {
          window.RTCPeerConnection = function(config) {
            if (config && config.iceServers) {
              // Keep STUN/TURN but they'll only see proxy IP
            }
            return new originalRTCPeerConnection(config);
          };
          window.RTCPeerConnection.prototype = originalRTCPeerConnection.prototype;
        }
      } catch (e) {}

      console.log('[Fingerprint] ✅ Comprehensive fingerprint spoofing injected');
    })();
  `;

  return {
    userAgentOverride,
    initScript,
  };
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
