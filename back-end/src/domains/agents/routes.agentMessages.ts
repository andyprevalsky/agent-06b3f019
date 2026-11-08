/**
 * Agent-to-agent routes: send a message within a tree (finished targets wake),
 * kill an agent, list the tree, read a task inbox. Callers are agent workers (internal API key + X-User-Id) or the
 * owning user. Mounted by routes.ts.
 */

import { Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  agentAddressMessageSchema,
  agentInboxQuerySchema,
  agentKillSchema,
  agentMessageSchema,
  agentTreeQuerySchema,
  resolveAddressQuerySchema,
  undeliveredCodeTurnsSchema,
} from './types';
import { reportUndeliveredCodeTurns } from './agentCodeTurnUndelivered';
import * as a2aService from './agentToAgentService';
import { getAgentTreeView } from './agentTreeService';
import { killAgentByAddress } from './agentToAgentControlService';
import { handleRouteError, noCacheHeaders } from './routes.helpers';

const router = Router({ mergeParams: true });
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

function callerUserId(req: HybridAuthRequest): string | undefined | null {
  if (req.userId !== undefined && req.userId !== '') return req.userId;
  return req.isInternal === true ? undefined : null;
}

// POST /:id/agent-messages
router.post(
  '/:id/agent-messages',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = callerUserId(req);
      if (userId === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const body = agentMessageSchema.parse(req.body);
      const result = await a2aService.sendAgentMessage(req.params.id, body, userId);
      if ('error' in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.status(201).json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to send agent message', { agent_id: req.params.id });
    }
  })
);

// POST /:id/code-turns-undelivered (agent workers only): agent turns a code
// session accepted and lost when it ended; their senders are told (idempotent).
router.post(
  '/:id/code-turns-undelivered',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      if (req.isInternal !== true) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const body = undeliveredCodeTurnsSchema.parse(req.body);
      const result = await reportUndeliveredCodeTurns({
        ownerAgentId: req.params.id,
        sessionId: body.session_id,
        turnIds: body.turn_ids,
        reason: body.reason,
      });
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to report undelivered code turns', {
        agent_id: req.params.id,
      });
    }
  })
);

// GET /:id/tree?node=&depth=&limit=&cursor=&q=  (navigable view, agentTreeService.ts)
router.get(
  '/:id/tree',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      noCacheHeaders(res);
      const userId = callerUserId(req);
      if (userId === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const query = agentTreeQuerySchema.parse(req.query);
      const result = await getAgentTreeView(req.params.id, query, userId);
      if ('error' in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to fetch agent tree', { agent_id: req.params.id });
    }
  })
);

// GET /:id/agent-inbox?task_id=&since=
router.get(
  '/:id/agent-inbox',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      noCacheHeaders(res);
      const userId = callerUserId(req);
      if (userId === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const query = agentInboxQuerySchema.parse(req.query);
      const result = await a2aService.getAgentTaskInbox(req.params.id, query, userId);
      if (result === null) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to fetch agent inbox', { agent_id: req.params.id });
    }
  })
);

// POST /:id/send-agent-message — :id is the SENDER; body.to is a tree address.
router.post(
  '/:id/send-agent-message',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = callerUserId(req);
      if (userId === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const body = agentAddressMessageSchema.parse(req.body);
      const result = await a2aService.sendAgentMessageByAddress(req.params.id, body, userId);
      if ('error' in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.status(201).json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to send agent message', { agent_id: req.params.id });
    }
  })
);

// GET /:id/resolve-address?address= — resolve an address relative to agent :id.
router.get(
  '/:id/resolve-address',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      noCacheHeaders(res);
      const userId = callerUserId(req);
      if (userId === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const query = resolveAddressQuerySchema.parse(req.query);
      const result = await a2aService.resolveAddressForAgent(req.params.id, query.address, userId);
      if ('error' in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to resolve agent address', { agent_id: req.params.id });
    }
  })
);

// POST /:id/kill-agent — :id is the SENDER; kills a descendant and its subtree.
router.post(
  '/:id/kill-agent',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = callerUserId(req);
      if (userId === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const body = agentKillSchema.parse(req.body);
      const result = await killAgentByAddress(req.params.id, body, userId);
      if ('error' in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to kill agent', { agent_id: req.params.id });
    }
  })
);

export default router;
