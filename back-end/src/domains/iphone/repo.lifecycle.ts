/** Device-locked lease recovery; a pending physical command fences handoff. */
import {
  AUTH_REJECTED_RESPONSE,
  LEASE_TIMEOUT_MS,
  TERMINAL_AGENT_STATUSES,
  USER_CONTROL_TIMEOUT_MS,
  deadlineElapsed,
} from './config';
import type { Transaction, IPhoneLease, IPhoneDevice } from './types';
import { databaseNow } from './repo.clock';

export async function closeLease(tx: Transaction, id: string, status: string) {
  const executing = await tx.iPhoneOperation.findFirst({
    where: {
      leaseId: id,
      OR: [{ activeDeviceId: { not: null } }, { state: { in: ['CONNECTING', 'RUNNING'] } }],
    },
    select: { id: true },
  });
  if (executing !== null) {
    await tx.iPhoneLease.update({
      where: { id },
      data: { releaseRequestedAt: await databaseNow(tx), releaseStatus: status },
    });
    return;
  }
  await tx.iPhoneLease.update({
    where: { id },
    data: {
      status,
      activeDeviceId: null,
      controlOwner: 'agent',
      releaseRequestedAt: null,
      releaseStatus: null,
      revision: { increment: 1 },
    },
  });
}

async function reconcileActive(tx: Transaction, lease: IPhoneLease) {
  if (lease.releaseRequestedAt !== null) {
    await closeLease(tx, lease.id, lease.releaseStatus ?? 'RELEASED');
    return;
  }
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
  // A paused agent cannot act on the phone; it must not starve the FIFO queue. A pause for this
  // lease's own phone auth keeps the hold so the owner can act on a live phone; the pending-auth
  // branch below still bounds it by the user-control grace, and other pauses release at once.
  if (agent.status === 'PAUSED' && lease.attentionRequestId === null)
    return closeLease(tx, lease.id, 'RELEASED');
  if (lease.browserTaskId !== null) {
    const task = await tx.browserSession.findFirst({
      where: { id: lease.browserTaskId, agentId: lease.agentId, context: { userId: lease.userId } },
      select: { id: true },
    });
    if (task === null) {
      await closeLease(tx, lease.id, 'CANCELLED');
      return;
    }
  }
  const executing = await tx.iPhoneOperation.findUnique({
    where: { activeDeviceId: lease.deviceId },
  });
  if (executing !== null && executing.leaseId === lease.id) {
    const now = await databaseNow(tx);
    if (
      executing.deadlineAt <= now ||
      (executing.state === 'UNKNOWN' && deadlineElapsed(lease.leaseExpiresAt, now))
    ) {
      await tx.iPhoneOperation.update({
        where: { id: executing.id },
        data: { state: 'UNKNOWN' },
      });
      await closeLease(tx, lease.id, 'EXPIRED');
    }
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
  // Pending auth outlives agent heartbeats only for the bounded user grace.
  if (auth[0]?.userResponse === null) return expireHold(tx, lease, now, true);
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
  await expireHold(tx, lease, now, lease.controlOwner === 'user');
}
/** Agent holds expire with heartbeats. User control and pending auth get a bounded grace past
 * leaseExpiresAt, which only activity (commands, lease frames, heartbeats) renews. */
async function expireHold(tx: Transaction, lease: IPhoneLease, now: Date, userHeld: boolean) {
  const grace = userHeld ? USER_CONTROL_TIMEOUT_MS : 0;
  const deadline =
    lease.leaseExpiresAt === null ? null : new Date(lease.leaseExpiresAt.getTime() + grace);
  if (deadlineElapsed(deadline, now)) await closeLease(tx, lease.id, 'EXPIRED');
}
export async function reconcile(tx: Transaction, device: IPhoneDevice, enabled: boolean) {
  if (!enabled) {
    await tx.iPhoneLease.updateMany({
      where: { deviceId: device.id, status: 'WAITING' },
      data: {
        status: 'CANCELLED',
        activeDeviceId: null,
        controlOwner: 'agent',
        revision: { increment: 1 },
      },
    });
    const active = await tx.iPhoneLease.findFirst({
      where: { deviceId: device.id, status: 'ACTIVE' },
    });
    if (active !== null) await closeLease(tx, active.id, 'CANCELLED');
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
