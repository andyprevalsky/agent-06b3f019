/** Device-first message custody. Queue dispatch marker precedes any physical send. */
import { openPhoneValue, sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import { privacyState } from './privacy';
import { executionCustody } from './repo.executionCustody';
import { setupState } from '../../providers/phoneSetupState';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';
import { validateNativePhoneLease } from '../../providers/nativePhoneAttentionBinding';
import * as leases from './repo';
import { IPhoneError, type Transaction } from './types';
import type { CommandClaim } from './types.operations';
import { messageQueue } from './repo.messageQueue';
export { messageBinding } from './repo.messageBinding';
import type { MessageBinding } from './repo.messageBinding';
export async function commitMessage(
  claim: CommandClaim,
  binding: MessageBinding,
  mode: 'send' | 'verify',
  status: string
) {
  return leases.transaction(async (tx) => {
    const { device, enabled } = await leases.lockedDevice(tx, claim.lease.userId);
    await lockAgentWorkflowGeneration(tx, claim.lease.agentId);
    await tx.$queryRaw`SELECT id FROM "User" WHERE "userId"=${claim.lease.userId} FOR SHARE`;
    const lease = await tx.iPhoneLease.findUniqueOrThrow({ where: { id: claim.lease.id } });
    if (lease.browserTaskId === null) throw new IPhoneError(409, 'phone_message_binding_required');
    await validateNativePhoneLease(
      tx,
      lease.userId,
      lease.agentId,
      { kind: 'iphone', browserTaskId: lease.browserTaskId, leaseId: lease.id },
      device.id,
      false
    );
    const state = setupState(device.setupEncrypted);
    const command = await tx.iPhoneOperation.findUniqueOrThrow({ where: { id: claim.command.id } });
    const now = await leases.databaseNow(tx);
    if (
      !enabled ||
      !(await executionCustody(tx, claim, device, lease)) ||
      lease.controlOwner !== 'agent' ||
      lease.attentionRequestId !== null ||
      lease.actionCursor !== command.cursor ||
      device.providerEpoch !== command.providerEpoch ||
      device.providerState === 'CLOSING' ||
      privacyState(device.privateInputEncrypted).active ||
      state.profileRevision !== binding.profileRevision ||
      state.attempt?.id !== binding.attemptId ||
      state.attempt.revision !== binding.revision ||
      state.attempt.floorAt !== binding.floorAt ||
      command.state !== 'CONNECTING' ||
      command.deadlineAt <= now
    )
      throw new IPhoneError(409, 'phone_message_binding_required');
    await tx.$queryRaw`SELECT id FROM "ImessageQueue" WHERE id=${binding.queue.id} FOR UPDATE`;
    const queue = await messageQueue(tx, claim, binding.queue.id);
    if (queue.phoneNumber !== binding.queue.phoneNumber || queue.message !== binding.queue.message)
      throw new IPhoneError(409, 'phone_message_binding_required');
    if (mode === 'send') {
      if (
        queue.dispatchedAt ||
        queue.phoneSendOperationId !== null ||
        queue.sentAt ||
        queue.failedAt ||
        (queue.expiresAt !== null && queue.expiresAt <= now)
      )
        throw new IPhoneError(409, 'phone_message_already_dispatched');
      await tx.imessageQueue.update({
        where: { id: queue.id },
        data: { dispatchedAt: now, phoneSendOperationId: command.id, attempts: { increment: 1 } },
      });
      const intent = openPhoneValue<Record<string, unknown>>(command.requestEncrypted);
      await tx.iPhoneOperation.update({
        where: { id: command.id },
        data: {
          state: 'RUNNING',
          requestEncrypted: sealPhoneValue({
            ...intent,
            messageBinding: { before: binding.before, digest: binding.digest },
          }),
        },
      });
    } else {
      await writeMessageVerification(tx, queue, binding, status, now);
      await tx.iPhoneOperation.update({ where: { id: command.id }, data: { state: 'RUNNING' } });
    }
  });
}
export async function markMessageUnknown(claim: CommandClaim, queueId: string) {
  await leases.transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "IPhoneDevice" WHERE id=${claim.device.id} FOR UPDATE`;
    await tx.imessageQueue.updateMany({
      where: { id: queueId, phoneSendOperationId: claim.command.id, sentAt: null },
      data: { lastError: 'phone_message_outcome_unknown' },
    });
  });
}

async function writeMessageVerification(
  tx: Transaction,
  queue: Awaited<ReturnType<typeof messageQueue>>,
  binding: MessageBinding,
  status: string,
  now: Date
) {
  if (
    queue.phoneSendOperationId !== binding.queue.phoneSendOperationId ||
    queue.dispatchedAt === null
  )
    throw new IPhoneError(409, 'phone_message_binding_required');
  if (queue.sentAt !== null || queue.failedAt !== null)
    throw new IPhoneError(409, 'phone_message_terminal');
  await tx.imessageQueue.update({
    where: { id: queue.id },
    data:
      status === 'sent'
        ? { sentAt: now, lastError: null }
        : status === 'failed'
          ? { failedAt: now, lastError: 'phone_message_send_failed' }
          : { lastError: 'phone_message_outcome_unknown' },
  });
}
