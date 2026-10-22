/**
 * Agent query service — get, list, poll, status, ancestors, tree.
 */

import * as repo from './repo';
import { hydrateProgressEstimates } from '../../providers/agentProgressEstimates';
import { listGraphCodeSessions } from './repoGraph';
import { codeAgentProvider } from './agentCodeAgentsService';
import { noteAgentMessagesConsumed } from './agentMessageGuardService';
import {
  findAgentAcrossRuns,
  findAncestorsAcrossRuns,
  findTreeAcrossRuns,
} from '../../providers/benchmarkHubStore';

// ---------------------------------------------------------------------------
// List agents
// ---------------------------------------------------------------------------

type ListedAgent = Awaited<
  ReturnType<
    typeof hydrateProgressEstimates<Awaited<ReturnType<typeof repo.findTopLevelAgents>>[number]>
  >
>[number];

/** Shared row shape for the active and archived sidebar lists. */
function toListItem(agent: ListedAgent) {
  return {
    agent_id: agent.id,
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
    temporal_workflow_id: agent.temporalWorkflowId,
    token_count: agent.tokenCount,
    tokens_in: agent.tokensIn,
    tokens_out: agent.tokensOut,
    context_size: agent.contextSize,
    message_count: agent.messageCount,
    fast_mode_cache_enabled: agent.fastModeCacheEnabled,
    world_model_mode: agent.worldModelMode,
    memory_enabled: agent.memoryEnabled,
    project_id: agent.projectId,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
  };
}

/** Get all top-level, non-archived agents for a user (pinned first). */
export async function listAgents(userId: string) {
  const agents = await hydrateProgressEstimates(await repo.findTopLevelAgents(userId));

  return { agents: agents.map(toListItem) };
}

/** Search a user's active top-level chats across title, goal, and messages. */
export async function searchAgents(userId: string, query: string) {
  const agents = await hydrateProgressEstimates(
    await repo.findTopLevelAgentsMatching(userId, query)
  );

  return { agents: agents.map(toListItem) };
}

/** Get a user's archived (soft-deleted) top-level agents, newest archive first. */
export async function listArchivedAgents(userId: string, limit: number) {
  const agents = await hydrateProgressEstimates(
    await repo.findArchivedTopLevelAgents(userId, limit)
  );

  return { agents: agents.map(toListItem) };
}

// ---------------------------------------------------------------------------
// Get agent tree
// ---------------------------------------------------------------------------

/**
 * Get all agents in a sub-agent tree by busId. Code agents (Claude Code /
 * Codex sessions) are listed alongside in `code_agents`, keyed to the Rose
 * agent that owns each session; `agents` keeps its Agent-row shape.
 */
export async function getAgentTree(busId: string, allowBenchmarkArchive = false) {
  const agents = await hydrateProgressEstimates(await repo.findAgentsByBusId(busId));

  if (agents.length === 0 && allowBenchmarkArchive) {
    const archived = await getBenchmarkArchivedTree(busId);
    if (archived !== null) return archived;
  }

  const codeSessions = await listGraphCodeSessions(agents.map((agent) => agent.id));
  return {
    code_agents: codeSessions.map((session) => ({
      code_agent_id: session.id,
      owner_agent_id: session.agentId,
      provider: codeAgentProvider(session),
      goal: session.goal,
      status: session.status,
      created_at: session.createdAt,
    })),
    agents: agents.map((agent) => ({
      agent_id: agent.id,
      parent_agent_id: agent.parentAgentId,
      temporal_workflow_id: agent.temporalWorkflowId,
      // Codex-style address ("/root/venue_capacities_0"); null for pre-path agents.
      task_path: agent.taskPath,
      goal: agent.goal,
      status: agent.status,
      progress: agent.progress,
      progressEstimate: agent.progressEstimate ?? null,
      taskProgressEstimates: agent.taskProgressEstimates ?? {},
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
  browserToolCallId?: string;
  /** Internal incremental poll: advance the reader's agent-message read mark. */
  consumesAgentMessages?: boolean;
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

export function tombstoneSkipsBenchmarkHub(tombstone: { isBenchmark: boolean } | null): boolean {
  return tombstone !== null && tombstone.isBenchmark !== true;
}

async function getMissingAgentDetail(agentId: string, options: AgentDetailOptions) {
  if (options.allowBenchmarkArchive !== true) return null;
  // Soft-delete is a local tombstone. GET must 404 it instead of consulting
  // a warming Benchmark Hub index (503). In-flight hub UUIDs have no Agent row.
  // Benchmark tombstones still consult hub so Open-agent of a locally archived
  // bench run keeps working.
  const tombstone = await repo.findArchivedAgent(agentId, options.userId);
  if (tombstoneSkipsBenchmarkHub(tombstone)) return null;
  return getBenchmarkArchivedDetail(agentId);
}

function detailFailureContext(agent: { status: string; structuredResponse: unknown }) {
  return agent.status === 'FAILED' && agent.structuredResponse !== null
    ? { partial_structured_response: agent.structuredResponse }
    : null;
}

/** A worker's incremental poll delivered these rows: advance the agent-message read mark. */
async function noteWorkerPollConsumption(
  agentId: string,
  messages: Awaited<ReturnType<typeof repo.findMessages>>,
  options: AgentDetailOptions
): Promise<void> {
  if (options.consumesAgentMessages !== true) return;
  await noteAgentMessagesConsumed(agentId, messages, options.browserToolCallId ?? null);
}

export async function getAgentDetail(agentId: string, options: AgentDetailOptions = {}) {
  const rawAgent = await repo.findAgentWithRelations(agentId, options.userId);
  const agent = rawAgent === null ? null : (await hydrateProgressEstimates([rawAgent]))[0];

  if (!agent) {
    return getMissingAgentDetail(agentId, options);
  }

  const [messages, parentGoal, toolUsages, inspectionContext] = await Promise.all([
    repo.findMessages(agentId, options.since, options.browserToolCallId),
    agent.parentAgentId === null ? Promise.resolve(null) : repo.findParentGoal(agent.parentAgentId),
    repo.findToolUsages(agentId),
    getInspectionContext(agent.userId, options.inspectionViewerUserId),
  ]);
  await noteWorkerPollConsumption(agentId, messages, options);
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
      memory_enabled: agent.memoryEnabled,
      project_id: agent.projectId,
      token_in_price_microdollars: agent.tokenInPriceMicrodollars,
      token_out_price_microdollars: agent.tokenOutPriceMicrodollars,
      created_at: agent.createdAt,
      updated_at: agent.updatedAt,
      write_lock_enabled: agent.writeLockEnabled,
      structured_output: agent.structuredResponse,
      failure_context: detailFailureContext(agent),
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

/**
 * Live Agent CTE first (includes hub-publish skeletons: archived rows with
 * parentAgentId so existing prod FE breadcrumbs work with no FE deploy).
 * If the CTE is empty and archive reads are allowed, walk the hub tree.
 *
 *   GET /?agent-id=GP
 *     → GET /api/agents/:id          (hub archive) parent_agent_id + parent_goal
 *     → GET /api/agents/:id/ancestors (CTE skeletons or hub tree, root first)
 *     → breadcrumb click → GET /api/agents/:parentId
 */
export async function getAncestors(agentId: string, allowBenchmarkArchive = false) {
  const live = await repo.findAncestors(agentId);
  if (live.length > 0 || !allowBenchmarkArchive) {
    return { ancestors: live };
  }
  return { ancestors: await findAncestorsAcrossRuns(agentId) };
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
