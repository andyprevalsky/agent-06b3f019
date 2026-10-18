/** Per-device command slot. Provider calls happen only after this transaction commits. */
import { createHash } from '../../providers/crypto';
import { sealPhoneValue, phoneCommandHash } from '../../providers/phoneHarnessCredentials';
import type { PhoneHarnessSession } from '../../providers/phoneHarness';
import * as leases from './repo';
import { LEASE_TIMEOUT_MS } from './config';
import { IPhoneError, type Transaction } from './types';
import type { CommandClaim, PhoneActor, PhoneCommand } from './types.operations';

const READ_OPERATIONS = new Set([
  'screen.text',
  'screen.text_pixels',
  'screen.bounds',
  'session.state',
  'apps.current',
  'apps.list',
  'tree',
]);
export function isPhoneRead(operation: string): boolean {
  return READ_OPERATIONS.has(operation);
}

async function rawLock(tx: Transaction, deviceId: string) {
  await tx.$queryRaw`SELECT id FROM "IPhoneDevice" WHERE id = ${deviceId} FOR UPDATE`;
}

export async function claimCommand(
  userId: string,
  leaseId: string,
  input: PhoneCommand,
  actor: PhoneActor
): Promise<CommandClaim> {
  const result = await leases.transaction(async (tx) => {
    if ((await leases.readLease(tx, leaseId, userId)) === null)
      return new IPhoneError(404, 'Lease not found');
    const { device, enabled } = await leases.lockedDevice(tx, userId);
    if (!enabled) return new IPhoneError(403, 'iPhone access denied');
    const lease = await leases.readLease(tx, leaseId, userId);
    if (lease === null || lease.status !== 'ACTIVE' || lease.releaseRequestedAt !== null)
      return new IPhoneError(409, 'The phone is not reserved for this interaction');
    if (lease.controlOwner !== actor)
      return new IPhoneError(409, 'Phone control belongs to the other participant');
    const inputHash = phoneCommandHash(input.operation, input.args, actor);
    const existing = await tx.iPhoneOperation.findUnique({
      where: { leaseId_requestKey: { leaseId, requestKey: input.operationId } },
    });
    if (existing !== null) {
      if (existing.inputHash !== inputHash)
        return new IPhoneError(409, 'Operation identity cannot be reused with different input');
      return { device, lease, command: existing, execute: existing.state === 'CONNECTING' };
    }
    const active = await tx.iPhoneOperation.findUnique({ where: { activeDeviceId: device.id } });
    if (active !== null && !isPhoneRead(input.operation))
      return new IPhoneError(409, 'A previous phone command is still running or unconfirmed');
    const now = await leases.databaseNow(tx);
    const command = await tx.iPhoneOperation.create({
      data: {
        deviceId: device.id,
        leaseId,
        requestKey: input.operationId,
        operation: input.operation,
        actor,
        inputHash,
        requestEncrypted: sealPhoneValue({ operation: input.operation, args: input.args, actor }),
        activeDeviceId: active === null ? device.id : null,
        providerEpoch: device.providerEpoch,
        deadlineAt: new Date(now.getTime() + 300_000),
      },
    });
    return { device, lease, command, execute: true };
  });
  if (result instanceof IPhoneError) throw result;
  return result;
}

/** Exactly one request may cross from connection recovery into physical execution. */
export async function beginExecution(claim: CommandClaim): Promise<boolean> {
  return leases.transaction(async (tx) => {
    await rawLock(tx, claim.device.id);
    const device = await tx.iPhoneDevice.findUniqueOrThrow({ where: { id: claim.device.id } });
    const lease = await tx.iPhoneLease.findUnique({ where: { id: claim.lease.id } });
    if (
      lease === null ||
      lease.status !== 'ACTIVE' ||
      lease.releaseRequestedAt !== null ||
      lease.controlOwner !== claim.command.actor ||
      !device.enabled ||
      !(await leases.accountPermitted(tx, lease.userId))
    )
      return false;
    const changed = await tx.iPhoneOperation.updateMany({
      where: {
        id: claim.command.id,
        state: 'CONNECTING',
        deadlineAt: { gt: await leases.databaseNow(tx) },
      },
      data: { state: 'RUNNING' },
    });
    return changed.count === 1;
  });
}

export async function finishCommand(
  claim: CommandClaim,
  state: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN',
  value: unknown,
  errorCode?: string
) {
  const resultEncrypted = sealPhoneValue(value);
  return leases.transaction(async (tx) => {
    await rawLock(tx, claim.device.id);
    const now = await leases.databaseNow(tx);
    await tx.iPhoneOperation.updateMany({
      where: { id: claim.command.id, state: { in: ['CONNECTING', 'RUNNING'] } },
      data: {
        state,
        resultEncrypted,
        errorCode,
        completedAt: now,
        ...(state !== 'UNKNOWN' ? { activeDeviceId: null } : {}),
      },
    });
    await tx.iPhoneLease.updateMany({
      where: { id: claim.lease.id, status: 'ACTIVE' },
      data: { leaseExpiresAt: new Date(now.getTime() + LEASE_TIMEOUT_MS) },
    });
    return tx.iPhoneOperation.findUniqueOrThrow({ where: { id: claim.command.id } });
  });
}

export async function ownedCommand(userId: string, leaseId: string, operationId: string) {
  return leases.transaction(async (tx) => {
    if ((await leases.readLease(tx, leaseId, userId)) === null)
      throw new IPhoneError(404, 'Lease not found');
    await leases.lockedDevice(tx, userId);
    return tx.iPhoneOperation.findUnique({
      where: { leaseId_requestKey: { leaseId, requestKey: operationId } },
    });
  });
}

export async function reserveSession(deviceId: string) {
  return leases.transaction(async (tx) => {
    await rawLock(tx, deviceId);
    let device = await tx.iPhoneDevice.findUniqueOrThrow({ where: { id: deviceId } });
    if (device.providerStartKey === null) {
      const key = createHash('sha256').update(`${device.id}:${device.providerEpoch}`).digest('hex');
      device = await tx.iPhoneDevice.update({
        where: { id: deviceId },
        data: { providerStartKey: key, providerState: 'STARTING' },
      });
    }
    return device;
  });
}

export async function saveSession(deviceId: string, key: string, session: PhoneHarnessSession) {
  const encrypted = sealPhoneValue(session);
  return leases.transaction(async (tx) => {
    await rawLock(tx, deviceId);
    const changed = await tx.iPhoneDevice.updateMany({
      where: { id: deviceId, providerStartKey: key, providerState: { not: 'CLOSING' } },
      data: {
        providerSessionId: session.id,
        providerSessionEncrypted: encrypted,
        providerState: session.state === 'ready' ? 'READY' : 'STARTING',
      },
    });
    return changed.count === 1;
  });
}

export async function cleanupCandidate(userId: string) {
  return leases.transaction(async (tx) => {
    const { device } = await leases.lockedDevice(tx, userId);
    const operation = await tx.iPhoneOperation.findUnique({ where: { activeDeviceId: device.id } });
    if (operation === null) return null;
    const lease = await tx.iPhoneLease.findUnique({ where: { id: operation.leaseId } });
    const now = await leases.databaseNow(tx);
    if (lease?.releaseRequestedAt === null && operation.deadlineAt > now) return null;
    await tx.iPhoneDevice.update({ where: { id: device.id }, data: { providerState: 'CLOSING' } });
    return { device, operation, lease };
  });
}

export async function confirmCleanup(deviceId: string, key: string, retainedCommandId?: string) {
  return leases.transaction(async (tx) => {
    await rawLock(tx, deviceId);
    const device = await tx.iPhoneDevice.findUniqueOrThrow({ where: { id: deviceId } });
    if (device.providerStartKey !== key) return false;
    await tx.iPhoneOperation.updateMany({
      where: {
        deviceId,
        activeDeviceId: deviceId,
        ...(retainedCommandId === undefined ? {} : { id: { not: retainedCommandId } }),
      },
      data: {
        state: 'UNKNOWN',
        activeDeviceId: null,
        completedAt: await leases.databaseNow(tx),
        errorCode: 'provider_session_ended',
      },
    });
    await tx.iPhoneDevice.update({
      where: { id: deviceId },
      data: {
        providerState: 'IDLE',
        providerStartKey: null,
        providerSessionId: null,
        providerSessionEncrypted: null,
        providerEpoch: { increment: 1 },
      },
    });
    if (retainedCommandId !== undefined)
      await tx.iPhoneOperation.updateMany({
        where: { id: retainedCommandId, deviceId, state: 'CONNECTING' },
        data: { providerEpoch: device.providerEpoch + 1 },
      });
    return true;
  });
}

export async function confirmUnstartedCleanup(deviceId: string, operationId: string) {
  return leases.transaction(async (tx) => {
    await rawLock(tx, deviceId);
    const device = await tx.iPhoneDevice.findUniqueOrThrow({ where: { id: deviceId } });
    if (device.providerStartKey !== null) return false;
    await tx.iPhoneOperation.updateMany({
      where: { id: operationId, deviceId, state: 'CONNECTING' },
      data: { state: 'FAILED', activeDeviceId: null, errorCode: 'cancelled_before_connection' },
    });
    await tx.iPhoneDevice.update({ where: { id: deviceId }, data: { providerState: 'IDLE' } });
    return true;
  });
}

export async function deviceExists(userId: string) {
  return leases.transaction((tx) =>
    tx.iPhoneDevice.findUnique({
      where: { userId },
      select: { id: true },
    })
  );
}
