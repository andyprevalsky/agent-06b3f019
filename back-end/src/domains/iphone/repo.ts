/** Durable admission: device FOR UPDATE -> reconcile -> mutate -> FIFO admit.
 * Every process uses this lock order. Transactions perform database I/O only. */
import { prisma, runTransactionWithRetry } from '../../providers/database';
import {
  permitted,
  deadlineElapsed,
  AUTH_REJECTED_RESPONSE,
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
export async function accountPermitted(tx: Transaction, userId: string) {
  return permitted(await tx.user.findUnique({ where: { userId } }));
}
export async function readLease(tx: Transaction, id: string, userId?: string) {
  return tx.iPhoneLease.findFirst({ where: { id, userId } });
}

async function closeLease(tx: Transaction, id: string, status: string) {
  await tx.iPhoneLease.update({
    where: { id },
    data: {
      status,
      activeDeviceId: null,
      controlOwner: 'agent',
      revision: { increment: 1 },
    },
  });
}

const deadAgent = {
  OR: [{ deletedAt: { not: null } }, { status: { in: [...TERMINAL_AGENT_STATUSES] } }],
};

export async function databaseNow(tx: Transaction): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row.now;
}
async function reconcileActive(tx: Transaction, lease: IPhoneLease) {
  await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${lease.agentId} FOR SHARE`;
  const agent = await tx.agent.findUnique({ where: { id: lease.agentId } });
  if (
    agent === null ||
    agent.deletedAt !== null ||
    TERMINAL_AGENT_STATUSES.some((status) => status === agent.status)
  ) {
    await closeLease(tx, lease.id, 'CANCELLED');
    return;
  }
  const auth =
    lease.attentionRequestId === null
      ? []
      : await tx.$queryRaw<{ userResponse: string | null }[]>`
    SELECT "userResponse" FROM "AgentAttentionRequest"
    WHERE id = ${lease.attentionRequestId} AND "userId" = ${lease.userId}
      AND "agentId" = ${lease.agentId} FOR SHARE`;
  const now = await databaseNow(tx);
  if (auth[0]?.userResponse === null) return;
  if (auth[0]?.userResponse === AUTH_REJECTED_RESPONSE) {
    await closeLease(tx, lease.id, 'RELEASED');
    return;
  }
  if (auth[0] !== undefined) {
    // Consume the answered transition exactly once; polling cannot extend grace.
    await tx.iPhoneLease.update({
      where: { id: lease.id },
      data: {
        attentionRequestId: null,
        controlOwner: 'agent',
        leaseExpiresAt: new Date(now.getTime() + LEASE_TIMEOUT_MS),
        revision: { increment: 1 },
      },
    });
    return;
  }
  if (lease.attentionRequestId !== null)
    await tx.iPhoneLease.update({
      where: { id: lease.id },
      data: { attentionRequestId: null, revision: { increment: 1 } },
    });
  if (deadlineElapsed(lease.leaseExpiresAt, now)) await closeLease(tx, lease.id, 'EXPIRED');
}
async function reconcile(tx: Transaction, device: IPhoneDevice, enabled: boolean) {
  if (!enabled) {
    await tx.iPhoneLease.updateMany({
      where: { deviceId: device.id, status: { in: ['WAITING', 'ACTIVE'] } },
      data: {
        status: 'CANCELLED',
        activeDeviceId: null,
        controlOwner: 'agent',
        revision: { increment: 1 },
      },
    });
  } else {
    const active = await tx.iPhoneLease.findFirst({
      where: { deviceId: device.id, status: 'ACTIVE' },
    });
    if (active !== null) await reconcileActive(tx, active);
  }
  await tx.iPhoneLease.updateMany({
    where: {
      deviceId: device.id,
      status: 'WAITING',
      queueDeadlineAt: { lte: await databaseNow(tx) },
    },
    data: { status: 'EXPIRED', revision: { increment: 1 } },
  });
}
export async function admit(tx: Transaction, deviceId: string): Promise<void> {
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
  now: Date
) {
  if (action === 'read') return null;
  if (action === 'release') {
    if (lease.status === 'ACTIVE' || lease.status === 'WAITING')
      await closeLease(tx, lease.id, 'RELEASED');
    return null;
  }
  if (lease.status !== 'ACTIVE') return new IPhoneError(409, 'Lease is not active');
  if (lease.attentionRequestId === null && deadlineElapsed(lease.leaseExpiresAt, now)) {
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
    await tx.iPhoneLease.update({
      where: { id: lease.id },
      data: {
        ...(action === 'heartbeat'
          ? { leaseExpiresAt: new Date(now.getTime() + LEASE_TIMEOUT_MS) }
          : { controlOwner: input.mode }),
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
          },
        }))
      : lease.status === 'ACTIVE'
        ? 0
        : null;
  return { lease, queuePosition };
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
