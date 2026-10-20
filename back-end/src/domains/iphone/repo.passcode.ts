/** Bounded create/confirm custody; never an existing-device unlock credential. */
import { setupState, sealSetup, type SetupState } from '../../providers/phoneSetupState';
import { privacyState, rememberPrivate } from './privacy';
import { READ_OPERATIONS } from './repo.operations';
import { executionCustody } from './repo.executionCustody';
import * as leases from './repo';
import { IPhoneError, type Transaction } from './types';
import type { CommandClaim } from './types.operations';
import type { savedBinding } from './repo.savedCredential';

export async function prepareDevicePasscode(
  claim: CommandClaim,
  binding: Awaited<ReturnType<typeof savedBinding>>,
  stage: 'create' | 'confirm' | 'acknowledge'
) {
  return leases.transaction(async (tx) => {
    const { device, enabled } = await leases.lockedDevice(tx, claim.lease.userId);
    const lease = await tx.iPhoneLease.findUniqueOrThrow({ where: { id: claim.lease.id } });
    const state = setupState(device.setupEncrypted);
    const command = await tx.iPhoneOperation.findUniqueOrThrow({ where: { id: claim.command.id } });
    const now = await leases.databaseNow(tx);
    if (
      !enabled ||
      !(await executionCustody(tx, claim, device, lease)) ||
      lease.status !== 'ACTIVE' ||
      lease.releaseRequestedAt !== null ||
      lease.controlOwner !== 'agent' ||
      lease.attentionRequestId !== null ||
      lease.actionCursor !== command.cursor ||
      device.providerEpoch !== command.providerEpoch ||
      state.profileRevision !== binding.state.profileRevision ||
      state.attempt?.id !== binding.state.attempt?.id ||
      state.attempt?.revision !== binding.state.attempt?.revision ||
      privacyState(device.privateInputEncrypted).active ||
      command.state !== 'CONNECTING' ||
      command.activeDeviceId !== device.id ||
      command.deadlineAt <= now ||
      device.providerState === 'CLOSING'
    )
      throw new IPhoneError(409, 'phone_passcode_binding_required');
    const previous = state.passcodeCreation;
    if (stage === 'create' && previous !== undefined)
      throw new IPhoneError(409, 'phone_passcode_binding_required');
    await validateContinuation(tx, claim, state, stage);
    state.passcodeCreation = {
      operationId: command.id,
      cursor: command.cursor,
      attemptId: state.attempt!.id,
      revision: state.attempt!.revision,
      profileRevision: state.profileRevision,
      workflowId: claim.executionGeneration!,
      providerEpoch: device.providerEpoch,
      leaseId: lease.id,
      confirmed: stage === 'confirm',
      acknowledged: stage === 'acknowledge' || previous?.acknowledged === true,
    };
    // Never persist the numeric value in setup/journal intent; register before provider input.
    const code = '1234';
    await tx.iPhoneDevice.update({
      where: { id: device.id },
      data: {
        setupEncrypted: sealSetup(state),
        privateInputEncrypted: rememberPrivate(device.privateInputEncrypted, code),
      },
    });
    await tx.iPhoneOperation.update({ where: { id: command.id }, data: { state: 'RUNNING' } });
    return code;
  });
}

async function validateContinuation(
  tx: Transaction,
  claim: CommandClaim,
  state: SetupState,
  stage: 'create' | 'confirm' | 'acknowledge'
) {
  if (stage !== 'create') {
    const previous = state.passcodeCreation;
    if (
      !previous ||
      (stage === 'acknowledge' && previous.acknowledged === true) ||
      previous.confirmed ||
      previous.attemptId !== state.attempt?.id ||
      previous.revision !== state.attempt?.revision ||
      previous.profileRevision !== state.profileRevision ||
      previous.workflowId !== claim.executionGeneration ||
      previous.providerEpoch !== claim.command.providerEpoch ||
      previous.leaseId !== claim.lease.id
    )
      throw new IPhoneError(409, 'phone_passcode_binding_required');
    const original = await tx.iPhoneOperation.findUnique({ where: { id: previous.operationId } });
    const intervening = await tx.iPhoneOperation.findFirst({
      where: {
        leaseId: claim.lease.id,
        cursor: { gt: previous.cursor, lt: claim.command.cursor },
        operation: { notIn: [...READ_OPERATIONS] },
      },
    });
    if (original?.state !== 'SUCCEEDED' || intervening !== null)
      throw new IPhoneError(409, 'phone_passcode_binding_required');
  }
}
