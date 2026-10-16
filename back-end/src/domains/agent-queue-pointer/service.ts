import {
  admitQueueContinuation,
  type ContinuationIdentity,
} from '../../providers/workflowQueueContinuation';
import { managedQueue } from '../../providers/workflowManagedQueue';
import { WorkflowStartAdmissionPendingError } from '../../providers/workflowQueueAdmission';
import { getCurrentAgentQueue, readAgentQueuePointer } from './repo';
import type { AgentQueuePointerPayload } from './types';

export async function getAgentQueuePointerPayload(
  identity?: ContinuationIdentity,
  observationOnly = false
): Promise<AgentQueuePointerPayload> {
  const row = await readAgentQueuePointer();
  const queue = row?.taskQueue ?? (await getCurrentAgentQueue());
  if (managedQueue(queue) && !identity && !observationOnly)
    throw new WorkflowStartAdmissionPendingError(
      'Managed continuation source identity is required'
    );
  const admitted =
    managedQueue(queue) && !observationOnly ? await admitQueueContinuation(identity!) : queue;
  if (admitted !== queue)
    throw new WorkflowStartAdmissionPendingError('Continuation pointer changed');
  return {
    managedDeploymentProtocol: 1,
    managedQueue: managedQueue(queue),
    continuationAdmitted: managedQueue(queue) && !observationOnly,
    taskQueue: admitted,
    surfaceHash: row?.surfaceHash ?? null,
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}
