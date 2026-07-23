/**
 * Tool-usage domain service — business logic for saving and querying tool usage.
 */

import * as repo from './repo';
import type {
  Prisma,
  SaveToolUsageInput,
  ToolUsageCreated,
  ToolUsageSummary,
  TreeToolUsageSummary,
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

export class WorkflowGenerationMismatchError extends Error {
  constructor() {
    super('Workflow generation is no longer current');
    this.name = 'WorkflowGenerationMismatchError';
  }
}

// ---------------------------------------------------------------------------
// Save tool usage
// ---------------------------------------------------------------------------

const EXECUTE_ITERATION_USAGE = new Set(['execute_loop', 'verifier_execute']);

function maxLlmIteration(toolName: string, usageItems: unknown[]): number | null {
  if (!EXECUTE_ITERATION_USAGE.has(toolName)) return null;
  let maximum: number | null = null;
  for (const item of usageItems) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const iteration = record.iteration;
    if (
      record.type !== 'llm' ||
      typeof iteration !== 'number' ||
      !Number.isInteger(iteration) ||
      iteration < 0 ||
      iteration > 2_147_483_647
    ) {
      continue;
    }
    maximum = maximum === null ? iteration : Math.max(maximum, iteration);
  }
  return maximum;
}

export async function saveToolUsage(input: SaveToolUsageInput): Promise<ToolUsageCreated> {
  const { agent_id, user_id, tool_name, total_cost_cents, usage_items, workflow_generation } =
    input;

  const result = await repo.createToolUsageForWorkflow({
    userId: user_id,
    agentId: agent_id,
    workflowGeneration: workflow_generation,
    toolName: tool_name,
    totalCostCents: total_cost_cents,
    usageItems: usage_items as Prisma.InputJsonValue,
    maxLlmIteration: maxLlmIteration(tool_name, usage_items),
  });
  if (result.status === 'agent_not_found') {
    throw new AgentNotFoundError();
  }
  if (result.status === 'ownership_mismatch') {
    throw new AgentOwnershipError();
  }
  if (result.status === 'stale_generation') {
    throw new WorkflowGenerationMismatchError();
  }
  const { toolUsage } = result;

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
  let llmCallCount = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  for (const usage of toolUsages) {
    if (!Array.isArray(usage.usageItems)) continue;
    const items = usage.usageItems as UsageItem[];
    for (const item of items) {
      if (item.type === 'llm') {
        llmCallCount += 1;
        if (item.number_of_tokens !== undefined && item.number_of_tokens !== 0) {
          totalTokens += item.number_of_tokens;
        }
        tokensIn += item.tokens_in ?? 0;
        tokensIn += item.cache_read_input_tokens ?? 0;
        tokensIn += item.cache_creation_input_tokens ?? 0;
        if (item.tokens_out !== undefined && item.tokens_out !== 0) {
          tokensOut += item.tokens_out;
        }
        if (item.cache_read_input_tokens !== undefined && item.cache_read_input_tokens !== 0) {
          cacheReadInputTokens += item.cache_read_input_tokens;
        }
        if (
          item.cache_creation_input_tokens !== undefined &&
          item.cache_creation_input_tokens !== 0
        ) {
          cacheCreationInputTokens += item.cache_creation_input_tokens;
        }
      }
    }
  }

  return {
    agent_id: agentId,
    tool_usage_count: toolUsages.length,
    llm_call_count: llmCallCount,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    total_cost_cents: totalCostCents,
    total_cost_dollars: totalCostCents / 100,
    total_tokens_from_tools: totalTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    usages: toolUsages.map((usage) => ({
      id: usage.id,
      tool_name: usage.toolName,
      total_cost_cents: usage.totalCostCents,
      usage_items: usage.usageItems,
      created_at: usage.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Get aggregated tool usage for an entire agent tree (root + sub-agents)
// ---------------------------------------------------------------------------

export async function getToolUsageForTree(
  agentId: string,
  requestUserId: string | undefined,
  isInternal: boolean
): Promise<TreeToolUsageSummary> {
  // Verify root agent exists and check access
  const agent = await repo.findAgentWithBusId(agentId);
  if (agent === null) {
    throw new AgentNotFoundError();
  }

  if (!isInternal) {
    if (agent.userId !== requestUserId) {
      throw new AccessDeniedError();
    }
  }

  // Collect all agent IDs in the tree
  let agentIds: string[];
  if (agent.busId !== null) {
    agentIds = await repo.findAgentIdsByBusId(agent.busId);
  } else {
    // No busId means root-only (no sub-agents spawned)
    agentIds = [agentId];
  }

  // Fetch all tool usages for the entire tree in one query
  const toolUsages = await repo.findToolUsagesByAgentIds(agentIds);

  // Aggregate totals
  let totalCostCents = 0;
  let totalTokens = 0;
  let llmCallCount = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;

  for (const usage of toolUsages) {
    totalCostCents += usage.totalCostCents;
    if (!Array.isArray(usage.usageItems)) continue;
    const items = usage.usageItems as UsageItem[];
    for (const item of items) {
      if (item.type === 'llm') {
        llmCallCount += 1;
        if (item.number_of_tokens !== undefined && item.number_of_tokens !== 0) {
          totalTokens += item.number_of_tokens;
        }
        tokensIn += item.tokens_in ?? 0;
        tokensIn += item.cache_read_input_tokens ?? 0;
        tokensIn += item.cache_creation_input_tokens ?? 0;
        if (item.tokens_out !== undefined && item.tokens_out !== 0) {
          tokensOut += item.tokens_out;
        }
        if (item.cache_read_input_tokens !== undefined && item.cache_read_input_tokens !== 0) {
          cacheReadInputTokens += item.cache_read_input_tokens;
        }
        if (
          item.cache_creation_input_tokens !== undefined &&
          item.cache_creation_input_tokens !== 0
        ) {
          cacheCreationInputTokens += item.cache_creation_input_tokens;
        }
      }
    }
  }

  return {
    root_agent_id: agentId,
    agent_count: agentIds.length,
    tool_usage_count: toolUsages.length,
    llm_call_count: llmCallCount,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    total_cost_cents: totalCostCents,
    total_cost_dollars: totalCostCents / 100,
    total_tokens_from_tools: totalTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
  };
}
