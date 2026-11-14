/** Owner device observation. Status runs the normal reconcile under the device lock but never
 * admits, extends or allocates a lease; frame reads take no lock and enter no command journal. */
import { prisma } from '../../providers/database';
import { openPhoneValue } from '../../providers/phoneHarnessCredentials';
import type { PhoneHarnessSession } from '../../providers/phoneHarness';
import * as leases from './repo';
import { permitted, TERMINAL_AGENT_STATUSES } from './config';
import { privacyState } from './privacy';
import { IPhoneError, PhoneDeviceUnavailable, type IPhoneDevice } from './types';

export interface DeviceStatus {
  enabled: boolean;
  setupState: string | null;
  providerState: string | null;
  holder: {
    agentId: string;
    leaseId: string;
    controlOwner: 'agent' | 'user';
    since: string;
  } | null;
  waiting: Array<{ agentId: string; leaseId: string; position: number; queueDeadlineAt: string }>;
}
const UNCONFIGURED: DeviceStatus = {
  enabled: false,
  setupState: null,
  providerState: null,
  holder: null,
  waiting: [],
};

export async function deviceStatus(userId: string): Promise<DeviceStatus> {
  return leases.transaction(async (tx) => {
    if (!(await leases.accountPermitted(tx, userId))) return UNCONFIGURED;
    const exists = await tx.iPhoneDevice.findUnique({ where: { userId }, select: { id: true } });
    if (exists === null) return UNCONFIGURED;
    // lockedDevice reconciles stale holders (paused/dead agents, bounded user holds).
    const { device, enabled } = await leases.lockedDevice(tx, userId);
    const holder = await tx.iPhoneLease.findFirst({
      where: { deviceId: device.id, status: 'ACTIVE' },
      select: { id: true, agentId: true, controlOwner: true, createdAt: true },
    });
    const waiting = await tx.iPhoneLease.findMany({
      where: {
        deviceId: device.id,
        status: 'WAITING',
        agent: { deletedAt: null, status: { notIn: [...TERMINAL_AGENT_STATUSES] } },
      },
      orderBy: { ticket: 'asc' },
      select: { id: true, agentId: true, queueDeadlineAt: true },
    });
    return {
      enabled,
      setupState: device.setupState,
      providerState: device.providerState,
      holder:
        holder === null
          ? null
          : {
              agentId: holder.agentId,
              leaseId: holder.id,
              controlOwner: holder.controlOwner === 'user' ? 'user' : 'agent',
              since: holder.createdAt.toISOString(),
            },
      waiting: waiting.map((lease, index) => ({
        agentId: lease.agentId,
        leaseId: lease.id,
        position: index + 1,
        queueDeadlineAt: lease.queueDeadlineAt.toISOString(),
      })),
    };
  });
}

function privateInput(device: IPhoneDevice): boolean {
  try {
    return privacyState(device.privateInputEncrypted).active;
  } catch {
    return true; // An unreadable privacy envelope fails closed.
  }
}

/** Owner snapshot of a READY session; a private phase is refused to internal callers only. */
export async function frameSnapshot(userId: string, owner = false) {
  if (!permitted(await prisma.user.findUnique({ where: { userId } })))
    throw new IPhoneError(403, 'iPhone access denied');
  const device = await prisma.iPhoneDevice.findUnique({ where: { userId } });
  if (device === null) throw new IPhoneError(404, 'iPhone device is not configured');
  if (!device.enabled) throw new IPhoneError(403, 'iPhone device is disabled');
  if (
    device.providerState !== 'READY' ||
    device.providerStartKey === null ||
    device.providerSessionEncrypted === null
  )
    throw new PhoneDeviceUnavailable(device.providerState, 'Phone session is not ready');
  if (!owner && privateInput(device))
    throw new PhoneDeviceUnavailable('private', 'Private input is active');
  const inFlight = await prisma.iPhoneOperation.findFirst({
    where: { deviceId: device.id, state: { in: ['CONNECTING', 'RUNNING'] } },
    select: { id: true },
  });
  if (inFlight !== null)
    throw new PhoneDeviceUnavailable('busy', 'A phone operation is in progress');
  return {
    deviceId: device.id,
    startKey: device.providerStartKey,
    providerEpoch: device.providerEpoch,
    session: openPhoneValue<PhoneHarnessSession>(device.providerSessionEncrypted),
  };
}

/** After the provider read: the same READY session generation, still not private. */
export async function frameStillValid(
  snapshot: Awaited<ReturnType<typeof frameSnapshot>>,
  owner = false
) {
  const device = await prisma.iPhoneDevice.findUnique({ where: { id: snapshot.deviceId } });
  if (device === null || !device.enabled) throw new IPhoneError(403, 'iPhone device is disabled');
  if (!owner && privateInput(device))
    throw new PhoneDeviceUnavailable('private', 'Private input is active');
  if (
    device.providerState !== 'READY' ||
    device.providerStartKey !== snapshot.startKey ||
    device.providerEpoch !== snapshot.providerEpoch
  )
    throw new PhoneDeviceUnavailable(device.providerState, 'Phone session changed');
}
