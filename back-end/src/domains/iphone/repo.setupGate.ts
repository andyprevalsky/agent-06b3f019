import { ensureSetup } from './repo.setup';
import { sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import type { Transaction, IPhoneLease } from './types';
import type { PhoneCommand, PhoneActor } from './types.operations';
import { databaseNow } from './repo.clock';

export async function setupGate(
  tx: Transaction,
  deviceId: string,
  lease: IPhoneLease,
  input: PhoneCommand,
  actor: PhoneActor,
  inputHash: string,
  requestEncrypted: string
) {
  if (actor !== 'agent') return null;
  const setup = await ensureSetup(tx, deviceId, lease);
  if (
    !setup.dto.required ||
    (setup.state.attempt?.id === input.setupAttemptId &&
      setup.state.attempt?.revision === input.setupRevision)
  )
    return null;
  const now = await databaseNow(tx);
  const command = await tx.iPhoneOperation.create({
    data: {
      deviceId,
      leaseId: lease.id,
      requestKey: input.operationId,
      operation: input.operation,
      actor,
      inputHash,
      requestEncrypted,
      cursor: lease.actionCursor + 1,
      state: 'FAILED',
      providerEpoch: setup.device.providerEpoch,
      deadlineAt: now,
      completedAt: now,
      errorCode: 'phone_setup_required',
      resultEncrypted: sealPhoneValue({
        success: false,
        outcome: 'rejected',
        error: 'Phone setup context is required',
      }),
    },
  });
  await tx.iPhoneLease.update({
    where: { id: lease.id },
    data: { actionCursor: { increment: 1 }, lastOperationId: command.id },
  });
  return command;
}
