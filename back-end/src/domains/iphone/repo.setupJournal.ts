import type { IPhoneDevice, IPhoneLease, Transaction } from './types';
import { type SetupState, type SetupInput, sealSetup } from '../../providers/phoneSetupState';
import { sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import { databaseNow } from './repo.clock';
export async function createSetupJournal(
  tx: Transaction,
  device: IPhoneDevice,
  lease: IPhoneLease,
  state: SetupState,
  input: SetupInput,
  inputHash: string,
  evidenceDigest: string
) {
  const now = await databaseNow(tx);
  const command = await tx.iPhoneOperation.create({
    data: {
      deviceId: device.id,
      leaseId: lease.id,
      requestKey: input.requestKey,
      operation: `setup.${input.action}`,
      actor: 'agent',
      cursor: lease.actionCursor + 1,
      inputHash,
      requestEncrypted: sealPhoneValue({
        input,
        profileRevision: state.profileRevision,
        evidenceDigest: evidenceDigest,
        workflowId: state.attempt!.workflowId,
      }),
      state: 'RUNNING',
      activeDeviceId: device.id,
      providerEpoch: device.providerEpoch,
      deadlineAt: new Date(now.getTime() + 120000),
    },
  });
  state.attempt!.lastRequest = {
    requestKey: input.requestKey,
    operationId: input.requestKey,
    action: input.action,
    status: 'RUNNING',
    errorCode: null,
  };
  await tx.iPhoneDevice.update({
    where: { id: device.id },
    data: {
      setupEncrypted: sealSetup(state),
      ...(input.action === 'verify' ? { setupState: 'verifying' } : {}),
    },
  });
  await tx.iPhoneLease.update({
    where: { id: lease.id },
    data: { actionCursor: { increment: 1 }, lastOperationId: command.id },
  });
  return command;
}
