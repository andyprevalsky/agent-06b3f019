import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import { AuthRequest, authenticate } from '../middleware/auth';
import { HybridAuthRequest, hybridAuth } from '../middleware/hybridAuth';
import { startAgentWorkflow, getTemporalClient } from '../lib/temporal';
import { getModelPricing, dollarsToMicrodollars } from '../lib/modelPricing';
import { getX402Endpoints } from '../lib/x402Endpoints';
import { setResponseSchema, generateResponseSchema } from '../lib/setResponseSchema';
import { handleChatMessage, broadcastAgentModeStarted } from '../lib/chat';
import { createMessage } from '../lib/messages';
import {
  processUploadedFile,
  validateTotalSize,
  getSignedUrl,
  MAX_FILE_SIZE,
  MAX_TOTAL_SIZE,
  FilePointer,
} from '../lib/storage';

const router = Router();

// Configure multer for attachment uploads (memory storage for processing)
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
});

// FilePointer schema for validation - all files stored in Supabase Storage
const filePointerSchema = z.object({
  id: z.string().uuid(),
  storage_path: z.string(), // Required - all files stored in storage
  original_filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number(),
  created_at: z.string(),
});

/**
 * Auto-generate verifier prompt from goal
 */
function generateVerifierPrompt(goal: string): string {
  return `You are judging whether the agent has achieved the following goal: "${goal}"

Scoring Instructions:
- Return a float between 0.0 and 1.0.
- 0.0 means no progress or only explanations/plans.
- 1.0 means the goal is FULLY accomplished with verifiable proof.
- Do not award 1.0 for partial completion.
- The agent has access to tools and can solve problems through persistence and creativity.`;
}

// Response schema field type
const ResponseSchemaFieldSchema = z.object({
  name: z.string(),
  type: z.enum(['str', 'int', 'float', 'bool', 'list[str]', 'list[int]', 'file_pointer', 'list[file_pointer]']),
  required: z.boolean(),
  description: z.string(),
});

// Response schema type (passed by parent agent for sub-agents)
const ResponseSchemaSchema = z.object({
  fields: z.array(ResponseSchemaFieldSchema),
});

// Validation schemas
const createAgentSchema = z.object({
  goal: z.string().min(1),
  model: z.string().optional().default('rose-labs/rose-1-lite'),
  reasoning_max_tokens: z.number().int().min(0).optional().default(256),
  source: z.enum(['WEB', 'MAC_APP']).optional().default('WEB'),
  task_queue: z.string().optional(), // Optional: for test isolation
  user_id: z.string().optional(), // Optional: for internal auth (sub-agent creation)
  parent_agent_id: z.string().uuid().optional(), // Optional: parent agent ID (for hierarchy)
  parent_workflow_id: z.string().optional(), // Optional: for sub-agents to signal parent
  depth: z.number().int().min(0).max(4).optional().default(0), // Nesting depth (max 4)
  pause_state: z.boolean().optional().default(false), // Optional: inherit parent's pause state
  // Response schema: passed by parent agent for sub-agents (required for sub-agents, generated async for root agents)
  response_schema: ResponseSchemaSchema.optional(),
  bus_id: z.string().uuid().optional(), // Optional: shared bus channel for sub-agent tree updates
  // Verifier is now optional - auto-generated from goal if not provided
  verifier: z.object({
    type: z.literal('FLOAT_LLM_JUDGE'),
    llm_judge_prompt: z.string().min(1),
  }).optional(),
  // File attachments for the initial goal message
  attachments: z.array(filePointerSchema).optional(),
});

const postMessageSchema = z.object({
  message: z.string().min(0), // Actual message content (tool result, assistant response, etc)
  role: z.enum(['USER', 'ASSISTANT', 'TOOL', 'SYSTEM']).optional(),
  metadata: z.record(z.any()).optional(), // JSON metadata about the tool call (toolCallId, toolName, status, etc)
  attachments: z.array(filePointerSchema).optional(), // File attachments (array, creates separate messages)
  file_pointer: filePointerSchema.optional(), // Single file pointer for this message (OAI-style)
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
  structuredResponse: z.record(z.unknown()).optional(),
});

// GET /api/agents - Get all agents for the authenticated user
router.get('/', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    // Prevent caching - agent statuses change in real-time
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    const userId = req.userId;

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
        reasoningMaxTokens: true,
        source: true,
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
        source: agent.source,
        reasoning_max_tokens: agent.reasoningMaxTokens,
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

// GET /api/agents/tree - Get all agents in a sub-agent tree by busId
// MUST be before /:id routes to prevent 'tree' from being treated as an agent ID
router.get('/tree', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    const { busId } = req.query;

    if (!busId || typeof busId !== 'string') {
      res.status(400).json({ error: 'busId query parameter is required' });
      return;
    }

    const agents = await prisma.agent.findMany({
      where: {
        busId,
        deletedAt: null,
      },
      select: {
        id: true,
        parentAgentId: true,
        goal: true,
        status: true,
        progress: true,
        toolsInUse: true,
        messageCount: true,
        responseSchema: true,
        structuredResponse: true,
      },
    });

    res.json({
      agents: agents.map((agent) => ({
        agent_id: agent.id,
        parent_agent_id: agent.parentAgentId,
        goal: agent.goal,
        status: agent.status,
        progress: agent.progress,
        tools_in_use: agent.toolsInUse,
        message_count: agent.messageCount,
        output_schema: agent.responseSchema,
        structured_output: agent.structuredResponse,
      })),
    });
  } catch (error) {
    console.error('Get agent tree error:', error);
    res.status(500).json({ error: 'Failed to fetch agent tree' });
  }
});

// POST /api/agents - Create a new agent
// Supports: JWT auth, internal API key, or x402 payment
router.post('/', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    const body = createAgentSchema.parse(req.body);
    
    // Get userId from hybrid auth middleware
    // - JWT: req.userId from token
    // - Internal: req.userId from body.user_id or X-User-Id header
    // - x402: req.userId from wallet address (credits already added by middleware)
    const userId = req.userId || body.user_id;
    
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized: user_id required' });
      return;
    }
    
    // Auto-generate verifier if not provided
    const verifierPrompt = body.verifier?.llm_judge_prompt || generateVerifierPrompt(body.goal);
    const verifier = {
      type: 'FLOAT_LLM_JUDGE' as const,
      llm_judge_prompt: verifierPrompt,
    };

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
          parentWorkflowId: body.parent_workflow_id || null,
          depth: body.depth || 0,
          busId: body.bus_id || null,
          goal: body.goal,
          model: body.model,
          reasoningMaxTokens: body.reasoning_max_tokens,
          source: body.source,
          tokenInPriceMicrodollars,
          tokenOutPriceMicrodollars,
          progress: 0.0,
          status: body.pause_state ? 'PAUSED' : 'STARTING_UP',
          // Store response schema directly if provided (for sub-agents)
          responseSchema: body.response_schema || undefined,
        },
      });

      // Create verifier (auto-generated or from request)
      await tx.verifier.create({
        data: {
          agentId: newAgent.id,
          type: verifier.type,
          llmJudgePrompt: verifier.llm_judge_prompt,
        },
      });

      // Insert goal as the first USER message
      const goalMessage = await tx.message.create({
        data: {
          agentId: newAgent.id,
          text: body.goal,
          role: 'USER',
          timestamp: new Date(),
        },
      });

      // Create separate messages for each file attachment (OAI-style)
      if (body.attachments && body.attachments.length > 0) {
        for (const attachment of body.attachments) {
          await tx.message.create({
            data: {
              agentId: newAgent.id,
              text: '', // Empty text for file-only messages
              role: 'USER',
              timestamp: new Date(),
              filePointer: attachment as Prisma.JsonObject,
            },
          });
        }
      }

      return { agent: newAgent, goalMessage };
    });

    // Determine if this is a sub-agent (has parent) or root agent
    const isSubAgent = !!body.parent_agent_id;
    let workflowId: string | null = null;

    if (isSubAgent) {
      // ============================================
      // SUB-AGENT: Start Temporal workflow immediately
      // Sub-agents always run in agent mode
      // ============================================
      try {
        workflowId = await startAgentWorkflow({
          agentId: agent.agent.id,
          userId,
          goal: body.goal,
          model: body.model,
          reasoningMaxTokens: body.reasoning_max_tokens,
          verifier: {
            type: verifier.type,
            llmJudgePrompt: verifier.llm_judge_prompt,
          },
          ...(body.task_queue ? { taskQueue: body.task_queue } : {}),
          ...(body.parent_workflow_id ? { parentWorkflowId: body.parent_workflow_id } : {}),
          ...(body.parent_agent_id ? { parentAgentId: body.parent_agent_id } : {}),
          ...(body.depth !== undefined ? { depth: body.depth } : {}),
          ...(body.bus_id ? { busId: body.bus_id } : {}),
        });

        // Update agent with workflow ID
        await prisma.agent.update({
          where: { id: agent.agent.id },
          data: { temporalWorkflowId: workflowId },
        });

        console.log('✅ Sub-agent workflow started', {
          agentId: agent.agent.id,
          workflowId,
          parentAgentId: body.parent_agent_id,
        });
      } catch (error) {
        console.error('❌ Failed to start sub-agent workflow', {
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
    } else {
      // ============================================
      // ROOT AGENT: Start in Chat Mode
      // Run chat handler, may escalate to agent mode automatically
      // ============================================
      console.log('💬 Starting root agent in chat mode', {
        agentId: agent.agent.id,
        goal: body.goal.substring(0, 100),
      });

      // Update status to ACTIVE for chat mode (not STARTING_UP)
      await prisma.agent.update({
        where: { id: agent.agent.id },
        data: { status: 'ACTIVE' },
      });

      // Response schema generation:
      // - Sub-agents: get schema passed via spawn_sub_agent tool call (stored in responseSchema)
      // - Root agents: schema is generated during set_plan tool execution (not at creation)
      // This defers expensive LLM call until planning phase when goal context is richer
      if (body.parent_agent_id && body.response_schema) {
        console.log('✅ Sub-agent has schema from parent', { agentId: agent.agent.id });
      } else if (body.parent_agent_id) {
        console.log('⚠️ Sub-agent spawned without schema', { agentId: agent.agent.id });
      } else {
        console.log('⏳ Root agent - schema will be generated during set_plan', { agentId: agent.agent.id });
      }

      // Handle chat message (non-blocking for response)
      // Run in background so we can return the agent immediately
      handleChatMessage({
        agentId: agent.agent.id,
        userId,
        model: body.model,
      }).catch((err) => {
        console.error('❌ Chat handler error', {
          agentId: agent.agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        // Update agent status to failed
        prisma.agent.update({
          where: { id: agent.agent.id },
          data: {
            status: 'FAILED',
            statusMessage: 'Chat handler error: ' + (err instanceof Error ? err.message : String(err)),
          },
        }).catch(console.error);
      });

      // Note: workflowId remains null for chat mode agents
      // It gets set later if chat escalates to agent mode
    }

    // Return agent (workflow ID may be null for chat mode)
    res.status(201).json({
      agent_id: agent.agent.id,
      progress: agent.agent.progress,
      goal: agent.agent.goal,
      model: agent.agent.model,
      source: body.source,
      reasoning_max_tokens: body.reasoning_max_tokens,
      status: isSubAgent ? agent.agent.status : 'ACTIVE',
      status_message: agent.agent.statusMessage,
      temporal_workflow_id: workflowId,
      created_at: agent.agent.createdAt,
      updated_at: agent.agent.updatedAt,
      available_endpoints: getX402Endpoints(agent.agent.id),
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
router.get('/:id', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    // Prevent caching - data changes in real-time
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    const userId = req.isInternal ? undefined : req.userId;
    const agentId = req.params.id;

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

    // Fetch ALL messages (pagination disabled for now)
    const messages = await prisma.message.findMany({
      where: { agentId },
      orderBy: { timestamp: 'asc' },
    });

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
        source: agent.source,
        reasoning_max_tokens: agent.reasoningMaxTokens,
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
        response_schema: agent.responseSchema,
      },
      messages: messages.map((msg) => ({
        message_id: msg.id,
        timestamp: msg.timestamp,
        text: msg.text,
        role: msg.role,
        metadata: msg.metadata,
        file_pointer: msg.filePointer,
      })),
      pagination: {
        has_more: false,
        oldest_timestamp: null,
      },
    });
  } catch (error) {
    console.error('Get agent error:', error);
    res.status(500).json({ error: 'Failed to fetch agent' });
  }
});

// GET /api/agents/:id/ancestors - Get ancestor chain for breadcrumb navigation
router.get('/:id/ancestors', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    const agentId = req.params.id;

    // Use recursive CTE to fetch all ancestors in a single query
    const ancestors = await prisma.$queryRaw<{ id: string; goal: string }[]>`
      WITH RECURSIVE ancestors AS (
        SELECT id, goal, "parentAgentId", 0 as depth
        FROM "Agent"
        WHERE id = (SELECT "parentAgentId" FROM "Agent" WHERE id = ${agentId})

        UNION ALL

        SELECT a.id, a.goal, a."parentAgentId", ancestors.depth + 1
        FROM "Agent" a
        JOIN ancestors ON a.id = ancestors."parentAgentId"
      )
      SELECT id, goal FROM ancestors
      ORDER BY depth DESC
    `;

    res.json({ ancestors });
  } catch (error) {
    console.error('Get ancestors error:', error);
    res.status(500).json({ error: 'Failed to fetch ancestors' });
  }
});

// POST /api/agents/:id/messages - Post a message (user or internal)
router.post('/:id/messages', hybridAuth, async (req: HybridAuthRequest, res) => {
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
      const userId = req.userId;
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

    // Validate attachments if provided
    if (body.attachments && body.attachments.length > 0) {
      try {
        validateTotalSize(body.attachments as FilePointer[]);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid attachments' });
        return;
      }
    }

    // Create the text message (optionally with file_pointer for single-file messages)
    const message = await createMessage({
      agentId,
      text: body.message,
      role,
      metadata: body.metadata,
      filePointer: body.file_pointer as Record<string, unknown> | undefined,
    });

    // Create separate messages for each file attachment (OAI-style)
    if (body.attachments && body.attachments.length > 0) {
      for (const attachment of body.attachments) {
        await createMessage({
          agentId,
          text: '', // Empty text for file-only messages
          role,
          filePointer: attachment as Record<string, unknown>,
        });
      }
    }

    // If this is a USER message, either signal workflow or run chat handler
    if (role === 'USER') {
      // Re-fetch agent to check for workflow
      const agentForChat = await prisma.agent.findUnique({
        where: { id: agentId },
      });

      if (agentForChat?.temporalWorkflowId) {
        // Agent mode: signal Temporal workflow
        try {
          const { getTemporalClient } = await import('../lib/temporal');
          const client = await getTemporalClient();
          const handle = client.workflow.getHandle(agentForChat.temporalWorkflowId);
          await handle.signal('receive_user_response', body.message);
        } catch (error) {
          // Don't fail the request if signaling fails - workflow will eventually poll
          console.error('Failed to signal workflow:', error);
        }
      } else if (agentForChat) {
        // Chat mode: handle message with fixed LLM call sequence
        // Run in background so we can return response immediately
        handleChatMessage({
          agentId,
          userId: agentForChat.userId,
          model: agentForChat.model,
        }).catch((err) => {
          console.error('❌ Chat handler error in message route', {
            agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

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

// POST /api/agents/:id/attachments - DEPRECATED: Use POST /api/upload instead
// Kept for backwards compatibility - redirects to new endpoint behavior
router.post('/:id/attachments', authenticate, attachmentUpload.single('file') as any, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    // Process the uploaded file (stored under userId, not agent-scoped)
    const filePointer = await processUploadedFile(
      userId,
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );

    console.log(`[Attachments] Uploaded file for user ${userId}: ${filePointer.original_filename} (${filePointer.size_bytes} bytes)`);

    res.status(201).json({
      file_pointer: filePointer,
    });
  } catch (error) {
    console.error('Upload attachment error:', error);
    res.status(500).json({
      error: 'Failed to upload attachment',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/agents/:id/attachments/:fileId/url - Get a signed URL for a file attachment
// Verifies the storage path starts with the user's ID for security
router.get('/:id/attachments/:fileId/url', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const storagePath = req.query.storage_path as string;

    if (!storagePath) {
      res.status(400).json({ error: 'storage_path query parameter is required' });
      return;
    }

    // Verify the storage path belongs to this user (files are stored under userId/)
    if (!storagePath.startsWith(`${userId}/`)) {
      res.status(403).json({ error: 'Access denied to this file' });
      return;
    }

    // Generate signed URL (1 hour expiry)
    const signedUrl = await getSignedUrl(storagePath, 3600);

    res.json({
      signed_url: signedUrl,
      expires_in: 3600,
    });
  } catch (error) {
    console.error('Get signed URL error:', error);
    res.status(500).json({
      error: 'Failed to generate signed URL',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/agents/:id/status - Get agent status (for browser agent pause check)
router.get('/:id/status', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    const agentId = req.params.id;

    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        deletedAt: null,
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    res.json({
      agent_id: agent.id,
      status: agent.status,
    });
  } catch (error) {
    console.error('Get agent status error:', error);
    res.status(500).json({ error: 'Failed to get agent status' });
  }
});

// POST /api/agents/:id/start-agent - Manually escalate from chat mode to agent mode
router.post('/:id/start-agent', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    const agentId = req.params.id;
    const userId = req.userId;

    // Verify agent belongs to user
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

    // Check if already in agent mode
    if (agent.temporalWorkflowId) {
      res.status(400).json({ error: 'Agent is already in agent mode' });
      return;
    }

    if (!agent.verifier) {
      res.status(400).json({ error: 'Agent has no verifier configured' });
      return;
    }

    console.log('🚀 Manual escalation to agent mode', {
      agentId,
      goal: agent.goal.substring(0, 100),
    });

    // Start Temporal workflow with original goal
    const workflowId = await startAgentWorkflow({
      agentId,
      userId: agent.userId,
      goal: agent.goal,
      model: agent.model,
      reasoningMaxTokens: agent.reasoningMaxTokens,
      verifier: {
        type: agent.verifier.type,
        llmJudgePrompt: agent.verifier.llmJudgePrompt,
      },
    });

    // Update agent with workflow ID
    await prisma.agent.update({
      where: { id: agentId },
      data: { temporalWorkflowId: workflowId },
    });

    // Broadcast that agent mode started
    await broadcastAgentModeStarted(agentId);

    console.log('✅ Escalated to agent mode', {
      agentId,
      workflowId,
    });

    res.json({
      success: true,
      agent_id: agentId,
      workflow_id: workflowId,
    });
  } catch (error) {
    console.error('Start agent error:', error);
    res.status(500).json({ error: 'Failed to start agent mode' });
  }
});

// PATCH /api/agents/:id/status - Update agent status (internal/worker only)
router.patch('/:id/status', hybridAuth, async (req: HybridAuthRequest, res) => {
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
        ...(body.structuredResponse !== undefined && {
          structuredResponse: body.structuredResponse as Prisma.InputJsonValue,
        }),
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

// Helper function to recursively delete an agent and all its children
async function deleteAgentRecursive(agentId: string): Promise<void> {
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

  // First, recursively delete all children
  for (const child of agent.children) {
    await deleteAgentRecursive(child.id);
  }

  // Terminate Temporal workflow if it exists
  if (agent.temporalWorkflowId) {
    try {
      console.log(`🔄 Terminating workflow ${agent.temporalWorkflowId} for agent ${agentId}`);
      const { getTemporalClient } = await import('../lib/temporal');
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      await handle.terminate('Agent deleted by user');
      console.log(`✅ Terminated workflow ${agent.temporalWorkflowId}`);
    } catch (error) {
      console.warn(`⚠️ Failed to terminate workflow ${agent.temporalWorkflowId}: ${error instanceof Error ? error.message : String(error)}`);
      // Continue with deletion even if termination fails
    }
  }

  // Soft delete this agent
  await prisma.agent.update({
    where: { id: agentId },
    data: { deletedAt: new Date() },
  });

  console.log(`🗑️ Deleted agent ${agentId}`);
}

// DELETE /api/agents/:id - Soft delete an agent and all its children, cancel workflows
router.delete('/:id', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    const userId = req.isInternal ? undefined : req.userId;
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

    // Recursively delete this agent and all its children
    await deleteAgentRecursive(agentId);

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

  // Skip agents that are already in a terminal state
  if (agent.status === 'COMPLETED' || agent.status === 'FAILED') {
    console.log(`⏭️ Skipping pause for ${agentId} - already ${agent.status}`);
    // Still recurse to children in case any are still running
    for (const child of agent.children) {
      await pauseAgentRecursive(child.id);
    }
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
router.post('/:id/pause', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    const userId = req.userId;
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
router.post('/:id/resume', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    const userId = req.userId;
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
  reasoning_max_tokens: z.number().int().min(0).optional(),
  tool_ids: z.array(z.string().uuid()).optional(),
  verifier_prompt: z.string().min(1).optional(),
  tools_in_use: z.array(z.string()).optional(), // For tree state updates
  progress: z.number().min(0).max(1).optional(), // For tree state updates
  message_count: z.number().int().min(0).optional(), // For tree state updates
  response_schema: ResponseSchemaSchema.optional(), // For storing generated schema during set_plan
});

router.patch('/:id', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    // Support both user auth (userId) and internal auth (API key)
    const userId = req.isInternal ? undefined : req.userId;
    const agentId = req.params.id;
    const body = updateAgentSchema.parse(req.body);

    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        ...(userId ? { userId } : {}), // Only filter by userId for user auth
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
    if (body.reasoning_max_tokens !== undefined) {
      agentUpdateData.reasoningMaxTokens = body.reasoning_max_tokens;
    }
    if (body.tools_in_use !== undefined) {
      agentUpdateData.toolsInUse = body.tools_in_use;
    }
    if (body.progress !== undefined) {
      agentUpdateData.progress = body.progress;
    }
    if (body.message_count !== undefined) {
      agentUpdateData.messageCount = body.message_count;
    }
    if (body.response_schema !== undefined) {
      agentUpdateData.responseSchema = body.response_schema;
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
        reasoning_max_tokens: updatedAgent!.reasoningMaxTokens,
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

// POST /api/agents/:id/restart - Restart an agent's workflow
// Terminates existing workflow and starts a fresh one with same agent data
router.post('/:id/restart', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    const agentId = req.params.id;

    // Fetch agent with all required relations
    // For internal API key calls, don't filter by userId
    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        ...(req.isInternal ? {} : { userId: req.userId }),
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

    if (!agent.verifier) {
      res.status(400).json({ error: 'Agent has no verifier configured' });
      return;
    }

    // 1. Terminate existing workflow if running
    const client = await getTemporalClient();
    try {
      const handle = client.workflow.getHandle(agentId);
      await handle.terminate('Restarting with new worker code');
      console.log(`✅ Terminated workflow ${agentId}`);
    } catch (e: any) {
      // Workflow might already be completed/terminated - that's fine
      console.log(`⚠️ Could not terminate workflow ${agentId}: ${e.message}`);
    }

    // Small delay to ensure termination is processed
    await new Promise(resolve => setTimeout(resolve, 500));

    // 2. Reset agent status to ACTIVE
    await prisma.agent.update({
      where: { id: agentId },
      data: { status: 'ACTIVE', statusMessage: null },
    });

    // 3. Start fresh workflow with same agent params
    const workflowId = await startAgentWorkflow({
      agentId: agent.id,
      userId: agent.userId,
      goal: agent.goal,
      model: agent.model,
      reasoningMaxTokens: agent.reasoningMaxTokens,
      verifier: {
        type: agent.verifier.type,
        llmJudgePrompt: agent.verifier.llmJudgePrompt,
      },
      ...(agent.parentWorkflowId ? { parentWorkflowId: agent.parentWorkflowId } : {}),
      depth: agent.depth,
    });

    // 4. Update agent with new workflow ID (should be same as agentId, but just in case)
    await prisma.agent.update({
      where: { id: agentId },
      data: { temporalWorkflowId: workflowId },
    });

    console.log(`✅ Restarted agent ${agentId}, workflow: ${workflowId}`);

    res.json({
      success: true,
      agent_id: agentId,
      workflow_id: workflowId,
      message: 'Workflow restarted - will continue from existing context',
    });
  } catch (error) {
    console.error('Restart agent error:', error);
    res.status(500).json({ error: 'Failed to restart agent' });
  }
});

// =============================================================================
// Signup Workflow Signals (for request_user_signup tool)
// =============================================================================

// POST /api/agents/:id/signal/signup_completed - Signal that user completed signup
router.post('/:id/signal/signup_completed', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    const agentId = req.params.id;
    const userId = req.userId;

    // Verify agent exists and belongs to user
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

    // Send signal to workflow
    if (agent.temporalWorkflowId) {
      try {
        const client = await getTemporalClient();
        const handle = client.workflow.getHandle(agent.temporalWorkflowId);
        await handle.signal('signup_completed');
        console.log(`✅ Sent signup_completed signal to workflow ${agent.temporalWorkflowId}`);
      } catch (error) {
        console.error(`Failed to signal workflow ${agent.temporalWorkflowId}:`, error);
        res.status(500).json({ error: 'Failed to signal workflow' });
        return;
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Signal signup_completed error:', error);
    res.status(500).json({ error: 'Failed to signal signup completed' });
  }
});

// POST /api/agents/:id/signal/signup_dismissed - Signal that user dismissed signup prompt
router.post('/:id/signal/signup_dismissed', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    const agentId = req.params.id;
    const userId = req.userId;

    // Verify agent exists and belongs to user
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

    // Send signal to workflow
    if (agent.temporalWorkflowId) {
      try {
        const client = await getTemporalClient();
        const handle = client.workflow.getHandle(agent.temporalWorkflowId);
        await handle.signal('signup_dismissed');
        console.log(`✅ Sent signup_dismissed signal to workflow ${agent.temporalWorkflowId}`);
      } catch (error) {
        console.error(`Failed to signal workflow ${agent.temporalWorkflowId}:`, error);
        res.status(500).json({ error: 'Failed to signal workflow' });
        return;
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Signal signup_dismissed error:', error);
    res.status(500).json({ error: 'Failed to signal signup dismissed' });
  }
});

// POST /api/agents/generate-response-schema - Generate response schema for a goal (used by browser agent)
const generateSchemaRequestSchema = z.object({
  goal: z.string().min(1),
});

router.post('/generate-response-schema', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    const body = generateSchemaRequestSchema.parse(req.body);

    const { schema, tokensIn, tokensOut } = await generateResponseSchema(body.goal);

    res.json({
      schema,
      tokensIn,
      tokensOut,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    console.error('Generate response schema error:', error);
    res.status(500).json({ error: 'Failed to generate response schema' });
  }
});

export default router;

