/** Root workflow launch and exact-reservation recovery share one admission path. */
import { startAgentWorkflowExecution } from '../../providers/temporal';
import { bindStartedRunIdentity } from '../../providers/workflowGeneration';
import { broadcastAgentModeStarted } from '../../providers/chat';
import type { CreateAgentBody } from './types';
import * as repo from './repo';

/** Start root agent directly in plan/execute (bypass chat). */
export async function startDirectWorkflow(
  body: CreateAgentBody,
  agentDbId: string,
  userId: string,
  verifier: { type: string },
  priceLimitCents: number,
  rejectDuplicateWorkflowId = false
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
    ...(rejectDuplicateWorkflowId ? { rejectDuplicateWorkflowId: true } : {}),
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

/** Resume only a request-validated independent root after an ambiguous/failed start. */
export async function resumeIndependentRootStart(
  body: CreateAgentBody,
  userId: string,
  priceLimitCents: number
) {
  if (
    body.agent_id === undefined ||
    body.parent_agent_id !== undefined ||
    body.start_phase === undefined
  ) {
    throw new Error('An independent root launch requires its original id and phase');
  }
  await startDirectWorkflow(
    body,
    body.agent_id,
    userId,
    { type: 'FLOAT_LLM_JUDGE' },
    priceLimitCents,
    true
  );
  await repo.updateAgent(body.agent_id, { temporalWorkflowStartPending: false });
}
