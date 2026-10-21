/** Caller owns device lock. Only the active exact task can see the configured identity. */
import {
  setupState,
  sealSetup,
  setupIdentity,
  type SetupState,
} from '../../providers/phoneSetupState';
import type { Transaction, IPhoneDevice, IPhoneLease } from './types';
import { verificationDto } from '../../providers/phoneSetupVerification';
import { databaseNow } from './repo.clock';

export function setupDto(device: IPhoneDevice, state: SetupState, lease: IPhoneLease) {
  const active =
    lease.status === 'ACTIVE' &&
    lease.releaseRequestedAt === null &&
    state.attempt?.leaseId === lease.id &&
    state.attempt.taskId === lease.browserTaskId;
  const verification = verificationDto(state.verification, {
    attemptId: state.attempt?.id,
    profileRevision: state.profileRevision,
    workflowId: state.attempt?.workflowId,
    providerEpoch: device.providerEpoch,
    expectedPhone: state.expectedPhone ?? null,
    expectedGoogleIdentity: state.expectedGoogleIdentity,
    allowGooglePasscodeException: state.allowGooglePasscodeException,
    floorAt: state.attempt?.floorAt,
    floorCursor: state.attempt?.floorCursor,
  });
  const required =
    !verification.configurationReady ||
    device.setupState !== 'ready' ||
    state.verified?.profileRevision !== state.profileRevision ||
    state.expectedAppleIdentity === undefined;
  return {
    required,
    state: device.setupState,
    attemptId: active ? state.attempt!.id : null,
    revision: active ? state.attempt!.revision : state.claimRevision,
    profileRevision: state.profileRevision,
    ...(active && state.allowGooglePasscodeException === true
      ? { googlePasscodeExceptionAllowed: true }
      : {}),
    identityVerified: state.verified?.profileRevision === state.profileRevision,
    ...(active && state.expectedGoogleIdentity !== undefined
      ? { expectedGoogleAccountIdentifier: state.expectedGoogleIdentity }
      : {}),
    verification: {
      ...verification,
      ...(active && state.expectedPhone !== undefined && state.expectedPhone !== null
        ? { expectedReceiveAddress: state.expectedPhone }
        : {}),
    },
    ...(active && required && state.expectedAppleIdentity !== undefined
      ? { expectedAccountIdentifier: state.expectedAppleIdentity }
      : {}),
    ...(active && state.attempt?.reasonCode !== undefined
      ? { reasonCode: state.attempt.reasonCode }
      : {}),
    ...(state.verified ? { lastVerifiedAt: state.verified.at } : {}),
    ...(active && state.attempt?.lastRequest ? { lastRequest: state.attempt.lastRequest } : {}),
  };
}
export async function ensureSetup(tx: Transaction, deviceId: string, lease: IPhoneLease) {
  let device = await tx.iPhoneDevice.findUniqueOrThrow({ where: { id: deviceId } });
  const state = setupState(device.setupEncrypted);
  const agent =
    lease.status === 'ACTIVE' ? await tx.agent.findUnique({ where: { id: lease.agentId } }) : null;
  const owner =
    lease.status === 'ACTIVE'
      ? await tx.user.findUnique({ where: { userId: lease.userId }, select: { phone: true } })
      : null;
  const expectedPhone = owner?.phone ?? null;
  const generation = agent?.temporalWorkflowId ?? agent?.id;
  if (
    lease.status === 'ACTIVE' &&
    lease.releaseRequestedAt === null &&
    lease.browserTaskId !== null &&
    (state.attempt?.leaseId !== lease.id ||
      state.attempt.workflowId !== generation ||
      state.attempt.taskId !== lease.browserTaskId ||
      state.expectedPhone !== expectedPhone)
  ) {
    const now = await databaseNow(tx);
    state.expectedPhone = expectedPhone;
    state.claimRevision++;
    state.attempt = {
      id: setupIdentity(lease.id, state.claimRevision),
      revision: state.claimRevision,
      leaseId: lease.id,
      taskId: lease.browserTaskId,
      agentId: lease.agentId,
      workflowId: generation!,
      floorCursor: lease.actionCursor,
      floorAt: now.toISOString(),
      ...(state.expectedAppleIdentity === undefined
        ? { reasonCode: 'configuration_unavailable' }
        : {}),
    };
    const ready = false;
    device = await tx.iPhoneDevice.update({
      where: { id: device.id },
      data: {
        setupEncrypted: sealSetup(state),
        setupState: ready
          ? 'ready'
          : state.expectedAppleIdentity !== undefined
            ? 'in_progress'
            : 'blocked',
      },
    });
  }
  if (
    device.setupState === 'ready' &&
    !setupDto(device, state, lease).verification.configurationReady
  ) {
    device = await tx.iPhoneDevice.update({
      where: { id: device.id },
      data: { setupState: 'in_progress' },
    });
  }
  return { device, state, dto: setupDto(device, state, lease) };
}
