import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthRequest, authenticate } from '../middleware/auth';

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

// POST /api/attention-requests - Create an attention request (called by agent)
router.post('/', async (req, res) => {
  try {
    console.log('📥 Received attention request:', JSON.stringify(req.body, null, 2));
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
    
    console.log('✅ Attention request created:', request.id);
    
    res.json({
      id: request.id,
      created_at: request.createdAt,
      metadata: request.metadata,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Validation error:', JSON.stringify(error.errors, null, 2));
      console.error('Request body was:', JSON.stringify(req.body, null, 2));
      return res.status(400).json({ error: 'Invalid request data', details: error.errors });
    }
    console.error('Failed to create attention request:', error);
    res.status(500).json({ error: 'Failed to create attention request' });
  }
});

// GET /api/attention-requests - Get pending requests for authenticated user
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    
    const requests = await prisma.agentAttentionRequest.findMany({
      where: {
        userId,
      },
      orderBy: {
        updatedAt: 'asc', // Oldest first (queue order)
      },
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
    console.error('Failed to fetch attention requests:', error);
    res.status(500).json({ error: 'Failed to fetch attention requests' });
  }
});

// GET /api/attention-requests/count - Get count of unanswered requests
router.get('/count', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    
    const count = await prisma.agentAttentionRequest.count({
      where: {
        userId,
        userResponse: null,
      },
    });
    
    res.json({ count });
  } catch (error) {
    console.error('Failed to count attention requests:', error);
    res.status(500).json({ error: 'Failed to count attention requests' });
  }
});

// POST /api/attention-requests/:id/respond - Submit response and signal workflow
router.post('/:id/respond', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const data = respondSchema.parse(req.body);
    
    // Find the request
    const request = await prisma.agentAttentionRequest.findUnique({
      where: { id },
    });
    
    if (!request) {
      return res.status(404).json({ error: 'Attention request not found' });
    }
    
    // Verify ownership
    if (request.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Update the request with response
    await prisma.agentAttentionRequest.update({
      where: { id },
      data: {
        userResponse: data.response,
      },
    });
    
    // Send signal to workflow to resume
    try {
      const { getTemporalClient } = await import('../lib/temporal');
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(request.workflowId);
      await handle.signal('receive_user_response', data.response);
    } catch (error) {
      console.error(`Failed to send signal to workflow ${request.workflowId}:`, error);
      // Don't fail the request - DB is updated, workflow will eventually check
    }
    
    res.json({
      success: true,
      request_id: id,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid response data', details: error.errors });
    }
    console.error('Failed to respond to attention request:', error);
    res.status(500).json({ error: 'Failed to respond to attention request' });
  }
});

// POST /api/attention-requests/:id/skip - Skip request (move to back of queue)
router.post('/:id/skip', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Find the request
    const request = await prisma.agentAttentionRequest.findUnique({
      where: { id },
    });

    if (!request) {
      return res.status(404).json({ error: 'Attention request not found' });
    }

    // Verify ownership
    if (request.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Update updatedAt to move to back of queue
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
    console.error('Failed to skip attention request:', error);
    res.status(500).json({ error: 'Failed to skip attention request' });
  }
});

// POST /api/attention-requests/:id/reject - Reject request and signal workflow
router.post('/:id/reject', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Find the request
    const request = await prisma.agentAttentionRequest.findUnique({
      where: { id },
    });

    if (!request) {
      return res.status(404).json({ error: 'Attention request not found' });
    }

    // Verify ownership
    if (request.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Update the request with rejection marker
    await prisma.agentAttentionRequest.update({
      where: { id },
      data: {
        userResponse: '__REJECTED__',
      },
    });

    // Send signal to workflow to resume (with rejection)
    try {
      const { getTemporalClient } = await import('../lib/temporal');
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(request.workflowId);
      await handle.signal('receive_user_response', '__REJECTED__');
    } catch (error) {
      console.error(`Failed to send rejection signal to workflow ${request.workflowId}:`, error);
      // Don't fail the request - DB is updated, workflow will eventually check
    }

    res.json({
      success: true,
      request_id: id,
    });
  } catch (error) {
    console.error('Failed to reject attention request:', error);
    res.status(500).json({ error: 'Failed to reject attention request' });
  }
});

export default router;

