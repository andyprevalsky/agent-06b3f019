/** Owner-scoped shared credential selection; no caller secret/ref/realm. */
import { openPhoneValue } from '../../providers/phoneHarnessCredentials';
import { setupState } from '../../providers/phoneSetupState';
import { privacyState, rememberPrivate, resumedPrivacy, internalPhoneObservation } from './privacy';
import { executionCustody } from './repo.executionCustody';
import * as leases from './repo';
import { IPhoneError } from './types';
import type { CommandClaim } from './types.operations';
import { selectedPassword } from '../../providers/phoneSavedPassword';
export async function savedBinding(
  claim: CommandClaim,
  bounds: { x: number; y: number; w: number; h: number },
  preserveConfiguredIdentities = true
) {
  return leases.transaction(async (tx) => {
    const { device } = await leases.lockedDevice(tx, claim.lease.userId);
    const lease = await tx.iPhoneLease.findUniqueOrThrow({ where: { id: claim.lease.id } });
    if (
      !(await executionCustody(tx, claim, device, lease)) ||
      lease.controlOwner !== 'agent' ||
      lease.attentionRequestId !== null ||
      lease.actionCursor !== claim.command.cursor
    )
      throw new IPhoneError(409, 'phone_credential_binding_required');
    const state = setupState(device.setupEncrypted);
    if (
      state.expectedAppleIdentity === undefined ||
      state.expectedAppleIdentity === '' ||
      !state.attempt ||
      state.attempt.id === undefined ||
      device.providerEpoch !== claim.command.providerEpoch
    )
      throw new IPhoneError(409, 'phone_credential_binding_required');
    const read = await tx.iPhoneOperation.findFirst({
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
    if (
      read?.resultEncrypted === null ||
      read?.resultEncrypted === undefined ||
      read.completedAt === null ||
      read.cursor <= state.attempt.floorCursor ||
      read.completedAt.getTime() < new Date(state.attempt.floorAt).getTime() ||
      now.getTime() - read.completedAt.getTime() > 60_000
    )
      throw new IPhoneError(409, 'phone_credential_binding_required');
    const intent = openPhoneValue<{ setupAttemptId?: string; setupRevision?: number }>(
      read.requestEncrypted
    );
    if (
      intent.setupAttemptId !== state.attempt.id ||
      intent.setupRevision !== state.attempt.revision
    )
      throw new IPhoneError(409, 'phone_credential_binding_required');
    return {
      state,
      evidence: [
        {
          operationId: read.requestKey,
          cursor: read.cursor,
          result: internalPhoneObservation(
            read,
            openPhoneValue(read.resultEncrypted),
            device.privateInputEncrypted,
            preserveConfiguredIdentities ? state : {}
          ),
        },
      ],
      bounds,
    };
  });
}
export async function prepareSavedPassword(
  claim: CommandClaim,
  binding: Awaited<ReturnType<typeof savedBinding>>,
  credentialRealm: 'apple' | 'google' = 'apple'
) {
  return leases.transaction(async (tx) => {
    const { device, enabled } = await leases.lockedDevice(tx, claim.lease.userId);
    const lease = await tx.iPhoneLease.findUniqueOrThrow({ where: { id: claim.lease.id } });
    const state = setupState(device.setupEncrypted);
    if (
      !enabled ||
      !(await executionCustody(tx, claim, device, lease)) ||
      lease.status !== 'ACTIVE' ||
      lease.releaseRequestedAt !== null ||
      lease.controlOwner !== 'agent' ||
      lease.attentionRequestId !== null ||
      lease.actionCursor !== claim.command.cursor ||
      device.providerEpoch !== claim.command.providerEpoch ||
      state.profileRevision !== binding.state.profileRevision ||
      state.expectedAppleIdentity !== binding.state.expectedAppleIdentity ||
      state.expectedGoogleIdentity !== binding.state.expectedGoogleIdentity ||
      state.attempt?.revision !== binding.state.attempt?.revision ||
      privacyState(device.privateInputEncrypted).active
    )
      throw new IPhoneError(409, 'phone_credential_binding_required');
    const now = await leases.databaseNow(tx);
    const command = await tx.iPhoneOperation.findUniqueOrThrow({ where: { id: claim.command.id } });
    if (
      command.state !== 'CONNECTING' ||
      command.deadlineAt <= now ||
      command.activeDeviceId !== device.id ||
      device.providerState === 'CLOSING'
    )
      throw new IPhoneError(409, 'phone_credential_binding_required');
    const identity =
      credentialRealm === 'apple' ? state.expectedAppleIdentity : state.expectedGoogleIdentity;
    if (identity === undefined || identity === '')
      throw new IPhoneError(409, 'phone_credential_binding_required');
    const password = await selectedPassword(tx, lease.userId, identity, credentialRealm);
    await tx.iPhoneDevice.update({
      where: { id: device.id },
      data: { privateInputEncrypted: rememberPrivate(device.privateInputEncrypted, password) },
    });
    await tx.iPhoneOperation.update({ where: { id: command.id }, data: { state: 'RUNNING' } });
    return password;
  });
}
export async function resumeSavedPrivacy(claim: CommandClaim) {
  return leases.transaction(async (tx) => {
    const { device, enabled } = await leases.lockedDevice(tx, claim.lease.userId);
    const lease = await tx.iPhoneLease.findUniqueOrThrow({ where: { id: claim.lease.id } });
    const agent = await tx.agent.findUnique({ where: { id: lease.agentId } });
    if (
      enabled &&
      lease.status === 'ACTIVE' &&
      lease.controlOwner === 'agent' &&
      lease.attentionRequestId === null &&
      lease.actionCursor === claim.command.cursor &&
      device.providerEpoch === claim.command.providerEpoch &&
      (agent?.temporalWorkflowId ?? agent?.id) === claim.executionGeneration
    )
      await tx.iPhoneDevice.update({
        where: { id: device.id },
        data: { privateInputEncrypted: resumedPrivacy(device.privateInputEncrypted) },
      });
  });
}
