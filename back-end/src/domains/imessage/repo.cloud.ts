import { Prisma } from '@prisma/client';
import { CloudMessageBindingConflictError, CloudMessageEligibilityError } from './types';
/** Cloud message intent ownership; existing relay rows remain on their original transport. */
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { permitted, TERMINAL_AGENT_STATUSES } from '../../providers/phoneAccountPolicy';
import { cloudPhoneRoutingEnabled } from './config';

export async function cloudMessageEligible(userId: string, agentId: string): Promise<boolean> {
  if (!cloudPhoneRoutingEnabled()) return false;
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { userId: true, phone: true, isAnonymous: true },
  });
  if (!permitted(user)) return false;
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, userId, deletedAt: null },
    select: { status: true },
  });
  if (!agent || TERMINAL_AGENT_STATUSES.some((status) => status === agent.status))
    throw new CloudMessageEligibilityError('Cloud message requires an active owned agent');
  const device = await prisma.iPhoneDevice.findUnique({
    where: { userId },
    select: { enabled: true },
  });
  if (device?.enabled !== true)
    throw new CloudMessageEligibilityError('Cloud phone is unavailable');
  return true;
}

export async function bindCloudMessage(userId: string, id: string, browserTaskId: string) {
  return runTransactionWithRetry(async (tx) => {
    // Serialize new binders for this logical task; the partial unique index also fences old writers.
    await tx.$queryRaw`SELECT b.id FROM "BrowserSession" b JOIN "BrowserContext" c ON c.id=b."contextId"
      WHERE b.id=${browserTaskId} AND c."userId"=${userId} FOR UPDATE OF b`;

    await tx.$queryRaw`SELECT id FROM "ImessageQueue" WHERE id = ${id} FOR UPDATE`;
    const row = await tx.imessageQueue.findFirst({
      where: { id, userId, transport: 'phone_harness' },
    });
    if (!row) throw new CloudMessageBindingConflictError('Cloud message not found');
    const task = await tx.browserSession.findFirst({
      where: { id: browserTaskId, agentId: row.agentId, context: { userId } },
      select: { id: true },
    });
    if (!task)
      throw new CloudMessageBindingConflictError('Cloud message browser task is not owned');
    const agent = await tx.agent.findFirst({
      where: { id: row.agentId, userId, deletedAt: null },
      select: { status: true },
    });
    if (!agent || TERMINAL_AGENT_STATUSES.some((status) => status === agent.status))
      throw new CloudMessageBindingConflictError('Cloud message agent is no longer active');
    if (row.phoneBrowserTaskId !== null && row.phoneBrowserTaskId !== browserTaskId)
      throw new CloudMessageBindingConflictError('Cloud message belongs to another browser task');
    if (row.phoneBrowserTaskId === null) {
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      // Expiry can retire only an intent that never reached physical dispatch.
      await tx.imessageQueue.updateMany({
        where: {
          phoneBrowserTaskId: browserTaskId,
          transport: 'phone_harness',
          sentAt: null,
          failedAt: null,
          dispatchedAt: null,
          expiresAt: { lte: clock.now },
        },
        data: { failedAt: clock.now, lastError: 'phone_message_expired' },
      });
    }
    return row.phoneBrowserTaskId !== null
      ? row
      : tx.imessageQueue.update({
          where: { id },
          data: { phoneBrowserTaskId: browserTaskId },
        });
  }).catch((error: unknown) => {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      Array.isArray(error.meta?.target) &&
      error.meta.target.length === 1 &&
      error.meta.target[0] === 'phoneBrowserTaskId'
    )
      throw new CloudMessageBindingConflictError('Cloud message task is already bound');
    throw error;
  });
}
