/** Completed receipt is durable; it never regains authority over a successor. */
import type { Prisma, IPhoneDevice } from '@prisma/client';
import { NativePhoneAttentionError, type NativePhoneTarget } from './nativePhoneAttention';
import { TERMINAL_AGENT_STATUSES } from './phoneAccountPolicy';

type NativeRequest = Prisma.UserAuthAssistanceRequestGetPayload<{
  include: { attentionRequest: true };
}>;
export async function nativeCompletionRetry(
  tx: Prisma.TransactionClient,
  request: NativeRequest,
  device: IPhoneDevice,
  target: NativePhoneTarget,
  initiallyCompleted: boolean,
  response: string
) {
  // A retry must repeat the committed intent; a different owner action is stale.
  if (request.attentionRequest.userResponse !== response)
    throw new NativePhoneAttentionError(409, 'Native attention is no longer current');
  await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${request.agentId} FOR SHARE`;
  const agent = await tx.agent.findFirst({
    where: { id: request.agentId, userId: request.userId, deletedAt: null },
  });
  const currentGeneration =
    agent !== null &&
    (agent.temporalWorkflowId ?? agent.id) === request.attentionRequest.workflowId;
  const lease = await tx.iPhoneLease.findFirst({
    where: {
      id: target.leaseId,
      deviceId: device.id,
      userId: request.userId,
      agentId: request.agentId,
      browserTaskId: target.browserTaskId,
    },
  });
  const task = await tx.browserSession.findFirst({
    where: {
      id: target.browserTaskId,
      agentId: request.agentId,
      context: { userId: request.userId },
    },
    select: { id: true },
  });
  const current =
    currentGeneration &&
    agent !== null &&
    !TERMINAL_AGENT_STATUSES.some((state) => state === agent.status) &&
    task !== null &&
    lease?.status === 'ACTIVE' &&
    lease.activeDeviceId === device.id &&
    lease.releaseRequestedAt === null &&
    lease.attentionRequestId === null &&
    lease.controlOwner === 'agent' &&
    device.providerState !== 'CLOSING';
  const inFlight = current
    ? await tx.iPhoneOperation.findFirst({
        where: {
          deviceId: device.id,
          OR: [{ activeDeviceId: { not: null } }, { state: { in: ['CONNECTING', 'RUNNING'] } }],
        },
        select: { id: true },
      })
    : null;
  return {
    status: 'already_completed' as const,
    request,
    interrupted: !currentGeneration,
    retrySideEffects: initiallyCompleted && current && inFlight === null,
    workflowId: request.attentionRequest.workflowId,
    userMessage: null,
    response,
  };
}
