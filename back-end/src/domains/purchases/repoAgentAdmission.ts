import type { Prisma } from '@prisma/client';
import { runTransactionWithRetry } from '../../providers/database';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';
import { PurchaseError } from './errors';

export type PurchaseAgentAdmission = { userId: string; agentId?: string };

/** Share the deletion fence only while admitting durable work, never across provider I/O. */
export async function lockPurchaseAgentAdmission(
  tx: Prisma.TransactionClient,
  input: PurchaseAgentAdmission
): Promise<string | undefined> {
  const candidate = input.agentId?.trim();
  const agentId = candidate !== undefined && candidate !== '' ? candidate : undefined;
  // The public purchase API also supports purchases without an agent.
  if (agentId === undefined) return undefined;
  await lockAgentWorkflowGeneration(tx, agentId);
  const agent = await tx.agent.findFirst({
    where: { id: agentId, userId: input.userId, deletedAt: null },
    select: { id: true },
  });
  if (agent === null) {
    throw new PurchaseError(
      'The agent is no longer available for this purchase',
      409,
      'purchase_agent_unavailable'
    );
  }
  return agentId;
}

/** Reject stale callers before returning reusable card credentials as well as before minting. */
export async function assertPurchaseAgentAdmitted(input: PurchaseAgentAdmission): Promise<void> {
  if (input.agentId === undefined || input.agentId.trim() === '') return;
  await runTransactionWithRetry(async (tx) => {
    await lockPurchaseAgentAdmission(tx, input);
  });
}
