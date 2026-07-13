/**
 * Browser-session routes — thin controller layer.
 *
 * POST /api/browser-session/init                     - Initialize browser session
 * POST /api/browser-session/close                    - Close/pause browser session
 * POST /api/browser-session/resume                   - Resume paused browser task
 * GET  /api/browser-session/task/:taskId             - Get task info
 * POST /api/browser-session/task/:taskId/viewport    - Match remote viewport to live-view pane
 * GET  /api/browser-session/context/:userId          - Get user's browser context
 * GET  /api/browser-session/:sessionId               - Get session info
 * POST /api/browser-session/:sessionId/files         - Upload file to session
 * GET  /api/browser-session/:sessionId/files/list    - List session files
 * POST /api/browser-session/:sessionId/inject-localStorage - Inject localStorage
 */

import { type RequestHandler, type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import { BrowserProviderRateLimitError } from '../../providers/browser';
// eslint-disable-next-line no-restricted-imports -- Express file upload middleware, configured per-route
import multer from 'multer';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  initSession,
  closeBrowserSession,
  resumeBrowserSession,
  getTaskInfo,
  getTaskOwnerUserId,
  getContext,
  getSessionById,
  uploadFile,
  listFiles,
  injectLocalStorage,
  resizeBrowserViewport,
  SessionNotFoundError,
  SessionNoUserError,
  SessionNoWsUrlError,
  CdpInjectionError,
} from './service';
import {
  initSessionSchema,
  closeSessionSchema,
  resumeSessionSchema,
  injectLocalStorageSchema,
} from './types';
import { registerBrowserDataRoutes } from './routes.files';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const log = createLogger('BrowserSession');

const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);
const MAX_VIEWPORT_WIDTH = 4096;
const MAX_VIEWPORT_HEIGHT = 2160;

function isValidViewportDimension(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= maximum;
}

/* c8 ignore start -- init, close, resume require Steel SDK; files + inject require Steel/CDP */
/**
 * POST /api/browser-session/init
 * Initialize or get browser session for user.
 * Automatically injects user's stored Chrome cookies if available.
 * Fast operation - just creates session and injects cookies.
 */
router.post(
  '/init',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
    try {
      const { user_id, agent_id, start_url } = initSessionSchema.parse(req.body);
      const userId = req.isInternal === true ? user_id : req.userId;
      if (userId === undefined || userId === '') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const result = await initSession(userId, agent_id, start_url);

      res.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof BrowserProviderRateLimitError) {
        log.warn('Browser provider rate limit hit during session init', {
          provider: error.provider,
        });
        res.status(429).json({
          error: 'browser_provider_rate_limit',
          provider: error.provider,
          message: 'Browser session rate limit exceeded. Retry after delay.',
        });
        return;
      }
      log.error('Failed to init browser session', { error: String(error) });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to initialize browser session',
      });
    }
  })
);

/**
 * POST /api/browser-session/close
 * Close a browser session (stops billing).
 * @param pause - If true, session is PAUSED (resumable). If false, CLOSED (terminal).
 * Fast operation.
 */
router.post(
  '/close',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { session_id, pause, current_url } = closeSessionSchema.parse(req.body);

      const result = await closeBrowserSession(session_id, pause, current_url);

      res.json({ success: true, ...result });
    } catch (error) {
      log.error('Failed to close browser session', { error: String(error) });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to close browser session',
      });
    }
  })
);

/**
 * POST /api/browser-session/resume
 * Resume a paused browser task by creating a new session with the same context.
 * Automatically injects user's stored Chrome cookies if available.
 * Fast operation.
 */
router.post(
  '/resume',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { task_id } = resumeSessionSchema.parse(req.body);

      const result = await resumeBrowserSession(task_id);

      res.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof BrowserProviderRateLimitError) {
        log.warn('Browser provider rate limit hit during session resume', {
          provider: error.provider,
        });
        res.status(429).json({
          error: 'browser_provider_rate_limit',
          provider: error.provider,
          message: 'Browser session rate limit exceeded. Retry after delay.',
        });
        return;
      }
      log.error('Failed to resume browser task', { error: String(error) });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to resume browser task',
      });
    }
  })
);
/* c8 ignore stop */

/**
 * GET /api/browser-session/task/:taskId
 * Get current session info for a task.
 * Includes user's passwords for type interception.
 */
router.get(
  '/task/:taskId',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
    try {
      const { taskId } = req.params;

      if (req.isInternal !== true) {
        const ownerUserId = await getTaskOwnerUserId(taskId);
        if (ownerUserId !== req.userId) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
      }

      const validateLive = req.query.validateLive === 'true' || req.query.validate_live === 'true';
      const result = await getTaskInfo(taskId, { validateLive });

      if (!result) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.json(result);
    } catch (error) {
      log.error('Failed to get session info', { error: String(error) });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get session info',
      });
    }
  })
);

/**
 * POST /api/browser-session/task/:taskId/viewport
 * Resize the provider-owned remote viewport to the rendered live-view pane.
 */
router.post(
  '/task/:taskId/viewport',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
    const { taskId } = req.params;
    const body =
      typeof req.body === 'object' && req.body !== null
        ? (req.body as { width?: unknown; height?: unknown })
        : {};
    const { width, height } = body;
    if (
      !isValidViewportDimension(width, MAX_VIEWPORT_WIDTH) ||
      !isValidViewportDimension(height, MAX_VIEWPORT_HEIGHT)
    ) {
      res.status(400).json({ error: 'Invalid viewport dimensions' });
      return;
    }

    try {
      const result = await resizeBrowserViewport(
        taskId,
        { width, height },
        req.isInternal === true ? undefined : req.userId
      );
      res.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      log.error('Failed to resize browser viewport', { error: String(error), taskId });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to resize browser viewport',
      });
    }
  })
);

/**
 * GET /api/browser-session/context/:userId
 * Get user's browser context info.
 */
router.get(
  '/context/:userId',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
    try {
      const { userId } = req.params;

      if (req.isInternal !== true && userId !== req.userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const context = await getContext(userId);

      res.json({ context });
    } catch (error) {
      log.error('Failed to get context', { error: String(error) });
      res.status(500).json({ error: 'Failed to get context' });
    }
  })
);

/**
 * GET /api/browser-session/:sessionId
 * Get session info.
 */
router.get(
  '/:sessionId',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { sessionId } = req.params;

      const session = await getSessionById(sessionId);

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.json({ session });
    } catch (error) {
      log.error('Failed to get session', { error: String(error) });
      res.status(500).json({ error: 'Failed to get session' });
    }
  })
);

/* c8 ignore start -- file upload, list, and localStorage injection require Steel SDK/CDP */
/**
 * POST /api/browser-session/:sessionId/files
 * Upload a file to a Steel browser session.
 * The file becomes available in the session's VM environment for use with file inputs.
 */
router.post(
  '/:sessionId/files',
  authenticate,
  upload.single('file') as RequestHandler,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { sessionId } = req.params;

      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      const result = await uploadFile(
        sessionId,
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );

      res.json({ success: true, ...result });
    } catch (error) {
      log.error('Failed to upload file to session', { error: String(error) });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to upload file to session',
      });
    }
  })
);

/**
 * GET /api/browser-session/:sessionId/files/list
 * List all files in a Steel browser session.
 * Returns files that have been downloaded by the browser or uploaded.
 */
router.get(
  '/:sessionId/files/list',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { sessionId } = req.params;

      const result = await listFiles(sessionId);

      res.json({ success: true, ...result });
    } catch (error) {
      log.error('Failed to list session files', { error: String(error) });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to list session files',
      });
    }
  })
);

registerBrowserDataRoutes(router);

/**
 * POST /api/browser-session/:sessionId/inject-localStorage
 * Inject localStorage for a specific origin if not already injected or data has changed.
 * Called by browser agent after navigation to inject user's localStorage.
 *
 * Uses LocalStorageOrigin table for O(1) lookup by origin.
 */
router.post(
  '/:sessionId/inject-localStorage',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { sessionId } = req.params;
      const { origin } = injectLocalStorageSchema.parse(req.body);

      const result = await injectLocalStorage(sessionId, origin);

      res.json(result);
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error instanceof SessionNoUserError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof SessionNoWsUrlError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof CdpInjectionError) {
        res.status(500).json({
          error: 'Failed to inject localStorage via CDP',
          details: error.message,
        });
        return;
      }
      log.error('Failed to inject localStorage', { error: String(error) });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to inject localStorage',
      });
    }
  })
);
/* c8 ignore stop */

export default router;
