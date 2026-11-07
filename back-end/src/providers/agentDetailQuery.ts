/**
 * Preview-only agent-detail query for the unauthenticated benchmark preview endpoint.
 * Mirrors agents/agentQueryService.getAgentDetail; kept isolated in a provider so the
 * public benchmarks router doesn't cross-import the agents domain.
 * Follow-up: unify the two into one shared query.
 */

import { prisma } from './database';
import { hydrateProgressEstimates } from './agentProgressEstimates';
import { agentSpeedFromRow } from './rose/speed';

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

/**
 * Get agent details with messages and tool usage for the benchmark preview.
 * No user-ownership filter and no `since` filter — mirrors getAgentDetail(agentId)
 * called with no userId/since. Returns null when the agent is not found.
 */
export async function getAgentDetailForPreview(agentId: string) {
  const rawAgent = await prisma.agent.findFirst({
    where: {
      id: agentId,
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

  const agent = rawAgent === null ? null : (await hydrateProgressEstimates([rawAgent]))[0];
  if (!agent) {
    return null;
  }

  const messages = await prisma.message.findMany({
    where: {
      agentId,
    },
    orderBy: { timestamp: 'asc' },
  });

  // Fetch parent goal if this is a sub-agent
  let parentGoal: string | null = null;
  if (agent.parentAgentId !== null) {
    const parent = await prisma.agent.findUnique({
      where: { id: agent.parentAgentId },
      select: { goal: true },
    });
    parentGoal = parent?.goal ?? null;
  }

  // Fetch tool usage summary
  const toolUsages = await prisma.toolUsage.findMany({
    where: { agentId },
    select: {
      totalCostCents: true,
      usageItems: true,
    },
  });
  const { toolTokensIn, toolTokensOut, totalCostCents } = computeToolTokens(toolUsages);

  return {
    agent: {
      agent_id: agent.id,
      parent_agent_id: agent.parentAgentId,
      parent_goal: parentGoal,
      goal: agent.goal,
      title: agent.title,
      pinned_at: agent.pinnedAt,
      archived_at: agent.deletedAt,
      model: agent.model,
      source: agent.source,
      reasoning_max_tokens: agent.reasoningMaxTokens,
      progress: agent.progress,
      progressEstimate: agent.progressEstimate ?? null,
      taskProgressEstimates: agent.taskProgressEstimates ?? {},
      status: agent.status,
      status_message: agent.statusMessage,
      user_control_revision: agent.userControlRevision,
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
      speed: agentSpeedFromRow(agent),
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
  };
}
