/** Device-locked, owner-scoped reservation; no workflow/provider IO inside transactions. */
import { prisma } from '../../providers/database';
import { setupState, sealSetup } from '../../providers/phoneSetupState';
import {
  connectionDto,
  connectionKey,
  currentConnection,
  reserveConnection,
  type PhoneConnectionReservation,
} from '../../providers/phoneConnectionState';
import * as leases from './repo';
import { configurationGenerationCurrent } from './repo.availability';
import { IPhoneError, type Transaction } from './types';

const terminal = ['COMPLETED', 'FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED'];
async function activeSetup(tx: Transaction, userId: string, id: string | undefined) {
  if (id === undefined || id === '') return false;
  const agent = await tx.agent.findUnique({
    where: { id },
    select: { status: true, userId: true, deletedAt: true },
  });
  if (agent && (agent.userId !== userId || agent.deletedAt !== null))
    throw new IPhoneError(409, 'iPhone setup agent is unavailable');
  // The encrypted reservation is committed before normal creation starts.
  return agent === null || !terminal.includes(agent.status);
}
export async function connection(userId: string) {
  return leases.transaction(async (tx) => {
    const permitted = await leases.accountPermitted(tx, userId);
    const device = await tx.iPhoneDevice.findUnique({ where: { userId } });
    if (!permitted || device?.enabled !== true)
      return connectionDto(device, null, permitted, false);
    const state = setupState(device.setupEncrypted);
    const dto = connectionDto(
      device,
      state,
      permitted,
      await activeSetup(tx, userId, currentConnection(state)?.agentId)
    );
    const owner = await tx.user.findUniqueOrThrow({ where: { userId }, select: { phone: true } });
    if (
      state.expectedPhone !== owner.phone ||
      (dto.status === 'ready' && !(await configurationGenerationCurrent(tx, userId, state)))
    )
      return { ...dto, status: 'not_connected' as const };
    return dto;
  });
}
export async function reserve(userId: string, expectedRevision: number, requestKey: string) {
  return leases.transaction(async (tx) => {
    const { device, enabled } = await leases.lockedDevice(tx, userId);
    if (!enabled || !(await leases.accountPermitted(tx, userId)))
      throw new IPhoneError(403, 'iPhone access denied');
    const state = setupState(device.setupEncrypted);
    const owner = await tx.user.findUniqueOrThrow({ where: { userId }, select: { phone: true } });
    if (state.expectedPhone !== undefined && state.expectedPhone !== owner.phone)
      throw new IPhoneError(409, 'iPhone setup account configuration changed');
    state.expectedPhone = owner.phone;
    const active = await activeSetup(tx, userId, currentConnection(state)?.agentId);
    const dto = connectionDto(device, state, true, active);
    if (dto.status === 'ready' && (await configurationGenerationCurrent(tx, userId, state))) {
      if (
        currentConnection(state)?.requestKeyHash !== connectionKey(requestKey) &&
        dto.connectionRevision !== expectedRevision
      )
        throw new IPhoneError(409, 'iPhone connection changed');
      return { dto, reservation: null, deviceId: device.id };
    }
    const result = reserveConnection(
      state,
      userId,
      device.id,
      expectedRevision,
      requestKey,
      active
    );
    if (!result.reused)
      await tx.iPhoneDevice.update({
        where: { id: device.id },
        data: {
          setupEncrypted: sealSetup(state),
          setupState: 'not_started',
        },
      });
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
