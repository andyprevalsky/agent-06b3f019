import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import { AuthRequest, authenticate } from '../middleware/auth';
import {
  getOrCreateContext,
  createSessionWithContext,
  closeSession,
  resumeSession,
  getSession,
  injectUserCookies,
  uploadFileToSession,
  listSessionFiles,
  SteelFileInfo
} from '../lib/steel';

// Configure multer for file uploads (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
  }
});

const router = Router();

// Validation schemas
const initSessionSchema = z.object({
  user_id: z.string(),
  agent_id: z.string().uuid(),
});

const closeSessionSchema = z.object({
  session_id: z.string(),
  pause: z.boolean().optional().default(false),
  current_url: z.string().optional(),  // Save current page URL for resume
});

const resumeSessionSchema = z.object({
  task_id: z.string().uuid(),  // Use stable task ID instead of session_id
});

const injectLocalStorageSchema = z.object({
  origin: z.string().url(),
});

/**
 * POST /api/browser-session/init
 * Initialize or get browser session for user.
 * Automatically injects user's stored Chrome cookies if available.
 * Fast operation - just creates session and injects cookies.
 */
router.post('/init', authenticate, async (req: AuthRequest, res) => {
  try {
    const { user_id, agent_id } = initSessionSchema.parse(req.body);
    
    console.log(`🌐 Initializing browser session for user ${user_id}, agent ${agent_id}`);
    
    // 1. Get or create persistent context for user
    const contextId = await getOrCreateContext(user_id);
    
    // 2. Create temporary session for this task
    const session = await createSessionWithContext(contextId, agent_id);
    
    // 3. Inject user's stored Chrome cookies (if available)
    const cookieResult = await injectUserCookies(session.sessionId, user_id);
    
    res.json({
      success: true,
      task_id: session.taskId,  // Stable ID for grouping browser actions
      context_id: contextId,
      session_id: session.sessionId,
      debug_url: session.debugUrl,
      ws_url: session.wsUrl,  // CDP WebSocket URL for browser-use
      // project_id no longer needed for Steel
      cookies_injected: cookieResult.injected,
      cookies_count: cookieResult.cookieCount,
    });
    
  } catch (error) {
    console.error('❌ Failed to init browser session:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to initialize browser session' 
    });
  }
});

/**
 * POST /api/browser-session/close
 * Close a browser session (stops billing).
 * @param pause - If true, session is PAUSED (resumable). If false, CLOSED (terminal).
 * Fast operation.
 */
router.post('/close', authenticate, async (req: AuthRequest, res) => {
  try {
    const { session_id, pause, current_url } = closeSessionSchema.parse(req.body);
    
    console.log(`🌐 ${pause ? 'Pausing' : 'Closing'} browser session ${session_id}`);
    console.log(`   Received current_url: ${current_url ? current_url : 'NULL/EMPTY'}`);
    
    await closeSession(session_id, pause, current_url);
    
    res.json({
      success: true,
      status: pause ? 'PAUSED' : 'CLOSED',
    });
    
  } catch (error) {
    console.error('❌ Failed to close browser session:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to close browser session' 
    });
  }
});

/**
 * POST /api/browser-session/resume
 * Resume a paused browser task by creating a new session with the same context.
 * Automatically injects user's stored Chrome cookies if available.
 * Fast operation.
 */
router.post('/resume', authenticate, async (req: AuthRequest, res) => {
  try {
    const { task_id } = resumeSessionSchema.parse(req.body);
    
    console.log(`🌐 Resuming browser task ${task_id}`);
    
    const result = await resumeSession(task_id);
    
    // Get user_id from the session's context
    const session = await prisma.browserSession.findUnique({
      where: { id: task_id },
      include: { context: true }
    });
    
    // Inject cookies into resumed session
    let cookieResult = { injected: false, cookieCount: 0 };
    if (session?.context?.userId) {
      cookieResult = await injectUserCookies(result.sessionId, session.context.userId);
    }
    
    res.json({
      success: true,
      task_id,  // Same stable task ID
      session_id: result.sessionId,  // NEW BrowserBase session ID
      debug_url: result.debugUrl,
      ws_url: result.wsUrl,  // CDP WebSocket URL for browser-use
      saved_url: result.savedUrl,  // URL to navigate back to
      status: 'ACTIVE',
      cookies_injected: cookieResult.injected,
      cookies_count: cookieResult.cookieCount,
    });
    
  } catch (error) {
    console.error('❌ Failed to resume browser task:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to resume browser task' 
    });
  }
});

/**
 * GET /api/browser-session/task/:taskId
 * Get current session info for a task.
 */
router.get('/task/:taskId', authenticate, async (req: AuthRequest, res) => {
  try {
    const { taskId } = req.params;
    
    const session = await prisma.browserSession.findUnique({
      where: { id: taskId }
    });
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    res.json({
      task_id: session.id,
      session_id: session.sessionId,
      debug_url: session.debugUrl,
      ws_url: session.wsUrl,  // CDP WebSocket URL for browser-use
      status: session.status
    });
    
  } catch (error) {
    console.error('❌ Failed to get session info:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to get session info' 
    });
  }
});

/**
 * GET /api/browser-session/context/:userId
 * Get user's browser context info.
 */
router.get('/context/:userId', authenticate, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params;
    
    const context = await prisma.browserContext.findUnique({
      where: { userId },
      include: {
        sessions: {
          where: { status: 'ACTIVE' },
          take: 5,
          orderBy: { createdAt: 'desc' }
        }
      }
    });
    
    res.json({ context });
  } catch (error) {
    console.error('❌ Failed to get context:', error);
    res.status(500).json({ error: 'Failed to get context' });
  }
});

/**
 * GET /api/browser-session/:sessionId
 * Get session info.
 */
router.get('/:sessionId', authenticate, async (req: AuthRequest, res) => {
  try {
    const { sessionId } = req.params;

    const session = await getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ session });
  } catch (error) {
    console.error('❌ Failed to get session:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

/**
 * POST /api/browser-session/:sessionId/files
 * Upload a file to a Steel browser session.
 * The file becomes available in the session's VM environment for use with file inputs.
 */
router.post('/:sessionId/files', authenticate, upload.single('file') as any, async (req: AuthRequest, res) => {
  try {
    const { sessionId } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    console.log(`📎 Uploading file to session ${sessionId}: ${req.file.originalname} (${req.file.size} bytes)`);

    const result = await uploadFileToSession(
      sessionId,
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );

    res.json({
      success: true,
      path: result.path,
      size: result.size,
      filename: req.file.originalname,
    });

  } catch (error) {
    console.error('❌ Failed to upload file to session:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to upload file to session'
    });
  }
});

/**
 * GET /api/browser-session/:sessionId/files/list
 * List all files in a Steel browser session.
 * Returns files that have been downloaded by the browser or uploaded.
 */
router.get('/:sessionId/files/list', authenticate, async (req: AuthRequest, res) => {
  try {
    const { sessionId } = req.params;

    console.log(`📂 Listing files for session ${sessionId}`);

    const files = await listSessionFiles(sessionId);

    res.json({
      success: true,
      session_id: sessionId,
      files,
      count: files.length,
    });

  } catch (error) {
    console.error('❌ Failed to list session files:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to list session files'
    });
  }
});

/**
 * POST /api/browser-session/:sessionId/inject-localStorage
 * Inject localStorage for a specific origin if not already injected or data has changed.
 * Called by browser agent after navigation to inject user's localStorage.
 *
 * Uses LocalStorageOrigin table for O(1) lookup by origin.
 */
router.post('/:sessionId/inject-localStorage', authenticate, async (req: AuthRequest, res) => {
  try {
    const { sessionId } = req.params;
    const { origin } = injectLocalStorageSchema.parse(req.body);

    console.log(`🍪 Inject localStorage request: session=${sessionId}, origin=${origin}`);

    // 1. Get session with context to find userId
    const session = await prisma.browserSession.findUnique({
      where: { sessionId },
      include: { context: true }
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!session.context?.userId) {
      return res.status(400).json({ error: 'Session has no associated user' });
    }

    const userId = session.context.userId;

    // 2. Get localStorage for this specific origin (O(1) indexed lookup)
    const originData = await prisma.localStorageOrigin.findUnique({
      where: { userId_origin: { userId, origin } },
    });

    if (!originData) {
      console.log(`  No localStorage data for origin ${origin}`);
      return res.json({
        injected: false,
        reason: 'no_data_for_origin',
        count: 0
      });
    }

    const entries = originData.entries as { key: string; value: string }[];
    const currentHash = originData.hash;

    if (!entries || entries.length === 0) {
      console.log(`  No localStorage entries for origin ${origin}`);
      return res.json({
        injected: false,
        reason: 'no_data_for_origin',
        count: 0
      });
    }

    // 3. Check if already injected with same hash
    const injectedOrigins = (session.injectedOrigins as Record<string, string>) || {};
    const injectedHash = injectedOrigins[origin];

    if (injectedHash && injectedHash === currentHash) {
      console.log(`  Origin ${origin} already injected with same hash, skipping`);
      return res.json({
        injected: false,
        reason: 'already_injected',
        count: entries.length
      });
    }

    // 4. Inject via CDP
    if (!session.wsUrl) {
      return res.status(400).json({ error: 'Session has no WebSocket URL for CDP' });
    }

    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.connectOverCDP(session.wsUrl);
      const context = browser.contexts()[0];
      const page = context.pages()[0];

      // Inject localStorage entries
      await page.evaluate((entries: { key: string; value: string }[]) => {
        for (const { key, value } of entries) {
          try {
            localStorage.setItem(key, value);
          } catch (e) {
            // Ignore individual entry errors (e.g., quota exceeded)
            console.warn(`Failed to set localStorage key ${key}:`, e);
          }
        }
      }, entries);

      console.log(`  ✅ Injected ${entries.length} localStorage entries for ${origin}`);

    } catch (cdpError) {
      console.error(`  ❌ Failed to inject via CDP:`, cdpError);
      return res.status(500).json({
        error: 'Failed to inject localStorage via CDP',
        details: cdpError instanceof Error ? cdpError.message : 'Unknown error'
      });
    }

    // 5. Update session with injected origin and hash
    const updatedInjectedOrigins = {
      ...injectedOrigins,
      [origin]: currentHash || 'unknown',
    };

    await prisma.browserSession.update({
      where: { sessionId },
      data: {
        injectedOrigins: updatedInjectedOrigins,
      },
    });

    console.log(`  📝 Updated session injectedOrigins with ${origin}`);

    return res.json({
      injected: true,
      reason: injectedHash ? 'data_changed' : 'first_injection',
      count: entries.length,
    });

  } catch (error) {
    console.error('❌ Failed to inject localStorage:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to inject localStorage'
    });
  }
});

export default router;

