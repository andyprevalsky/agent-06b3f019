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
import { getTemporalClient, startAgentWorkflow } from '../temporal';
import { executeWebSearch } from '../chat/chatTools';
import { getAgentUrl } from '../smsTemplates';
import { cleanupAgentSessions } from '../agentCleanup';
import { createMessage } from '../messages';
import { createLogger } from '../logger';

const log = createLogger('SmsSupervisorTools');

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
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  success: boolean;
  result: string;
  error?: string;
}

// Per-tool argument types (validated upstream via JSON schema)
interface ReplyToAgentArgs {
  agent_id_or_prefix: string;
  message: string;
  attention_request_id?: string;
  reject?: boolean;
}

interface KillAgentArgs {
  agent_id_or_prefix: string;
}

interface IncreaseBudgetArgs {
  agent_id_or_prefix: string;
  amount_dollars: number;
}

interface StartNewAgentArgs {
  goal: string;
  budget_dollars?: number;
}

interface WebSearchArgs {
  query: string;
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

  log.info('Resolving agent prefix', { input, userId });

  // Try exact match first (full UUID)
  if (input.length > 6) {
    const agent = await prisma.agent.findFirst({
      where: { id: input, userId, deletedAt: null },
    });
    if (agent) {
      log.info('Resolved by exact match', { agentId: agent.id });
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
    log.info('Resolved by prefix', {
      prefix: input,
      agentId: agent.id,
      goal: agent.goal.substring(0, 50),
    });
  } else {
    log.info('No agent found for prefix', { prefix: input, userId });
  }

  return agent;
}

// ============================================
// Tool Executors
// ============================================

export async function executeToolCall(toolCall: ToolCall, userId: string): Promise<ToolResult> {
  const startTime = Date.now();
  const { tool, arguments: args } = toolCall;

  log.info('Executing tool', {
    tool,
    args: JSON.stringify(args),
    userId,
  });

  try {
    let result: ToolResult;

    switch (tool) {
      case 'reply_to_agent':
        result = await executeReplyToAgent(args as unknown as ReplyToAgentArgs, userId);
        break;
      case 'kill_agent':
        result = await executeKillAgent(args as unknown as KillAgentArgs, userId);
        break;
      case 'increase_budget':
        result = await executeIncreaseBudget(args as unknown as IncreaseBudgetArgs, userId);
        break;
      case 'start_new_agent':
        result = await executeStartNewAgent(args as unknown as StartNewAgentArgs, userId);
        break;
      case 'web_search':
        result = await executeWebSearchTool(args as unknown as WebSearchArgs);
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

    log.info('Tool execution complete', {
      tool,
      success: result.success,
      resultLength: result.result.length,
      error: result.error,
      durationMs: Date.now() - startTime,
    });

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error('Tool execution failed', {
      tool,
      args: JSON.stringify(args),
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

async function executeReplyToAgent(args: ReplyToAgentArgs, userId: string): Promise<ToolResult> {
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

  log.info('Replying to agent', {
    phase: 'reply',
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

    log.info('Posted USER message', {
      phase: 'reply',
      agentId: agent.id,
    });
  } catch (error) {
    log.error('Failed to post message', {
      phase: 'reply',
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

      log.info('Signaled workflow', {
        phase: 'reply',
        workflowId: agent.temporalWorkflowId,
        agentId: agent.id,
        reject: !!reject,
      });
    } catch (error) {
      log.error('Failed to signal workflow', {
        phase: 'reply',
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

      log.info('Resolved attention request', {
        phase: 'reply',
        requestId: attention_request_id,
        reject: !!reject,
      });
    } catch (error) {
      log.warn('Failed to resolve attention request', {
        phase: 'reply',
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

async function executeKillAgent(args: KillAgentArgs, userId: string): Promise<ToolResult> {
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

  log.info('Killing agent', {
    phase: 'kill',
    agentId: agent.id,
    goal: agent.goal.substring(0, 80),
  });

  // Recursive delete (same logic as DELETE /api/agents/:id)
  await deleteAgentRecursive(agent.id);

  log.info('Agent killed', { phase: 'kill', agentId: agent.id });

  return {
    tool: 'kill_agent',
    success: true,
    result: `Killed agent [${agent.id.substring(0, 6)}]: "${agent.goal.substring(0, 50)}"`,
  };
}

async function executeIncreaseBudget(
  args: IncreaseBudgetArgs,
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

  log.info('Increasing budget', {
    phase: 'budget',
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
      log.info('Signaled price_limit_increased', {
        phase: 'budget',
        workflowId: agent.temporalWorkflowId,
        newLimitCents,
      });
    } catch (error) {
      log.error('Failed to signal workflow', {
        phase: 'budget',
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

async function executeStartNewAgent(args: StartNewAgentArgs, userId: string): Promise<ToolResult> {
  const { goal, budget_dollars } = args;
  const priceLimitCents = budget_dollars ? Math.round(budget_dollars * 100) : 100;

  log.info('Starting new agent', {
    phase: 'start',
    userId,
    goal: goal.substring(0, 100),
    priceLimitCents,
  });

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
      },
      priceLimitCents,
    });

    await prisma.agent.update({
      where: { id: agent.id },
      data: { temporalWorkflowId: workflowId },
    });

    log.info('Agent created and workflow started', {
      phase: 'start',
      agentId: agent.id,
      prefix: agent.id.substring(0, 6),
      workflowId,
    });
  } catch (error) {
    log.error('Failed to start workflow', {
      phase: 'start',
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

async function executeWebSearchTool(args: WebSearchArgs): Promise<ToolResult> {
  const { query } = args;

  log.info('Executing web search', { phase: 'search', query });
  const startTime = Date.now();

  const searchResult = await executeWebSearch(query);

  log.info('Search complete', {
    phase: 'search',
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
      log.info('Terminating workflow', {
        phase: 'kill',
        workflowId: agent.temporalWorkflowId,
        agentId,
      });
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      await handle.terminate('Agent killed via SMS');
    } catch (error) {
      log.warn('Failed to terminate workflow', {
        phase: 'kill',
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

  log.info('Deleted agent', { phase: 'kill', agentId });
}
