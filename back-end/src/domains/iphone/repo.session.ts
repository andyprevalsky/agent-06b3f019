/** Keyed provider-session state; all transitions commit under the device lock. */
import { createHash } from '../../providers/crypto';
import { sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import type { PhoneHarnessSession } from '../../providers/phoneHarness';
import type { Transaction } from './types';
import * as leases from './repo';

async function rawLock(tx: Transaction, deviceId: string) {
  await tx.$queryRaw`SELECT id FROM "IPhoneDevice" WHERE id = ${deviceId} FOR UPDATE`;
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

export async function confirmCleanup(deviceId: string, key: string, retainedCommandId?: string) {
  return leases.transaction(async (tx) => {
    await rawLock(tx, deviceId);
    const device = await tx.iPhoneDevice.findUniqueOrThrow({ where: { id: deviceId } });
    if (device.providerStartKey !== key) return false;
    await tx.iPhoneOperation.updateMany({
      where: {
        deviceId,
        OR: [{ activeDeviceId: deviceId }, { state: { in: ['CONNECTING', 'RUNNING'] } }],
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

/** Quarantine the current key before a session-expiry stop; recovery owns rotation. */
export async function closeSessionForRefresh(deviceId: string, key: string) {
  return leases.transaction(async (tx) => {
    await rawLock(tx, deviceId);
    await tx.iPhoneDevice.updateMany({
      where: { id: deviceId, providerStartKey: key },
      data: { providerState: 'CLOSING' },
    });
  });
}
