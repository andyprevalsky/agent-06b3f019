import { type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import type { FilePointer } from '../../providers/storage';
import { createSessionSchema, closeSessionSchema } from './types';
import * as service from './service';
import { GitHubAccessDeniedError, MissingUserIdError } from './service';
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
        memory_enabled,
        harness_mode,
        rose_api_base_url,
        target,
      } = createSessionSchema.parse(req.body);

      // C14: a local session runs on the agent tree's Mac with the user's own login.
      const result =
        target === 'local'
          ? await createLocalCodeSessionResponse({
              agentId: agent_id,
              goal,
              provider: 'codex',
              expectedUserId: user_id,
            })
          : await service.createSession({
              agent_id,
              goal,
              attachments: attachments as FilePointer[] | undefined,
              github_repo_url,
              user_id,
              fast_mode_cache_enabled,
              memory_enabled,
              harness_mode,
              rose_api_base_url,
            });

      res.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof LocalTargetUnavailableError) {
        res.status(409).json(localTargetUnavailableBody(error));
        return;
      }
      if (error instanceof LocalSessionOwnerMismatchError) {
        res.status(403).json({ error: error.message, code: 'AGENT_OWNER_MISMATCH' });
        return;
      }
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
        const validSources = new Set(['initial', 'oauth', 'funded_api_key']);
        const valid = rawCredentialFeedback.every((item) => {
          if (typeof item !== 'object' || item === null) return false;
          const candidate = item as Record<string, unknown>;
          return (
            typeof candidate.source === 'string' &&
            validSources.has(candidate.source) &&
            typeof candidate.reason === 'string' &&
            candidate.reason.length > 0 &&
            candidate.reason.length <= 2000
          );
        });
        if (!valid) {
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
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await service.checkSandboxHealth(req.params.sandboxId);
    res.json(result);
  })
);

export default router;
