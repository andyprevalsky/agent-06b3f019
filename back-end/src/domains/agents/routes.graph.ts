/**
 * /api/agent-graph — the agent graph seen from one agent of one tree.
 *
 *   GET  /agents          list root + every agent / code agent in the caller's tree
 *   POST /messages        { to, text, message_id }  send to one of them (idempotent;
 *                         `to` may be an id, "parent" or "root"; a sender over its
 *                         budget gets 429 + Retry-After, a retry of a delivered
 *                         message never does)
 *   POST /grep            { pattern, agent_id?, role?, head_limit?, case_insensitive? }
 *   GET  /question-route  code agents: { deliver_to: "user" | "agent", agent_id }
 *   POST /token           code agents: swap a still-valid token for a fresh one
 *
 * Auth (scope comes from the credential, never from the body):
 *   - `Bearer rag.…` token minted for one code session (rose-agents CLI)
 *   - internal X-API-Key + `X-Agent-Id: <Rose agent id>` (agents worker), plus
 *     `X-Code-Session-Id` + `X-Code-Provider` to act as one of that agent's
 *     code sessions
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import {
  isAgentGraphToken,
  verifyAgentGraphToken,
  type AgentGraphClaims,
} from '../../providers/agentGraph/token';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as graphService from './agentGraphService';
import * as questionService from './agentGraphQuestionService';
import * as sendService from './agentGraphSendService';
import { killGraphAgent } from './agentGraphKillService';

const log = createLogger('AgentGraphRoutes');
const router = Router();

const sendSchema = z.object({
  to: z.string().min(1).max(100),
  text: z.string().min(1).max(20_000),
  message_id: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/),
});

const grepSchema = z.object({
  pattern: z.string().min(1).max(500),
  agent_id: z.string().min(1).max(100).optional(),
  role: z.enum(['USER', 'ASSISTANT', 'TOOL']).optional(),
  head_limit: z.number().int().min(1).max(100).optional(),
  case_insensitive: z.boolean().optional(),
  since: z.string().max(40).optional(),
  until: z.string().max(40).optional(),
});

type GraphRequest = HybridAuthRequest & {
  graphCaller?: graphService.GraphCaller;
  graphClaims?: AgentGraphClaims;
};

function bearer(req: Request): string {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof graphService.AgentGraphError) {
    if (err.retryAfterSeconds !== undefined) res.setHeader('Retry-After', err.retryAfterSeconds);
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

async function resolveInternalCaller(req: GraphRequest, res: Response): Promise<void> {
  if (req.isInternal !== true) {
    res.status(401).json({ error: 'Agent graph requires a session token or the internal API key' });
    return;
  }
  const agentId = req.header('x-agent-id');
  if (agentId === undefined || agentId === '') {
    res.status(400).json({ error: 'X-Agent-Id is required for API-key calls' });
    return;
  }
  const sessionId = req.header('x-code-session-id');
  if (sessionId === undefined || sessionId === '') {
    req.graphCaller = await graphService.callerForAgent(agentId);
    return;
  }
  const provider = req.header('x-code-provider') === 'codex' ? 'codex' : 'claude';
  req.graphCaller = await graphService.callerForCodeSession(agentId, sessionId, provider);
}

function graphAuth(req: GraphRequest, res: Response, next: NextFunction): void {
  const token = bearer(req);
  if (isAgentGraphToken(token)) {
    const check = verifyAgentGraphToken(token);
    if (!check.ok) {
      log.warn('Rejected agent graph token', { reason: check.reason });
      res.status(401).json({ error: `Invalid agent graph token (${check.reason})` });
      return;
    }
    const { claims } = check;
    req.graphClaims = claims;
    req.graphCaller = {
      userId: claims.sub,
      rootAgentId: claims.rootAgentId,
      self: {
        kind: 'code',
        id: claims.sessionId,
        ownerAgentId: claims.ownerAgentId,
        provider: claims.provider,
      },
    };
    graphService
      .assertCodeCallerLive(req.graphCaller)
      .then(() => next())
      .catch((err: unknown) => {
        try {
          sendError(res, err);
        } catch (unexpected) {
          next(unexpected);
        }
      });
    return;
  }
  void hybridAuth(req, res, () => {
    resolveInternalCaller(req, res)
      .then(() => {
        if (req.graphCaller !== undefined) next();
      })
      .catch((err: unknown) => {
        try {
          sendError(res, err);
        } catch (unexpected) {
          next(unexpected);
        }
      });
  });
}

function caller(req: GraphRequest): graphService.GraphCaller {
  if (req.graphCaller === undefined) throw new Error('graphAuth did not resolve a caller');
  return req.graphCaller;
}

router.delete(
  '/agents/:id',
  graphAuth,
  asyncHandler<GraphRequest>(async (req, res) => {
    try {
      res.json(await killGraphAgent(caller(req), req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  })
);

router.get(
  '/agents',
  graphAuth,
  asyncHandler<GraphRequest>(async (req, res) => {
    try {
      res.json(await graphService.listGraph(caller(req)));
    } catch (err) {
      sendError(res, err);
    }
  })
);

router.post(
  '/messages',
  graphAuth,
  asyncHandler<GraphRequest>(async (req, res) => {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await sendService.sendGraphMessage(caller(req), parsed.data));
    } catch (err) {
      sendError(res, err);
    }
  })
);

router.post(
  '/grep',
  graphAuth,
  asyncHandler<GraphRequest>(async (req, res) => {
    const parsed = grepSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await graphService.grepGraph(caller(req), parsed.data));
    } catch (err) {
      sendError(res, err);
    }
  })
);

router.get(
  '/question-route',
  graphAuth,
  asyncHandler<GraphRequest>(async (req, res) => {
    const self = caller(req).self;
    if (self.kind !== 'code') {
      res.status(400).json({ error: 'Question routing is for code agents' });
      return;
    }
    try {
      res.json(await questionService.questionRouteForCodeSession(self.id));
    } catch (err) {
      sendError(res, err);
    }
  })
);

router.post(
  '/token',
  graphAuth,
  asyncHandler<GraphRequest>(async (req, res) => {
    if (req.graphClaims === undefined) {
      res.status(400).json({ error: 'Only code-session tokens can be refreshed' });
      return;
    }
    res.json(graphService.refreshCodeSessionToken(req.graphClaims));
  })
);

export default router;
