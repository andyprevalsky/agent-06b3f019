/**
 * Persistent code-session routes (mounted on /api/claude-code-session).
 *
 * GET    /code-sessions/:id  - the caller's code session (404 for unknown/foreign)
 * DELETE /code-sessions/:id  - retire it: kill sandbox, delete checkpoints
 * POST   /checkpoint         - checkpoint a running task (worker drain) without pausing
 * POST   /:taskId/keepalive  - extend an attached task's sandbox idle window + lease
 * POST   /:taskId/usage-limit - the CLI stopped on a usage limit: rate-limit its credential (C15)
 * POST   /:taskId/resize    - apply a pending sandbox size change; returns the continuing task (C16)
 * GET    /:taskId/preview   - live dev-server preview of the task's session (dev accounts, A1)
 * POST   /:taskId/preview/handoff - one-time code that signs that preview in (routes.previewHandoff.ts)
 * POST   /:taskId/publish   - push its branch + open a PR, never merge (dev accounts, A1)
 * GET    /credential-availability?user_id[&own_only=true][&code_session_id&prefer] - can a Claude / Codex
 *        credential be leased now; with code_session_id also the session's provider and the outlook (C15)
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
import {
  CodePublishError,
  getOwnedTaskPreview,
  publishOwnedTask,
} from '../../providers/codePreview/service';
import { ROSE_DEV_ONLY_BODY, isRoseDevUser } from '../../utils/roseDevAccess';
import {
  codePublishSchema,
  codeSessionCheckpointSchema,
  codeTaskResizeSchema,
  codeTaskUsageLimitSchema,
  credentialAvailabilityQuerySchema,
} from './types';
import { registerPreviewHandoffMintRoute } from './routes.previewHandoff';
import { resizeSession } from './resizeService';
import { sandboxResizeHttpError } from '../../providers/codeSessions/sandboxResize';
import {
  codeSpawnCredentialPlan,
  parseResetsAt,
  reportCodeTaskUsageLimit,
} from '../../providers/codeSessions/usageLimit';

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

  router.get(
    '/credential-availability',
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (req.isInternal !== true) {
        res.status(403).json({ error: 'Internal callers only' });
        return;
      }
      const { user_id, own_only, code_session_id, prefer } =
        credentialAvailabilityQuerySchema.parse(req.query);
      res.json(
        await codeSpawnCredentialPlan(user_id, {
          ownOnly: own_only === 'true',
          ...(code_session_id !== undefined ? { codeSessionId: code_session_id } : {}),
          ...(prefer !== undefined ? { prefer } : {}),
        })
      );
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

/** Rose-in-Rose (A1): dev accounts only; returns the caller's id or sends 401/403. */
function devCaller(req: HybridAuthRequest, res: Response): string | null {
  const userId = callerUserId(req);
  if (userId === undefined) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  if (!isRoseDevUser(userId)) {
    res.status(403).json(ROSE_DEV_ONLY_BODY);
    return null;
  }
  return userId;
}

/**
 * Rose-in-Rose task routes (A1). Claude Code and Codex tasks share one table, so
 * these serve both providers' tasks under /api/claude-code-session.
 *
 * GET  /:taskId/preview   - where this task's live dev-server preview is served
 *                           and whether it answers (dev accounts only)
 * POST /:taskId/publish   - push the session's branch and open a PR; never
 *                           merges or deploys (dev accounts only)
 */
export function registerCodePreviewRoutes(router: Router): void {
  registerPreviewHandoffMintRoute(router);

  router.get(
    '/:taskId/preview',
    auth,
    asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
      const userId = devCaller(req, res);
      if (userId === null) return;
      const view = UUID.test(req.params.taskId)
        ? await getOwnedTaskPreview(userId, req.params.taskId)
        : null;
      if (view === null) {
        res.status(404).json({ error: 'Session not found', code: 'CODE_TASK_NOT_FOUND' });
        return;
      }
      res.json(view);
    })
  );

  router.post(
    '/:taskId/publish',
    auth,
    asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
      const userId = devCaller(req, res);
      if (userId === null) return;
      const body = codePublishSchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: 'Invalid body', details: body.error.issues });
        return;
      }
      try {
        const result = UUID.test(req.params.taskId)
          ? await publishOwnedTask(userId, req.params.taskId, body.data)
          : null;
        if (result === null) {
          res.status(404).json({ error: 'Session not found', code: 'CODE_TASK_NOT_FOUND' });
          return;
        }
        res.json(result);
      } catch (error) {
        if (error instanceof CodePublishError) {
          res.status(error.status).json({ error: error.message, code: error.code });
          return;
        }
        throw error;
      }
    })
  );
}

/**
 * Task-scoped routes shared by the Claude Code router.
 *
 * POST /:taskId/keepalive - the attached activity extends the sandbox idle
 *                           window and the session lease (internal only).
 */
export function registerCodeSessionTaskRoutes(router: Router): void {
  registerCodePreviewRoutes(router);

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

  router.post(
    '/:taskId/usage-limit',
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
      const { resets_at } = codeTaskUsageLimitSchema.parse(req.body ?? {});
      res.json(
        await reportCodeTaskUsageLimit(req.params.taskId, 'claude', parseResetsAt(resets_at))
      );
    })
  );

  router.post(
    '/:taskId/resize',
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (req.isInternal !== true) {
        res.status(403).json({ error: 'Internal callers only' });
        return;
      }
      const parsed = codeTaskResizeSchema.safeParse(req.body ?? {});
      if (!UUID.test(req.params.taskId) || !parsed.success) {
        res.status(400).json({ error: 'task id and request_id (uuid) are required' });
        return;
      }
      try {
        const result = await resizeSession(req.params.taskId, parsed.data.request_id);
        res.json({ ...result.session, resized: result.resized, request: result.request });
      } catch (error) {
        const mapped = sandboxResizeHttpError(error);
        if (mapped !== null) {
          res.status(mapped.status).json(mapped.body);
          return;
        }
        if (sendCodeSessionError(res, error)) return;
        throw error;
      }
    })
  );
}
