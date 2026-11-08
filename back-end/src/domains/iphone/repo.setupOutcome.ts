import type { IPhoneDevice, Transaction } from './types';
import {
  sealSetup,
  configurationState,
  type SetupState,
  type SetupInput,
} from '../../providers/phoneSetupState';
import {
  verificationDto,
  SETUP_REQUIREMENTS_VERSION,
} from '../../providers/phoneSetupVerification';
import type { SetupOutcomeResult } from '../../providers/phoneSetupVerifier';
export async function writeSetupOutcome(
  tx: Transaction,
  device: IPhoneDevice,
  state: SetupState,
  input: SetupInput,
  result: SetupOutcomeResult | null,
  now: Date,
  succeeded: boolean,
  errorCode: string | null,
  evidenceDigest: string
) {
  if (!(input.action === 'verify' && input.verificationTarget === 'runtime'))
    delete state.completedConfiguration;
  state.claimRevision++;
  state.attempt!.revision = state.claimRevision;
  const target = input.verificationTarget ?? 'apple_account';
  if (input.action === 'verify') {
    state.verification ??= { requirementsVersion: SETUP_REQUIREMENTS_VERSION, checks: {} };
    state.verification.requirementsVersion = SETUP_REQUIREMENTS_VERSION;
    const status =
      target === 'apple_account'
        ? result?.identityConfirmed === true
          ? 'confirmed'
          : 'unknown'
        : (result?.status ?? 'unknown');
    state.verification.checks[target] = {
      status,
      observedAt: now.toISOString(),
      evidenceDigest,
      requirementsVersion: SETUP_REQUIREMENTS_VERSION,
      floorCursor: state.attempt!.floorCursor,
      attemptId: state.attempt!.id,
      profileRevision: state.profileRevision,
      workflowId: state.attempt!.workflowId,
      providerEpoch: device.providerEpoch,
      expectedPhone: state.expectedPhone ?? null,
      ...(target === 'runtime' && result && 'runtime' in result && result.runtime
        ? { runtime: result.runtime }
        : {}),
    };
    if (target === 'apple_account' && result?.identityConfirmed === true)
      state.verified = { at: now.toISOString(), profileRevision: state.profileRevision };
  }
  const ready = currentConfigurationReady(device, state, now);
  const phase =
    input.action === 'defer'
      ? 'deferred'
      : input.action === 'block'
        ? 'blocked'
        : ready
          ? 'ready'
          : 'in_progress';
  state.attempt!.reasonCode = outcomeReason(input, result);
  state.attempt!.lastRequest = {
    requestKey: input.requestKey,
    operationId: input.requestKey,
    action: input.action,
    status: succeeded ? 'SUCCEEDED' : 'FAILED',
    errorCode,
  };
  if (input.action === 'block' && input.reasonCode === 'observed_signed_out') {
    delete state.connection;
    delete state.readinessAdmission;
    state.attempt!.floorAt = now.toISOString();
    state.attempt!.floorCursor = input.expectedCursor + 1;
    delete state.verified;
    const proof = state.verification?.checks.apple_account;
    if (proof) {
      proof.status = 'disabled';
      proof.observedAt = now.toISOString();
    }
  }
  await tx.iPhoneDevice.update({
    where: { id: device.id },
    data: { setupEncrypted: sealSetup(state), setupState: phase },
  });
}

function outcomeReason(input: SetupInput, result: SetupOutcomeResult | null) {
  const target = input.verificationTarget ?? 'apple_account';
  return (
    input.reasonCode ??
    ((
      target === 'apple_account'
        ? result?.identityConfirmed === true
        : result?.status === 'confirmed'
    )
      ? undefined
      : result !== null
        ? 'verification_unconfirmed'
        : 'verification_unavailable')
  );
}

function currentConfigurationReady(device: IPhoneDevice, state: SetupState, now: Date) {
  state = configurationState(state);
  return verificationDto(state.verification, {
    attemptId: state.attempt!.id,
    profileRevision: state.profileRevision,
    workflowId: state.attempt!.workflowId,
    providerEpoch: device.providerEpoch,
    expectedPhone: state.expectedPhone ?? null,
    expectedGoogleIdentity: state.expectedGoogleIdentity,
    allowGooglePasscodeException: state.allowGooglePasscodeException,
    floorAt: state.attempt!.floorAt,
    floorCursor: state.attempt!.floorCursor,
    now,
  }).configurationReady;
}
