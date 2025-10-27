import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthRequest, authenticate } from '../middleware/auth';
import { startAgentWorkflow } from '../lib/temporal';
import { getModelPricing, dollarsToMicrodollars } from '../lib/modelPricing';
import { chooseTools } from '../lib/chooseTools';

const router = Router();

// Validation schemas
const createAgentSchema = z.object({
  goal: z.string().min(1),
  model: z.string().optional().default('google/gemini-2.5-flash'),
  reasoning_effort: z.enum(['off', 'low', 'medium', 'high']).optional().default('low'),
  tool_ids: z.array(z.string().uuid()).nullable().optional().default([]).transform(val => val ?? []),
  task_queue: z.string().optional(), // Optional: for test isolation
  user_id: z.string().optional(), // Optional: for internal auth (sub-agent creation)
  user_phone: z.string().optional(), // Optional: for internal auth (sub-agent creation)
  parent_agent_id: z.string().uuid().optional(), // Optional: parent agent ID (for hierarchy)
  parent_workflow_id: z.string().optional(), // Optional: for sub-agents to signal parent
  depth: z.number().int().min(0).max(1).optional().default(0), // Nesting depth
  pause_state: z.boolean().optional().default(false), // Optional: inherit parent's pause state
  verifier: z.object({
    type: z.literal('FLOAT_LLM_JUDGE'),
    llm_judge_prompt: z.string().min(1),
  }),
});

const postMessageSchema = z.object({
  message: z.string().min(0), // Actual message content (tool result, assistant response, etc)
  role: z.enum(['USER', 'ASSISTANT', 'TOOL', 'SYSTEM']).optional(),
  metadata: z.record(z.any()).optional(), // JSON metadata about the tool call (toolCallId, toolName, status, etc)
});

const updateStatusSchema = z.object({
  status: z.enum(['STARTING_UP', 'ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED']),
  statusMessage: z.string().optional(),
  progress: z.number().min(0).max(1),
  tokenCount: z.number().int().min(0),
  tokensIn: z.number().int().min(0).optional().default(0),
  tokensOut: z.number().int().min(0).optional().default(0),
  contextSize: z.number().int().min(0),
  messageCount: z.number().int().min(0),
});

// GET /api/agents - Get all agents for the authenticated user
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    // Prevent caching - agent statuses change in real-time
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    const userId = req.user!.id;

    // Only get top-level agents (no parent)
    const agents = await prisma.agent.findMany({
      where: {
        userId,
        parentAgentId: null, // Only top-level agents
        deletedAt: null,
      },
      select: {
        id: true,
        goal: true,
        model: true,
        reasoningEffort: true,
        progress: true,
        status: true,
        statusMessage: true,
        temporalWorkflowId: true,
        tokenCount: true,
        tokensIn: true,
        tokensOut: true,
        contextSize: true,
        messageCount: true,
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
        goal: agent.goal,
        model: agent.model,
        reasoning_effort: agent.reasoningEffort,
        progress: agent.progress,
        status: agent.status,
        status_message: agent.statusMessage,
        temporal_workflow_id: agent.temporalWorkflowId,
        token_count: agent.tokenCount,
        tokens_in: agent.tokensIn,
        tokens_out: agent.tokensOut,
        context_size: agent.contextSize,
        message_count: agent.messageCount,
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
router.post('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const body = createAgentSchema.parse(req.body);
    // For internal calls (API key), accept user_id from body
    // For user calls (JWT), extract from token
    const userId = req.isInternal ? body.user_id : req.user!.id;
    
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized: user_id required for internal auth' });
      return;
    }

    // 🤖 LLM-based tool selection
    // Get all available tools for LLM to choose from
    const allTools = await prisma.tool.findMany({
      select: {
        id: true,
        name: true,
        description: true,
      },
    });

    // Use LLM to select relevant tools based on the goal
    const { toolIds: llmSelectedToolIds, tokensIn, tokensOut } = await chooseTools(body.goal, allTools, body.model);
    
    // Merge LLM-selected tools with user-provided tools (no duplicates)
    const mergedToolIds = Array.from(new Set([...body.tool_ids, ...llmSelectedToolIds]));
    
    console.log('🔧 Tool selection summary', {
      userProvided: body.tool_ids.length,
      llmSelected: llmSelectedToolIds.length,
      merged: mergedToolIds.length,
      llmTools: allTools.filter(t => llmSelectedToolIds.includes(t.id)).map(t => t.name),
      tokensIn,
      tokensOut
    });

    // Verify all merged tools exist
    const tools = await prisma.tool.findMany({
      where: {
        id: { in: mergedToolIds },
      },
    });

    if (tools.length !== mergedToolIds.length) {
      res.status(400).json({ error: 'One or more tool IDs are invalid' });
      return;
    }

    // Fetch pricing for the model
    const pricing = await getModelPricing(body.model);
    let tokenInPriceMicrodollars: number | null = null;
    let tokenOutPriceMicrodollars: number | null = null;
    
    if (pricing) {
      tokenInPriceMicrodollars = dollarsToMicrodollars(pricing.prompt);
      tokenOutPriceMicrodollars = dollarsToMicrodollars(pricing.completion);
      console.log(`💰 Fetched pricing for ${body.model}: in=${tokenInPriceMicrodollars} µ$/token, out=${tokenOutPriceMicrodollars} µ$/token`);
    } else {
      console.warn(`⚠️  Could not fetch pricing for ${body.model}, agent will have no pricing data`);
    }

    // Create agent with verifier and tool associations in a transaction
    const agent = await prisma.$transaction(async (tx) => {
      const newAgent = await tx.agent.create({
        data: {
          userId,
          parentAgentId: body.parent_agent_id || null,
          goal: body.goal,
          model: body.model,
          reasoningEffort: body.reasoning_effort,
          tokenInPriceMicrodollars,
          tokenOutPriceMicrodollars,
          tokensIn, // Include tokens from tool selection
          tokensOut, // Include tokens from tool selection
          progress: 0.0,
          status: body.pause_state ? 'PAUSED' : 'STARTING_UP',
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

      // Associate tools (using merged tool IDs)
      await tx.agentTool.createMany({
        data: mergedToolIds.map((toolId) => ({
          agentId: newAgent.id,
          toolId,
        })),
      });

      // Insert goal as the first USER message in the chat
      const goalMessage = await tx.message.create({
        data: {
          agentId: newAgent.id,
          text: body.goal,
          role: 'USER',
          timestamp: new Date(),
        },
      });

      return { agent: newAgent, goalMessage };
    });

    // Start Temporal workflow with initial context containing goal message
    let workflowId: string | null = null;
    try {
      // Get user's phone number from JWT (user auth) or request body (internal API key auth)
      const userPhone = req.isInternal ? body.user_phone : req.user?.phone;
      if (!userPhone) {
        return res.status(400).json({
          error: req.isInternal 
            ? 'user_phone is required in request body for internal API calls'
            : 'User phone number not found in authentication token',
        });
      }
      
      workflowId = await startAgentWorkflow({
        agentId: agent.agent.id,
        userId,
        goal: body.goal,
        model: body.model,
        reasoningEffort: body.reasoning_effort,
        toolIds: mergedToolIds, // Use merged tool IDs
        verifier: {
          type: body.verifier.type,
          llmJudgePrompt: body.verifier.llm_judge_prompt,
        },
        userPhone, // Always required
        ...(body.task_queue ? { taskQueue: body.task_queue } : {}),
        ...(body.parent_workflow_id ? { parentWorkflowId: body.parent_workflow_id } : {}),
        ...(body.depth !== undefined ? { depth: body.depth } : {}),
      });

      // Update agent with workflow ID
      await prisma.agent.update({
        where: { id: agent.agent.id },
        data: { temporalWorkflowId: workflowId },
      });

      console.log('✅ Agent workflow started', {
        agentId: agent.agent.id,
        workflowId,
        taskQueue: body.task_queue || 'default',
      });
    } catch (error) {
      console.error('❌ Failed to start workflow', {
        agentId: agent.agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
      
      // Mark agent as failed
      await prisma.agent.update({
        where: { id: agent.agent.id },
        data: {
          status: 'FAILED',
          statusMessage: 'Failed to start workflow: ' + (error instanceof Error ? error.message : String(error)),
        },
      });

      throw error;
    }

    // Return agent with updated workflow ID
    res.status(201).json({
      agent_id: agent.agent.id,
      progress: agent.agent.progress,
      goal: agent.agent.goal,
      model: agent.agent.model,
      reasoning_effort: body.reasoning_effort,
      status: agent.agent.status,
      status_message: agent.agent.statusMessage,
      temporal_workflow_id: workflowId, // Use the workflow ID we just got
      created_at: agent.agent.createdAt,
      updated_at: agent.agent.updatedAt,
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
router.get('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    // Prevent caching - data changes in real-time
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    const userId = req.isInternal ? undefined : req.user!.id;
    const agentId = req.params.id;
    const before = req.query.before as string | undefined; // Load messages BEFORE this timestamp (scroll up)
    const limit = 50;

    // Verify agent belongs to user (or internal) and is not deleted
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        ...(userId ? { userId } : {}), // Only filter by userId for user auth
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

    // Fetch messages with pagination by ASSISTANT messages
    // Strategy: 
    // 1. Find last N assistant messages (these represent conversation "turns")
    // 2. Get the oldest timestamp from those assistant messages
    // 3. Load ALL messages from that timestamp onwards (includes tool calls, system msgs, etc.)
    // This ensures we get complete conversation turns with all context
    
    // First, get the last N assistant messages to find the time range
    const assistantMessages = await prisma.message.findMany({
      where: {
        agentId,
        role: 'ASSISTANT',
        ...(before ? { timestamp: { lt: new Date(before) } } : {}),
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: limit,
      select: {
        timestamp: true,
      },
    });

    let messages: any[] = [];
    let oldestAssistantTimestamp: Date | null = null;

    if (assistantMessages.length === 0 || assistantMessages.length < limit) {
      // We have ALL assistant messages (or none) - fetch all messages from the beginning
      // This ensures we get USER goal and TOOL blueprint messages that come before first ASSISTANT message
      const oldestMessage = await prisma.message.findFirst({
        where: { 
          agentId,
          ...(before ? { timestamp: { lt: new Date(before) } } : {}),
        },
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true },  // Lightweight - only get timestamp
      });

      if (oldestMessage) {
        messages = await prisma.message.findMany({
          where: {
            agentId,
            timestamp: { gte: oldestMessage.timestamp },
            ...(before ? { timestamp: { lt: new Date(before) } } : {}),
          },
          orderBy: { timestamp: 'asc' },
        });
      }
      
      // For pagination response, use oldest assistant timestamp if we have any
      oldestAssistantTimestamp = assistantMessages.length > 0 
        ? assistantMessages[assistantMessages.length - 1].timestamp 
        : null;
    } else {
      // Hit the limit - there might be more assistant messages, use pagination
      oldestAssistantTimestamp = assistantMessages[assistantMessages.length - 1].timestamp;

      // Fetch all messages from the oldest assistant timestamp onwards
      messages = await prisma.message.findMany({
        where: {
          agentId,
          timestamp: { gte: oldestAssistantTimestamp },
          ...(before ? { timestamp: { lt: new Date(before) } } : {}),
        },
        orderBy: {
          timestamp: 'asc', // Chronological order
        },
      });
    }

    // Fetch parent goal if this is a sub-agent
    let parentGoal: string | null = null;
    if (agent.parentAgentId) {
      const parent = await prisma.agent.findUnique({
        where: { id: agent.parentAgentId },
        select: { goal: true },
      });
      parentGoal = parent?.goal || null;
    }

    // Fetch tool usage summary
    const toolUsages = await prisma.toolUsage.findMany({
      where: { agentId },
      select: { 
        totalCostCents: true,
        usageItems: true 
      }
    });

    const toolUsageTotalCostCents = toolUsages.reduce((sum: number, usage: any) => sum + usage.totalCostCents, 0);
    
    // Calculate tool tokens from usage items
    let toolTokensIn = 0;
    let toolTokensOut = 0;
    for (const usage of toolUsages) {
      const items = usage.usageItems as any[];
      for (const item of items) {
        if (item.type === 'llm' && item.number_of_tokens) {
          // Perplexity reports all tokens - we'll bundle them all as "in" for simplicity
          // since tools don't distinguish input/output the same way
          if (item.provider?.includes('Output')) {
            toolTokensOut += item.number_of_tokens;
          } else {
            toolTokensIn += item.number_of_tokens;
          }
        }
      }
    }

    res.json({
      agent: {
        agent_id: agent.id,
        parent_agent_id: agent.parentAgentId,
        parent_goal: parentGoal,
        goal: agent.goal,
        model: agent.model,
        reasoning_effort: agent.reasoningEffort,
        progress: agent.progress,
        status: agent.status,
        status_message: agent.statusMessage,
        temporal_workflow_id: agent.temporalWorkflowId,
        token_count: agent.tokenCount,
        tokens_in: agent.tokensIn,
        tokens_out: agent.tokensOut,
        tool_tokens_in: toolTokensIn,
        tool_tokens_out: toolTokensOut,
        tool_cost_cents: toolUsageTotalCostCents,
        context_size: agent.contextSize,
        message_count: agent.messageCount,
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
        metadata: msg.metadata,
      })),
      pagination: {
        has_more: assistantMessages.length === limit,
        oldest_timestamp: oldestAssistantTimestamp ? oldestAssistantTimestamp.toISOString() : null,
      },
    });
  } catch (error) {
    console.error('Get agent error:', error);
    res.status(500).json({ error: 'Failed to fetch agent' });
  }
});

// POST /api/agents/:id/messages - Post a message (user or internal)
router.post('/:id/messages', authenticate, async (req: AuthRequest, res) => {
  try {
    const agentId = req.params.id;
    const body = postMessageSchema.parse(req.body);
    const isInternal = req.isInternal!;

    // Determine role based on auth type
    let role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
    if (isInternal) {
      // Internal (worker): role must be provided
      if (!body.role) {
        res.status(400).json({ error: 'Internal messages must specify role (USER/ASSISTANT/TOOL/SYSTEM)' });
        return;
      }
      role = body.role;
    } else {
      // User: always USER role, ignore any provided role
      role = 'USER';
    }

    // Verify agent exists
    if (isInternal) {
      // Internal: just check agent exists
      const agent = await prisma.agent.findFirst({
        where: {
          id: agentId,
          deletedAt: null,
        },
      });

      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
    } else {
      // User: verify ownership
      const userId = req.user!.id;
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
    }

    // Create message
    const message = await prisma.message.create({
      data: {
        agentId,
        text: body.message,
        role,
        metadata: body.metadata || undefined,
        timestamp: new Date(),
      },
    });

    res.status(201).json({
      message_id: message.id,
      timestamp: message.timestamp,
      text: message.text,
      role: message.role,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    console.error('Post message error:', error);
    res.status(500).json({ error: 'Failed to post message' });
  }
});

// PATCH /api/agents/:id/status - Update agent status (internal/worker only)
router.patch('/:id/status', authenticate, async (req: AuthRequest, res) => {
  try {
    const agentId = req.params.id;
    const body = updateStatusSchema.parse(req.body);

    // Verify agent exists
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        deletedAt: null,
      },
    });

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Update agent status
    const updated = await prisma.agent.update({
      where: { id: agentId },
      data: {
        status: body.status,
        statusMessage: body.statusMessage,
        progress: body.progress,
        tokenCount: body.tokenCount,
        tokensIn: body.tokensIn,
        tokensOut: body.tokensOut,
        contextSize: body.contextSize,
        messageCount: body.messageCount,
        updatedAt: new Date(),
      },
    });

    res.json({
      agent_id: updated.id,
      status: updated.status,
      status_message: updated.statusMessage,
      progress: updated.progress,
      token_count: updated.tokenCount,
      tokens_in: updated.tokensIn,
      tokens_out: updated.tokensOut,
      context_size: updated.contextSize,
      message_count: updated.messageCount,
      updated_at: updated.updatedAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    console.error('Update status error:', error);
    res.status(500).json({ error: 'Failed to update agent status' });
  }
});

// DELETE /api/agents/:id - Soft delete an agent and cancel workflow
router.delete('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.isInternal ? undefined : req.user!.id;
    const agentId = req.params.id;

    // Verify agent belongs to user (or internal)
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        ...(userId ? { userId } : {}),
        deletedAt: null,
      },
    });

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Cancel Temporal workflow if it exists
    if (agent.temporalWorkflowId) {
      try {
        const logMsg = `[${new Date().toISOString()}] Attempting to cancel workflow ${agent.temporalWorkflowId} for agent ${agentId}`;
        console.log(`🔄 ${logMsg}`);
        await import('fs').then(fs => fs.promises.appendFile('/tmp/workflow-cancel.log', logMsg + '\n'));
        
        const { getTemporalClient } = await import('../lib/temporal');
        const client = await getTemporalClient();
        const handle = client.workflow.getHandle(agent.temporalWorkflowId);
        
        // Terminate the workflow (forceful stop)
        // Using terminate() instead of cancel() because cancel() is graceful
        // and may not work if the workflow is stuck in a retry loop
        await handle.terminate('Agent deleted by user');
        
        const successMsg = `[${new Date().toISOString()}] Successfully terminated workflow ${agent.temporalWorkflowId}`;
        console.log(`✅ ${successMsg}`);
        await import('fs').then(fs => fs.promises.appendFile('/tmp/workflow-cancel.log', successMsg + '\n'));
      } catch (error) {
        const errorMsg = `[${new Date().toISOString()}] Failed to cancel workflow ${agent.temporalWorkflowId}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`⚠️  ${errorMsg}`);
        await import('fs').then(fs => fs.promises.appendFile('/tmp/workflow-cancel.log', errorMsg + '\n'));
        // Continue with deletion even if cancellation fails
      }
    } else {
      console.log(`ℹ️  No workflow ID for agent ${agentId}, skipping workflow cancellation`);
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

// Helper function to recursively pause all child agents
async function pauseAgentRecursive(agentId: string): Promise<void> {
  const agent = await prisma.agent.findFirst({
    where: {
      id: agentId,
      deletedAt: null,
    },
    include: {
      children: {
        where: {
          deletedAt: null,
        },
      },
    },
  });

  if (!agent) {
    return;
  }

  // Update this agent's status to PAUSED
  await prisma.agent.update({
    where: { id: agentId },
    data: { status: 'PAUSED' },
  });

  // Try to send signal (best effort for instant response)
  if (agent.temporalWorkflowId) {
    try {
      const { getTemporalClient } = await import('../lib/temporal');
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      await handle.signal('pause');
    } catch (error) {
      console.warn(`Pause signal failed for agent ${agentId}, but DB updated. Workflow will sync next iteration:`, error);
    }
  }

  // Recursively pause all children
  for (const child of agent.children) {
    await pauseAgentRecursive(child.id);
  }
}

// POST /api/agents/:id/pause - Pause workflow
router.post('/:id/pause', authenticate, async (req: AuthRequest, res) => {
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

    // Recursively pause this agent and all its children
    await pauseAgentRecursive(agentId);

    res.json({ success: true });
  } catch (error) {
    console.error('Pause agent error:', error);
    res.status(500).json({ error: 'Failed to pause agent' });
  }
});

// Helper function to recursively resume all child agents
async function resumeAgentRecursive(agentId: string): Promise<void> {
  const agent = await prisma.agent.findFirst({
    where: {
      id: agentId,
      deletedAt: null,
    },
    include: {
      children: {
        where: {
          deletedAt: null,
        },
      },
    },
  });

  if (!agent) {
    return;
  }

  // Update this agent's status to ACTIVE
  await prisma.agent.update({
    where: { id: agentId },
    data: { status: 'ACTIVE' },
  });

  // Try to send signal (best effort for instant response)
  if (agent.temporalWorkflowId) {
    try {
      const { getTemporalClient } = await import('../lib/temporal');
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      await handle.signal('resume');
    } catch (error) {
      console.warn(`Resume signal failed for agent ${agentId}, but DB updated. Workflow will sync next iteration:`, error);
    }
  }

  // Recursively resume all children
  for (const child of agent.children) {
    await resumeAgentRecursive(child.id);
  }
}

// POST /api/agents/:id/resume - Resume workflow
router.post('/:id/resume', authenticate, async (req: AuthRequest, res) => {
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

    // Recursively resume this agent and all its children
    await resumeAgentRecursive(agentId);

    res.json({ success: true });
  } catch (error) {
    console.error('Resume agent error:', error);
    res.status(500).json({ error: 'Failed to resume agent' });
  }
});

// PATCH /api/agents/:id - Update agent configuration
const updateAgentSchema = z.object({
  model: z.string().optional(),
  reasoning_effort: z.enum(['off', 'low', 'medium', 'high']).optional(),
  tool_ids: z.array(z.string().uuid()).optional(),
  verifier_prompt: z.string().min(1).optional(),
});

router.patch('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const agentId = req.params.id;
    const body = updateAgentSchema.parse(req.body);

    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        userId,
        deletedAt: null,
      },
      include: {
        verifier: true,
      },
    });

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Update agent model and/or reasoning effort if provided
    const agentUpdateData: any = {};
    if (body.model) {
      agentUpdateData.model = body.model;
    }
    if (body.reasoning_effort) {
      agentUpdateData.reasoningEffort = body.reasoning_effort;
    }
    if (Object.keys(agentUpdateData).length > 0) {
      await prisma.agent.update({
        where: { id: agentId },
        data: agentUpdateData,
      });
    }

    // Update tools if provided
    if (body.tool_ids) {
      // Delete existing tool assignments
      await prisma.agentTool.deleteMany({
        where: { agentId },
      });

      // Create new tool assignments
      await prisma.agentTool.createMany({
        data: body.tool_ids.map((toolId) => ({
          agentId,
          toolId,
        })),
      });
    }

    // Update verifier prompt if provided
    if (body.verifier_prompt && agent.verifier) {
      await prisma.verifier.update({
        where: { id: agent.verifier.id },
        data: { llmJudgePrompt: body.verifier_prompt },
      });
    }

    // Fetch updated agent
    const updatedAgent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        verifier: true,
        tools: {
          include: {
            tool: true,
          },
        },
      },
    });

    res.json({
      agent: {
        agent_id: updatedAgent!.id,
        goal: updatedAgent!.goal,
        model: updatedAgent!.model,
        reasoning_effort: updatedAgent!.reasoningEffort,
        progress: updatedAgent!.progress,
        status: updatedAgent!.status,
        status_message: updatedAgent!.statusMessage,
        temporal_workflow_id: updatedAgent!.temporalWorkflowId,
        token_count: updatedAgent!.tokenCount,
        tokens_in: updatedAgent!.tokensIn,
        tokens_out: updatedAgent!.tokensOut,
        context_size: updatedAgent!.contextSize,
        message_count: updatedAgent!.messageCount,
        created_at: updatedAgent!.createdAt,
        updated_at: updatedAgent!.updatedAt,
        verifier: updatedAgent!.verifier
          ? {
              type: updatedAgent!.verifier.type,
              llm_judge_prompt: updatedAgent!.verifier.llmJudgePrompt,
            }
          : null,
        tools: updatedAgent!.tools.map((at) => ({
          id: at.tool.id,
          name: at.tool.name,
          description: at.tool.description,
        })),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    console.error('Update agent error:', error);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

export default router;

