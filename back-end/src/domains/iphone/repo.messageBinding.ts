import { openPhoneValue, phoneCommandHash } from '../../providers/phoneHarnessCredentials';
import { privacyState, privateResult } from './privacy';
import { executionCustody } from './repo.executionCustody';
import { setupState } from '../../providers/phoneSetupState';
import * as leases from './repo';
import { IPhoneError, type Transaction } from './types';
import type { CredentialEvidence } from '../../providers/phoneCredentialVerifier';

import type { CommandClaim } from './types.operations';
import { messageQueue } from './repo.messageQueue';
export async function messageBinding(claim: CommandClaim, queueId: string) {
  return leases.transaction(async (tx) => {
    const { device } = await leases.lockedDevice(tx, claim.lease.userId);
    const lease = await tx.iPhoneLease.findUniqueOrThrow({ where: { id: claim.lease.id } });
    if (
      !(await executionCustody(tx, claim, device, lease)) ||
      lease.browserTaskId === null ||
      lease.controlOwner !== 'agent' ||
      lease.attentionRequestId !== null ||
      privacyState(device.privateInputEncrypted).active ||
      lease.actionCursor !== claim.command.cursor
    )
      throw new IPhoneError(409, 'phone_message_binding_required');
    const queue = await messageQueue(tx, claim, queueId);
    const row = await tx.iPhoneOperation.findFirst({
      where: {
        leaseId: lease.id,
        cursor: claim.command.cursor - 1,
        operation: 'screen.text',
        actor: 'agent',
        state: 'SUCCEEDED',
        providerEpoch: device.providerEpoch,
      },
    });
    const now = await leases.databaseNow(tx);
    const state = setupState(device.setupEncrypted);
    if (
      row?.resultEncrypted === null ||
      row?.resultEncrypted === undefined ||
      !row.completedAt ||
      now.getTime() - row.completedAt.getTime() > 60000 ||
      !state.attempt ||
      row.cursor <= state.attempt.floorCursor ||
      row.completedAt.getTime() < Date.parse(state.attempt.floorAt)
    )
      throw new IPhoneError(409, 'phone_message_observation_required');
    const intent = openPhoneValue<{ setupAttemptId?: string; setupRevision?: number }>(
      row.requestEncrypted
    );
    if (
      intent.setupAttemptId !== state.attempt.id ||
      intent.setupRevision !== state.attempt.revision
    )
      throw new IPhoneError(409, 'phone_message_observation_required');
    const evidence = [
      {
        operationId: row.requestKey,
        cursor: row.cursor,
        result: privateResult(
          row,
          openPhoneValue(row.resultEncrypted),
          device.privateInputEncrypted
        ),
      },
    ];
    const before =
      claim.command.operation === 'messages.verify_sent'
        ? await originalEvidence(
            tx,
            claim,
            queue.phoneSendOperationId,
            row.completedAt,
            row.cursor,
            device.providerEpoch,
            device.privateInputEncrypted
          )
        : evidence;
    return {
      queue,
      evidence,
      before,
      profileRevision: state.profileRevision,
      attemptId: state.attempt.id,
      revision: state.attempt.revision,
      floorAt: state.attempt.floorAt,
      digest: phoneCommandHash('message-observation', evidence, 'agent'),
    };
  });
}
export type MessageBinding = Awaited<ReturnType<typeof messageBinding>>;

async function originalEvidence(
  tx: Transaction,
  claim: CommandClaim,
  sendId: string | null,
  completedAt: Date,
  cursor: number,
  epoch: number,
  privateInput: string | null
): Promise<CredentialEvidence[]> {
  if (sendId === null) throw new IPhoneError(409, 'phone_message_not_dispatched');
  const sent = await tx.iPhoneOperation.findUnique({ where: { id: sendId } });
  if (
    !sent ||
    sent.leaseId !== claim.lease.id ||
    sent.providerEpoch !== epoch ||
    cursor <= sent.cursor ||
    sent.completedAt === null ||
    completedAt < sent.completedAt
  )
    throw new IPhoneError(409, 'phone_message_observation_required');
  const before =
    openPhoneValue<{ messageBinding?: { before: CredentialEvidence[] } }>(sent.requestEncrypted)
      .messageBinding?.before ?? [];
  if (before.length === 0) throw new IPhoneError(409, 'phone_message_observation_required');
  return before.map((evidence) => ({
    ...evidence,
    result: privateResult(sent, evidence.result, privateInput),
  }));
}
