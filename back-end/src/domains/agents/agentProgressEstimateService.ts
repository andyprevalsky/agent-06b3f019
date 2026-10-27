import { broadcastAgentUpdate } from '../../providers/chat';
import type { ProgressEstimate } from '../../utils/progressEstimate';
import * as repo from './repoProgressEstimate';

export async function updateAgentProgressEstimate(
  agentId: string,
  workflowGeneration: string,
  estimate: ProgressEstimate | null
) {
  const result = await repo.updateProgressEstimate(agentId, workflowGeneration, estimate);
  if (result.outcome === 'updated') {
    await broadcastAgentUpdate(
      agentId,
      {
        temporalWorkflowId: workflowGeneration,
        updatedAt: result.updatedAt.toISOString(),
        ...(result.estimate.taskId === undefined
          ? { progressEstimate: result.estimate }
          : {
              taskProgressEstimates: { [result.estimate.taskId]: result.estimate },
            }),
      },
      result.busId
    );
  }
  return result;
}
