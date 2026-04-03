/**
 * Tool-usage domain service — business logic for saving and querying tool usage.
 */

import * as repo from './repo';
import type {
  Prisma,
  SaveToolUsageInput,
  ToolUsageCreated,
  ToolUsageSummary,
  UsageItem,
} from './types';
import { createLogger } from '../../providers/logger';

const log = createLogger('ToolUsage');

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class AgentNotFoundError extends Error {
  constructor() {
    super('Agent not found');
    this.name = 'AgentNotFoundError';
  }
}

export class AgentOwnershipError extends Error {
  constructor() {
    super('Agent does not belong to user');
    this.name = 'AgentOwnershipError';
  }
}

export class AccessDeniedError extends Error {
  constructor() {
    super('Access denied');
    this.name = 'AccessDeniedError';
  }
}

// ---------------------------------------------------------------------------
// Save tool usage
// ---------------------------------------------------------------------------

export async function saveToolUsage(input: SaveToolUsageInput): Promise<ToolUsageCreated> {
  const { agent_id, user_id, tool_name, total_cost_cents, usage_items } = input;

  // Verify agent exists and belongs to user
  const agent = await repo.findAgentById(agent_id);
  if (agent === null) {
    throw new AgentNotFoundError();
  }
  if (agent.userId !== user_id) {
    throw new AgentOwnershipError();
  }

  // Save tool usage
  const toolUsage = await repo.createToolUsage({
    userId: user_id,
    agentId: agent_id,
    toolName: tool_name,
    totalCostCents: total_cost_cents,
    usageItems: usage_items as Prisma.InputJsonValue,
  });

  log.info(`Saved tool usage: ${tool_name} - $${(total_cost_cents / 100).toFixed(2)}`, {
    agent_id,
    tool_name,
  });

  return {
    id: toolUsage.id,
    agent_id: toolUsage.agentId!,
    tool_name: toolUsage.toolName,
    total_cost_cents: toolUsage.totalCostCents,
    created_at: toolUsage.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Get tool usage for an agent
// ---------------------------------------------------------------------------

export async function getToolUsageForAgent(
  agentId: string,
  requestUserId: string | undefined,
  isInternal: boolean
): Promise<ToolUsageSummary> {
  // Verify agent exists
  const agent = await repo.findAgentById(agentId);
  if (agent === null) {
    throw new AgentNotFoundError();
  }

  // For JWT auth, verify ownership; for API key auth, allow access
  if (!isInternal) {
    if (agent.userId !== requestUserId) {
      throw new AccessDeniedError();
    }
  }

  // Get all tool usage for this agent
  const toolUsages = await repo.findToolUsagesByAgentId(agentId);

  // Calculate totals
  const totalCostCents = toolUsages.reduce((sum, usage) => sum + usage.totalCostCents, 0);

  // Aggregate token counts (only from LLM-type usage items)
  let totalTokens = 0;
  for (const usage of toolUsages) {
    if (!Array.isArray(usage.usageItems)) continue;
    const items = usage.usageItems as UsageItem[];
    for (const item of items) {
      if (
        item.type === 'llm' &&
        item.number_of_tokens !== undefined &&
        item.number_of_tokens !== 0
      ) {
        totalTokens += item.number_of_tokens;
      }
    }
  }

  return {
    agent_id: agentId,
    tool_usage_count: toolUsages.length,
    total_cost_cents: totalCostCents,
    total_cost_dollars: totalCostCents / 100,
    total_tokens_from_tools: totalTokens,
    usages: toolUsages.map((usage) => ({
      id: usage.id,
      tool_name: usage.toolName,
      total_cost_cents: usage.totalCostCents,
      usage_items: usage.usageItems,
      created_at: usage.createdAt,
    })),
  };
}
