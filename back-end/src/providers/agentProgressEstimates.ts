import type { Prisma } from '@prisma/client';
import { prisma } from './database';
import type { ProgressEstimate } from '../utils/progressEstimate';
export { isNewerProgressEstimate, type ProgressEstimate } from '../utils/progressEstimate';

/** One batched query, restricted to the generations already returned by the owning read. */
export async function hydrateProgressEstimates<
  T extends {
    id: string;
    temporalWorkflowId: string | null;
    progressEstimate: Prisma.JsonValue;
    progressEstimateGeneration: string | null;
  },
>(agents: T[]) {
  if (agents.length === 0) return [];
  const rows = await prisma.agentTaskProgressEstimate.findMany({
    where: {
      OR: agents.map((agent) => ({
        agentId: agent.id,
        workflowGeneration: agent.temporalWorkflowId ?? agent.id,
      })),
    },
  });
  const tasks = new Map<string, Record<string, ProgressEstimate>>();
  for (const row of rows) {
    const byTask =
      tasks.get(row.agentId) ?? (Object.create(null) as Record<string, ProgressEstimate>);
    byTask[row.taskId] = row.estimate as unknown as ProgressEstimate;
    tasks.set(row.agentId, byTask);
  }
  return agents.map((agent) => ({
    ...agent,
    progressEstimate:
      agent.progressEstimateGeneration === (agent.temporalWorkflowId ?? agent.id)
        ? agent.progressEstimate
        : null,
    taskProgressEstimates: tasks.get(agent.id) ?? {},
  }));
}
