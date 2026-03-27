import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logJson } from '../lib/log';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { hybridAuth, type HybridAuthRequest } from '../middleware/hybridAuth';
import { createMessage } from '../lib/messages';
import { createLogger } from '../lib/logger';
import { asyncHandler } from '../lib/asyncHandler';

const log = createLogger('Attention');
const router = Router();

// Validation schemas
const createAttentionRequestSchema = z.object({
  userId: z.string(),
  agentId: z.string(),
  workflowId: z.string(),
  question: z.string().min(1),
  imageUrl: z.string().url().optional(),
  metadata: z.record(z.any()).optional(),
});

const respondSchema = z.object({
  response: z.string().min(1),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
});

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function signalWorkflow(
  workflowId: string,
  agentId: string,
  requestId: string,
  response: string
): Promise<void> {
  try {
    const { getTemporalClient } = await import('../lib/temporal');
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId);
    await handle.signal(
      'receive_user_response',
      JSON.stringify({ request_id: requestId, response })
    );
  } catch (error) {
    log.error('Failed to signal workflow', {
      workflow_id: workflowId,
      agent_id: agentId,
      error: errMsg(error),
    });
  }
}

// POST /api/attention-requests - Create an attention request (called by agent)
router.post(
  '/',
  asyncHandler(async (req, res) => {
    try {
      log.info('Received attention request', {
        agent_id: req.body.agentId,
        body: logJson(req.body),
      });
      const data = createAttentionRequestSchema.parse(req.body);

      const request = await prisma.agentAttentionRequest.create({
        data: {
          userId: data.userId,
          agentId: data.agentId,
          workflowId: data.workflowId,
          question: data.question,
          imageUrl: data.imageUrl,
          metadata: data.metadata,
        },
      });

      log.info('Attention request created', { request_id: request.id, agent_id: data.agentId });

      res.json({
        id: request.id,
        created_at: request.createdAt,
        metadata: request.metadata,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        log.error('Validation error', { errors: logJson(error.errors), body: logJson(req.body) });
        res.status(400).json({ error: 'Invalid request data', details: error.errors });
        return;
      }
      log.error('Failed to create attention request', { error: errMsg(error) });
      res.status(500).json({ error: 'Failed to create attention request' });
    }
  })
);

// GET /api/attention-requests - Get pending requests for authenticated user
router.get(
  '/',
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      const userId = req.user!.id;

      const requests = await prisma.agentAttentionRequest.findMany({
        where: { userId },
        orderBy: { updatedAt: 'asc' },
      });

      res.json({
        requests: requests.map((r) => ({
          id: r.id,
          agent_id: r.agentId,
          workflow_id: r.workflowId,
          question: r.question,
          image_url: r.imageUrl,
          metadata: r.metadata,
          user_response: r.userResponse,
          created_at: r.createdAt,
          updated_at: r.updatedAt,
          answered: r.userResponse !== null,
        })),
      });
    } catch (error) {
      log.error('Failed to fetch attention requests', {
        error: errMsg(error),
      });
      res.status(500).json({ error: 'Failed to fetch attention requests' });
    }
  })
);

// GET /api/attention-requests/count - Get count of unanswered requests
router.get(
  '/count',
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      const userId = req.user!.id;

      const count = await prisma.agentAttentionRequest.count({
        where: { userId, userResponse: null },
      });

      res.json({ count });
    } catch (error) {
      log.error('Failed to count attention requests', {
        error: errMsg(error),
      });
      res.status(500).json({ error: 'Failed to count attention requests' });
    }
  })
);

// GET /api/attention-requests/:id - Get a single attention request by ID (for polling)
// Uses hybridAuth to support both agent (API key) and user (JWT) authentication
router.get(
  '/:id',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const { id } = req.params;

      const request = await prisma.agentAttentionRequest.findUnique({
        where: { id },
      });

      if (request === null) {
        res.status(404).json({ error: 'Attention request not found' });
        return;
      }

      // Authorization: internal API calls (agents) can access any request,
      // but user calls must own the request
      if (req.isInternal !== true && request.userId !== req.userId) {
        res.status(403).json({ error: 'Not authorized' });
        return;
      }

      res.json({
        id: request.id,
        agentId: request.agentId,
        workflowId: request.workflowId,
        question: request.question,
        imageUrl: request.imageUrl,
        metadata: request.metadata,
        userResponse: request.userResponse,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      });
    } catch (error) {
      log.error('Failed to fetch attention request', {
        error: errMsg(error),
      });
      res.status(500).json({ error: 'Failed to fetch attention request' });
    }
  })
);

// POST /api/attention-requests/:id/respond - Submit response and signal workflow
router.post(
  '/:id/respond',
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user!.id;
      const data = respondSchema.parse(req.body);

      const request = await prisma.agentAttentionRequest.findUnique({
        where: { id },
      });

      if (request === null) {
        res.status(404).json({ error: 'Attention request not found' });
        return;
      }

      if (request.userId !== userId) {
        res.status(403).json({ error: 'Not authorized' });
        return;
      }

      await prisma.agentAttentionRequest.update({
        where: { id },
        data: {
          userResponse: data.response,
        },
      });

      await signalWorkflow(request.workflowId, request.agentId, id, data.response);

      res.json({
        success: true,
        request_id: id,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid response data', details: error.errors });
        return;
      }
      log.error('Failed to respond to attention request', {
        error: errMsg(error),
      });
      res.status(500).json({ error: 'Failed to respond to attention request' });
    }
  })
);

// POST /api/attention-requests/:id/skip - Skip request (move to back of queue)
router.post(
  '/:id/skip',
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user!.id;

      const request = await prisma.agentAttentionRequest.findUnique({
        where: { id },
      });

      if (request === null) {
        res.status(404).json({ error: 'Attention request not found' });
        return;
      }

      if (request.userId !== userId) {
        res.status(403).json({ error: 'Not authorized' });
        return;
      }

      await prisma.agentAttentionRequest.update({
        where: { id },
        data: {
          updatedAt: new Date(),
        },
      });

      res.json({
        success: true,
        request_id: id,
      });
    } catch (error) {
      log.error('Failed to skip attention request', {
        error: errMsg(error),
      });
      res.status(500).json({ error: 'Failed to skip attention request' });
    }
  })
);

// POST /api/attention-requests/:id/reject - Reject request and signal workflow
router.post(
  '/:id/reject',
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user!.id;

      const request = await prisma.agentAttentionRequest.findUnique({
        where: { id },
      });

      if (request === null) {
        res.status(404).json({ error: 'Attention request not found' });
        return;
      }

      if (request.userId !== userId) {
        res.status(403).json({ error: 'Not authorized' });
        return;
      }

      // If the user provided a rejection message, post it as a USER message on the agent
      const body = req.body as Record<string, unknown>;
      const rawMessage = typeof body?.message === 'string' ? body.message : '';
      const rejectionMessage = rawMessage.trim();
      if (rejectionMessage.length > 0) {
        await createMessage({
          agentId: request.agentId,
          text: rejectionMessage,
          role: 'USER',
        });
      }

      await prisma.agentAttentionRequest.update({
        where: { id },
        data: {
          userResponse: '__REJECTED__',
        },
      });

      await signalWorkflow(request.workflowId, request.agentId, id, '__REJECTED__');

      res.json({
        success: true,
        request_id: id,
      });
    } catch (error) {
      log.error('Failed to reject attention request', {
        error: errMsg(error),
      });
      res.status(500).json({ error: 'Failed to reject attention request' });
    }
  })
);

export default router;
