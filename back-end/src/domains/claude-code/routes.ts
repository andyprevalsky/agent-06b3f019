/**
 * Claude Code session routes -- thin controller layer.
 *
 * POST /api/claude-code-session/create   - Create a new E2B sandbox session
 * POST /api/claude-code-session/close    - Close a session (checkpoint + pause a persistent
 *                                          code session's sandbox; kill legacy sessions)
 * POST /api/claude-code-session/checkpoint - Checkpoint a running task's code session
 * GET  /api/claude-code-session/code-sessions/:id    - Owned code session (404 otherwise)
 * DELETE /api/claude-code-session/code-sessions/:id - Retire it (kill + delete checkpoints)
 * GET  /api/claude-code-session/:taskId  - Get session info
 * GET  /api/claude-code-session/agent/:agentId - Get all sessions for an agent
 * POST /api/claude-code-session/:taskId/output - Persist terminal output
 * GET  /api/claude-code-session/:sandboxId/health - Health check sandbox
 */

import { type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { createSessionSchema, closeSessionSchema } from './types';
import type { FilePointer } from '../../providers/storage';
import * as service from './service';
import { registerCodeSessionRoutes, sendCodeSessionError } from './routes.codeSessions';
import { AgentOwnerMismatchError, MissingUserIdError, GitHubAccessDeniedError } from './service';
import { ProjectNotFoundForSessionError } from '../../providers/projects/session';

const log = createLogger('ClaudeCodeRoutes');
const router = Router();

registerCodeSessionRoutes(router);

/**
 * POST /api/claude-code-session/create
 * Create a new E2B sandbox with Claude Code and WebSocket streaming.
 * Called by agents service to create a new session.
 * ANTHROPIC_API_KEY is injected from backend environment.
 */
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
        code_session_id,
        lease_owner,
        base_branch,
        project_id,
      } = createSessionSchema.parse(req.body);

      const result = await service.createSession({
        agent_id,
        goal,
        attachments: attachments as FilePointer[] | undefined,
        github_repo_url,
        user_id,
        code_session_id,
        lease_owner,
        base_branch,
        project_id,
      });

      res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      if (error instanceof MissingUserIdError) {
        res.status(400).json({
          error: 'user_id is required when using github_repo_url',
          code: 'MISSING_USER_ID',
        });
        return;
      }
      if (error instanceof GitHubAccessDeniedError) {
        res.status(403).json({
          error: error.detail,
          code: 'GITHUB_ACCESS_DENIED',
        });
        return;
      }
      if (error instanceof ProjectNotFoundForSessionError) {
        res.status(404).json({ error: error.message, code: 'PROJECT_NOT_FOUND' });
        return;
      }
      if (error instanceof AgentOwnerMismatchError) {
        res.status(403).json({
          error: error.message,
          code: 'AGENT_OWNER_MISMATCH',
        });
        return;
      }
      if (sendCodeSessionError(res, error)) return;
      log.error('Failed to create Claude Code session', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to create Claude Code session',
      });
    }
  })
);

/**
 * POST /api/claude-code-session/close
 * Close a Claude Code session (kills the sandbox).
 */
router.post(
  '/close',
  authenticate,
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

      res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      log.error('Failed to close Claude Code session', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to close Claude Code session',
      });
    }
  })
);

/**
 * GET /api/claude-code-session/:taskId
 * Get session info for a task.
 */
router.get(
  '/:taskId',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { taskId } = req.params;

      const session = await service.getSession(taskId);

      if (session === null) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.json(session);
    } catch (error) {
      log.error('Failed to get Claude Code session', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get session info',
      });
    }
  })
);

/**
 * GET /api/claude-code-session/agent/:agentId
 * Get all sessions for an agent.
 */
router.get(
  '/agent/:agentId',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { agentId } = req.params;

      const sessions = await service.getAgentSessions(agentId);

      res.json({ sessions });
    } catch (error) {
      log.error('Failed to get agent sessions', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to get agent sessions' });
    }
  })
);

/**
 * POST /api/claude-code-session/:taskId/output
 * Persist terminal output for a Claude Code session.
 * Called by the agent worker after the session completes.
 */
router.post(
  '/:taskId/output',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { taskId } = req.params;
      const { output } = req.body as { output: unknown };

      if (output === undefined || output === null || typeof output !== 'string' || output === '') {
        res.status(400).json({ error: 'output field required' });
        return;
      }

      await service.persistOutput(taskId, output);

      res.json({ success: true });
    } catch (error) {
      log.error('Failed to persist Claude Code output', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to persist output',
      });
    }
  })
);

/**
 * GET /api/claude-code-session/:sandboxId/health
 * Check if an E2B sandbox is still alive and responsive.
 * Used by agents to determine root cause of WebSocket disconnects.
 *
 * If sandbox is alive, extracts diagnostic info to help debug crashes.
 */
router.get(
  '/:sandboxId/health',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { sandboxId } = req.params;

    const result = await service.checkSandboxHealth(sandboxId);

    res.json(result);
  })
);

export default router;
