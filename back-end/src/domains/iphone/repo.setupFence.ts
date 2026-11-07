import { availabilityInTransaction } from './repo.availability';
import { validateNativePhoneLease } from '../../providers/nativePhoneAttentionBinding';
import { permitted } from '../../providers/phoneAccountPolicy';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';
import { privacyState } from './privacy';
import type { SetupClaim } from './repo.setupCommand';
import type { IPhoneDevice, IPhoneOperation, Transaction } from './types';
import type { SetupState, SetupInput } from '../../providers/phoneSetupState';
export async function lockSetupCommit(tx: Transaction, claim: SetupClaim) {
  await tx.$queryRaw`SELECT id FROM "IPhoneDevice" WHERE id=${claim.device.id} FOR UPDATE`;
  await lockAgentWorkflowGeneration(tx, claim.lease.agentId);
  await tx.$queryRaw`SELECT id FROM "User" WHERE "userId"=${claim.lease.userId} FOR SHARE`;
  return tx.iPhoneDevice.findUniqueOrThrow({ where: { id: claim.device.id } });
}
export async function setupCommitValid(
  tx: Transaction,
  device: IPhoneDevice,
  claim: SetupClaim,
  input: SetupInput,
  command: IPhoneOperation,
  state: SetupState
) {
  let valid =
    command.state === 'RUNNING' &&
    device.enabled &&
    permitted(await tx.user.findUnique({ where: { userId: claim.lease.userId } })) &&
    state.profileRevision === claim.state.profileRevision &&
    (await tx.user.findUnique({ where: { userId: claim.lease.userId }, select: { phone: true } }))
      ?.phone === claim.state.expectedPhone &&
    state.attempt?.id === input.attemptId &&
    state.attempt.revision === input.expectedRevision &&
    device.providerEpoch === command.providerEpoch &&
    device.providerState !== 'CLOSING' &&
    !privacyState(device.privateInputEncrypted).active &&
    (await availabilityInTransaction(tx, claim.lease.userId, claim.lease.browserTaskId!)).enabled;
  try {
    const { lease, agent } = await validateNativePhoneLease(
      tx,
      claim.lease.userId,
      claim.lease.agentId,
      { kind: 'iphone', browserTaskId: claim.lease.browserTaskId!, leaseId: claim.lease.id },
      device.id,
      false
    );
    const other = await tx.iPhoneOperation.findFirst({
      where: {
        deviceId: device.id,
        id: { not: command.id },
        OR: [
          { activeDeviceId: { not: null } },
          { state: { in: ['CONNECTING', 'RUNNING'] } },
          {
            state: 'UNKNOWN',
            OR: [{ errorCode: null }, { errorCode: { not: 'provider_session_ended' } }],
          },
        ],
      },
      select: { id: true },
    });
    valid =
      valid &&
      lease.actionCursor === command.cursor &&
      lease.controlOwner === 'agent' &&
      lease.attentionRequestId === null &&
      other === null &&
      (agent.temporalWorkflowId ?? agent.id) === claim.state.attempt!.workflowId &&
      agent.temporalFirstExecutionRunId === claim.state.attempt!.firstExecutionRunId;
  } catch {
    valid = false;
  }
  return valid;
}
