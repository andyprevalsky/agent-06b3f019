/**
 * Agent query service — get, list, poll, status, ancestors, tree.
 */

import * as repo from './repo';
import { findAgentAcrossRuns, findTreeAcrossRuns } from '../../providers/benchmarkHubStore';

// ---------------------------------------------------------------------------
// List agents
// ---------------------------------------------------------------------------

/** Get all top-level agents for a user. */
export async function listAgents(userId: string) {
  const agents = await repo.findTopLevelAgents(userId);

  return {
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
      fast_mode_cache_enabled: agent.fastModeCacheEnabled,
      world_model_mode: agent.worldModelMode,
      created_at: agent.createdAt,
      updated_at: agent.updatedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Get agent tree
// ---------------------------------------------------------------------------

/** Get all agents in a sub-agent tree by busId. */
export async function getAgentTree(busId: string, allowBenchmarkArchive = false) {
  const agents = await repo.findAgentsByBusId(busId);

  if (agents.length === 0 && allowBenchmarkArchive) {
    const archived = await getBenchmarkArchivedTree(busId);
    if (archived !== null) return archived;
  }

  return {
    agents: agents.map((agent) => ({
      agent_id: agent.id,
      parent_agent_id: agent.parentAgentId,
      goal: agent.goal,
      status: agent.status,
      progress: agent.progress,
      tools_in_use: agent.toolsInUse,
      message_count: agent.messageCount,
      tokens_in: agent.tokensIn,
      tokens_out: agent.tokensOut,
      output_schema: agent.responseSchema,
      structured_output: agent.structuredResponse,
      failure_context:
        agent.status === 'FAILED' && agent.structuredResponse !== null
          ? { partial_structured_response: agent.structuredResponse }
          : undefined,
      tree_cost_cents: agent.treeCostCents,
      created_at: agent.createdAt,
      updated_at: agent.updatedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Get agent detail
// ---------------------------------------------------------------------------

interface ToolUsageItem {
  type: string;
  number_of_tokens?: number;
  provider?: string;
}

/** Compute tool token totals from usage items. */
function computeToolTokens(toolUsages: { totalCostCents: number; usageItems: unknown }[]) {
  let toolTokensIn = 0;
  let toolTokensOut = 0;
  let totalCostCents = 0;

  for (const usage of toolUsages) {
    totalCostCents += usage.totalCostCents;
    if (!Array.isArray(usage.usageItems)) continue;
    const items = usage.usageItems as ToolUsageItem[];
    for (const item of items) {
      if (item.type === 'llm' && item.number_of_tokens !== undefined) {
        if (item.provider !== undefined && item.provider.includes('Output')) {
          toolTokensOut += item.number_of_tokens;
        } else {
          toolTokensIn += item.number_of_tokens;
        }
      }
    }
  }

  return { toolTokensIn, toolTokensOut, totalCostCents };
}

/** Get agent details with messages and tool usage.
 *  If `since` is provided, only messages after that timestamp are returned. */
/**
 * Benchmark agents live in torn-down bench stacks; when allowed, the hub
 * archive serves them through the normal detail/tree shapes so "Open agent"
 * lands in the main panel like any other agent.
 */
export async function getBenchmarkArchivedDetail(agentId: string) {
  const archived = await findAgentAcrossRuns(agentId);
  if (archived === null) return null;
  return {
    agent: archived.agent,
    messages: archived.messages,
    pagination: { has_more: false, oldest_timestamp: null as string | null },
  };
}

export async function getBenchmarkArchivedTree(busId: string) {
  const archived = await findTreeAcrossRuns(busId);
  if (archived === null) return null;
  return { agents: archived };
}

interface AgentDetailOptions {
  userId?: string;
  since?: Date;
  allowBenchmarkArchive?: boolean;
  inspectionViewerUserId?: string;
}

async function getInspectionContext(agentUserId: string, viewerUserId?: string) {
  if (viewerUserId === undefined || viewerUserId === agentUserId) return null;
  const identity = await repo.findUserInspectionIdentity(agentUserId);
  return {
    user_id: agentUserId,
    name: identity?.name ?? null,
    phone: identity?.phone ?? null,
    email: identity?.email ?? null,
  };
}

export async function getAgentDetail(agentId: string, options: AgentDetailOptions = {}) {
  const agent = await repo.findAgentWithRelations(agentId, options.userId);

  if (!agent) {
    return options.allowBenchmarkArchive === true ? getBenchmarkArchivedDetail(agentId) : null;
  }

  const [messages, parentGoal, toolUsages, inspectionContext] = await Promise.all([
    repo.findMessages(agentId, options.since),
    agent.parentAgentId === null ? Promise.resolve(null) : repo.findParentGoal(agent.parentAgentId),
    repo.findToolUsages(agentId),
    getInspectionContext(agent.userId, options.inspectionViewerUserId),
  ]);
  const { toolTokensIn, toolTokensOut, totalCostCents } = computeToolTokens(toolUsages);

  return {
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
      tool_cost_cents: totalCostCents,
      context_size: agent.contextSize,
      message_count: agent.messageCount,
      price_limit_cents: agent.priceLimitCents,
      tree_cost_cents: agent.treeCostCents,
      fast_mode_cache_enabled: agent.fastModeCacheEnabled,
      world_model_mode: agent.worldModelMode,
      token_in_price_microdollars: agent.tokenInPriceMicrodollars,
      token_out_price_microdollars: agent.tokenOutPriceMicrodollars,
      created_at: agent.createdAt,
      updated_at: agent.updatedAt,
      write_lock_enabled: agent.writeLockEnabled,
      structured_output: agent.structuredResponse,
      failure_context:
        agent.status === 'FAILED' && agent.structuredResponse !== null
          ? { partial_structured_response: agent.structuredResponse }
          : null,
      verifier: agent.verifier
        ? {
            type: agent.verifier.type,
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
    inspection_context: inspectionContext,
  };
}

// ---------------------------------------------------------------------------
// Get ancestors
// ---------------------------------------------------------------------------

/** Get ancestor chain for breadcrumb navigation. */
export async function getAncestors(agentId: string) {
  return { ancestors: await repo.findAncestors(agentId) };
}

// ---------------------------------------------------------------------------
// Get agent status
// ---------------------------------------------------------------------------

/** Get agent status only (for browser agent pause check). */
export async function getAgentStatus(agentId: string) {
  const agent = await repo.findAgentStatus(agentId);

  if (!agent) {
    return null;
  }

  return {
    agent_id: agent.id,
    status: agent.status,
  };
}

/** Resolve the internal, minimal context used to render an agent failure alert. */
export async function getAgentAlertContext(agentId: string) {
  const context = await repo.findAgentAlertContext(agentId);
  if (!context) return null;

  return {
    agent_id: context.id,
    affected_user_name: context.userName,
    current_agent_status: context.status,
  };
}
