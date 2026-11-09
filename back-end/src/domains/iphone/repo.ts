/** Durable admission: device FOR UPDATE -> reconcile -> mutate -> FIFO admit.
 * Every process uses this lock order. Transactions perform database I/O only. */
import { accountPermitted } from './repo.account';
export { accountPermitted } from './repo.account';
import { ensureSetup } from './repo.setup';
import { availabilityInTransaction } from './repo.availability';
import { nativeControlError } from './repo.attention';
import { resumePrivacy } from './repo.privacy';
import { databaseNow } from './repo.clock';
export { databaseNow } from './repo.clock';
import { closeLease, reconcile } from './repo.lifecycle';
import type { PhoneActor } from './types.operations';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import {
  permitted,
  deadlineElapsed,
  LEASE_TIMEOUT_MS,
  QUEUE_TIMEOUT_MS,
  TERMINAL_AGENT_STATUSES,
} from './config';
import {
  IPhoneError,
  type AcquireInput,
  type ActionInput,
  type IPhoneDevice,
  type IPhoneLease,
  type LeaseAction,
  type Transaction,
} from './types';

export async function capabilityData(userId: string) {
  const user = await prisma.user.findUnique({ where: { userId } });
  return permitted(user) ? await prisma.iPhoneDevice.findUnique({ where: { userId } }) : null;
}

export async function bind(userId: string, providerDeviceId: string) {
  try {
    return await runTransactionWithRetry(async (tx) => {
      if (!(await accountPermitted(tx, userId))) throw new IPhoneError(403, 'iPhone access denied');
      const device = await tx.iPhoneDevice.upsert({
        where: { userId },
        update: {},
        create: { userId, providerDeviceId, enabled: true },
      });
      if (device.providerDeviceId !== providerDeviceId)
        throw new IPhoneError(409, 'Device binding cannot be changed');
      return device;
    });
  } catch (error) {
    // Prisma may emulate upsert. Recover only identical mappings after rollback.
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P2002')
      throw error;
    const device = await prisma.iPhoneDevice.findUnique({ where: { userId } });
    if (device?.providerDeviceId !== providerDeviceId)
      throw new IPhoneError(409, 'Device is already bound');
    if ((await capabilityData(userId)) === null) throw new IPhoneError(403, 'iPhone access denied');
    return device;
  }
}
export const transaction = runTransactionWithRetry;
export async function readLease(tx: Transaction, id: string, userId?: string) {
  return tx.iPhoneLease.findFirst({ where: { id, userId } });
}

export async function requireOwnedLease(userId: string, id: string): Promise<void> {
  const lease = await prisma.iPhoneLease.findFirst({ where: { id, userId }, select: { id: true } });
  if (lease === null) throw new IPhoneError(404, 'Lease not found');
}

const deadAgent = {
  OR: [{ deletedAt: { not: null } }, { status: { in: [...TERMINAL_AGENT_STATUSES] } }],
};

export async function admit(tx: Transaction, deviceId: string): Promise<void> {
  const device = await tx.iPhoneDevice.findUniqueOrThrow({ where: { id: deviceId } });
  if (device.providerState === 'CLOSING') return;
  if (
    (await tx.iPhoneLease.findFirst({
      where: { deviceId, status: 'ACTIVE' },
      select: { id: true },
    })) !== null
  )
    return;
  // Dead waiter cleanup is only needed when promoting, never on a live heartbeat.
  await tx.iPhoneLease.updateMany({
    where: { deviceId, status: 'WAITING', agent: deadAgent },
    data: { status: 'CANCELLED', revision: { increment: 1 } },
  });
  const [next] = await tx.$queryRaw<{ id: string; queueDeadlineAt: Date }[]>`
    SELECT l.id, l."queueDeadlineAt" FROM "IPhoneLease" l JOIN "Agent" a ON a.id = l."agentId"
    WHERE l."deviceId" = ${deviceId} AND l.status = 'WAITING' AND a."deletedAt" IS NULL
      AND a.status::text NOT IN ('COMPLETED', 'FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED')
    ORDER BY l.ticket LIMIT 1 FOR SHARE OF a`;
  if (next === undefined) return;
  const now = await databaseNow(tx);
  if (deadlineElapsed(next.queueDeadlineAt, now)) {
    await closeLease(tx, next.id, 'EXPIRED');
    return admit(tx, deviceId);
  }
  await tx.iPhoneLease.update({
    where: { id: next.id },
    data: {
      status: 'ACTIVE',
      activeDeviceId: deviceId,
      leaseExpiresAt: new Date(now.getTime() + LEASE_TIMEOUT_MS),
      revision: { increment: 1 },
    },
  });
}

async function validateAgent(tx: Transaction, userId: string, input: AcquireInput) {
  await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${input.agentId} FOR SHARE`;
  const agent = await tx.agent.findFirst({ where: { id: input.agentId, userId, deletedAt: null } });
  if (agent === null) return new IPhoneError(404, 'Agent not found');
  if (TERMINAL_AGENT_STATUSES.some((status) => status === agent.status))
    return new IPhoneError(409, 'Agent is terminal');
  if (input.browserTaskId !== undefined) {
    const browser = await tx.browserSession.findFirst({
      where: {
        id: input.browserTaskId,
        agentId: input.agentId,
        context: { userId },
      },
      select: { id: true },
    });
    if (browser === null) return new IPhoneError(404, 'Browser task not found');
  }
  return null;
}

export async function enqueue(tx: Transaction, device: IPhoneDevice, input: AcquireInput) {
  const invalid = await validateAgent(tx, device.userId, input);
  if (invalid !== null) return invalid;
  const existing = await tx.iPhoneLease.findUnique({
    where: {
      deviceId_agentId_requestKey: {
        deviceId: device.id,
        agentId: input.agentId,
        requestKey: input.requestKey,
      },
    },
  });
  if (existing !== null) {
    if (existing.browserTaskId !== (input.browserTaskId ?? null))
      return new IPhoneError(409, 'Request key belongs to another browser task');
    return existing.id;
  }
  if (input.browserTaskId !== undefined) {
    const allowed = await availabilityInTransaction(tx, device.userId, input.browserTaskId);
    if (!allowed.enabled || allowed.source === 'continuation')
      return new IPhoneError(409, 'iPhone setup is required');
  }
  const now = await databaseNow(tx);
  const lease = await tx.iPhoneLease.create({
    data: {
      deviceId: device.id,
      userId: device.userId,
      agentId: input.agentId,
      requestKey: input.requestKey,
      browserTaskId: input.browserTaskId,
      queueDeadlineAt: new Date(now.getTime() + QUEUE_TIMEOUT_MS),
      createdAt: now,
    },
  });
  return lease.id;
}

export async function mutate(
  tx: Transaction,
  lease: IPhoneLease,
  action: LeaseAction,
  input: ActionInput,
  now: Date,
  actor: PhoneActor = 'agent'
) {
  if (action === 'read') return null;
  if (action === 'release') {
    if (lease.status === 'ACTIVE' || lease.status === 'WAITING')
      await closeLease(tx, lease.id, 'RELEASED');
    return null;
  }
  if (lease.status !== 'ACTIVE') return new IPhoneError(409, 'Lease is not active');
  if (lease.releaseRequestedAt !== null)
    return new IPhoneError(409, 'Phone interaction is finishing');
  if (
    action === 'control' &&
    actor === 'agent' &&
    lease.controlOwner === 'user' &&
    input.mode === 'agent'
  )
    return new IPhoneError(409, 'Only the user can return phone control');
  const nativeError = await nativeControlError(tx, lease, action);
  if (nativeError !== null) return nativeError;
  if (action === 'control' || action === 'awaiting-auth') {
    const executing = await tx.iPhoneOperation.findFirst({
      where: {
        leaseId: lease.id,
        OR: [{ activeDeviceId: { not: null } }, { state: { in: ['CONNECTING', 'RUNNING'] } }],
      },
      select: { id: true },
    });
    if (executing !== null)
      return new IPhoneError(409, 'A phone command is still running or unconfirmed');
  }
  if (
    lease.controlOwner !== 'user' &&
    lease.attentionRequestId === null &&
    deadlineElapsed(lease.leaseExpiresAt, now)
  ) {
    await closeLease(tx, lease.id, 'EXPIRED');
    return new IPhoneError(409, 'Lease expired');
  }
  if (action === 'awaiting-auth') {
    const attention = await tx.agentAttentionRequest.findFirst({
      where: {
        id: input.attentionRequestId,
        userId: lease.userId,
        agentId: lease.agentId,
        userResponse: null,
      },
      select: { id: true },
    });
    if (attention === null) return new IPhoneError(404, 'Pending attention request not found');
    await tx.iPhoneLease.update({
      where: { id: lease.id },
      data: {
        attentionRequestId: attention.id,
        revision: { increment: 1 },
      },
    });
  } else {
    if (action === 'control' && actor === 'user' && input.mode === 'agent')
      await resumePrivacy(tx, lease.deviceId, lease.id, lease.actionCursor, now);
    await tx.iPhoneLease.update({
      where: { id: lease.id },
      data: {
        ...(action === 'heartbeat' || (action === 'control' && input.mode === 'agent')
          ? { leaseExpiresAt: new Date(now.getTime() + LEASE_TIMEOUT_MS) }
          : {}),
        ...(action === 'control' ? { controlOwner: input.mode } : {}),
        revision: { increment: 1 },
      },
    });
  }
  return null;
}

export async function view(tx: Transaction, id: string) {
  const lease = await tx.iPhoneLease.findUniqueOrThrow({ where: { id } });
  const queuePosition =
    lease.status === 'WAITING'
      ? 1 +
        (await tx.iPhoneLease.count({
          where: {
            deviceId: lease.deviceId,
            status: 'WAITING',
            ticket: { lt: lease.ticket },
            agent: { deletedAt: null, status: { notIn: [...TERMINAL_AGENT_STATUSES] } },
          },
        }))
      : lease.status === 'ACTIVE'
        ? 0
        : null;
  const setup = await ensureSetup(tx, lease.deviceId, lease);
  return { lease, queuePosition, setup: setup.dto };
}

export async function lockedDevice(tx: Transaction, userId: string) {
  const rows = await tx.$queryRaw<IPhoneDevice[]>`
    SELECT * FROM "IPhoneDevice" WHERE "userId" = ${userId} FOR UPDATE`;
  const device = rows[0];
  if (device === undefined) throw new IPhoneError(409, 'iPhone device is not configured');
  // Device -> account -> active/candidate agent -> attention. No queued-agent fan-in.
  await tx.$queryRaw`SELECT id FROM "User" WHERE "userId" = ${userId} FOR SHARE`;
  const user = await tx.user.findUnique({ where: { userId } });
  const enabled = device.enabled && permitted(user);
  await reconcile(tx, device, enabled);
  return { device, enabled };
}
