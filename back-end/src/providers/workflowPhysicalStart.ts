import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  WorkflowStartAdmissionPendingError,
  retainPendingWorkflowStart,
} from './workflowQueueAdmission';
import type { TemporalWorkflowExecutionRef } from './temporal';
export interface RootTerminalWitness {
  workflowId: string;
  firstExecutionRunId?: string;
  status: 'TERMINAL' | 'ABSENT';
}
export class PhysicalRootReconciliationRequired extends Error {
  constructor(
    readonly executions: TemporalWorkflowExecutionRef[],
    readonly logicalProbeId?: string
  ) {
    super('Prior physical root chains require terminal reconciliation');
    retainPendingWorkflowStart(this);
  }
}
export const physicalWitnessKey = (ref: TemporalWorkflowExecutionRef) =>
  `${ref.workflowId}:${ref.firstExecutionRunId}`;
/** Generation lock owns every membership read/write; native IO must happen outside this transaction. */
export async function claimPhysicalRootStart(
  tx: Prisma.TransactionClient,
  agentId: string,
  fingerprint: string,
  witnesses: ReadonlyMap<string, RootTerminalWitness> = new Map()
): Promise<string> {
  const agent = await tx.agent.findUnique({
    where: { id: agentId },
    select: {
      deletedAt: true,
      temporalWorkflowId: true,
      temporalFirstExecutionRunId: true,
      workflowReplacementToken: true,
    },
  });
  if (!agent || agent.deletedAt !== null)
    throw new WorkflowStartAdmissionPendingError('Root generation no longer exists');
  const installed = agent.temporalWorkflowId;
  const key = (id: string) => `agent-physical-start:${agentId}:${id}`;
  if (installed && installed !== agentId) {
    const row = await tx.toolSideEffect.findUnique({ where: { operationKey: key(installed) } });
    const saved = row?.request as { fingerprint?: string } | undefined;
    if (!row || saved?.fingerprint !== fingerprint)
      throw new WorkflowStartAdmissionPendingError(
        'Root start differs from the retained generation'
      );
    return installed;
  }
  if (agent.temporalFirstExecutionRunId || agent.workflowReplacementToken)
    throw new WorkflowStartAdmissionPendingError('Prior root generation is still installed');
  const rows = await tx.toolSideEffect.findMany({
    where: { operationType: 'AGENT_QUEUE_START', externalId: agentId },
  });
  const pending = rows.filter(
    (row) => row.status !== 'COMPLETED' || !(row.request as { accepted?: unknown }).accepted
  );
  if (pending.length > 0) {
    const ids = new Set(pending.map((row) => (row.request as { workflowId: string }).workflowId));
    if (ids.size !== 1)
      throw new WorkflowStartAdmissionPendingError('Prior physical starts remain unresolved');
    const workflowId = [...ids][0];
    const saved = (await tx.toolSideEffect.findUnique({ where: { operationKey: key(workflowId) } }))
      ?.request as { fingerprint?: string } | undefined;
    if (saved?.fingerprint !== fingerprint)
      throw new WorkflowStartAdmissionPendingError('Prior physical start remains unresolved');
    await tx.agent.update({
      where: { id: agentId },
      data: { temporalWorkflowId: workflowId },
      select: { id: true },
    });
    return workflowId;
  }
  const missing = new Map<string, TemporalWorkflowExecutionRef>();
  for (const row of rows) {
    const ref = (row.request as unknown as { accepted: TemporalWorkflowExecutionRef }).accepted;
    if (!ref?.workflowId || !ref.firstExecutionRunId)
      throw new WorkflowStartAdmissionPendingError('Prior physical start identity is incomplete');
    const response = row.response as Prisma.JsonObject | null;
    const saved = response?.nativeTerminalWitness as unknown as RootTerminalWitness | undefined;
    const savedValid =
      saved?.status === 'TERMINAL' &&
      saved.workflowId === ref.workflowId &&
      saved.firstExecutionRunId === ref.firstExecutionRunId;
    const proof = savedValid ? saved : witnesses.get(physicalWitnessKey(ref));
    if (
      proof?.status !== 'TERMINAL' ||
      proof.workflowId !== ref.workflowId ||
      proof.firstExecutionRunId !== ref.firstExecutionRunId
    )
      missing.set(physicalWitnessKey(ref), ref);
  }
  const logicalProof = witnesses.get(`logical:${agentId}`);
  const logicalValid =
    logicalProof?.workflowId === agentId &&
    (logicalProof.status === 'ABSENT' ||
      (logicalProof.status === 'TERMINAL' &&
        typeof logicalProof.firstExecutionRunId === 'string' &&
        logicalProof.firstExecutionRunId.length > 0));
  if (missing.size > 0 || (rows.length === 0 && !logicalValid))
    throw new PhysicalRootReconciliationRequired(
      [...missing.values()],
      rows.length === 0 ? agentId : undefined
    );
  for (const row of rows) {
    const ref = (row.request as unknown as { accepted: TemporalWorkflowExecutionRef }).accepted;
    const proof = witnesses.get(physicalWitnessKey(ref));
    if (proof)
      await tx.toolSideEffect.update({
        where: { operationKey: row.operationKey },
        data: {
          response: {
            ...(row.response as Prisma.JsonObject | null),
            nativeTerminalWitness: proof as unknown as Prisma.InputJsonObject,
          },
        },
      });
  }
  const workflowId = `${agentId}:start:${randomUUID()}`;
  await tx.toolSideEffect.create({
    data: {
      operationKey: key(workflowId),
      operationType: 'AGENT_PHYSICAL_START',
      externalId: agentId,
      status: 'STARTED',
      request: {
        workflowId,
        fingerprint,
        ...(logicalProof
          ? { logicalProbe: logicalProof as unknown as Prisma.InputJsonObject }
          : {}),
      },
    },
  });
  await tx.agent.update({
    where: { id: agentId },
    data: { temporalWorkflowId: workflowId },
    select: { id: true },
  });
  return workflowId;
}
