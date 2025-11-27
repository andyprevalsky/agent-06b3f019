import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthRequest, authenticate } from '../middleware/auth';
import { 
  getOrCreateContext, 
  createSessionWithContext, 
  closeSession,
  resumeSession,
  getSession,
  injectUserCookies
} from '../lib/browserbase';

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
      project_id: process.env.BROWSERBASE_PROJECT_ID,
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

export default router;

