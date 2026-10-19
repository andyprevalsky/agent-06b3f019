/**
 * Agent config service — update agent configuration (model, tools, verifier, price limit).
 */

import { getTemporalClient } from '../../providers/temporal';
import { broadcastAgentUpdate } from '../../providers/chat';
import { createLogger } from '../../providers/logger';
import type { Prisma, UpdateAgentBody } from './types';
import * as repo from './repo';

const log = createLogger('Agents');

interface UpdateAgentConfigDependencies {
  signalPriceLimit?: (workflowId: string, newLimitCents: number) => Promise<void>;
  broadcastUpdate?: typeof broadcastAgentUpdate;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the agent update data from the request body. */
function buildAgentUpdateData(body: UpdateAgentBody): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  // Rename: an explicit null clears the override so the UI falls back to `goal`.
  if (body.title !== undefined) {
    data.title = body.title;
  }
  if (body.pinned !== undefined) {
    data.pinnedAt = body.pinned ? new Date() : null;
  }
  if (body.model !== undefined && body.model !== '') {
    data.model = body.model;
  }
  if (body.reasoning_max_tokens !== undefined) {
    data.reasoningMaxTokens = body.reasoning_max_tokens;
  }
  if (body.tools_in_use !== undefined) {
    data.toolsInUse = body.tools_in_use;
  }
  if (body.background_tasks !== undefined) {
    data.backgroundTasks = body.background_tasks;
  }
  if (body.progress !== undefined) {
    data.progress = body.progress;
  }
  if (body.message_count !== undefined) {
    data.messageCount = body.message_count;
  }
  if (body.response_schema !== undefined) {
    data.responseSchema = body.response_schema;
  }
  if (body.tree_cost_cents !== undefined) {
    data.treeCostCents = body.tree_cost_cents;
  }
  if (body.own_cost_cents !== undefined) {
    data.ownCostCents = body.own_cost_cents;
  }
  if (body.status !== undefined) {
    data.status = body.status;
  }
  if (body.write_lock_enabled !== undefined) {
    data.writeLockEnabled = body.write_lock_enabled;
  }
  return data;
}

/** Handle price limit update with validation and workflow signal. */
async function handlePriceLimitUpdate(
  agentId: string,
  body: UpdateAgentBody,
  agent: { treeCostCents: number; status: string; temporalWorkflowId: string | null },
  data: Record<string, unknown>
): Promise<{ error: string; status: number; current_cost_cents: number } | null> {
  if (body.price_limit_cents === undefined) {
    return null;
  }

  if (body.price_limit_cents < agent.treeCostCents) {
    return {
      error: 'New limit must be >= current cost',
      status: 400,
      current_cost_cents: agent.treeCostCents,
    };
  }

  data.priceLimitCents = body.price_limit_cents;

  // Signal is sent AFTER DB update in updateAgentConfig to ensure persistence first
  return null;
}

/** Format an agent record into the API response shape. */
function formatAgentResponse(
  agent: NonNullable<Awaited<ReturnType<typeof repo.findAgentWithFullRelations>>>
) {
  return {
    agent: {
      agent_id: agent.id,
      goal: agent.goal,
      title: agent.title,
      pinned_at: agent.pinnedAt,
      archived_at: agent.deletedAt,
      model: agent.model,
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
      price_limit_cents: agent.priceLimitCents,
      tree_cost_cents: agent.treeCostCents,
      created_at: agent.createdAt,
      updated_at: agent.updatedAt,
      write_lock_enabled: agent.writeLockEnabled,
      verifier:
        agent.verifier !== null
          ? {
              type: agent.verifier.type,
            }
          : null,
      tools: agent.tools.map((at) => ({
        id: at.tool.id,
        name: at.tool.name,
        description: at.tool.description,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Update agent config
// ---------------------------------------------------------------------------

export async function updateAgentConfig(
  agentId: string,
  body: UpdateAgentBody,
  userId?: string,
  workflowGeneration?: string,
  dependencies: UpdateAgentConfigDependencies = {}
) {
  const agent = await repo.findAgentWithVerifier(agentId, userId);

  if (!agent) {
    return { error: 'Agent not found', status: 404 };
  }

  const agentUpdateData = buildAgentUpdateData(body);

  const priceLimitError = await handlePriceLimitUpdate(agentId, body, agent, agentUpdateData);
  if (priceLimitError !== null) {
    return priceLimitError;
  }

  const hasMutation =
    Object.keys(agentUpdateData).length > 0 ||
    body.tool_ids !== undefined ||
    body.generated_title !== undefined;
  const accepted = hasMutation
    ? await repo.updateAgentConfigMutation(
        agentId,
        agentUpdateData as Prisma.AgentUpdateManyMutationInput,
        body.tool_ids,
        workflowGeneration,
        body.generated_title
      )
    : true;

  const updatedAgent = await repo.findAgentWithFullRelations(agentId);

  if (accepted && updatedAgent !== null) {
    const realtimeUpdate: Parameters<typeof broadcastAgentUpdate>[1] = {};
    if (body.tree_cost_cents !== undefined) {
      realtimeUpdate.treeCostCents = body.tree_cost_cents;
    }
    if (body.generated_title !== undefined && updatedAgent.parentAgentId === null) {
      // Broadcast the stored value, not the candidate, so a concurrent human
      // rename can never be replaced in the UI by a stale generated title.
      realtimeUpdate.title = updatedAgent.title;
    }
    if (Object.keys(realtimeUpdate).length > 0) {
      await (dependencies.broadcastUpdate ?? broadcastAgentUpdate)(agentId, realtimeUpdate);
    }
  }

  // Signal Temporal AFTER all DB writes to ensure persistence first
  if (
    accepted &&
    body.price_limit_cents !== undefined &&
    agent.status === 'COST_LIMIT_REACHED' &&
    updatedAgent !== null &&
    updatedAgent.temporalWorkflowId !== null
  ) {
    try {
      if (dependencies.signalPriceLimit !== undefined) {
        await dependencies.signalPriceLimit(
          updatedAgent.temporalWorkflowId,
          body.price_limit_cents
        );
      } else {
        const client = await getTemporalClient();
        const handle = client.workflow.getHandle(updatedAgent.temporalWorkflowId);
        await handle.signal('price_limit_increased', {
          new_limit_cents: body.price_limit_cents,
        });
      }
      log.info('Signaled price_limit_increased to workflow', {
        workflow_id: updatedAgent.temporalWorkflowId,
        agent_id: agentId,
      });
    } catch (error) {
      log.error('Failed to signal price_limit_increased', {
        workflow_id: updatedAgent.temporalWorkflowId,
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ...formatAgentResponse(updatedAgent!),
    mutation_accepted: accepted,
  };
}
