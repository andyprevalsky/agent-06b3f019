import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middleware/auth';

const router = Router();

// Validation schemas
const createAgentSchema = z.object({
  goal: z.string().min(1),
  tool_ids: z.array(z.string().uuid()),
  verifier: z.object({
    type: z.literal('FLOAT_LLM_JUDGE'),
    llm_judge_prompt: z.string().min(1),
  }),
});

const postMessageSchema = z.object({
  message: z.string().min(1),
});

// GET /api/agents - Get all agents for the authenticated user
router.get('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;

    const agents = await prisma.agent.findMany({
      where: {
        userId,
        deletedAt: null, // Only non-deleted agents
      },
      select: {
        id: true,
        goal: true,
        progress: true,
        status: true,
        statusMessage: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json({
      agents: agents.map((agent) => ({
        agent_id: agent.id,
        progress: agent.progress,
        goal: agent.goal,
        status: agent.status,
        status_message: agent.statusMessage,
        created_at: agent.createdAt,
        updated_at: agent.updatedAt,
      })),
    });
  } catch (error) {
    console.error('Get agents error:', error);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

// POST /api/agents - Create a new agent
router.post('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const body = createAgentSchema.parse(req.body);

    // Verify all tools exist
    const tools = await prisma.tool.findMany({
      where: {
        id: { in: body.tool_ids },
      },
    });

    if (tools.length !== body.tool_ids.length) {
      res.status(400).json({ error: 'One or more tool IDs are invalid' });
      return;
    }

    // Create agent with verifier and tool associations in a transaction
    const agent = await prisma.$transaction(async (tx) => {
      const newAgent = await tx.agent.create({
        data: {
          userId,
          goal: body.goal,
          progress: 0.0,
          status: 'STARTING_UP',
        },
      });

      // Create verifier
      await tx.verifier.create({
        data: {
          agentId: newAgent.id,
          type: body.verifier.type,
          llmJudgePrompt: body.verifier.llm_judge_prompt,
        },
      });

      // Associate tools
      await tx.agentTool.createMany({
        data: body.tool_ids.map((toolId) => ({
          agentId: newAgent.id,
          toolId,
        })),
      });

      return newAgent;
    });

    res.status(201).json({
      agent_id: agent.id,
      progress: agent.progress,
      goal: agent.goal,
      status: agent.status,
      status_message: agent.statusMessage,
      created_at: agent.createdAt,
      updated_at: agent.updatedAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    console.error('Create agent error:', error);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

// GET /api/agents/:id - Get agent details with messages
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const agentId = req.params.id;
    const cursor = req.query.cursor as string | undefined;
    const limit = 50;

    // Verify agent belongs to user and is not deleted
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        userId,
        deletedAt: null,
      },
      include: {
        verifier: true,
        tools: {
          include: {
            tool: true,
          },
        },
      },
    });

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Fetch messages with pagination (cursor-based)
    // Cursor is the timestamp of the oldest message we've seen
    const messages = await prisma.message.findMany({
      where: {
        agentId,
        ...(cursor ? { timestamp: { lt: new Date(cursor) } } : {}),
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: limit,
    });

    res.json({
      agent: {
        agent_id: agent.id,
        goal: agent.goal,
        progress: agent.progress,
        status: agent.status,
        status_message: agent.statusMessage,
        created_at: agent.createdAt,
        updated_at: agent.updatedAt,
        verifier: agent.verifier
          ? {
              type: agent.verifier.type,
              llm_judge_prompt: agent.verifier.llmJudgePrompt,
            }
          : null,
        tools: agent.tools.map((at) => ({
          id: at.tool.id,
          name: at.tool.name,
          description: at.tool.description,
        })),
      },
      messages: messages.map((msg) => ({
        message_id: msg.id,
        timestamp: msg.timestamp,
        text: msg.text,
        role: msg.role,
      })),
      pagination: {
        next_cursor: messages.length === limit ? messages[messages.length - 1].timestamp.toISOString() : null,
        has_more: messages.length === limit,
      },
    });
  } catch (error) {
    console.error('Get agent error:', error);
    res.status(500).json({ error: 'Failed to fetch agent' });
  }
});

// POST /api/agents/:id/messages - Post a message to an agent
router.post('/:id/messages', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const agentId = req.params.id;
    const body = postMessageSchema.parse(req.body);

    // Verify agent belongs to user and is not deleted
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        userId,
        deletedAt: null,
      },
    });

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Create message with role USER
    const message = await prisma.message.create({
      data: {
        agentId,
        text: body.message,
        role: 'USER',
        timestamp: new Date(),
      },
    });

    res.status(201).json({
      message_id: message.id,
      timestamp: message.timestamp,
      text: message.text,
      role: message.role,
    });

    // TODO: Trigger agent processing here
    // This is where you would send the message to your agent system
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    console.error('Post message error:', error);
    res.status(500).json({ error: 'Failed to post message' });
  }
});

// DELETE /api/agents/:id - Soft delete an agent
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const agentId = req.params.id;

    // Verify agent belongs to user
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        userId,
        deletedAt: null,
      },
    });

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Soft delete
    await prisma.agent.update({
      where: { id: agentId },
      data: { deletedAt: new Date() },
    });

    res.status(204).send();
  } catch (error) {
    console.error('Delete agent error:', error);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

export default router;

