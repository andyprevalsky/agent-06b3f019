/**
 * The per-(user, source) refresh lease, held on the `UserDataProviderSyncState`
 * row. A refresh claims it, renews it while it works, and writes its final
 * state only while it still holds it. A refresh that outlives its lease
 * therefore stops at its next renewal instead of running alongside the refresh
 * that took over, and can never overwrite that refresh's result.
 *
 * A refresh renews after every Google request and every database write, so the
 * longest stretch without a renewal is one request with its retries, about
 * half the lease. Parallel downloads renew through the same lease, so its
 * writes run one at a time.
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

/** This refresh no longer holds the source; it must stop without writing. */
export class LeaseLostError extends Error {
  constructor() {
    super('This refresh no longer holds the Google source');
    this.name = 'LeaseLostError';
  }
}

export interface SyncLease {
  /**
   * Renew when due. Throws `LeaseLostError` once this refresh no longer holds
   * the lease: another refresh took it over, or this one already ended.
   */
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
  // Insert-if-absent in one statement. An upsert is a read then a write, so
  // two searches racing on a user's first refresh made one of them fail on
  // the unique key instead of deferring to the other.
  await prisma.userDataProviderSyncState.createMany({
    data: [{ userId, source, status: STATUS_NOT_CONNECTED }],
    skipDuplicates: true,
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
  let holding = true;
  const fence = (): Prisma.UserDataProviderSyncStateWhereInput => ({
    userId,
    source,
    status: STATUS_SYNCING,
    lastStartedAt: stamp,
  });
  // Each write reads the stamp the previous one left. Two renewals racing on
  // the same stamp would make the slower one look like a lost lease.
  let lastWrite: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(write: () => Promise<T>): Promise<T> => {
    const result = lastWrite.then(write);
    lastWrite = result.catch(() => undefined);
    return result;
  };
  const renewalDue = (): boolean => Date.now() - renewedAt >= renewEveryMs;
  return {
    async keepAlive() {
      if (!holding) throw new LeaseLostError();
      if (!renewalDue()) return;
      await inTurn(async () => {
        if (!holding) throw new LeaseLostError();
        // A renewal that waited behind another one finds the lease fresh.
        if (!renewalDue()) return;
        const next = new Date(
          Math.max(now.getTime() + (Date.now() - startedAt), stamp.getTime() + 1)
        );
        const renewed = await prisma.userDataProviderSyncState.updateMany({
          where: fence(),
          data: { lastStartedAt: next },
        });
        if (renewed.count !== 1) {
          holding = false;
          throw new LeaseLostError();
        }
        stamp = next;
        renewedAt = Date.now();
      });
    },
    async finish(data) {
      return inTurn(async () => {
        if (!holding) return false;
        const written = await prisma.userDataProviderSyncState.updateMany({
          where: fence(),
          data,
        });
        // Released only once the write went through, so `fail` can still
        // record a refresh whose final write threw.
        holding = false;
        return written.count === 1;
      });
    },
    async fail(lastError) {
      await inTurn(async () => {
        if (!holding) return;
        holding = false;
        await prisma.userDataProviderSyncState.updateMany({
          where: fence(),
          data: { status: STATUS_FAILED, lastError },
        });
      }).catch(() => undefined);
    },
  };
}
