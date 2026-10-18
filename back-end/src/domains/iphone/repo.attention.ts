/** Exact pending native attention fence; caller already holds device lock. */
import { SETUP_OPERATIONS } from '../../providers/phoneSetupState';
import { sealPhoneValue, phoneCommandHash } from '../../providers/phoneHarnessCredentials';
import { getNativePhoneTarget, isNativePhoneAttention } from '../../providers/nativePhoneAttention';
import { IPhoneError, type IPhoneLease, type LeaseAction, type Transaction } from './types';
import type { PhoneActor, PhoneCommand } from './types.operations';

export async function pendingNativeAttention(tx: Transaction, lease: IPhoneLease) {
  if (lease.attentionRequestId === null) return null;
  const attention = await tx.agentAttentionRequest.findUnique({
    where: { id: lease.attentionRequestId },
  });
  return attention !== null &&
    attention.userResponse === null &&
    isNativePhoneAttention(attention.metadata)
    ? attention
    : null;
}
export async function validateAttentionInput(
  tx: Transaction,
  lease: IPhoneLease,
  input: PhoneCommand,
  actor: PhoneActor
) {
  if (SETUP_OPERATIONS.has(input.operation))
    return new IPhoneError(403, 'Use the task setup route');
  const attention = await pendingNativeAttention(tx, lease);
  if (attention === null) {
    if (input.attentionRequestId !== undefined)
      return new IPhoneError(409, 'Native attention is no longer pending');
    return null;
  }
  const target = getNativePhoneTarget(attention.metadata);
  if (
    actor !== 'user' ||
    input.attentionRequestId !== attention.id ||
    target === null ||
    target.leaseId !== lease.id ||
    target.browserTaskId !== lease.browserTaskId ||
    attention.userId !== lease.userId ||
    attention.agentId !== lease.agentId
  )
    return new IPhoneError(409, 'Exact native attention is required for phone input');
  const request = await tx.userAuthAssistanceRequest.findFirst({
    where: {
      id: attention.id,
      userId: lease.userId,
      agentId: lease.agentId,
      completedAt: null,
      authRealm: 'iphone',
      mode: 'manual_step',
    },
    select: { id: true },
  });
  if (request === null) return new IPhoneError(409, 'Native attention is no longer pending');
  return null;
}

export async function nativeControlError(tx: Transaction, lease: IPhoneLease, action: LeaseAction) {
  if (
    (action === 'control' || action === 'awaiting-auth') &&
    (await pendingNativeAttention(tx, lease)) !== null
  )
    return new IPhoneError(409, 'Use exact native attention completion to return phone control');
  return null;
}
export async function taskBoundError(tx: Transaction, lease: IPhoneLease, taskBound: boolean) {
  if (!taskBound) return null;
  const task =
    lease.browserTaskId === null
      ? null
      : await tx.browserSession.findFirst({
          where: {
            id: lease.browserTaskId,
            agentId: lease.agentId,
            context: { userId: lease.userId },
          },
          select: { id: true },
        });
  return task === null ? new IPhoneError(404, 'Browser phone interaction not found') : null;
}

export function phoneIntent(input: PhoneCommand, actor: PhoneActor) {
  return {
    inputHash: phoneCommandHash(
      input.operation,
      input.attentionRequestId === undefined &&
        input.setupAttemptId === undefined &&
        input.setupRevision === undefined
        ? input.args
        : {
            args: input.args,
            attentionRequestId: input.attentionRequestId,
            setupAttemptId: input.setupAttemptId,
            setupRevision: input.setupRevision,
          },
      actor
    ),
    requestEncrypted: sealPhoneValue({
      operation: input.operation,
      args: input.args,
      actor,
      ...(input.setupAttemptId === undefined
        ? {}
        : { setupAttemptId: input.setupAttemptId, setupRevision: input.setupRevision }),
      ...(input.attentionRequestId === undefined
        ? {}
        : { attentionRequestId: input.attentionRequestId }),
    }),
  };
}
