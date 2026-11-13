/** POST /api/agents response body for a newly created (or launched) agent row. */

import { getX402Endpoints } from '../../providers/x402Endpoints';
import type * as repo from './repo';
import type { CreateAgentBody } from './types';
import { agentSpeedFromRow } from '../../providers/rose/speed';

type CreatedAgent = Awaited<ReturnType<typeof repo.createAgentTransaction>>;

export function createAgentResponse(
  created: CreatedAgent,
  body: CreateAgentBody,
  isSubAgent: boolean,
  workflowId: string | null,
  externalExecution = false
) {
  const { agent } = created;
  return {
    ...(externalExecution ? { execution_mode: 'external' } : {}),
    agent_id: agent.id,
    progress: agent.progress,
    goal: agent.goal,
    title: agent.title,
    task_path: agent.taskPath,
    model: agent.model,
    source: body.source,
    reasoning_max_tokens: body.reasoning_max_tokens,
    status: isSubAgent ? agent.status : 'ACTIVE',
    status_message: agent.statusMessage,
    temporal_workflow_id: workflowId,
    fast_mode_cache_enabled: agent.fastModeCacheEnabled,
    speed: agentSpeedFromRow(agent),
    memory_enabled: agent.memoryEnabled,
    world_model_mode: agent.worldModelMode,
    project_id: agent.projectId,
    folder_id: agent.folderId,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
    available_endpoints: getX402Endpoints(agent.id),
  };
}
