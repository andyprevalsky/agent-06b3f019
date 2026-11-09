/** Carry existing device settings across a confirmed same-device session stop, never runtime. */
import {
  configurationProvenanceBound,
  setupState,
  sealSetup,
  configurationState,
} from '../../providers/phoneSetupState';
import { connectionDto } from '../../providers/phoneConnectionState';
import { proofCurrent } from '../../providers/phoneSetupVerification';
import { privacyState } from './privacy';
import { accountPermitted } from './repo.account';
import type { IPhoneDevice, Transaction } from './types';

export async function configurationAfterConfirmedStop(tx: Transaction, device: IPhoneDevice) {
  const state = setupState(device.setupEncrypted);
  const configuration = configurationState(state);
  const owner = await tx.user.findUnique({
    where: { userId: device.userId },
    select: { phone: true },
  });
  if (
    !device.enabled ||
    !(await accountPermitted(tx, device.userId)) ||
    state.expectedPhone !== owner?.phone ||
    privacyState(device.privateInputEncrypted).active ||
    state.attempt?.reasonCode === 'observed_signed_out' ||
    connectionDto(device, state, true, false).status !== 'ready' ||
    !configurationProvenanceBound(state) ||
    !configuration.verification
  )
    return device.setupEncrypted;

  const context = {
    attemptId: configuration.attempt?.id,
    profileRevision: state.profileRevision,
    workflowId: configuration.attempt?.workflowId,
    providerEpoch: device.providerEpoch,
    expectedPhone: state.expectedPhone ?? null,
    floorAt: configuration.attempt?.floorAt,
    floorCursor: configuration.attempt?.floorCursor,
  };
  for (const [target, proof] of Object.entries(configuration.verification.checks)) {
    if (target === 'runtime' || !proofCurrent(proof, context)) continue;
    // A control session ended, not a device reset. Retain when/where the settings
    // were observed; advancing the transport binding is not a fresh observation.
    proof.observedProviderEpoch ??= proof.providerEpoch;
    proof.providerEpoch = device.providerEpoch + 1;
  }
  delete configuration.verification.checks.runtime;
  if (state.verification) delete state.verification.checks.runtime;
  const admission = state.readinessAdmission;
  if (admission) {
    const lease = await tx.iPhoneLease.findFirst({
      where: {
        id: admission.leaseId,
        deviceId: device.id,
        userId: device.userId,
        agentId: admission.agentId,
        browserTaskId: admission.taskId,
        status: 'ACTIVE',
        releaseRequestedAt: null,
      },
    });
    const agent = await tx.agent.findFirst({
      where: {
        id: admission.agentId,
        userId: device.userId,
        deletedAt: null,
        temporalWorkflowId: admission.workflowId,
        temporalFirstExecutionRunId: admission.firstExecutionRunId,
      },
    });
    if (
      lease &&
      agent &&
      admission.profileRevision === state.profileRevision &&
      admission.providerEpoch === device.providerEpoch
    )
      admission.providerEpoch = device.providerEpoch + 1;
    else delete state.readinessAdmission;
  }
  return sealSetup(state);
}
