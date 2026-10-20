/**
 * Persistent code-session routes (mounted on /api/claude-code-session).
 *
 * GET    /code-sessions/:id  - the caller's code session (404 for unknown/foreign)
 * DELETE /code-sessions/:id  - retire it: kill sandbox, delete checkpoints
 * POST   /checkpoint         - checkpoint a running task (worker drain) without pausing
 * POST   /:taskId/keepalive  - extend an attached task's sandbox idle window + lease
 *
 * Every read/write is scoped to the authenticated user; a foreign id is
 * indistinguishable from an unknown one.
 */
import { type Response, type Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { authenticate, type AuthRequest } from '../../providers/auth';
import {
  checkpointRunningTask,
  codeSessionHttpError,
  getOwnedCodeSessionView,
  keepAliveCodeTask,
  retireOwnedCodeSession,
} from '../../providers/codeSessions/spawn';
import { asyncHandler } from '../../utils/asyncHandler';
import { codeSessionCheckpointSchema } from './types';

const auth = asyncHandler<HybridAuthRequest>(hybridAuth);
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Map code-session errors to HTTP; returns true when a response was sent. */
export function sendCodeSessionError(res: Response, error: unknown): boolean {
  const mapped = codeSessionHttpError(error);
  if (mapped === null) return false;
  res.status(mapped.status).json(mapped.body);
  return true;
}

function callerUserId(req: HybridAuthRequest): string | undefined {
  const userId = req.userId ?? req.user?.id;
  return userId !== undefined && userId !== '' ? userId : undefined;
}

export function registerCodeSessionRoutes(router: Router): void {
  router.get(
    '/code-sessions/:id',
    auth,
    asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
      const userId = callerUserId(req);
      if (userId === undefined) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (!UUID.test(req.params.id)) {
        res.status(404).json({ error: 'Code session not found', code: 'CODE_SESSION_NOT_FOUND' });
        return;
      }
      try {
        res.json(await getOwnedCodeSessionView(userId, req.params.id));
      } catch (error) {
        if (sendCodeSessionError(res, error)) return;
        throw error;
      }
    })
  );

  router.delete(
    '/code-sessions/:id',
    auth,
    asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
      const userId = callerUserId(req);
      if (userId === undefined) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (!UUID.test(req.params.id)) {
        res.status(404).json({ error: 'Code session not found', code: 'CODE_SESSION_NOT_FOUND' });
        return;
      }
      try {
        res.json(await retireOwnedCodeSession(userId, req.params.id));
      } catch (error) {
        if (sendCodeSessionError(res, error)) return;
        throw error;
      }
    })
  );

  router.post(
    '/checkpoint',
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (req.isInternal !== true) {
        res.status(403).json({ error: 'Internal callers only' });
        return;
      }
      const { task_id, reason } = codeSessionCheckpointSchema.parse(req.body);
      res.json(await checkpointRunningTask(task_id, reason ?? 'drain'));
    })
  );

  registerCodeSessionTaskRoutes(router);
}

/**
 * Task-scoped routes shared by the Claude Code and Codex routers.
 *
 * POST /:taskId/keepalive - the attached activity extends the sandbox idle
 *                           window and the session lease (internal only).
 */
export function registerCodeSessionTaskRoutes(router: Router): void {
  router.post(
    '/:taskId/keepalive',
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (req.isInternal !== true) {
        res.status(403).json({ error: 'Internal callers only' });
        return;
      }
      if (!UUID.test(req.params.taskId)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.json(await keepAliveCodeTask(req.params.taskId));
    })
  );
}
