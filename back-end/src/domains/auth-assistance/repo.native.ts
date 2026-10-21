/** Device-first native handoff. Stable ID and input hash prevent duplicate attention. */
import type { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { phoneCommandHash } from '../../providers/phoneHarnessCredentials';
import { writeNativeRequest } from './repo.nativeWrite';
import {
  NativePhoneAttentionError,
  getNativePhoneTarget,
  phoneMetadataObject,
  type NativePhoneInput,
} from '../../providers/nativePhoneAttention';
import {
  lockNativePhoneDevice,
  validateNativePhoneLease,
} from '../../providers/nativePhoneAttentionBinding';

export async function createNativeRequest(userId: string, input: NativePhoneInput) {
  const id = `phone-auth:${phoneCommandHash('attention', { userId, agentId: input.agentId, requestKey: input.requestKey }, 'agent')}`;
  const inputHash = phoneCommandHash('attention-context', input, 'agent');
  return runTransactionWithRetry(async (tx) => {
    const device = await lockNativePhoneDevice(tx, userId, input.agentId);
    const existing = await tx.userAuthAssistanceRequest.findUnique({
      where: { id },
      include: { attentionRequest: true },
    });
    if (existing !== null)
      return recoverNative(tx, userId, input, device.id, id, inputHash, existing);
    const lease = await tx.iPhoneLease.findFirst({
      where: {
        deviceId: device.id,
        userId,
        agentId: input.agentId,
        browserTaskId: input.browserTaskId,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    if (lease === null)
      throw new NativePhoneAttentionError(409, 'Native phone lease is not active');
    const target = {
      kind: 'iphone' as const,
      browserTaskId: input.browserTaskId,
      leaseId: lease.id,
    };
    const current = await validateNativePhoneLease(tx, userId, input.agentId, target, device.id);
    if (
      device.providerState === 'CLOSING' ||
      current.lease.attentionRequestId !== null ||
      current.lease.actionCursor !== input.expectedCursor
    )
      throw new NativePhoneAttentionError(409, 'Phone interaction changed');
    const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    if (
      current.lease.controlOwner !== 'user' &&
      (current.lease.leaseExpiresAt === null || current.lease.leaseExpiresAt <= clock.now)
    )
      throw new NativePhoneAttentionError(409, 'Native phone lease expired');
    const request = await writeNativeRequest(
      tx,
      device,
      current,
      input,
      id,
      inputHash,
      target,
      userId
    );
    return { request, created: true };
  });
}
export async function nativeRequestById(id: string, userId: string, refresh = false) {
  const request = await prisma.userAuthAssistanceRequest.findUnique({
    where: { id },
    include: { attentionRequest: true },
  });
  if (request === null || !getNativePhoneTarget(request.attentionRequest.metadata)) return null;
  if (request.userId !== userId) throw new NativePhoneAttentionError(403, 'Not authorized');
  if (refresh && request.completedAt === null)
    await runTransactionWithRetry(async (tx) => {
      const device = await lockNativePhoneDevice(tx, userId, request.agentId);
      const target = getNativePhoneTarget(request.attentionRequest.metadata)!;
      const { lease } = await validateNativePhoneLease(
        tx,
        userId,
        request.agentId,
        target,
        device.id,
        false
      );
      const attention = await tx.agentAttentionRequest.findUniqueOrThrow({ where: { id } });
      if (lease.attentionRequestId !== id || attention.userResponse !== null)
        throw new NativePhoneAttentionError(409, 'Native attention is no longer pending');
    });
  return request;
}

type NativeRequest = Prisma.UserAuthAssistanceRequestGetPayload<{
  include: { attentionRequest: true };
}>;
async function recoverNative(
  tx: Prisma.TransactionClient,
  userId: string,
  input: NativePhoneInput,
  deviceId: string,
  id: string,
  inputHash: string,
  existing: NativeRequest
) {
  const context = phoneMetadataObject(
    phoneMetadataObject(existing.attentionRequest.metadata).authAssistance
  );
  if (
    existing.userId !== userId ||
    existing.agentId !== input.agentId ||
    context.inputHash !== inputHash
  )
    throw new NativePhoneAttentionError(
      409,
      'Native attention identity cannot be reused with different context'
    );
  if (existing.completedAt !== null) return { request: existing, created: false };
  const target = getNativePhoneTarget(existing.attentionRequest.metadata);
  if (target === null)
    throw new NativePhoneAttentionError(409, 'Native attention binding is invalid');
  const { lease } = await validateNativePhoneLease(
    tx,
    userId,
    input.agentId,
    target,
    deviceId,
    false
  );
  if (lease.attentionRequestId !== id || existing.attentionRequest.userResponse !== null)
    throw new NativePhoneAttentionError(409, 'Native attention is no longer pending');
  return { request: existing, created: false };
}
