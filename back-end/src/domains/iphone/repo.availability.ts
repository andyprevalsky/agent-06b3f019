/** Task-scoped discovery is database-only and cannot create a lease or provider session. */
import * as leases from './repo';
import { getNativePhoneTarget } from '../../providers/nativePhoneAttention';
import { setupState, type SetupState } from '../../providers/phoneSetupState';
import {
  bootstrapAuthorized,
  connectionDto,
  continuationAuthorized,
} from '../../providers/phoneConnectionState';
import { IPhoneError, type Transaction } from './types';

export async function availability(userId: string, taskId: string) {
  return leases.transaction((tx) => availabilityInTransaction(tx, userId, taskId));
}

export async function availabilityInTransaction(tx: Transaction, userId: string, taskId: string) {
  const task = await tx.browserSession.findFirst({
    where: { id: taskId, context: { userId } },
    select: { agentId: true },
  });
  const agent =
    task === null
      ? null
      : await tx.agent.findFirst({ where: { id: task.agentId, userId, deletedAt: null } });
  if (!task || !agent) throw new IPhoneError(404, 'Browser task not found');
  const device = await tx.iPhoneDevice.findUnique({ where: { userId } });
  const disabled = { enabled: false, source: null } as const;
  if (
    device?.enabled !== true ||
    !(await leases.accountPermitted(tx, userId)) ||
    ['COMPLETED', 'FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED'].includes(agent.status)
  )
    return disabled;
  const state = setupState(device.setupEncrypted);
  const owner = await tx.user.findUnique({ where: { userId }, select: { phone: true } });
  if (state.expectedPhone !== (owner?.phone ?? null)) return disabled;
  if (
    connectionDto(device, state, true, false).status === 'ready' &&
    (await configurationGenerationCurrent(tx, userId, state))
  )
    return { enabled: true, source: 'ready' } as const;
  const first = await tx.message.findFirst({
    where: { agentId: agent.id, role: 'USER' },
    orderBy: { timestamp: 'asc' },
    select: { metadata: true },
  });
  if (
    agent.parentAgentId === null &&
    bootstrapAuthorized(
      state,
      userId,
      device.id,
      agent.id,
      (first?.metadata as Record<string, unknown> | null)?.iphone_setup_hash,
      agent.temporalWorkflowId ?? agent.id,
      agent.temporalFirstExecutionRunId ?? ''
    )
  )
    return { enabled: true, source: 'bootstrap' } as const;
  const lease = await tx.iPhoneLease.findFirst({
    where: {
      deviceId: device.id,
      userId,
      agentId: agent.id,
      browserTaskId: taskId,
      status: 'ACTIVE',
      releaseRequestedAt: null,
    },
  });
  let pendingAuth = false;
  if (lease?.controlOwner === 'user' && lease.attentionRequestId !== null) {
    const attention = await tx.agentAttentionRequest.findFirst({
      where: { id: lease.attentionRequestId, userId, agentId: agent.id, userResponse: null },
      select: { metadata: true },
    });
    const target = getNativePhoneTarget(attention?.metadata);
    pendingAuth = target?.leaseId === lease.id && target.browserTaskId === taskId;
  }
  if (
    lease &&
    continuationAuthorized(state, {
      leaseId: lease.id,
      taskId,
      agentId: agent.id,
      workflowId: agent.temporalWorkflowId ?? agent.id,
      firstExecutionRunId: agent.temporalFirstExecutionRunId ?? '',
      providerEpoch: device.providerEpoch,
      active:
        pendingAuth ||
        (lease.leaseExpiresAt !== null && lease.leaseExpiresAt > (await leases.databaseNow(tx))),
    })
  )
    return { enabled: true, source: 'continuation' } as const;
  return disabled;
}

/** Ready configuration remains bound to the setup producer's real execution chain. */
export async function configurationGenerationCurrent(
  tx: Transaction,
  userId: string,
  state: SetupState
) {
  if (state.attempt?.firstExecutionRunId === undefined || state.attempt.firstExecutionRunId === '')
    return false;
  const producer = await tx.agent.findFirst({
    where: { id: state.attempt.agentId, userId, deletedAt: null },
    select: { temporalWorkflowId: true, temporalFirstExecutionRunId: true },
  });
  return (
    producer !== null &&
    producer.temporalWorkflowId === state.attempt.workflowId &&
    producer.temporalFirstExecutionRunId === state.attempt.firstExecutionRunId
  );
}
