/**
 * Agent lifecycle service — create and delete agents.
 */

import { resolveAgentProjectId } from './agentProject';
import { randomUUID } from '../../providers/crypto';
import { startAgentWorkflowExecution } from '../../providers/temporal';
import { bindStartedRunIdentity } from '../../providers/workflowGeneration';
import { handleChatMessage, broadcastAgentModeStarted } from '../../providers/chat';
import { recoverChatHandlerFailure } from '../../providers/chat/chatHandlerFailure';
import { deleteAgentRecursive as killAgentRecursive } from '../../providers/agentKill';
import { assertCodeSessionShareTarget, recordCodeSessionShare } from './agentCodeSessionShare';
import { createLogger } from '../../providers/logger';
import { originDeviceFields } from './agentOriginService';
import { resolvePriceLimitCents } from '../../providers/priceLimitDefaults';
import type { CreateAgentBody } from './types';
import { getPromptSecret } from './config';
import * as repo from './repo';
import { resolveCreateMetadata } from './agentCreateMetadata';
import { resolveCreateTaskPaths } from './agentTaskPathCreate';
import { createAgentResponse } from './agentCreateResponse';
import { prepareAgentStartArchive } from '../../providers/traceArchiveLifecycle';
import {
  applyFastModeDefault,
  applyFastModeInheritance,
  applyMemoryDefault,
  applyMemoryInheritance,
  applyWorldModelModeInheritance,
  assertWorldModelModeAccess,
  disableFastModeForWorldModel,
} from './agentExecutionMode';
import {
  resumeExistingSubAgent,
  shouldKeepDescendantStartPending,
  startSubAgentWorkflow,
} from './agentDescendantStartService';

const log = createLogger('Agents');

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

/**
 * Post-create work that must not block the create response.
 *
 * Fire-and-forget by design: the archive fixture is diagnostic and must not
 * delay the create response.
 */
function runPostCreateSideEffects(
  agentDbId: string,
  archiveStartFixture: (() => Promise<void>) | null
): void {
  archiveStartFixture?.().catch((error: unknown) => {
    log.warn('Trace archive start fixture failed', {
      agent_id: agentDbId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/* c8 ignore start -- startSubAgentWorkflow, startDirectWorkflow, startChatMode require Temporal/GitHub/LLM infrastructure */
/** Start root agent directly in plan/execute (bypass chat). */
async function startDirectWorkflow(
  body: CreateAgentBody,
  agentDbId: string,
  userId: string,
  verifier: { type: string },
  priceLimitCents: number
): Promise<string> {
  const execution = await startAgentWorkflowExecution({
    agentId: agentDbId,
    userId,
    goal: body.goal,
    model: body.model,
    reasoningMaxTokens: body.reasoning_max_tokens,
    verifier: { type: verifier.type },
    ...(body.task_queue !== undefined ? { taskQueue: body.task_queue } : {}),
    startPhase: body.start_phase!,
    ...(body.max_iterations !== undefined ? { maxIterations: body.max_iterations } : {}),
    priceLimitCents,
    ...(body.fast_mode_cache_enabled !== undefined
      ? { fastModeCacheEnabled: body.fast_mode_cache_enabled }
      : {}),
    ...(body.world_model_mode !== undefined ? { worldModelMode: body.world_model_mode } : {}),
    ...(body.memory_enabled !== undefined ? { memoryEnabled: body.memory_enabled } : {}),
    ...(body.context_gates !== undefined ? { contextGates: body.context_gates } : {}),
  });
  // temporalWorkflowId was set during createAgentTransaction (see comment on
  // startSubAgentWorkflow above); bind the run so cleanup can tell this
  // generation from a later follow-up that reuses the same Workflow ID.
  await bindStartedRunIdentity(agentDbId, execution);
  await broadcastAgentModeStarted(agentDbId);
  return execution.workflowId;
}

/** Start root agent in chat mode (fire-and-forget). */
async function startChatMode(
  body: CreateAgentBody,
  agentDbId: string,
  userId: string
): Promise<void> {
  // The tree's GitHub repo is created when it first starts a code session
  // (ensureAgentTreeRepo), not for every chat: most chats never write code, and
  // every create shares one account-wide GitHub rate limit.
  handleChatMessage({ agentId: agentDbId, userId, model: body.model }).catch((err: unknown) => {
    void recoverChatHandlerFailure({
      agentId: agentDbId,
      userId,
      error: err,
    });
  });
}
/* c8 ignore stop */

// ---------------------------------------------------------------------------
// Create agent
// ---------------------------------------------------------------------------

async function resolveSubAgentBenchmarkFlag(
  body: CreateAgentBody,
  userId: string,
  isBenchmark: boolean
): Promise<boolean> {
  if (body.parent_agent_id === undefined) return isBenchmark;
  // Only inherit benchmark (and mode flags) from a parent the caller owns —
  // otherwise any UUID would escalate into SMS/WhatsApp transport mocking.
  const parent = await repo.findAgent(body.parent_agent_id, userId);
  if (
    body.fast_mode_cache_enabled === undefined ||
    body.world_model_mode === undefined ||
    body.memory_enabled === undefined
  ) {
    applyFastModeInheritance(body, parent?.fastModeCacheEnabled);
    applyWorldModelModeInheritance(body, parent?.worldModelMode);
    applyMemoryInheritance(body, parent?.memoryEnabled);
  }
  return !isBenchmark && parent?.isBenchmark === true ? true : isBenchmark;
}

/** Server-side create options that are not part of the public request body. */
export interface CreateAgentOptions {
  /** Root repository for code sessions, persisted in the create transaction. */
  githubRepoUrl?: string;
  /**
   * `X-Rose-Device-Id` sent by the Rose Mac app's main process (C14). Recorded
   * only for a MAC_APP root agent and only when the caller owns that device.
   */
  originDeviceHeader?: string;
}

/** Server-side create fields: the root repository and the Mac that started it. */
async function serverCreateFields(
  body: CreateAgentBody,
  userId: string,
  isSubAgent: boolean,
  options: CreateAgentOptions
): Promise<{ githubRepoUrl?: string; originDeviceId?: string }> {
  return {
    ...(options.githubRepoUrl !== undefined ? { githubRepoUrl: options.githubRepoUrl } : {}),
    ...(await originDeviceFields(body, userId, isSubAgent, options.originDeviceHeader)),
  };
}

/** Defaults and access checks every create body passes before any row is written. */
async function applyCreateBodyRules(
  body: CreateAgentBody,
  userId: string,
  benchmarkFlag: boolean
): Promise<void> {
  applyMemoryDefault(body, benchmarkFlag);
  disableFastModeForWorldModel(body);
  assertWorldModelModeAccess(body, userId);
  await assertCodeSessionShareTarget(body, userId);
}

export async function createAgent(
  body: CreateAgentBody,
  userId: string,
  isInternal: boolean,
  clientIP: string | null,
  isBenchmark = false,
  options: CreateAgentOptions = {}
) {
  if (isInternal) body.goal = resolvePromptSecrets(body.goal);
  const verifier = { type: 'FLOAT_LLM_JUDGE' as const };
  const isSubAgent = body.parent_agent_id !== undefined;
  applyFastModeDefault(body, userId);

  const benchmarkFlag = await resolveSubAgentBenchmarkFlag(body, userId, isBenchmark);
  await applyCreateBodyRules(body, userId, benchmarkFlag);
  const existingSubAgent = await resumeExistingSubAgent(body, userId, verifier);
  if (existingSubAgent !== null) return existingSubAgent;
  const projectId = await resolveAgentProjectId(body, userId);
  const { tokenInPriceMicrodollars, tokenOutPriceMicrodollars, proxyGeo } =
    await resolveCreateMetadata(body.model, clientIP, body.parent_agent_id ?? null, userId);
  const agentId = body.agent_id ?? randomUUID();
  const [taskPath] = await resolveCreateTaskPaths([body]);
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
    priceLimitCents: resolvePriceLimitCents(body.price_limit_cents),
    writeLockEnabled: body.write_lock_enabled,
    fastModeCacheEnabled: body.fast_mode_cache_enabled,
    memoryEnabled: body.memory_enabled,
    worldModelMode: body.world_model_mode,
    verifierType: verifier.type,
    isBenchmark: benchmarkFlag,
    attachments: body.attachments as Array<Record<string, unknown>> | undefined,
    temporalWorkflowId: willStartWorkflow ? agentId : null,
    workflowMaxIterations: body.max_iterations,
    workflowContextGates: body.context_gates,
    workflowStartPhase: body.start_phase,
    workflowTaskQueue: body.task_queue,
    ...(await serverCreateFields(body, userId, isSubAgent, options)),
    projectId,
    taskPath,
  });
  const archiveStartFixture = !isSubAgent ? await prepareAgentStartArchive(agent.agent.id) : null;
  await recordCodeSessionShare(body, userId, agent.agent.id);

  const workflowId = await launchAgentWorkflow(body, agent, userId, isSubAgent, agentId, verifier);

  runPostCreateSideEffects(agent.agent.id, archiveStartFixture);

  return createAgentResponse(agent, body, isSubAgent, workflowId);
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
      if (!(await shouldKeepDescendantStartPending(agent.agent.id))) {
        await repo.updateAgent(agent.agent.id, {
          status: 'FAILED',
          statusMessage:
            'Failed to start workflow: ' + (error instanceof Error ? error.message : String(error)),
        });
      }
      throw error;
    }
  }
  if (body.start_phase !== undefined) {
    return startDirectWorkflow(body, agent.agent.id, userId, verifier, agent.agent.priceLimitCents);
  }
  await repo.updateAgent(agent.agent.id, { status: 'ACTIVE' });
  void startChatMode(body, agent.agent.id, userId);
  return null;
}
/* c8 ignore stop */

// ---------------------------------------------------------------------------
// Delete agent
// ---------------------------------------------------------------------------

/** Soft-delete an agent tree via the canonical kill path (UI Archive / SMS /clear). */
export async function deleteAgentRecursive(agentId: string): Promise<void> {
  await killAgentRecursive(agentId, { terminateReason: 'Agent deleted by user' });
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

/**
 * Un-archive a soft-deleted agent (and its archived descendants) after
 * verifying ownership. Returns true if an archived agent was found.
 *
 * The run is NOT resumed: archiving terminated the Temporal workflow and tore
 * down browser/sandbox sessions, so the agent returns readable and stopped.
 */
export async function unarchiveAgent(agentId: string, userId?: string): Promise<boolean> {
  const agent = await repo.findArchivedAgent(agentId, userId);
  if (!agent) {
    return false;
  }
  await repo.restoreAgentAndDescendants(agentId);
  log.info('Unarchived agent', { agent_id: agentId });
  return true;
}
