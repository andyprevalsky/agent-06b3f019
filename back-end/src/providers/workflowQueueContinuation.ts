import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { runTransactionWithRetry } from './database';
import { getTemporalClient, withTemporalControlDeadline } from './temporal';
import {
  lockQueueAdmission,
  queueAdmissionKey,
  nativeWorkflowTerminal,
  type QueueAdmission,
  WorkflowStartAdmissionPendingError,
} from './workflowQueueAdmission';
import { managedQueue } from './workflowManagedQueue';
export const CONTINUATION_OPERATION = 'AGENT_QUEUE_CONTINUATION';
export interface ContinuationIdentity {
  workflowId: string;
  runId: string;
}
export interface ContinuationTicket extends ContinuationIdentity {
  firstExecutionRunId: string;
  sourceQueue: string;
  queue: string;
  incarnation: string;
}
export async function nativeContinuationSource(identity: ContinuationIdentity) {
  const client = await getTemporalClient();
  const description = await withTemporalControlDeadline(client, () =>
    client.workflow.getHandle(identity.workflowId).describe()
  );
  const info = description.raw.workflowExecutionInfo;
  if (!info?.firstRunId || !info.execution?.runId || !info.taskQueue)
    throw new WorkflowStartAdmissionPendingError('Native continuation identity is incomplete');
  return {
    firstExecutionRunId: info.firstRunId,
    runId: info.execution.runId,
    queue: info.taskQueue,
    terminal: nativeWorkflowTerminal(description.status.name),
  };
}
/** Native read happens before the admission transaction; an ended source cannot later CAN. */
export async function admitQueueContinuation(
  identity: ContinuationIdentity,
  observe = nativeContinuationSource
): Promise<string> {
  if (
    !identity.workflowId ||
    !identity.runId ||
    identity.workflowId.length > 512 ||
    identity.runId.length > 128
  )
    throw new WorkflowStartAdmissionPendingError('Continuation source identity is required');
  const native = await observe(identity);
  if (native.runId !== identity.runId || native.terminal)
    throw new WorkflowStartAdmissionPendingError('Continuation source run is no longer current');
  return runTransactionWithRetry(async (tx) => {
    await lockQueueAdmission(tx);
    const pointer = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
    if (!pointer || !managedQueue(pointer.taskQueue))
      throw new WorkflowStartAdmissionPendingError(
        'Managed destination changed during continuation admission'
      );
    const gate = (
      await tx.toolSideEffect.findUnique({
        where: { operationKey: queueAdmissionKey(pointer.taskQueue) },
      })
    )?.request as unknown as QueueAdmission;
    if (
      !gate ||
      gate.phase !== 'OPEN' ||
      gate.legacyCoverage !== 'QUALIFIED' ||
      gate.surfaceHash !== pointer.surfaceHash
    )
      throw new WorkflowStartAdmissionPendingError(
        'Managed continuation destination is not qualified OPEN'
      );
    if (native.queue === pointer.taskQueue) return pointer.taskQueue;
    const ticket: ContinuationTicket = {
      ...identity,
      firstExecutionRunId: native.firstExecutionRunId,
      sourceQueue: native.queue,
      queue: pointer.taskQueue,
      incarnation: gate.incarnation,
    };
    const key = `agent-queue-continuation:${createHash('sha256').update(JSON.stringify(ticket)).digest('hex')}`;
    const existing = await tx.toolSideEffect.findUnique({ where: { operationKey: key } });
    if (!existing)
      await tx.toolSideEffect.create({
        data: {
          operationKey: key,
          operationType: CONTINUATION_OPERATION,
          externalId: identity.workflowId,
          status: 'STARTED',
          request: ticket as unknown as Prisma.InputJsonObject,
        },
      });
    return pointer.taskQueue;
  });
}
