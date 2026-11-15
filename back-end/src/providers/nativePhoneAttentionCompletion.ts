/** Exact native completion: device -> generation -> live binding -> one completion CAS. */
import { setupAfterAttention } from './phoneSetupState';
import { nativeCompletionRetry } from './nativePhoneAttentionRetry';
import type { Prisma } from '@prisma/client';
import {
  getNativePhoneTarget,
  NativePhoneAttentionError,
  nativePhoneResponse,
  type NativePhoneUserAction,
} from './nativePhoneAttention';
import { lockNativePhoneDevice, validateNativePhoneLease } from './nativePhoneAttentionBinding';
import { resumedPrivacy } from './phoneInputPrivacy';
import { LEASE_TIMEOUT_MS } from './phoneAccountPolicy';

export async function completeNativePhoneAttention(
  tx: Prisma.TransactionClient,
  id: string,
  userId: string,
  agentId: string,
  now: Date,
  userMessage: unknown,
  initiallyCompleted: boolean,
  action?: NativePhoneUserAction
) {
  const response = nativePhoneResponse(action);
  // This guard precedes every authored-message write, including completed retries.
  if (
    userMessage !== undefined &&
    userMessage !== null &&
    (typeof userMessage !== 'string' || userMessage.trim() !== '')
  )
    throw new NativePhoneAttentionError(
      403,
      'Native phone completion cannot contain user messages'
    );
  const device = await lockNativePhoneDevice(tx, userId, agentId);
  const request = await tx.userAuthAssistanceRequest.findUniqueOrThrow({
    where: { id },
    include: { attentionRequest: true },
  });
  const target = getNativePhoneTarget(request.attentionRequest.metadata);
  if (
    target === null ||
    request.userId !== userId ||
    request.agentId !== agentId ||
    request.attentionRequest.userId !== userId ||
    request.attentionRequest.agentId !== agentId ||
    request.authRealm !== 'iphone' ||
    request.mode !== 'manual_step'
  )
    throw new NativePhoneAttentionError(403, 'Native attention binding is invalid');
  if (request.completedAt !== null)
    return nativeCompletionRetry(tx, request, device, target, initiallyCompleted, response);
  const { lease, agent } = await validateNativePhoneLease(tx, userId, agentId, target, device.id);
  if ((agent.temporalWorkflowId ?? agent.id) !== request.attentionRequest.workflowId)
    throw new NativePhoneAttentionError(409, 'Native attention workflow changed');
  if (
    request.attentionRequest.userResponse !== null ||
    lease.attentionRequestId !== id ||
    lease.controlOwner !== 'user' ||
    device.providerState === 'CLOSING'
  )
    throw new NativePhoneAttentionError(409, 'Native attention is no longer pending');
  await tx.userAuthAssistanceRequest.update({ where: { id }, data: { completedAt: now } });
  const answered = await tx.agentAttentionRequest.updateMany({
    where: { id, userResponse: null },
    data: { userResponse: response },
  });
  if (answered.count !== 1) throw new NativePhoneAttentionError(409, 'Native attention changed');
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  await tx.iPhoneLease.update({
    where: { id: lease.id },
    data: {
      attentionRequestId: null,
      controlOwner: 'agent',
      leaseExpiresAt: new Date(clock.now.getTime() + LEASE_TIMEOUT_MS),
      revision: { increment: 1 },
    },
  });
  await tx.iPhoneDevice.update({
    where: { id: device.id },
    data: {
      privateInputEncrypted: resumedPrivacy(device.privateInputEncrypted),
      setupEncrypted: setupAfterAttention(
        device.setupEncrypted,
        lease.id,
        lease.actionCursor,
        clock.now
      ),
      ...(device.setupState === 'awaiting_user' ? { setupState: 'verifying' } : {}),
    },
  });
  return {
    status: 'completed' as const,
    request: { ...request, completedAt: now },
    steelSessionAuthId: null,
    interrupted: false,
    workflowId: request.attentionRequest.workflowId,
    userMessage: null,
    response,
  };
}
