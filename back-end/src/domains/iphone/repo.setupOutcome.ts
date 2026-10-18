import type { IPhoneDevice, Transaction } from './types';
import { sealSetup, type SetupState, type SetupInput } from '../../providers/phoneSetupState';
import type { SetupVerificationResult } from '../../providers/phoneSetupVerifier';
export async function writeSetupOutcome(
  tx: Transaction,
  device: IPhoneDevice,
  state: SetupState,
  input: SetupInput,
  result: SetupVerificationResult | null,
  now: Date,
  succeeded: boolean,
  errorCode: string | null
) {
  state.claimRevision++;
  state.attempt!.revision = state.claimRevision;
  const phase =
    input.action === 'defer'
      ? 'deferred'
      : input.action === 'block'
        ? 'blocked'
        : result?.identityConfirmed === true
          ? 'ready'
          : 'blocked';
  state.attempt!.reasonCode =
    input.reasonCode ??
    (result?.identityConfirmed === true
      ? undefined
      : result !== null
        ? 'identity_unconfirmed'
        : 'verification_unavailable');
  state.attempt!.lastRequest = {
    requestKey: input.requestKey,
    operationId: input.requestKey,
    action: input.action,
    status: succeeded ? 'SUCCEEDED' : 'FAILED',
    errorCode,
  };
  if (phase === 'ready')
    state.verified = { at: now.toISOString(), profileRevision: state.profileRevision };
  else if (input.action === 'block' && input.reasonCode === 'observed_signed_out')
    delete state.verified;
  await tx.iPhoneDevice.update({
    where: { id: device.id },
    data: { setupEncrypted: sealSetup(state), setupState: phase },
  });
}
