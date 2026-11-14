import type { Prisma } from '@prisma/client';
import type { AgentSpeed } from '../../providers/rose/speed';

/**
 * Optional Agent columns that are only written when the caller supplied a value,
 * so DB-level defaults stand otherwise. Kept out of createAgentTransaction to keep
 * that function under the line budget.
 */
export function optionalAgentCreateFields(params: {
  temporalWorkflowId?: string | null;
  workflowMaxIterations?: number;
  workflowContextGates?: Record<string, boolean>;
  workflowStartPhase?: string;
  workflowTaskQueue?: string;
  priceLimitCents?: number;
  writeLockEnabled?: boolean;
  fastModeCacheEnabled?: boolean;
  speed?: AgentSpeed;
  memoryEnabled?: boolean;
  worldModelMode?: 'real' | 'simulate' | 'shadow';
  isBenchmark?: boolean;
  githubRepoUrl?: string;
  githubRepoRef?: string;
  originDeviceId?: string;
  projectId?: string | null;
  folderId?: string | null;
  title?: string;
  taskPath?: string | null;
}): Partial<Prisma.AgentUncheckedCreateInput> {
  return {
    ...(params.folderId !== undefined && params.folderId !== null
      ? { folderId: params.folderId }
      : {}),
    ...(params.title !== undefined ? { title: params.title } : {}),
    ...(params.projectId !== undefined && params.projectId !== null
      ? { projectId: params.projectId }
      : {}),
    ...(params.temporalWorkflowId !== undefined && params.temporalWorkflowId !== null
      ? { temporalWorkflowId: params.temporalWorkflowId }
      : {}),
    ...(params.workflowMaxIterations !== undefined
      ? { workflowMaxIterations: params.workflowMaxIterations }
      : {}),
    ...(params.workflowContextGates !== undefined
      ? { workflowContextGates: params.workflowContextGates }
      : {}),
    ...(params.workflowStartPhase !== undefined
      ? { workflowStartPhase: params.workflowStartPhase }
      : {}),
    ...(params.workflowTaskQueue !== undefined
      ? { workflowTaskQueue: params.workflowTaskQueue }
      : {}),
    ...(params.priceLimitCents !== undefined && params.priceLimitCents !== 0
      ? { priceLimitCents: params.priceLimitCents }
      : {}),
    ...(params.writeLockEnabled !== undefined ? { writeLockEnabled: params.writeLockEnabled } : {}),
    ...(params.fastModeCacheEnabled !== undefined
      ? { fastModeCacheEnabled: params.fastModeCacheEnabled }
      : {}),
    ...(params.speed !== undefined ? { speed: params.speed } : {}),
    ...(params.memoryEnabled !== undefined ? { memoryEnabled: params.memoryEnabled } : {}),
    ...(params.worldModelMode !== undefined ? { worldModelMode: params.worldModelMode } : {}),
    ...(params.isBenchmark === true ? { isBenchmark: true } : {}),
    ...(params.githubRepoUrl !== undefined ? { githubRepoUrl: params.githubRepoUrl } : {}),
    ...(params.githubRepoRef !== undefined ? { githubRepoRef: params.githubRepoRef } : {}),
    ...(params.originDeviceId !== undefined ? { originDeviceId: params.originDeviceId } : {}),
    ...(params.taskPath !== undefined && params.taskPath !== null
      ? { taskPath: params.taskPath }
      : {}),
  };
}
