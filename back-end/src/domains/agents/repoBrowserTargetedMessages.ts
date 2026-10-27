/**
 * Browser-composer message writes: the BrowserSession status check and the
 * message insert share one transaction (see createBrowserTargetedMessage).
 * One FOR SHARE row lock on an indexed primary key per message.
 */

import type { Prisma } from '@prisma/client';
import { runTransactionWithRetry } from '../../providers/database';

/**
 * Run `insert` only while the agent's BrowserSession is ACTIVE, holding a FOR
 * SHARE lock on that row until the insert commits. A concurrent pause-close
 * UPDATE either waits for the insert (its post-close read then sees the row)
 * or commits first (the status is no longer ACTIVE and this returns null).
 */
export async function withActiveBrowserSessionShareLock<T>(
  agentId: string,
  browserTaskId: string,
  insert: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T | null> {
  return runTransactionWithRetry(async (tx) => {
    const [session] = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM "BrowserSession"
      WHERE id = ${browserTaskId} AND "agentId" = ${agentId}
      FOR SHARE`;
    if (session?.status !== 'ACTIVE') return null;
    return insert(tx);
  });
}
