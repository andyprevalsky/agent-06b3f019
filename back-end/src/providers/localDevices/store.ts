/**
 * Persistence for Rose Mac app devices and local code-agent origin (C14).
 *
 * Every lookup is a primary-key read: device by id, agent by id, root by busId.
 * Nothing here scans by user except the owner's own device list.
 */
import { prisma } from '../database';

export interface LocalDeviceRecord {
  id: string;
  userId: string;
  name: string;
  platform: string;
  appVersion: string | null;
  lastSeenAt: Date;
}

export interface AgentOrigin {
  agentId: string;
  rootAgentId: string;
  userId: string;
  source: string;
  originDeviceId: string | null;
}

export class DeviceOwnedByAnotherUserError extends Error {
  constructor() {
    super('This device is registered to another account');
    this.name = 'DeviceOwnedByAnotherUserError';
  }
}

const DEVICE_SELECT = {
  id: true,
  userId: true,
  name: true,
  platform: true,
  appVersion: true,
  lastSeenAt: true,
} as const;

/** Bind a Mac-minted device id to its user (first register wins, forever). */
export async function registerLocalDevice(params: {
  deviceId: string;
  userId: string;
  name: string;
  platform: string;
  appVersion: string | null;
}): Promise<LocalDeviceRecord> {
  const existing = await prisma.localDevice.findUnique({
    where: { id: params.deviceId },
    select: { userId: true },
  });
  if (existing !== null && existing.userId !== params.userId) {
    throw new DeviceOwnedByAnotherUserError();
  }
  const row = await prisma.localDevice.upsert({
    where: { id: params.deviceId },
    create: {
      id: params.deviceId,
      userId: params.userId,
      name: params.name,
      platform: params.platform,
      appVersion: params.appVersion,
    },
    // userId is never updated: a concurrent first register by another user
    // keeps the original owner and is rejected below.
    update: {
      name: params.name,
      platform: params.platform,
      appVersion: params.appVersion,
      lastSeenAt: new Date(),
    },
    select: DEVICE_SELECT,
  });
  if (row.userId !== params.userId) throw new DeviceOwnedByAnotherUserError();
  return row;
}

export async function findLocalDevice(deviceId: string): Promise<LocalDeviceRecord | null> {
  return prisma.localDevice.findUnique({ where: { id: deviceId }, select: DEVICE_SELECT });
}

export async function listLocalDevices(userId: string): Promise<LocalDeviceRecord[]> {
  return prisma.localDevice.findMany({
    where: { userId },
    select: DEVICE_SELECT,
    orderBy: { lastSeenAt: 'desc' },
  });
}

export async function touchLocalDevice(deviceId: string): Promise<void> {
  await prisma.localDevice.updateMany({
    where: { id: deviceId },
    data: { lastSeenAt: new Date() },
  });
}

const ORIGIN_SELECT = {
  id: true,
  userId: true,
  busId: true,
  parentAgentId: true,
  source: true,
  originDeviceId: true,
} as const;

/** Sub-agents chain to their root through busId; a missing busId walks parents. */
const MAX_PARENT_HOPS = 32;

/** The origin (client + Mac) of the root of `agentId`'s tree. */
export async function findAgentOrigin(agentId: string): Promise<AgentOrigin | null> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: ORIGIN_SELECT });
  if (agent === null) return null;
  let root = agent;
  if (agent.busId !== null && agent.busId !== '' && agent.busId !== agent.id) {
    const bus = await prisma.agent.findUnique({
      where: { id: agent.busId },
      select: ORIGIN_SELECT,
    });
    if (bus !== null) root = bus;
  } else {
    for (let hops = 0; root.parentAgentId !== null && hops < MAX_PARENT_HOPS; hops += 1) {
      const parent = await prisma.agent.findUnique({
        where: { id: root.parentAgentId },
        select: ORIGIN_SELECT,
      });
      if (parent === null) break;
      root = parent;
    }
  }
  return {
    agentId: agent.id,
    rootAgentId: root.id,
    // A root owned by someone else can never lend its Mac to this agent.
    userId: agent.userId,
    source: root.userId === agent.userId ? root.source : 'WEB',
    originDeviceId: root.userId === agent.userId ? root.originDeviceId : null,
  };
}

/** The device, only when `userId` owns it (UUID-shaped ids only). */
export async function findOwnedLocalDevice(
  deviceId: string,
  userId: string
): Promise<LocalDeviceRecord | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId))
    return null;
  const device = await findLocalDevice(deviceId);
  return device !== null && device.userId === userId ? device : null;
}

export async function findActiveCodeSession(
  taskId: string
): Promise<{ id: string; agentId: string; sandboxId: string } | null> {
  return prisma.claudeCodeSession.findFirst({
    where: { id: taskId, status: 'ACTIVE' },
    select: { id: true, agentId: true, sandboxId: true },
  });
}
