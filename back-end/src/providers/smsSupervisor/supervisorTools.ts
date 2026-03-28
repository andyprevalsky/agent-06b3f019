/**
 * SMS Supervisor Tools
 *
 * 6 tools available to the SMS supervisor LLM:
 * 1. reply_to_agent — Send a reply to an agent (answers questions, approves/rejects write-locks)
 * 2. kill_agent — Terminate an agent and all sub-agents
 * 3. increase_budget — Increase an agent's cost limit
 * 4. start_new_agent — Create and start a new agent
 * 5. web_search — Search the web for information
 * 6. attempt_completion — Send final SMS to user (loop terminator)
 *
 * Each tool has a JSON schema for the LLM and an executor function.
 * All executors log extensively at boundaries.
 */

import { prisma } from '../database';
import { getTemporalClient } from '../temporal';
import { startAgentWorkflow } from '../temporal';
import { executeWebSearch } from '../chat/chatTools';
import { getAgentUrl } from '../smsTemplates';
import { cleanupAgentSessions } from '../agentCleanup';
import { createMessage } from '../messages';

// ============================================
// Tool Schemas (for LLM structured output)
// ============================================

export const TOOL_SCHEMAS = [
  {
    name: 'reply_to_agent',
    description:
      'Send a reply to an agent — answers questions, approves/rejects write-locks, or sends any message.',
    parameters: {
      type: 'object' as const,
      properties: {
        agent_id_or_prefix: {
          type: 'string' as const,
          description: 'Agent ID or 6-char prefix (e.g. "a3f2b1")',
        },
        message: {
          type: 'string' as const,
          description: 'The reply text to send to the agent',
        },
        attention_request_id: {
          type: 'string' as const,
          description:
            'If resolving a pending attention request, provide the attn_id from the Pending Requests list',
        },
        reject: {
          type: 'boolean' as const,
          description: 'Set to true to reject an attention request. Default: false (approve)',
        },
      },
      required: ['agent_id_or_prefix', 'message'],
    },
  },
  {
    name: 'kill_agent',
    description:
      'Stop/kill an agent and all its sub-agents. Use the 6-character prefix or full ID.',
    parameters: {
      type: 'object' as const,
      properties: {
        agent_id_or_prefix: {
          type: 'string' as const,
          description: 'Agent ID or 6-char prefix (e.g. "a3f2b1")',
        },
      },
      required: ['agent_id_or_prefix'],
    },
  },
  {
    name: 'increase_budget',
    description: "Increase an agent's cost limit. The amount is ADDED to the current limit.",
    parameters: {
      type: 'object' as const,
      properties: {
        agent_id_or_prefix: {
          type: 'string' as const,
          description: 'Agent ID or 6-char prefix',
        },
        amount_dollars: {
          type: 'number' as const,
          description: 'Amount in dollars to ADD to the current budget (e.g. 5.00 adds $5)',
        },
      },
      required: ['agent_id_or_prefix', 'amount_dollars'],
    },
  },
  {
    name: 'start_new_agent',
    description:
      'Start a new autonomous Rose Labs agent. These agents are superintelligent — they recursively decompose any problem and run an entire agentic swarm in parallel to accomplish ANY goal, from curing cancer to simple shopping tasks and everything in between.',
    parameters: {
      type: 'object' as const,
      properties: {
        goal: {
          type: 'string' as const,
          description: 'The task goal for the agent',
        },
        budget_dollars: {
          type: 'number' as const,
          description: 'Budget in dollars (default: $1.00)',
        },
      },
      required: ['goal'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for current information',
    parameters: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string' as const,
          description: 'Search query',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'attempt_completion',
    description:
      'Send the final SMS message to the user. Call this when you are done thinking and using tools.',
    parameters: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string' as const,
          description: 'The SMS message to send to the user',
        },
      },
      required: ['message'],
    },
  },
];

// ============================================
// Tool Call Type
// ============================================

export interface ToolCall {
  tool: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  tool: string;
  success: boolean;
  result: string;
  error?: string;
}

// ============================================
// Prefix Resolution Helper
// ============================================

async function resolveAgentPrefix(
  prefixOrId: string,
  userId: string
): Promise<{
  id: string;
  goal: string;
  status: string;
  priceLimitCents: number;
  treeCostCents: number;
  temporalWorkflowId: string | null;
} | null> {
  const input = prefixOrId.trim();

  console.log('[SMS Tools] Resolving agent prefix', { input, userId });

  // Try exact match first (full UUID)
  if (input.length > 6) {
    const agent = await prisma.agent.findFirst({
      where: { id: input, userId, deletedAt: null },
    });
    if (agent) {
      console.log('[SMS Tools] Resolved by exact match', { agentId: agent.id });
      return agent;
    }
  }

  // Prefix match
  const agent = await prisma.agent.findFirst({
    where: {
      id: { startsWith: input },
      userId,
      deletedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (agent) {
    console.log('[SMS Tools] Resolved by prefix', {
      prefix: input,
      agentId: agent.id,
      goal: agent.goal.substring(0, 50),
    });
  } else {
    console.log('[SMS Tools] No agent found for prefix', { prefix: input, userId });
  }

  return agent;
}

// ============================================
// Tool Executors
// ============================================

export async function executeToolCall(toolCall: ToolCall, userId: string): Promise<ToolResult> {
  const startTime = Date.now();
  const { tool, arguments: args } = toolCall;

  console.log('[SMS Tools] Executing tool', {
    tool,
    args,
    userId,
  });

  try {
    let result: ToolResult;

    switch (tool) {
      case 'reply_to_agent':
        result = await executeReplyToAgent(args, userId);
        break;
      case 'kill_agent':
        result = await executeKillAgent(args, userId);
        break;
      case 'increase_budget':
        result = await executeIncreaseBudget(args, userId);
        break;
      case 'start_new_agent':
        result = await executeStartNewAgent(args, userId);
        break;
      case 'web_search':
        result = await executeWebSearchTool(args);
        break;
      case 'attempt_completion':
        // attempt_completion is handled by the handler loop, not here
        result = { tool, success: true, result: 'Completion signaled' };
        break;
      default:
        result = {
          tool,
          success: false,
          result: '',
          error: `Unknown tool: ${tool}`,
        };
    }

    console.log('[SMS Tools] Tool execution complete', {
      tool,
      success: result.success,
      resultLength: result.result.length,
      error: result.error,
      durationMs: Date.now() - startTime,
    });

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[SMS Tools] Tool execution failed', {
      tool,
      args,
      error: errorMsg,
      stack: error instanceof Error ? error.stack : undefined,
      durationMs: Date.now() - startTime,
    });

    return {
      tool,
      success: false,
      result: '',
      error: errorMsg,
    };
  }
}

// ============================================
// Individual Tool Implementations
// ============================================

async function executeReplyToAgent(args: Record<string, any>, userId: string): Promise<ToolResult> {
  const { agent_id_or_prefix, message, attention_request_id, reject } = args;

  const agent = await resolveAgentPrefix(agent_id_or_prefix, userId);
  if (!agent) {
    return {
      tool: 'reply_to_agent',
      success: false,
      result: '',
      error: `No agent found matching "${agent_id_or_prefix}"`,
    };
  }

  console.log('[SMS Tools:reply] Replying to agent', {
    agentId: agent.id,
    userId,
    messagePreview: message?.substring(0, 100),
    hasAttentionRequest: !!attention_request_id,
    reject: !!reject,
  });

  // 1. Post USER message to agent's conversation
  try {
    await createMessage({
      agentId: agent.id,
      text: message,
      role: 'USER',
      metadata: { source: 'sms_supervisor' },
    });

    console.log('[SMS Tools:reply] Posted USER message', {
      agentId: agent.id,
    });
  } catch (error) {
    console.error('[SMS Tools:reply] Failed to post message', {
      agentId: agent.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      tool: 'reply_to_agent',
      success: false,
      result: '',
      error: 'Failed to post message to agent',
    };
  }

  // 2. Signal the workflow to unblock any waiting tool
  if (agent.temporalWorkflowId) {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      const signalValue = attention_request_id
        ? JSON.stringify({
            request_id: attention_request_id,
            response: reject ? '__REJECTED__' : message,
          })
        : message;
      await handle.signal('receive_user_response', signalValue);

      console.log('[SMS Tools:reply] Signaled workflow', {
        workflowId: agent.temporalWorkflowId,
        agentId: agent.id,
        reject: !!reject,
      });
    } catch (error) {
      console.error('[SMS Tools:reply] Failed to signal workflow', {
        workflowId: agent.temporalWorkflowId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't fail — message is in DB, workflow will poll
    }
  }

  // 3. If resolving an attention request, mark it in DB
  if (attention_request_id) {
    try {
      const userResponse = reject ? '__REJECTED__' : message || 'Approved';
      await prisma.agentAttentionRequest.update({
        where: { id: attention_request_id },
        data: { userResponse },
      });

      console.log('[SMS Tools:reply] Resolved attention request', {
        requestId: attention_request_id,
        reject: !!reject,
      });
    } catch (error) {
      console.warn('[SMS Tools:reply] Failed to resolve attention request', {
        requestId: attention_request_id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't fail — message is posted, agent will see it
    }
  }

  const action = attention_request_id
    ? reject
      ? 'Rejected request and replied to'
      : 'Approved request and replied to'
    : 'Replied to';
  return {
    tool: 'reply_to_agent',
    success: true,
    result: `${action} agent [${agent.id.substring(0, 6)}]`,
  };
}

async function executeKillAgent(args: Record<string, any>, userId: string): Promise<ToolResult> {
  const { agent_id_or_prefix } = args;

  const agent = await resolveAgentPrefix(agent_id_or_prefix, userId);
  if (!agent) {
    return {
      tool: 'kill_agent',
      success: false,
      result: '',
      error: `No agent found matching "${agent_id_or_prefix}"`,
    };
  }

  console.log('[SMS Tools:kill] Killing agent', {
    agentId: agent.id,
    goal: agent.goal.substring(0, 80),
  });

  // Recursive delete (same logic as DELETE /api/agents/:id)
  await deleteAgentRecursive(agent.id);

  console.log('[SMS Tools:kill] Agent killed', { agentId: agent.id });

  return {
    tool: 'kill_agent',
    success: true,
    result: `Killed agent [${agent.id.substring(0, 6)}]: "${agent.goal.substring(0, 50)}"`,
  };
}

async function executeIncreaseBudget(
  args: Record<string, any>,
  userId: string
): Promise<ToolResult> {
  const { agent_id_or_prefix, amount_dollars } = args;

  const agent = await resolveAgentPrefix(agent_id_or_prefix, userId);
  if (!agent) {
    return {
      tool: 'increase_budget',
      success: false,
      result: '',
      error: `No agent found matching "${agent_id_or_prefix}"`,
    };
  }

  const addCents = Math.round(amount_dollars * 100);
  const newLimitCents = agent.priceLimitCents + addCents;

  console.log('[SMS Tools:budget] Increasing budget', {
    agentId: agent.id,
    currentLimitCents: agent.priceLimitCents,
    addCents,
    newLimitCents,
    treeCostCents: agent.treeCostCents,
  });

  // Update the agent's price limit
  await prisma.agent.update({
    where: { id: agent.id },
    data: { priceLimitCents: newLimitCents },
  });

  // If agent was cost-limited, signal workflow to resume
  if (agent.status === 'COST_LIMIT_REACHED' && agent.temporalWorkflowId) {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      await handle.signal('price_limit_increased', {
        new_limit_cents: newLimitCents,
      });
      console.log('[SMS Tools:budget] Signaled price_limit_increased', {
        workflowId: agent.temporalWorkflowId,
        newLimitCents,
      });
    } catch (error) {
      console.error('[SMS Tools:budget] Failed to signal workflow', {
        workflowId: agent.temporalWorkflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    tool: 'increase_budget',
    success: true,
    result: `Budget for [${agent.id.substring(0, 6)}] increased to $${(newLimitCents / 100).toFixed(2)}${agent.status === 'COST_LIMIT_REACHED' ? ' — agent resuming' : ''}`,
  };
}

async function executeStartNewAgent(
  args: Record<string, any>,
  userId: string
): Promise<ToolResult> {
  const { goal, budget_dollars } = args;
  const priceLimitCents = budget_dollars ? Math.round(budget_dollars * 100) : 100;

  console.log('[SMS Tools:start] Starting new agent', {
    userId,
    goal: goal.substring(0, 100),
    priceLimitCents,
  });

  // Generate verifier prompt
  const verifierPrompt = `You are judging whether the agent has achieved the following goal: "${goal}"

Scoring Instructions:
- Return a float between 0.0 and 1.0.
- 0.0 means no progress or only explanations/plans.
- 1.0 means the goal is FULLY accomplished with verifiable proof.
- Do not award 1.0 for partial completion.
- The agent has access to tools and can solve problems through persistence and creativity.`;

  const agent = await prisma.$transaction(async (tx) => {
    const newAgent = await tx.agent.create({
      data: {
        userId,
        goal,
        source: 'SMS',
        model: 'rose-labs/rose-1-lite',
        reasoningMaxTokens: 2048,
        status: 'STARTING_UP',
        priceLimitCents,
      },
    });

    await tx.verifier.create({
      data: {
        agentId: newAgent.id,
        type: 'FLOAT_LLM_JUDGE',
        llmJudgePrompt: verifierPrompt,
      },
    });

    await tx.message.create({
      data: {
        agentId: newAgent.id,
        text: goal,
        role: 'USER',
        timestamp: new Date(),
      },
    });

    return newAgent;
  });

  // Start Temporal workflow
  try {
    const workflowId = await startAgentWorkflow({
      agentId: agent.id,
      userId,
      goal,
      model: 'rose-labs/rose-1-lite',
      reasoningMaxTokens: 2048,
      verifier: {
        type: 'FLOAT_LLM_JUDGE',
        llmJudgePrompt: verifierPrompt,
      },
      priceLimitCents,
    });

    await prisma.agent.update({
      where: { id: agent.id },
      data: { temporalWorkflowId: workflowId },
    });

    console.log('[SMS Tools:start] Agent created and workflow started', {
      agentId: agent.id,
      prefix: agent.id.substring(0, 6),
      workflowId,
    });
  } catch (error) {
    console.error('[SMS Tools:start] Failed to start workflow', {
      agentId: agent.id,
      error: error instanceof Error ? error.message : String(error),
    });

    await prisma.agent.update({
      where: { id: agent.id },
      data: { status: 'FAILED', statusMessage: 'Failed to start workflow' },
    });

    return {
      tool: 'start_new_agent',
      success: false,
      result: '',
      error: 'Failed to start agent workflow',
    };
  }

  return {
    tool: 'start_new_agent',
    success: true,
    result: `Agent [${agent.id.substring(0, 6)}] started: "${goal.substring(0, 60)}"\nTrack: ${getAgentUrl(agent.id)}`,
  };
}

async function executeWebSearchTool(args: Record<string, any>): Promise<ToolResult> {
  const { query } = args;

  console.log('[SMS Tools:search] Executing web search', { query });
  const startTime = Date.now();

  const searchResult = await executeWebSearch(query);

  console.log('[SMS Tools:search] Search complete', {
    query,
    answerLength: searchResult.answer.length,
    sourceCount: searchResult.sources.length,
    durationMs: Date.now() - startTime,
  });

  return {
    tool: 'web_search',
    success: true,
    result: searchResult.answer,
  };
}

// ============================================
// Agent Deletion Helper (extracted pattern from agents.ts:1068)
// ============================================

async function deleteAgentRecursive(agentId: string): Promise<void> {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, deletedAt: null },
    include: {
      children: {
        where: { deletedAt: null },
      },
    },
  });

  if (!agent) return;

  // Recursively delete children
  for (const child of agent.children) {
    await deleteAgentRecursive(child.id);
  }

  // Clean up E2B sandboxes and Steel browser sessions before terminating workflow
  await cleanupAgentSessions(agentId);

  // Terminate Temporal workflow
  if (agent.temporalWorkflowId) {
    try {
      console.log('[SMS Tools:kill] Terminating workflow', {
        workflowId: agent.temporalWorkflowId,
        agentId,
      });
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      await handle.terminate('Agent killed via SMS');
    } catch (error) {
      console.warn('[SMS Tools:kill] Failed to terminate workflow', {
        workflowId: agent.temporalWorkflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Soft delete
  await prisma.agent.update({
    where: { id: agentId },
    data: { deletedAt: new Date() },
  });

  console.log('[SMS Tools:kill] Deleted agent', { agentId });
}
