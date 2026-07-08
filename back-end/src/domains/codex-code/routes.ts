import { type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import type { FilePointer } from '../../providers/storage';
import { createSessionSchema, closeSessionSchema } from './types';
import * as service from './service';
import { GitHubAccessDeniedError, MissingUserIdError } from './service';

const log = createLogger('CodexCodeRoutes');
const router = Router();

router.post(
  '/create',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const {
        agent_id,
        goal,
        attachments,
        github_repo_url,
        user_id,
        fast_mode_cache_enabled,
      } = createSessionSchema.parse(req.body);

      const result = await service.createSession({
        agent_id,
        goal,
        attachments: attachments as FilePointer[] | undefined,
        github_repo_url,
        user_id,
        fast_mode_cache_enabled,
      });

      res.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof MissingUserIdError) {
        res.status(400).json({ error: error.message, code: 'MISSING_USER_ID' });
        return;
      }
      if (error instanceof GitHubAccessDeniedError) {
        res.status(403).json({ error: error.detail, code: 'GITHUB_ACCESS_DENIED' });
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
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { task_id, user_id, agent_id, additional_paths } = closeSessionSchema.parse(req.body);
      const result = await service.closeSession({ task_id, user_id, agent_id, additional_paths });
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
      const session = await service.getSession(req.params.taskId);
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
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { output } = req.body as { output: unknown };
      if (output === undefined || output === null || typeof output !== 'string' || output === '') {
        res.status(400).json({ error: 'output field required' });
        return;
      }

      await service.persistOutput(req.params.taskId, output);
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
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await service.checkSandboxHealth(req.params.sandboxId);
    res.json(result);
  })
);

export default router;
