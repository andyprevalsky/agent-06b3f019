/** Caller owns device lock. Only the active exact task can see the configured identity. */
import {
  setupState,
  sealSetup,
  setupIdentity,
  type SetupState,
} from '../../providers/phoneSetupState';
import type { Transaction, IPhoneDevice, IPhoneLease } from './types';
import { databaseNow } from './repo.clock';

export function setupDto(device: IPhoneDevice, state: SetupState, lease: IPhoneLease) {
  const active =
    lease.status === 'ACTIVE' &&
    lease.releaseRequestedAt === null &&
    state.attempt?.leaseId === lease.id &&
    state.attempt.taskId === lease.browserTaskId;
  const required =
    device.setupState !== 'ready' ||
    state.verified?.profileRevision !== state.profileRevision ||
    state.expectedAppleIdentity === undefined;
  return {
    required,
    state: device.setupState,
    attemptId: active ? state.attempt!.id : null,
    revision: active ? state.attempt!.revision : state.claimRevision,
    profileRevision: state.profileRevision,
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
  const generation = agent?.temporalWorkflowId ?? agent?.id;
  if (
    lease.status === 'ACTIVE' &&
    lease.releaseRequestedAt === null &&
    lease.browserTaskId !== null &&
    (state.attempt?.leaseId !== lease.id ||
      state.attempt.workflowId !== generation ||
      state.attempt.taskId !== lease.browserTaskId)
  ) {
    const now = await databaseNow(tx);
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
    const ready =
      device.setupState === 'ready' &&
      state.verified?.profileRevision === state.profileRevision &&
      Boolean(state.expectedAppleIdentity);
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
  return { device, state, dto: setupDto(device, state, lease) };
}
