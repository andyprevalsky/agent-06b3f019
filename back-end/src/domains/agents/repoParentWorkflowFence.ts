import type { Prisma } from '@prisma/client';
import {
  lockAgentWorkflowGeneration,
  StaleParentWorkflowGenerationError,
} from '../../providers/workflowGeneration';

export interface ParentWorkflowGeneration {
  parentAgentId: string | null;
  parentWorkflowId: string | null;
}

/** Lock parent generations in stable order and reject stale child inserts. */
export async function assertCurrentParentWorkflowGenerations(
  tx: Prisma.TransactionClient,
  items: ParentWorkflowGeneration[]
): Promise<void> {
  const expectedByParent = new Map<string, string>();
  for (const item of items) {
    if (item.parentAgentId === null || item.parentWorkflowId === null) continue;
    const previous = expectedByParent.get(item.parentAgentId);
    if (previous !== undefined && previous !== item.parentWorkflowId) {
      throw new StaleParentWorkflowGenerationError();
    }
    expectedByParent.set(item.parentAgentId, item.parentWorkflowId);
  }
  const parentIds = [...expectedByParent.keys()].sort();
  for (const parentId of parentIds) {
    await lockAgentWorkflowGeneration(tx, parentId);
  }
  if (parentIds.length === 0) return;
  const parents = await tx.agent.findMany({
    where: { id: { in: parentIds }, deletedAt: null },
    select: { id: true, temporalWorkflowId: true, status: true },
  });
  const currentByParent = new Map(
    parents.map((parent) => [
      parent.id,
      parent.status === 'COMPLETED' || parent.status === 'FAILED'
        ? null
        : parent.temporalWorkflowId,
    ])
  );
  for (const [parentId, expectedWorkflowId] of expectedByParent) {
    if (currentByParent.get(parentId) !== expectedWorkflowId) {
      throw new StaleParentWorkflowGenerationError();
    }
  }
}
