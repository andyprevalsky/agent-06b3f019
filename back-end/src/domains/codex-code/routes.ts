import { type Response, Router } from 'express';
import { ZodError } from 'zod';
import { type AuthRequest, authenticate, authenticateInternal } from '../../providers/auth';
import { callerCanAccessAgent, callerCanAccessCodeTask } from '../../providers/agentAccess';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import type { FilePointer } from '../../providers/storage';
import {
  createSessionSchema,
  closeSessionSchema,
  codeTaskResizeSchema,
  codeTaskUsageLimitSchema,
} from './types';
import { sandboxResizeHttpError } from '../../providers/codeSessions/sandboxResize';
import * as service from './service';
import { resizeSession } from './resizeService';
import { codeSessionHttpError, keepAliveCodeTask } from '../../providers/codeSessions/spawn';
import { parseResetsAt, reportCodeTaskUsageLimit } from '../../providers/codeSessions/usageLimit';
import { GitHubAccessDeniedError, MissingUserIdError } from './service';
import { ProjectNotFoundForSessionError } from '../../providers/projects/session';
import {
  LocalTargetUnavailableError,
  localTargetUnavailableBody,
} from '../../providers/localDevices/messages';
import {
  LocalSessionOwnerMismatchError,
  createLocalCodeSessionResponse,
} from '../../providers/localDevices/session';

const log = createLogger('CodexCodeRoutes');
const router = Router();

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/**
 * POST /api/codex-code-session/:taskId/keepalive - the attached activity extends
 * the sandbox idle window and the code-session lease (internal only).
 */
function invalidRequestBody(error: ZodError): { error: string; code: string } {
  const detail = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return { error: `Invalid request: ${detail}`, code: 'INVALID_REQUEST' };
}

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

/**
 * POST /api/codex-code-session/:taskId/usage-limit - Codex stopped on a usage
 * limit (structured codex_error_info): rate-limit its credential (C15).
 */
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
    res.json(await reportCodeTaskUsageLimit(req.params.taskId, 'codex', parseResetsAt(resets_at)));
  })
);

/**
 * POST /api/codex-code-session/:taskId/resize - apply a pending sandbox size
 * change and return the task that continues the session (C16, internal only).
 */
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
      const mapped = sandboxResizeHttpError(error) ?? codeSessionHttpError(error);
      if (mapped !== null) {
        res.status(mapped.status).json(mapped.body);
        return;
      }
      throw error;
    }
  })
);

/** Typed create failures that map to a client error rather than a 500. */
function createErrorResponse(error: unknown): { status: number; body: object } | null {
  if (error instanceof MissingUserIdError) {
    return { status: 400, body: { error: error.message, code: 'MISSING_USER_ID' } };
  }
  if (error instanceof GitHubAccessDeniedError) {
    return { status: 403, body: { error: error.detail, code: 'GITHUB_ACCESS_DENIED' } };
  }
  if (error instanceof ProjectNotFoundForSessionError) {
    return { status: 404, body: { error: error.message, code: 'PROJECT_NOT_FOUND' } };
  }
  return null;
}

router.post(
  '/create',
  authenticateInternal,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const body = createSessionSchema.parse(req.body);

      // C14: a local session runs on the agent tree's Mac with the user's own
      // login (no persistent code session: the work stays in the granted folder).
      const result =
        body.target === 'local'
          ? await createLocalCodeSessionResponse({
              agentId: body.agent_id,
              goal: body.goal,
              provider: 'codex',
              expectedUserId: body.user_id,
              deviceId: body.device_id,
              taskName: body.task_name ?? null,
            })
          : await service.createSession({
              ...body,
              attachments: body.attachments as FilePointer[] | undefined,
            });

      res.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json(invalidRequestBody(error));
        return;
      }
      if (error instanceof LocalTargetUnavailableError) {
        res.status(409).json(localTargetUnavailableBody(error));
        return;
      }
      if (error instanceof LocalSessionOwnerMismatchError) {
        res.status(403).json({ error: error.message, code: 'AGENT_OWNER_MISMATCH' });
        return;
      }
      const known = createErrorResponse(error);
      if (known !== null) {
        res.status(known.status).json(known.body);
        return;
      }
      const sessionError = codeSessionHttpError(error);
      if (sessionError !== null) {
        res.status(sessionError.status).json(sessionError.body);
        return;
      }
      log.error('Failed to create Codex Code session', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to create Codex Code session',
      });
    }
  })
);

router.post(
  '/close',
  authenticateInternal,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { task_id, user_id, agent_id, additional_paths, reason } = closeSessionSchema.parse(
        req.body
      );
      const result = await service.closeSession({
        task_id,
        user_id,
        agent_id,
        additional_paths,
        reason,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      log.error('Failed to close Codex Code session', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to close Codex Code session',
      });
    }
  })
);

router.get(
  '/:taskId',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const session = (await callerCanAccessCodeTask(req, req.params.taskId))
        ? await service.getSession(req.params.taskId)
        : null;
      if (session === null) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.json(session);
    } catch (error) {
      log.error('Failed to get Codex Code session', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get session info',
      });
    }
  })
);

router.get(
  '/agent/:agentId',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      if (!(await callerCanAccessAgent(req, req.params.agentId))) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      const sessions = await service.getAgentSessions(req.params.agentId);
      res.json({ sessions });
    } catch (error) {
      log.error('Failed to get Codex Code agent sessions', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to get agent sessions' });
    }
  })
);

router.post(
  '/:taskId/output',
  authenticateInternal,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { output, credential_feedback: rawCredentialFeedback } = req.body as {
        output: unknown;
        credential_feedback?: unknown;
      };
      if (output === undefined || output === null || typeof output !== 'string' || output === '') {
        res.status(400).json({ error: 'output field required' });
        return;
      }

      let credentialFeedback: service.CodexCredentialFeedback[] | undefined;
      if (rawCredentialFeedback !== undefined) {
        if (!Array.isArray(rawCredentialFeedback) || rawCredentialFeedback.length > 3) {
          res.status(400).json({ error: 'credential_feedback must contain at most 3 events' });
          return;
        }
        if (!rawCredentialFeedback.every(service.isCodexCredentialFeedback)) {
          res.status(400).json({ error: 'credential_feedback event is invalid' });
          return;
        }
        credentialFeedback = rawCredentialFeedback as service.CodexCredentialFeedback[];
      }

      await service.persistOutput(req.params.taskId, output, credentialFeedback);
      res.json({ success: true });
    } catch (error) {
      log.error('Failed to persist Codex Code output', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to persist output',
      });
    }
  })
);

router.get(
  '/:sandboxId/health',
  authenticateInternal,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await service.checkSandboxHealth(req.params.sandboxId);
    res.json(result);
  })
);

export default router;
