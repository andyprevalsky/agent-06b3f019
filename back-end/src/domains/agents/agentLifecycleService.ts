/**
 * Agent lifecycle service — create and delete agents.
 */

import { randomUUID } from '../../providers/crypto';
import { startAgentWorkflow, getTemporalClient } from '../../providers/temporal';
import { getModelPricing, dollarsToMicrodollars } from '../../providers/modelPricing';
import { getX402Endpoints } from '../../providers/x402Endpoints';
import { setResponseSchema } from '../../providers/setResponseSchema';
import { handleChatMessage, broadcastAgentModeStarted } from '../../providers/chat';
import { getGeoFromIP, DEFAULT_GEOLOCATION } from '../../providers/geoip';
import { cleanupAgentSessions } from '../../providers/agentCleanup';
import { createGithubRepo } from '../../providers/github';
import { createLogger } from '../../providers/logger';
import type { CreateAgentBody } from './types';
import * as repo from './repo';

const log = createLogger('Agents');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve {{VAR_NAME}} placeholders from PROMPT_SECRET_* env vars. */
export function resolvePromptSecrets(text: string): string {
  return text.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (_match, varName: string) => {
    const envKey = `PROMPT_SECRET_${varName}`;
    // eslint-disable-next-line no-restricted-syntax -- dynamic env key computed at runtime; can't enumerate in config.ts
    const value = process.env[envKey];
    if (value !== undefined && value !== '') {
      log.info(`Resolved prompt secret: {{${varName}}}`);
      return value;
    }
    log.warn(`Unresolved prompt secret: {{${varName}}} (env var ${envKey} not set)`);
    return `{{${varName}}}`;
  });
}

/** Auto-generate verifier prompt from goal. */
export function generateVerifierPrompt(goal: string): string {
  return `You are judging whether the agent has achieved the following goal: "${goal}"

Scoring Instructions:
- Return a float between 0.0 and 1.0.
- 0.0 means no progress or only explanations/plans.
- 1.0 means the goal is FULLY accomplished with verifiable proof.
- Do not award 1.0 for partial completion.
- The agent has access to tools and can solve problems through persistence and creativity.`;
}

/** Fetch model pricing and resolve geolocation. */
async function resolveCreateMetadata(model: string, clientIP: string | null) {
  const pricing = await getModelPricing(model);
  let tokenInPriceMicrodollars: number | null = null;
  let tokenOutPriceMicrodollars: number | null = null;

  if (pricing !== null && pricing !== undefined) {
    tokenInPriceMicrodollars = dollarsToMicrodollars(pricing.prompt);
    tokenOutPriceMicrodollars = dollarsToMicrodollars(pricing.completion);
  }

  let proxyGeo = DEFAULT_GEOLOCATION;
  if (clientIP !== null) {
    const geo = await getGeoFromIP(clientIP);
    if (geo !== null && geo !== undefined) {
      proxyGeo = geo;
    }
  }

  return { tokenInPriceMicrodollars, tokenOutPriceMicrodollars, proxyGeo };
}

/* c8 ignore start -- startSubAgentWorkflow, startDirectWorkflow, startChatMode require Temporal/GitHub/LLM infrastructure */
/** Start a sub-agent workflow and update DB. */
async function startSubAgentWorkflow(
  body: CreateAgentBody,
  agentDbId: string,
  userId: string,
  verifier: { type: string; llm_judge_prompt: string },
  priceLimitCents: number
): Promise<string> {
  const workflowId = await startAgentWorkflow({
    agentId: agentDbId,
    userId,
    goal: body.goal,
    model: body.model,
    reasoningMaxTokens: body.reasoning_max_tokens,
    verifier: { type: verifier.type, llmJudgePrompt: verifier.llm_judge_prompt },
    ...(body.task_queue !== undefined ? { taskQueue: body.task_queue } : {}),
    ...(body.parent_workflow_id !== undefined ? { parentWorkflowId: body.parent_workflow_id } : {}),
    ...(body.parent_agent_id !== undefined ? { parentAgentId: body.parent_agent_id } : {}),
    ...(body.depth !== undefined ? { depth: body.depth } : {}),
    ...(body.bus_id !== undefined ? { busId: body.bus_id } : {}),
    ...(body.start_phase !== undefined ? { startPhase: body.start_phase } : {}),
    ...(body.max_iterations !== undefined ? { maxIterations: body.max_iterations } : {}),
    priceLimitCents,
    ...(body.context_gates !== undefined ? { contextGates: body.context_gates } : {}),
  });
  await repo.updateAgent(agentDbId, { temporalWorkflowId: workflowId });
  return workflowId;
}

/** Start root agent directly in plan/execute (bypass chat). */
async function startDirectWorkflow(
  body: CreateAgentBody,
  agentDbId: string,
  userId: string,
  verifier: { type: string; llm_judge_prompt: string },
  priceLimitCents: number
): Promise<string> {
  const startPhase = body.start_phase!;
  if (startPhase === 'execute') {
    setResponseSchema(agentDbId).catch((err: unknown) => {
      log.error('Failed to set response schema (background)', {
        agent_id: agentDbId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  const workflowId = await startAgentWorkflow({
    agentId: agentDbId,
    userId,
    goal: body.goal,
    model: body.model,
    reasoningMaxTokens: body.reasoning_max_tokens,
    verifier: { type: verifier.type, llmJudgePrompt: verifier.llm_judge_prompt },
    startPhase,
    priceLimitCents,
  });
  await repo.updateAgent(agentDbId, { temporalWorkflowId: workflowId });
  await broadcastAgentModeStarted(agentDbId);
  return workflowId;
}

/** Start root agent in chat mode (fire-and-forget). */
function startChatMode(
  body: CreateAgentBody,
  agentDbId: string,
  agentId: string,
  userId: string
): void {
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
  const verifierPrompt =
    body.verifier?.llm_judge_prompt !== undefined && body.verifier.llm_judge_prompt !== ''
      ? body.verifier.llm_judge_prompt
      : generateVerifierPrompt(body.goal);
  const verifier = { type: 'FLOAT_LLM_JUDGE' as const, llm_judge_prompt: verifierPrompt };
  const { tokenInPriceMicrodollars, tokenOutPriceMicrodollars, proxyGeo } =
    await resolveCreateMetadata(body.model, clientIP);
  const isSubAgent = body.parent_agent_id !== undefined;
  const agentId = randomUUID();
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
    verifierType: verifier.type,
    verifierPrompt: verifier.llm_judge_prompt,
    attachments: body.attachments as Array<Record<string, unknown>> | undefined,
  });

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
  verifier: { type: 'FLOAT_LLM_JUDGE'; llm_judge_prompt: string }
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
  startChatMode(body, agent.agent.id, agentId, userId);
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
