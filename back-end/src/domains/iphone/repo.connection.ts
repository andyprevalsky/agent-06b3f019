/** Device-locked, owner-scoped reservation; no workflow/provider IO inside transactions. */
import { prisma } from '../../providers/database';
import { setupState, sealSetup, type SetupState } from '../../providers/phoneSetupState';
import {
  connectionDto,
  connectionKey,
  connectionVerification,
  currentConnection,
  reserveConnection,
  type PhoneConnection,
  type PhoneConnectionReservation,
} from '../../providers/phoneConnectionState';
import { setupProgress } from '../../providers/phoneSetupVerification';
import { resumedPrivacy } from './privacy';
import * as leases from './repo';
import { accessRequested } from './repo.accessRequest';
import { IPhoneError, type IPhoneDevice, type Transaction } from './types';

// A paused setup agent is not driving setup (and no longer holds the phone), so it must not
// pin the connection at setting_up: Connect starts a fresh setup agent instead.
const inactive = ['COMPLETED', 'FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED', 'PAUSED'];
async function activeSetup(tx: Transaction, userId: string, id: string | undefined) {
  if (id === undefined || id === '') return false;
  const agent = await tx.agent.findUnique({
    where: { id },
    select: { status: true, userId: true, deletedAt: true },
  });
  if (agent && agent.userId !== userId)
    throw new IPhoneError(409, 'iPhone setup agent is unavailable');
  // The encrypted reservation is committed before normal creation starts.
  if (agent === null) return true;
  // An owner-deleted setup agent is an ended setup: Connect starts a fresh one.
  return agent.deletedAt === null && !inactive.includes(agent.status);
}
/** Connection screen projection: stored checks as ordered steps plus the setup browser task. */
async function withProgress(
  tx: Transaction,
  userId: string,
  dto: PhoneConnection,
  device: IPhoneDevice | null,
  state: SetupState | null
) {
  const requested = await accessRequested(tx, userId);
  if (dto.status === 'not_connected' || device === null || state === null)
    return { ...dto, accessRequested: requested, setupProgress: null, setupTaskId: null };
  const task =
    dto.setupAgentId === null
      ? null
      : await tx.browserSession.findFirst({
          where: { agentId: dto.setupAgentId, context: { userId } },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
  return {
    ...dto,
    accessRequested: requested,
    setupProgress: setupProgress(connectionVerification(device, state), {
      status: dto.status,
      setupState: device.setupState,
      providerState: device.providerState,
      passcodeExceptionAllowed: state.allowGooglePasscodeException === true,
    }),
    setupTaskId: task?.id ?? null,
  };
}
export async function connection(userId: string) {
  return leases.transaction(async (tx) => {
    const permitted = await leases.accountPermitted(tx, userId);
    const device = await tx.iPhoneDevice.findUnique({ where: { userId } });
    if (!permitted || device?.enabled !== true)
      return withProgress(tx, userId, connectionDto(device, null, permitted, false), null, null);
    const state = setupState(device.setupEncrypted);
    const dto = connectionDto(device, state, permitted, false);
    const owner = await tx.user.findUniqueOrThrow({ where: { userId }, select: { phone: true } });
    if (state.expectedPhone !== owner.phone)
      return withProgress(tx, userId, { ...dto, status: 'not_connected' }, device, state);
    // A committed device attestation outlives its setup conversation. Only
    // pending setup requires that reservation's actor to remain available.
    if (dto.status === 'ready') return withProgress(tx, userId, dto, device, state);
    return withProgress(
      tx,
      userId,
      connectionDto(
        device,
        state,
        permitted,
        await activeSetup(tx, userId, currentConnection(state)?.agentId)
      ),
      device,
      state
    );
  });
}
export async function reserve(userId: string, expectedRevision: number, requestKey: string) {
  return leases.transaction(async (tx) => {
    if (!(await leases.accountPermitted(tx, userId)))
      throw new IPhoneError(403, 'iPhone access denied');
    const { device, enabled } = await leases.lockedDevice(tx, userId);
    if (!enabled) throw new IPhoneError(403, 'iPhone access denied');
    const state = setupState(device.setupEncrypted);
    const owner = await tx.user.findUniqueOrThrow({ where: { userId }, select: { phone: true } });
    if (state.expectedPhone !== undefined && state.expectedPhone !== owner.phone)
      throw new IPhoneError(409, 'iPhone setup account configuration changed');
    state.expectedPhone = owner.phone;
    const dto = connectionDto(device, state, true, false);
    if (dto.status === 'ready') {
      if (
        currentConnection(state)?.requestKeyHash !== connectionKey(requestKey) &&
        dto.connectionRevision !== expectedRevision
      )
        throw new IPhoneError(409, 'iPhone connection changed');
      return { dto, reservation: null, deviceId: device.id };
    }
    const active = await activeSetup(tx, userId, currentConnection(state)?.agentId);
    const result = reserveConnection(
      state,
      userId,
      device.id,
      expectedRevision,
      requestKey,
      active
    );
    if (!result.reused) {
      // Connect is the owner's explicit hand-off of the phone to setup, so it resumes a private
      // phase left by an ended session (known values stay for redaction). While any lease still
      // holds the phone or an operation (including an UNKNOWN private input) keeps device
      // custody, the phase is left alone.
      const holder = await tx.iPhoneLease.findFirst({
        where: { deviceId: device.id, status: 'ACTIVE' },
        select: { id: true },
      });
      const custody = await tx.iPhoneOperation.findUnique({
        where: { activeDeviceId: device.id },
        select: { id: true },
      });
      await tx.iPhoneDevice.update({
        where: { id: device.id },
        data: {
          setupEncrypted: sealSetup(state),
          setupState: 'not_started',
          ...(holder === null && custody === null
            ? { privateInputEncrypted: resumedPrivacy(device.privateInputEncrypted) }
            : {}),
        },
      });
    }
    return {
      dto: connectionDto({ ...device, setupState: 'not_started' }, state, true, true),
      reservation: result.reservation,
      deviceId: device.id,
    };
  });
}
export async function ownedSetupAgent(userId: string, id: string) {
  return prisma.agent.findFirst({ where: { id, userId, deletedAt: null } });
}

/** Bind the actual normal workflow only after its trusted start/resume returned. */
export async function recordSetupStart(userId: string, reservation: PhoneConnectionReservation) {
  return leases.transaction(async (tx) => {
    const { device, enabled } = await leases.lockedDevice(tx, userId);
    const state = setupState(device.setupEncrypted);
    const current = currentConnection(state);
    if (
      !enabled ||
      current?.agentId !== reservation.agentId ||
      current.revision !== reservation.revision ||
      current.requestKeyHash !== reservation.requestKeyHash
    )
      throw new IPhoneError(409, 'iPhone connection changed');
    const agent = await tx.agent.findFirst({
      where: { id: current.agentId, userId, deletedAt: null },
    });
    if (
      !agent ||
      agent.temporalWorkflowStartPending ||
      agent.temporalWorkflowId === null ||
      agent.temporalWorkflowId === '' ||
      agent.temporalFirstExecutionRunId === null ||
      agent.temporalFirstExecutionRunId === ''
    )
      throw new IPhoneError(409, 'iPhone setup workflow is not ready');
    if (
      current.firstExecutionRunId !== undefined &&
      current.firstExecutionRunId !== '' &&
      current.firstExecutionRunId !== agent.temporalFirstExecutionRunId
    )
      throw new IPhoneError(409, 'iPhone setup workflow generation changed');
    current.workflowId = agent.temporalWorkflowId;
    current.firstExecutionRunId = agent.temporalFirstExecutionRunId;
    await tx.iPhoneDevice.update({
      where: { id: device.id },
      data: { setupEncrypted: sealSetup(state) },
    });
  });
}
