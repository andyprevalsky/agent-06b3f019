import { requiresGoogleIdentity } from '../../providers/phoneSetupVerification';
/** Logical setup journal claims share the physical slot, without performing phone IO. */
import {
  lockNativePhoneDevice,
  validateNativePhoneLease,
} from '../../providers/nativePhoneAttentionBinding';
import { phoneCommandHash } from '../../providers/phoneHarnessCredentials';
import { privacyState } from './privacy';
import { type SetupInput, type SetupState } from '../../providers/phoneSetupState';
import { assertSetupPhysicalKnown, setupEvidence } from './repo.setupEvidence';
import { createSetupJournal } from './repo.setupJournal';
import { ensureSetup } from './repo.setup';
import * as leases from './repo';
import { IPhoneError } from './types';

export async function claimSetup(userId: string, taskId: string, input: SetupInput) {
  return leases.transaction(async (tx) => {
    const { task, device, holder, current } = await setupHolder(tx, userId, taskId);
    const inputHash = phoneCommandHash(`setup.${input.action}`, input, 'agent');
    const existing = await tx.iPhoneOperation.findUnique({
      where: { leaseId_requestKey: { leaseId: holder.id, requestKey: input.requestKey } },
    });
    const setup = await ensureSetup(tx, device.id, current.lease);
    if (existing) {
      if (existing.inputHash !== inputHash || existing.operation !== `setup.${input.action}`)
        throw new IPhoneError(409, 'Setup identity cannot be reused with different context');
      return {
        ...setup,
        lease: current.lease,
        command: existing,
        execute: false as const,
        evidence: [],
        evidenceDigest: '',
      };
    }
    await assertSetupPhysicalKnown(tx, device.id);
    await validateNativePhoneLease(
      tx,
      userId,
      task.agentId,
      { kind: 'iphone', browserTaskId: taskId, leaseId: holder.id },
      device.id
    );
    const state = setup.state;
    if (
      !state.attempt ||
      state.attempt.id !== input.attemptId ||
      state.attempt.revision !== input.expectedRevision ||
      state.attempt.workflowId !== (current.agent.temporalWorkflowId ?? current.agent.id) ||
      holder.actionCursor !== input.expectedCursor ||
      holder.controlOwner !== 'agent' ||
      holder.attentionRequestId !== null ||
      privacyState(device.privateInputEncrypted).active ||
      device.providerState === 'CLOSING'
    )
      throw new IPhoneError(409, 'Phone setup interaction changed');
    assertSetupProfile(state, input);
    const proof =
      input.action === 'verify'
        ? await setupEvidence(tx, setup.device, holder, state, input)
        : { evidence: [], digest: '' };
    const command = await createSetupJournal(
      tx,
      device,
      holder,
      state,
      input,
      inputHash,
      proof.digest
    );
    return {
      ...setup,
      state,
      lease: holder,
      command,
      execute: true as const,
      evidence: proof.evidence,
      evidenceDigest: proof.digest,
    };
  });
}
export type SetupClaim = Awaited<ReturnType<typeof claimSetup>>;

async function setupHolder(
  tx: Parameters<Parameters<typeof leases.transaction>[0]>[0],
  userId: string,
  taskId: string
) {
  const task = await tx.browserSession.findFirst({
    where: { id: taskId, context: { userId } },
    select: { agentId: true },
  });
  if (!task) throw new IPhoneError(404, 'Browser phone interaction not found');
  const device = await lockNativePhoneDevice(tx, userId, task.agentId);
  const holder = await tx.iPhoneLease.findFirst({
    where: {
      deviceId: device.id,
      browserTaskId: taskId,
      agentId: task.agentId,
      userId,
      status: 'ACTIVE',
    },
  });
  if (!holder) throw new IPhoneError(409, 'Native phone lease is not active');
  const current = await validateNativePhoneLease(
    tx,
    userId,
    task.agentId,
    { kind: 'iphone', browserTaskId: taskId, leaseId: holder.id },
    device.id,
    false
  );
  return { task, device, holder, current };
}

function assertSetupProfile(state: SetupState, input: SetupInput) {
  if (
    input.action === 'verify' &&
    requiresGoogleIdentity(input.verificationTarget) &&
    (state.expectedGoogleIdentity === undefined || state.expectedGoogleIdentity === '')
  )
    throw new IPhoneError(409, 'Phone Google setup profile is unavailable');
  if (
    input.action === 'verify' &&
    input.verificationTarget === 'google_passcode_exception' &&
    state.allowGooglePasscodeException !== true
  )
    throw new IPhoneError(409, 'Google passcode exception is not authorized');
  if (input.action === 'verify' && state.expectedAppleIdentity === undefined)
    throw new IPhoneError(409, 'Phone setup profile is unavailable');
  if (
    input.verificationTarget === 'receive_address' &&
    (state.expectedPhone === undefined || state.expectedPhone === null)
  )
    throw new IPhoneError(409, 'Phone receive address is unavailable');
}
