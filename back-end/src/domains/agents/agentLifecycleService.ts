/**
 * Agent lifecycle service — create and delete agents.
 */

import { randomUUID } from '../../providers/crypto';
import { startAgentWorkflow, getTemporalClient } from '../../providers/temporal';
import { getX402Endpoints } from '../../providers/x402Endpoints';
import { handleChatMessage, broadcastAgentModeStarted } from '../../providers/chat';
import { cleanupAgentSessions } from '../../providers/agentCleanup';
import { createGithubRepo } from '../../providers/github';
import { createLogger } from '../../providers/logger';
import type { CreateAgentBody } from './types';
import { getPromptSecret } from './config';
import * as repo from './repo';
import { resolveCreateMetadata } from './agentCreateMetadata';
import { captureAgentStart } from '../../providers/traceArchiveLifecycle';

const log = createLogger('Agents');
const DEFAULT_FAST_MODE_USER_IDS = new Set(['1f85ff25-6e29-4c1b-8739-f917bd101a30']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve {{VAR_NAME}} placeholders from PROMPT_SECRET_* env vars. */
export function resolvePromptSecrets(text: string): string {
  return text.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (_match, varName: string) => {
    const value = getPromptSecret(varName);
    if (value !== undefined && value !== '') {
      log.info(`Resolved prompt secret: {{${varName}}}`);
      return value;
    }
    log.warn(`Unresolved prompt secret: {{${varName}}} (env var PROMPT_SECRET_${varName} not set)`);
    return `{{${varName}}}`;
  });
}

/** Apply account-scoped Fast Mode defaults for root agents only. */
export function applyFastModeDefault(body: CreateAgentBody, userId: string): void {
  if (body.fast_mode_cache_enabled !== undefined) return;
  if (body.parent_agent_id !== undefined) return;
  if (!DEFAULT_FAST_MODE_USER_IDS.has(userId)) return;
  body.fast_mode_cache_enabled = true;
}

/** A sub-agent inherits Fast Mode reads from its parent unless explicitly set. */
export function applyFastModeInheritance(
  body: CreateAgentBody,
  parentFastModeCacheEnabled: boolean | null | undefined
): void {
  if (body.fast_mode_cache_enabled !== undefined) return;
  if (body.parent_agent_id === undefined) return;
  if (parentFastModeCacheEnabled === true) {
    body.fast_mode_cache_enabled = true;
  }
}

/* c8 ignore start -- startSubAgentWorkflow, startDirectWorkflow, startChatMode require Temporal/GitHub/LLM infrastructure */
/** Start a sub-agent workflow. The Agent row already has temporalWorkflowId
 *  set to agentId by createAgentTransaction (workflow ID === agent ID by
 *  convention; see providers/temporal.ts:88), so no UPDATE is needed here. */
async function startSubAgentWorkflow(
  body: CreateAgentBody,
  agentDbId: string,
  userId: string,
  verifier: { type: string },
  priceLimitCents: number
): Promise<string> {
  return startAgentWorkflow({
    agentId: agentDbId,
    userId,
    goal: body.goal,
    model: body.model,
    reasoningMaxTokens: body.reasoning_max_tokens,
    verifier: { type: verifier.type },
    ...(body.task_queue !== undefined ? { taskQueue: body.task_queue } : {}),
    ...(body.parent_workflow_id !== undefined ? { parentWorkflowId: body.parent_workflow_id } : {}),
    ...(body.parent_agent_id !== undefined ? { parentAgentId: body.parent_agent_id } : {}),
    ...(body.depth !== undefined ? { depth: body.depth } : {}),
    ...(body.bus_id !== undefined ? { busId: body.bus_id } : {}),
    ...(body.start_phase !== undefined ? { startPhase: body.start_phase } : {}),
    ...(body.max_iterations !== undefined ? { maxIterations: body.max_iterations } : {}),
    priceLimitCents,
    ...(body.context_gates !== undefined ? { contextGates: body.context_gates } : {}),
    ...(body.fast_mode_cache_enabled !== undefined
      ? { fastModeCacheEnabled: body.fast_mode_cache_enabled }
      : {}),
  });
}

/** Start root agent directly in plan/execute (bypass chat). */
async function startDirectWorkflow(
  body: CreateAgentBody,
  agentDbId: string,
  userId: string,
  verifier: { type: string },
  priceLimitCents: number
): Promise<string> {
  const workflowId = await startAgentWorkflow({
    agentId: agentDbId,
    userId,
    goal: body.goal,
    model: body.model,
    reasoningMaxTokens: body.reasoning_max_tokens,
    verifier: { type: verifier.type },
    ...(body.task_queue !== undefined ? { taskQueue: body.task_queue } : {}),
    startPhase: body.start_phase!,
    priceLimitCents,
    ...(body.fast_mode_cache_enabled !== undefined
      ? { fastModeCacheEnabled: body.fast_mode_cache_enabled }
      : {}),
    ...(body.context_gates !== undefined ? { contextGates: body.context_gates } : {}),
  });
  // temporalWorkflowId was set during createAgentTransaction (see comment on
  // startSubAgentWorkflow above), so no UPDATE is needed here.
  await broadcastAgentModeStarted(agentDbId);
  return workflowId;
}

/** Start root agent in chat mode (fire-and-forget). */
async function startChatMode(
  body: CreateAgentBody,
  agentDbId: string,
  agentId: string,
  userId: string
): Promise<void> {
  const repoName = `agent-${agentId.substring(0, 8)}`;
  createGithubRepo(repoName)
    .then(async (repoUrl) => {
      if (repoUrl !== null && repoUrl !== undefined) {
        try {
          await repo.updateAgent(agentDbId, { githubRepoUrl: repoUrl });
          await repo.createGithubRepoAccess(userId, repoUrl);
        } catch (err: unknown) {
          log.error('Failed to persist repo URL', {
            agent_id: agentDbId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })
    .catch((err: unknown) => {
      log.error('Repo creation failed', {
        agent_id: agentDbId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  handleChatMessage({ agentId: agentDbId, userId, model: body.model }).catch((err: unknown) => {
    log.error('Chat handler error', {
      agent_id: agentDbId,
      error: err instanceof Error ? err.message : String(err),
    });
    repo
      .failAgentIfStillActive(
        agentDbId,
        'Chat handler error: ' + (err instanceof Error ? err.message : String(err))
      )
      .catch((updateErr: unknown) =>
        log.error('Failed to update agent status', {
          agent_id: agentDbId,
          error: updateErr instanceof Error ? updateErr.message : String(updateErr),
        })
      );
  });
}
/* c8 ignore stop */

// ---------------------------------------------------------------------------
// Create agent
// ---------------------------------------------------------------------------

export async function createAgent(
  body: CreateAgentBody,
  userId: string,
  isInternal: boolean,
  clientIP: string | null
) {
  if (isInternal) {
    body.goal = resolvePromptSecrets(body.goal);
  }
  const verifier = { type: 'FLOAT_LLM_JUDGE' as const };
  const isSubAgent = body.parent_agent_id !== undefined;
  applyFastModeDefault(body, userId);

  // Fast Mode inheritance (#6): a sub-agent with no explicit flag inherits the
  // parent's persisted setting, so the whole agent tree records/replays together.
  if (
    isSubAgent &&
    body.fast_mode_cache_enabled === undefined &&
    body.parent_agent_id !== undefined
  ) {
    const parent = await repo.findAgentById(body.parent_agent_id);
    applyFastModeInheritance(body, parent?.fastModeCacheEnabled);
  }
  const { tokenInPriceMicrodollars, tokenOutPriceMicrodollars, proxyGeo } =
    await resolveCreateMetadata(body.model, clientIP, body.parent_agent_id ?? null, userId);
  const agentId = body.agent_id ?? randomUUID();
  // Workflow ID === agent ID by convention (see providers/temporal.ts:88).
  // For sub-agents and direct (plan/execute) root agents, the workflow always
  // starts immediately after this transaction, so set the column up-front and
  // skip the post-launch UPDATE. Chat-mode roots leave it null until they
  // transition out of chat.
  const willStartWorkflow = isSubAgent || body.start_phase !== undefined;
  const agent = await repo.createAgentTransaction({
    agentId,
    userId,
    parentAgentId: body.parent_agent_id ?? null,
    parentWorkflowId: body.parent_workflow_id ?? null,
    depth: body.depth ?? 0,
    busId: isSubAgent ? (body.bus_id ?? null) : agentId,
    goal: body.goal,
    model: body.model,
    reasoningMaxTokens: body.reasoning_max_tokens,
    source: body.source,
    tokenInPriceMicrodollars,
    tokenOutPriceMicrodollars,
    pauseState: body.pause_state,
    responseSchema: body.response_schema as unknown,
    proxyCountry: proxyGeo.country,
    proxyState: proxyGeo.state,
    proxyCity: proxyGeo.city,
    priceLimitCents: body.price_limit_cents,
    writeLockEnabled: body.write_lock_enabled,
    fastModeCacheEnabled: body.fast_mode_cache_enabled,
    verifierType: verifier.type,
    attachments: body.attachments as Array<Record<string, unknown>> | undefined,
    temporalWorkflowId: willStartWorkflow ? agentId : null,
  });
  if (!isSubAgent) {
    try {
      await captureAgentStart({ agentId: agent.agent.id });
    } catch (error) {
      log.warn('Trace archive start fixture unavailable', {
        agent_id: agent.agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const workflowId = await launchAgentWorkflow(body, agent, userId, isSubAgent, agentId, verifier);

  return {
    agent_id: agent.agent.id,
    progress: agent.agent.progress,
    goal: agent.agent.goal,
    model: agent.agent.model,
    source: body.source,
    reasoning_max_tokens: body.reasoning_max_tokens,
    status: isSubAgent ? agent.agent.status : 'ACTIVE',
    status_message: agent.agent.statusMessage,
    temporal_workflow_id: workflowId,
    fast_mode_cache_enabled: agent.agent.fastModeCacheEnabled,
    created_at: agent.agent.createdAt,
    updated_at: agent.agent.updatedAt,
    available_endpoints: getX402Endpoints(agent.agent.id),
  };
}

/* c8 ignore start -- launchAgentWorkflow delegates to Temporal-dependent functions */
async function launchAgentWorkflow(
  body: CreateAgentBody,
  agent: Awaited<ReturnType<typeof repo.createAgentTransaction>>,
  userId: string,
  isSubAgent: boolean,
  agentId: string,
  verifier: { type: 'FLOAT_LLM_JUDGE' }
): Promise<string | null> {
  if (isSubAgent) {
    try {
      return await startSubAgentWorkflow(
        body,
        agent.agent.id,
        userId,
        verifier,
        agent.agent.priceLimitCents
      );
    } catch (error) {
      log.error('Failed to start sub-agent workflow', {
        agent_id: agent.agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await repo.updateAgent(agent.agent.id, {
        status: 'FAILED',
        statusMessage:
          'Failed to start workflow: ' + (error instanceof Error ? error.message : String(error)),
      });
      throw error;
    }
  }
  if (body.start_phase !== undefined) {
    return startDirectWorkflow(body, agent.agent.id, userId, verifier, agent.agent.priceLimitCents);
  }
  await repo.updateAgent(agent.agent.id, { status: 'ACTIVE' });
  void startChatMode(body, agent.agent.id, agentId, userId);
  return null;
}
/* c8 ignore stop */

// ---------------------------------------------------------------------------
// Delete agent
// ---------------------------------------------------------------------------

export async function deleteAgentRecursive(agentId: string): Promise<void> {
  const agent = await repo.findAgentWithChildren(agentId);
  if (!agent) {
    return;
  }
  for (const child of agent.children) {
    await deleteAgentRecursive(child.id);
  }
  await cleanupAgentSessions(agentId);
  /* c8 ignore start -- Temporal termination requires live Temporal server */
  if (agent.temporalWorkflowId !== null) {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      await handle.terminate('Agent deleted by user');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes('not found') ||
        msg.includes('already completed') ||
        msg.includes('terminated')
      ) {
        log.info('No active workflow to terminate', {
          agent_id: agentId,
          workflow_id: agent.temporalWorkflowId,
          reason: msg,
        });
      } else {
        log.warn('Failed to terminate workflow', {
          agent_id: agentId,
          workflow_id: agent.temporalWorkflowId,
          error: msg,
        });
      }
    }
  } else {
    /* c8 ignore stop */
    log.info('No workflow id for agent, skipping termination', { agent_id: agentId });
  }
  await repo.deleteAttentionRequests(agentId);
  // Fast Mode cache entries intentionally outlive agent deletion. They are keyed by
  // goal hash and only removed by the explicit fast-cache purge endpoint.
  await repo.softDeleteAgent(agentId);
}

/** Delete an agent after verifying ownership. Returns true if found. */
export async function deleteAgent(agentId: string, userId?: string): Promise<boolean> {
  const agent = await repo.findAgent(agentId, userId);
  if (!agent) {
    return false;
  }
  await deleteAgentRecursive(agentId);
  return true;
}
