/** Task-scoped discovery is database-only and cannot create a lease or provider session. */
import { runTransactionWithRetry } from '../../providers/database';
import { accountPermitted } from './repo.account';
import { databaseNow } from './repo.clock';
import { getNativePhoneTarget } from '../../providers/nativePhoneAttention';
import {
  setupState,
  configurationProvenanceBound,
  type SetupState,
} from '../../providers/phoneSetupState';
import {
  bootstrapAuthorized,
  connectionDto,
  continuationAuthorized,
} from '../../providers/phoneConnectionState';
import { IPhoneError, type Transaction } from './types';
import type { Agent, IPhoneLease } from '@prisma/client';

export async function availability(userId: string, taskId: string) {
  return runTransactionWithRetry((tx) => availabilityInTransaction(tx, userId, taskId));
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
    !(await accountPermitted(tx, userId)) ||
    ['COMPLETED', 'FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED'].includes(agent.status)
  )
    return disabled;
  const state = setupState(device.setupEncrypted);
  const owner = await tx.user.findUnique({ where: { userId }, select: { phone: true } });
  if (state.expectedPhone !== (owner?.phone ?? null)) return disabled;
  const active = await tx.iPhoneLease.findFirst({
    where: {
      userId,
      agentId: agent.id,
      browserTaskId: taskId,
      status: 'ACTIVE',
      releaseRequestedAt: null,
    },
  });
  if (active && !currentBorrower(state, active, agent, taskId)) return disabled;
  const provenanceBound = configurationProvenanceBound(state);
  if (connectionDto(device, state, true, false).status === 'ready' && provenanceBound)
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
  if (state.completedConfiguration && !provenanceBound) return disabled;
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
        (await pendingNativeAuth(tx, lease, taskId)) ||
        (lease.leaseExpiresAt !== null && lease.leaseExpiresAt > (await databaseNow(tx))),
    })
  )
    return { enabled: true, source: 'continuation' } as const;
  return disabled;
}

async function pendingNativeAuth(tx: Transaction, lease: IPhoneLease | null, taskId: string) {
  if (lease?.controlOwner !== 'user' || lease.attentionRequestId === null) return false;
  const attention = await tx.agentAttentionRequest.findFirst({
    where: {
      id: lease.attentionRequestId,
      userId: lease.userId,
      agentId: lease.agentId,
      userResponse: null,
    },
    select: { metadata: true },
  });
  const target = getNativePhoneTarget(attention?.metadata);
  return target?.leaseId === lease.id && target.browserTaskId === taskId;
}

function currentBorrower(state: SetupState, lease: IPhoneLease, agent: Agent, taskId: string) {
  const attempt = state.attempt;
  return (
    attempt?.leaseId === lease.id &&
    attempt.taskId === taskId &&
    attempt.agentId === agent.id &&
    attempt.workflowId === (agent.temporalWorkflowId ?? agent.id) &&
    attempt.firstExecutionRunId === agent.temporalFirstExecutionRunId
  );
}
