import { IPhoneError, type Transaction } from './types';
import type { CommandClaim } from './types.operations';
export async function messageQueue(tx: Transaction, claim: CommandClaim, queueId: string) {
  const row = await tx.imessageQueue.findUnique({ where: { id: queueId } });
  if (
    !row ||
    row.transport !== 'phone_harness' ||
    row.userId !== claim.lease.userId ||
    row.agentId !== claim.lease.agentId ||
    row.phoneBrowserTaskId !== claim.lease.browserTaskId
  )
    throw new IPhoneError(409, 'phone_message_binding_required');
  return row;
}
