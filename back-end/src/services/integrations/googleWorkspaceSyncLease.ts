/**
 * The per-(user, source) refresh lease, held on the `UserDataProviderSyncState`
 * row. A refresh claims it, renews it while it works, and writes its final
 * state only while it still holds it. A refresh that outlives its lease
 * therefore stops at its next renewal instead of running alongside the refresh
 * that took over, and can never overwrite that refresh's result.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

export const STATUS_CONNECTED = 'CONNECTED';
export const STATUS_SYNCING = 'SYNCING';
export const STATUS_FAILED = 'SYNC_FAILED';
export const STATUS_NOT_CONNECTED = 'NOT_CONNECTED';

/** A refresh that has not renewed for this long is treated as abandoned. */
export const SYNC_LEASE_MS = 120_000;
/** Renewal spacing: well inside the lease, and at most one write per interval. */
const DEFAULT_RENEW_EVERY_MS = 20_000;

/** Another refresh took this source over; this one must stop without writing. */
export class LeaseLostError extends Error {
  constructor() {
    super('Another refresh took over this Google source');
    this.name = 'LeaseLostError';
  }
}

export interface SyncLease {
  /** Renew when due. Throws `LeaseLostError` once another refresh holds the lease. */
  keepAlive(): Promise<void>;
  /** Write this refresh's final state; false when the lease was lost. */
  finish(data: Prisma.UserDataProviderSyncStateUpdateManyMutationInput): Promise<boolean>;
  /** Record a failed refresh, only while this refresh still holds the lease. */
  fail(lastError: string): Promise<void>;
}

/** Take the lease, or null when another refresh holds a live one. */
export async function claimSyncLease(
  userId: string,
  source: string,
  now: Date,
  renewEveryMs = DEFAULT_RENEW_EVERY_MS
): Promise<SyncLease | null> {
  await prisma.userDataProviderSyncState.upsert({
    where: { userId_source: { userId, source } },
    create: { userId, source, status: STATUS_NOT_CONNECTED },
    update: {},
  });
  const claimed = await prisma.userDataProviderSyncState.updateMany({
    where: {
      userId,
      source,
      OR: [
        { status: { not: STATUS_SYNCING } },
        { lastStartedAt: null },
        { lastStartedAt: { lt: new Date(now.getTime() - SYNC_LEASE_MS) } },
      ],
    },
    data: { status: STATUS_SYNCING, lastStartedAt: now },
  });
  if (claimed.count !== 1) return null;

  // `lastStartedAt` is the lease's fence: every write below requires the exact
  // stamp this refresh last wrote. Renewal advances it on the refresh's own
  // clock (injected in tests) by the real time elapsed.
  const startedAt = Date.now();
  let renewedAt = startedAt;
  let stamp = now;
  const held = (): Prisma.UserDataProviderSyncStateWhereInput => ({
    userId,
    source,
    status: STATUS_SYNCING,
    lastStartedAt: stamp,
  });
  return {
    async keepAlive() {
      if (Date.now() - renewedAt < renewEveryMs) return;
      const next = new Date(
        Math.max(now.getTime() + (Date.now() - startedAt), stamp.getTime() + 1)
      );
      const renewed = await prisma.userDataProviderSyncState.updateMany({
        where: held(),
        data: { lastStartedAt: next },
      });
      if (renewed.count !== 1) throw new LeaseLostError();
      stamp = next;
      renewedAt = Date.now();
    },
    async finish(data) {
      const written = await prisma.userDataProviderSyncState.updateMany({ where: held(), data });
      return written.count === 1;
    },
    async fail(lastError) {
      await prisma.userDataProviderSyncState
        .updateMany({ where: held(), data: { status: STATUS_FAILED, lastError } })
        .catch(() => undefined);
    },
  };
}
