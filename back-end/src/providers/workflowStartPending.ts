import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import { lockAgentWorkflowGeneration } from './workflowGeneration';
import { START_ADMISSION_OPERATION } from './workflowQueueAdmission';
function pendingWhere(
  agentId: string,
  workflowId?: string,
  includeAcknowledgedUnknown = false
): Prisma.ToolSideEffectWhereInput {
  return {
    operationType: START_ADMISSION_OPERATION,
    OR: [
      { status: 'STARTED' },
      ...(includeAcknowledgedUnknown
        ? [{ status: 'COMPLETED', request: { path: ['wireCoverage'], equals: 'UNKNOWN' } }]
        : []),
    ],
    AND: [
      { request: { path: ['agentId'], equals: agentId } },
      ...(workflowId ? [{ request: { path: ['workflowId'], equals: workflowId } }] : []),
    ],
  };
}
export async function hasUnacknowledgedWorkflowStart(
  agentId: string,
  workflowId?: string
): Promise<boolean> {
  return (
    (await prisma.toolSideEffect.findFirst({
      where: pendingWhere(agentId, workflowId),
      select: { id: true },
    })) !== null
  );
}
/** Serialize the final terminal CAS with admission, after external tool reads. */
export async function updateAgentUnlessStartPending(
  agentId: string,
  workflowId: string | undefined,
  temporalStatus: string | undefined,
  update: Prisma.AgentUpdateManyArgs,
  expectedMembership: string
): Promise<{ count: number }> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    if ((await workflowStartMembership(agentId, workflowId, tx)) !== expectedMembership)
      return { count: 0 };
    if (
      await tx.toolSideEffect.findFirst({
        where: pendingWhere(
          agentId,
          workflowId,
          temporalStatus === undefined || temporalStatus === 'NOT_FOUND'
        ),
        select: { id: true },
      })
    )
      return { count: 0 };
    return tx.agent.updateMany(update);
  });
}

export async function workflowStartMembership(
  agentId: string,
  workflowId?: string,
  client: Pick<Prisma.TransactionClient, 'toolSideEffect'> = prisma
): Promise<string> {
  const rows = await client.toolSideEffect.findMany({
    where: {
      operationType: START_ADMISSION_OPERATION,
      AND: [
        { request: { path: ['agentId'], equals: agentId } },
        ...(workflowId ? [{ request: { path: ['workflowId'], equals: workflowId } }] : []),
      ],
    },
    select: { operationKey: true, status: true, request: true },
    orderBy: { operationKey: 'asc' },
  });
  return JSON.stringify(rows);
}
