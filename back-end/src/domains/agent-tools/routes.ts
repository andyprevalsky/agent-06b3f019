/**
 * /api/agent-tools/:agentId — the Rose tools agents use to talk to the user
 * (see service.ts for the flow diagram).
 *
 * Auth:
 *   Bearer rtt.<token>  code-agent sandbox token scoped to ONE agent (403 for others)
 *   X-API-Key           agents worker (internal); X-User-Id, when sent, must own the agent
 * A user session JWT is refused: these tools speak FOR an agent.
 */
import { Router, type NextFunction, type Response } from 'express';
import { CliIntegrationError } from '../../providers/cliIntegrations';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { isAgentToolsToken, verifyAgentToolsToken } from '../../providers/agentTools/token';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { displayMedia } from './displayService';
import { readEnvironment, requestEnvironmentSize } from './environmentService';
import { sandboxResizeHttpError } from '../../providers/codeSessions/sandboxResize';
import { sendMessageToUser } from './messageService';
import { answerQuestion } from './questionService';
import { waitForRequest } from './requestService';
import { generateVideo, readGeneratedVideo } from './videoService';
import { generateVideoRequestSchema } from './videoTypes';
import { AgentToolsError, resolveContext } from './service';
import {
  agentToolsAgentIdSchema,
  answerQuestionSchema,
  displayRequestSchema,
  environmentSizeSchema,
  messageRequestSchema,
  waitQuerySchema,
  type AgentToolsCaller,
} from './types';
import { REQUEST_WAIT_MAX_SECONDS } from './config';
import { mountCliToolRoutes } from './routes.cli';
import { mountMcpToolRoutes } from './routes.mcp';

const log = createLogger('AgentToolsRoutes');
const router = Router();

export interface AgentToolsRequest extends HybridAuthRequest {
  agentToolsToken?: {
    userId: string;
    agentId: string;
    provider: 'claude' | 'codex' | null;
    taskId: string | null;
  };
}

/** Agent-tools token OR internal hybrid auth. */
function agentToolsAuth(req: AgentToolsRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!isAgentToolsToken(bearer)) {
    void hybridAuth(req, res, next);
    return;
  }
  const check = verifyAgentToolsToken(bearer);
  if (!check.ok) {
    log.warn('Rejected agent-tools token', { reason: check.reason });
    res.status(401).json({ error: `Invalid agent tools token (${check.reason})` });
    return;
  }
  req.userId = check.userId;
  req.isInternal = false;
  req.agentToolsToken = {
    userId: check.userId,
    agentId: check.agentId,
    provider: check.provider,
    taskId: check.taskId,
  };
  next();
}

function callerFor(req: AgentToolsRequest, res: Response): AgentToolsCaller | null {
  const agentId = agentToolsAgentIdSchema.safeParse(req.params.agentId);
  if (!agentId.success) {
    res.status(404).json({ error: 'Agent not found' });
    return null;
  }
  const token = req.agentToolsToken;
  if (token !== undefined) {
    if (token.agentId !== agentId.data) {
      res.status(403).json({ error: 'Agent tools token is scoped to a different agent' });
      return null;
    }
    return {
      kind: 'code_agent',
      userId: token.userId,
      agentId: agentId.data,
      provider: token.provider,
      taskId: token.taskId,
    };
  }
  if (req.isInternal !== true) {
    res
      .status(403)
      .json({ error: 'Agent tools are for agents (sandbox token or internal API key)' });
    return null;
  }
  const userId = typeof req.userId === 'string' && req.userId.length > 0 ? req.userId : null;
  return { kind: 'agent', userId, agentId: agentId.data };
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof CliIntegrationError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof AgentToolsError) {
    res
      .status(err.status)
      .json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    return;
  }
  const resize = sandboxResizeHttpError(err);
  if (resize !== null) {
    res.status(resize.status).json(resize.body);
    return;
  }
  throw err;
}

function invalidBody(res: Response, issues: { path: (string | number)[]; message: string }[]) {
  res.status(400).json({
    error: 'Invalid body',
    details: issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  });
}

mountCliToolRoutes(router, agentToolsAuth, callerFor, sendError);
mountMcpToolRoutes(router, agentToolsAuth, callerFor, sendError);

router.post(
  '/:agentId/display',
  agentToolsAuth,
  asyncHandler<AgentToolsRequest>(async (req, res) => {
    const caller = callerFor(req, res);
    if (caller === null) return;
    const parsed = displayRequestSchema.safeParse(req.body);
    if (!parsed.success) return invalidBody(res, parsed.error.issues);
    try {
      const result = await displayMedia(await resolveContext(caller), parsed.data);
      res.status(result.posted_count > 0 || result.question !== undefined ? 201 : 200).json(result);
    } catch (err) {
      sendError(res, err);
    }
  })
);

/** POST /:agentId/generate-video — Gemini Omni video → stored file (videoService.ts). */
router.post(
  '/:agentId/generate-video',
  agentToolsAuth,
  asyncHandler<AgentToolsRequest>(async (req, res) => {
    const caller = callerFor(req, res);
    if (caller === null) return;
    const parsed = generateVideoRequestSchema.safeParse(req.body);
    if (!parsed.success) return invalidBody(res, parsed.error.issues);
    try {
      const result = await generateVideo(await resolveContext(caller), parsed.data);
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (err) {
      sendError(res, err);
    }
  })
);

/** GET /:agentId/generated-video/:sha256 — the MP4 bytes of a video the owner generated. */
router.get(
  '/:agentId/generated-video/:sha256',
  agentToolsAuth,
  asyncHandler<AgentToolsRequest>(async (req, res) => {
    const caller = callerFor(req, res);
    if (caller === null) return;
    try {
      const bytes = await readGeneratedVideo(await resolveContext(caller), req.params.sha256);
      res.status(200).type('video/mp4').send(bytes);
    } catch (err) {
      sendError(res, err);
    }
  })
);

router.post(
  '/:agentId/messages',
  agentToolsAuth,
  asyncHandler<AgentToolsRequest>(async (req, res) => {
    const caller = callerFor(req, res);
    if (caller === null) return;
    const parsed = messageRequestSchema.safeParse(req.body);
    if (!parsed.success) return invalidBody(res, parsed.error.issues);
    try {
      res.status(201).json(await sendMessageToUser(await resolveContext(caller), parsed.data));
    } catch (err) {
      sendError(res, err);
    }
  })
);

/** GET /:agentId/environment — the session's sandbox size, cap, built sizes, recent resizes (C16). */
router.get(
  '/:agentId/environment',
  agentToolsAuth,
  asyncHandler<AgentToolsRequest>(async (req, res) => {
    const caller = callerFor(req, res);
    if (caller === null) return;
    try {
      res.json(await readEnvironment(caller));
    } catch (err) {
      sendError(res, err);
    }
  })
);

/** POST /:agentId/environment/size {cpu?, memory_gb?, reason} — 202 accepted (C16). */
router.post(
  '/:agentId/environment/size',
  agentToolsAuth,
  asyncHandler<AgentToolsRequest>(async (req, res) => {
    const caller = callerFor(req, res);
    if (caller === null) return;
    const parsed = environmentSizeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalidBody(res, parsed.error.issues);
    try {
      const result = await requestEnvironmentSize(caller, parsed.data);
      res.status(result.httpStatus).json(result.body);
    } catch (err) {
      sendError(res, err);
    }
  })
);

router.get(
  '/:agentId/requests/:requestId',
  agentToolsAuth,
  asyncHandler<AgentToolsRequest>(async (req, res) => {
    const caller = callerFor(req, res);
    if (caller === null) return;
    const query = waitQuerySchema.safeParse(req.query);
    if (!query.success) return invalidBody(res, query.error.issues);
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const state = await waitForRequest(
        await resolveContext(caller),
        String(req.params.requestId),
        Math.min(query.data.wait, REQUEST_WAIT_MAX_SECONDS),
        abort.signal
      );
      res.json(state);
    } catch (err) {
      sendError(res, err);
    }
  })
);

export default router;

/**
 * Mounted at /api/agents (before the agents router; it has no router-wide
 * auth). POST /:id/questions/:questionId/answer {answer} | {dismiss: true}
 *   user session (owner) or internal API key (a parent agent answering).
 */
export const agentQuestionsRouter = Router();

agentQuestionsRouter.post(
  '/:id/questions/:questionId/answer',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const agentId = agentToolsAgentIdSchema.safeParse(req.params.id);
    if (!agentId.success) {
      res.status(404).json({ error: 'Question not found' });
      return;
    }
    const parsed = answerQuestionSchema.safeParse(req.body);
    if (!parsed.success) return invalidBody(res, parsed.error.issues);
    const userId = req.userId ?? req.user?.id ?? null;
    if (userId === null && req.isInternal !== true) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    try {
      const state = await answerQuestion({
        agentId: agentId.data,
        questionId: String(req.params.questionId),
        userId,
        answer: parsed.data.answer ?? null,
        dismiss: parsed.data.dismiss === true,
        byUser: req.isInternal !== true,
      });
      res.json(state);
    } catch (err) {
      sendError(res, err);
    }
  })
);
