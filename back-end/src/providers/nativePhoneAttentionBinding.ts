/** Lock order: device -> generation -> account/agent/task -> attention. No provider IO. */
import type { Prisma } from '@prisma/client';
import { PhoneInteractionError as ErrorWithStatus } from './phoneInteractionError';
import { permitted, TERMINAL_AGENT_STATUSES } from './phoneAccountPolicy';
import type { NativePhoneTarget } from './nativePhoneAttention';
import { lockAgentWorkflowGeneration } from './workflowGeneration';

export async function lockNativePhoneDevice(
  tx: Prisma.TransactionClient,
  userId: string,
  agentId: string
) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "IPhoneDevice" WHERE "userId" = ${userId} FOR UPDATE`;
  if (rows[0] === undefined) throw new ErrorWithStatus(409, 'iPhone device is not configured');
  await lockAgentWorkflowGeneration(tx, agentId);
  await tx.$queryRaw`SELECT id FROM "User" WHERE "userId" = ${userId} FOR SHARE`;
  const device = await tx.iPhoneDevice.findUniqueOrThrow({ where: { id: rows[0].id } });
  if (!device.enabled || !permitted(await tx.user.findUnique({ where: { userId } })))
    throw new ErrorWithStatus(403, 'iPhone access denied');
  return device;
}
export async function validateNativePhoneLease(
  tx: Prisma.TransactionClient,
  userId: string,
  agentId: string,
  target: NativePhoneTarget,
  deviceId: string,
  idle = true
) {
  await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${agentId} FOR SHARE`;
  const agent = await tx.agent.findFirst({ where: { id: agentId, userId, deletedAt: null } });
  if (agent === null || TERMINAL_AGENT_STATUSES.some((state) => state === agent.status))
    throw new ErrorWithStatus(409, 'Native phone agent is not active');
  const task = await tx.browserSession.findFirst({
    where: { id: target.browserTaskId, agentId, context: { userId } },
    select: { id: true },
  });
  if (task === null) throw new ErrorWithStatus(404, 'Browser phone interaction not found');
  const lease = await tx.iPhoneLease.findFirst({
    where: { id: target.leaseId, deviceId, userId, agentId, browserTaskId: target.browserTaskId },
  });
  if (
    lease === null ||
    lease.status !== 'ACTIVE' ||
    lease.activeDeviceId !== deviceId ||
    lease.releaseRequestedAt !== null
  )
    throw new ErrorWithStatus(409, 'Native phone lease is not active');
  if (
    idle &&
    (await tx.iPhoneOperation.findFirst({
      where: {
        deviceId,
        OR: [{ activeDeviceId: { not: null } }, { state: { in: ['CONNECTING', 'RUNNING'] } }],
      },
      select: { id: true },
    })) !== null
  )
    throw new ErrorWithStatus(409, 'A phone command is still running or unconfirmed');
  return { lease, agent };
}
