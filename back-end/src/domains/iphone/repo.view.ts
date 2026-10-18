import * as leases from './repo';
import { LEASE_TIMEOUT_MS } from './config';
import type { CommandClaim } from './types.operations';

/** Frames have bounded durable custody, but never enter the decision cursor/history. */
export async function retireObservation(claim: CommandClaim): Promise<boolean> {
  return leases.transaction(async (tx) => {
    const { device, enabled } = await leases.lockedDevice(tx, claim.lease.userId);
    const [lease, operation] = await Promise.all([
      tx.iPhoneLease.findUnique({ where: { id: claim.lease.id } }),
      tx.iPhoneOperation.findUnique({ where: { id: claim.command.id } }),
    ]);
    const task =
      claim.taskBound !== true
        ? true
        : lease?.browserTaskId === null || lease === null
          ? null
          : await tx.browserSession.findFirst({
              where: {
                id: lease.browserTaskId,
                agentId: lease.agentId,
                context: { userId: lease.userId },
              },
              select: { id: true },
            });
    const valid =
      enabled &&
      task !== null &&
      operation?.state === 'RUNNING' &&
      lease?.status === 'ACTIVE' &&
      lease.releaseRequestedAt === null &&
      lease.controlOwner === claim.command.actor &&
      device.providerState !== 'CLOSING' &&
      operation.providerEpoch === device.providerEpoch;
    await tx.iPhoneOperation.deleteMany({
      where: { id: claim.command.id, operation: 'screen.frame' },
    });
    if (valid && lease.controlOwner === 'user')
      await tx.iPhoneLease.update({
        where: { id: lease.id },
        data: {
          leaseExpiresAt: new Date((await leases.databaseNow(tx)).getTime() + LEASE_TIMEOUT_MS),
        },
      });
    return valid;
  });
}
