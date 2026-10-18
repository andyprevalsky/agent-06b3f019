/** Durable browser-task interaction discovery, independent of the current worker. */
import { prisma } from '../../providers/database';
import { createHash } from '../../providers/crypto';
import * as leases from './repo';
import { IPhoneError, type Transaction } from './types';

export async function requireBrowserTask(userId: string, taskId: string) {
  const task = await prisma.browserSession.findFirst({
    where: { id: taskId, context: { userId } },
    select: { id: true, agentId: true },
  });
  if (task === null) throw new IPhoneError(404, 'Browser task not found');
  const agent = await prisma.agent.findFirst({
    where: { id: task.agentId, userId },
    select: { id: true },
  });
  if (agent === null) throw new IPhoneError(404, 'Browser task not found');
  const device = await leases.capabilityData(userId);
  if (device === null || !device.enabled) throw new IPhoneError(403, 'iPhone access denied');
  return { ...task, deviceId: device.id };
}

/** Unused browser tasks must not join the physical phone's serialization path. */
export async function hasInteraction(deviceId: string, taskId: string): Promise<boolean> {
  return (
    (await prisma.iPhoneLease.findFirst({
      where: { deviceId, browserTaskId: taskId },
      select: { id: true },
    })) !== null
  );
}

async function interactionView(tx: Transaction, leaseId: string | null) {
  if (leaseId === null) return null;
  const view = await leases.view(tx, leaseId);
  const lastOperation =
    view.lease.lastOperationId === null
      ? null
      : await tx.iPhoneOperation.findFirst({
          where: { id: view.lease.lastOperationId, leaseId },
        });
  const pending = await tx.iPhoneOperation.findUnique({
    where: { activeDeviceId: view.lease.deviceId },
  });
  return {
    ...view,
    lastOperation,
    pendingOperation:
      pending?.leaseId === leaseId && pending.operation !== 'screen.frame' ? pending : null,
  };
}

export async function readInteraction(userId: string, taskId: string) {
  return leases.transaction(async (tx) => {
    const { device, enabled } = await leases.lockedDevice(tx, userId);
    if (!enabled) return new IPhoneError(403, 'iPhone access denied');
    await leases.admit(tx, device.id);
    const latest = await tx.iPhoneLease.findFirst({
      where: { deviceId: device.id, browserTaskId: taskId },
      orderBy: { ticket: 'desc' },
      select: { id: true },
    });
    return interactionView(tx, latest?.id ?? null);
  });
}

export async function ensureInteraction(
  userId: string,
  taskId: string,
  agentId: string,
  requestKey: string
) {
  return leases.transaction(async (tx) => {
    const { device, enabled } = await leases.lockedDevice(tx, userId);
    if (!enabled) return new IPhoneError(403, 'iPhone access denied');
    const old = await tx.iPhoneAcquireIntent.findUnique({
      where: {
        deviceId_browserTaskId_requestKey: {
          deviceId: device.id,
          browserTaskId: taskId,
          requestKey,
        },
      },
    });
    if (old !== null) return interactionView(tx, old.leaseId);
    const live = await tx.iPhoneLease.findFirst({
      where: { deviceId: device.id, browserTaskId: taskId, status: { in: ['ACTIVE', 'WAITING'] } },
      orderBy: { ticket: 'asc' },
      select: { id: true },
    });
    const identity = createHash('sha256')
      .update(JSON.stringify([taskId, requestKey]))
      .digest('hex');
    const id =
      live?.id ??
      (await leases.enqueue(tx, device, {
        agentId,
        browserTaskId: taskId,
        requestKey: `interaction:${identity}`,
      }));
    if (id instanceof IPhoneError) return id;
    await tx.iPhoneAcquireIntent.create({
      data: { deviceId: device.id, browserTaskId: taskId, requestKey, leaseId: id },
    });
    await leases.admit(tx, device.id);
    return interactionView(tx, id);
  });
}
