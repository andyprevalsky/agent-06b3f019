/**
 * Cross-instance shared state, backed by Postgres (the only store every
 * backend instance shares).
 *
 *   in-process Map / Set / promise chain        Postgres
 *   ───────────────────────────────────         ─────────────────────────────
 *   short-lived flow state (PKCE, ...)   ──►    putEphemeral / getEphemeral / takeEphemeral
 *   "first one wins" dedupe / leases     ──►    acquireLease / releaseLease
 *   per-key mutual exclusion             ──►    withSerializedLock (lease, no open tx)
 *
 * Everything here is keyed per flow, user or item: one row per key, so cost grows with the work being coordinated, never with the
 * number of instances or agents. Expired rows are reaped in small batches by
 * the writers, so the table stays bounded without a cron.
 */

import { Prisma } from '@prisma/client';
import { prisma } from './database';
import { randomUUID } from './crypto';
import { createLogger } from './logger';
import { retryWithBackoff } from './retry';

const log = createLogger('SharedState');

const REAP_BATCH = 100;

async function reapExpired(): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "SharedEphemeralState"
    WHERE ctid IN (
      SELECT ctid FROM "SharedEphemeralState"
      WHERE "expiresAt" <= now()
      LIMIT ${REAP_BATCH}
    )
  `;
}

function ttlInterval(ttlMs: number): Prisma.Sql {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error(`sharedState: invalid ttl ${ttlMs}`);
  return Prisma.sql`${Math.ceil(ttlMs)} * interval '1 millisecond'`;
}

/** Store (or replace) a value that any instance can read until it expires. */
export async function putEphemeral(
  namespace: string,
  key: string,
  value: Prisma.InputJsonValue,
  ttlMs: number
): Promise<void> {
  await reapExpired();
  await prisma.$executeRaw`
    INSERT INTO "SharedEphemeralState" (namespace, key, value, "expiresAt")
    VALUES (${namespace}, ${key}, ${JSON.stringify(value)}::jsonb, now() + ${ttlInterval(ttlMs)})
    ON CONFLICT (namespace, key) DO UPDATE
      SET value = EXCLUDED.value, "expiresAt" = EXCLUDED."expiresAt", "createdAt" = now()
  `;
}

/** Read a live value without consuming it. */
export async function getEphemeral<T>(namespace: string, key: string): Promise<T | undefined> {
  const rows = await prisma.$queryRaw<Array<{ value: T }>>`
    SELECT value FROM "SharedEphemeralState"
    WHERE namespace = ${namespace} AND key = ${key} AND "expiresAt" > now()
  `;
  return rows[0]?.value;
}

/** Atomically read and delete a live value: exactly one caller across all instances gets it. */
export async function takeEphemeral<T>(namespace: string, key: string): Promise<T | undefined> {
  const rows = await prisma.$queryRaw<Array<{ value: T }>>`
    DELETE FROM "SharedEphemeralState"
    WHERE namespace = ${namespace} AND key = ${key} AND "expiresAt" > now()
    RETURNING value
  `;
  return rows[0]?.value;
}

/**
 * Claim `key` until `ttlMs` elapses, unless another live claim holds it.
 * Returns an owner token on success, null when another instance holds it.
 * An expired claim is taken over, so a crashed holder never wedges the key.
 */
export async function acquireLease(
  namespace: string,
  key: string,
  ttlMs: number
): Promise<string | null> {
  await reapExpired();
  const token = randomUUID();
  const rows = await prisma.$queryRaw<Array<{ key: string }>>`
    INSERT INTO "SharedEphemeralState" (namespace, key, value, "expiresAt")
    VALUES (${namespace}, ${key}, ${JSON.stringify({ token })}::jsonb, now() + ${ttlInterval(ttlMs)})
    ON CONFLICT (namespace, key) DO UPDATE
      SET value = EXCLUDED.value, "expiresAt" = EXCLUDED."expiresAt", "createdAt" = now()
      WHERE "SharedEphemeralState"."expiresAt" <= now()
    RETURNING key
  `;
  return rows.length === 1 ? token : null;
}

/** Release a lease only if `token` still owns it (a taken-over lease is left alone). */
export async function releaseLease(namespace: string, key: string, token: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "SharedEphemeralState"
    WHERE namespace = ${namespace} AND key = ${key} AND value->>'token' = ${token}
  `;
}

/** Extend a lease `token` still owns. Returns false when it was lost or taken over. */
export async function renewLease(
  namespace: string,
  key: string,
  token: string,
  ttlMs: number
): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE "SharedEphemeralState"
    SET "expiresAt" = now() + ${ttlInterval(ttlMs)}
    WHERE namespace = ${namespace} AND key = ${key} AND value->>'token' = ${token}
  `;
  return count === 1;
}

export interface HeldLease {
  /** True once a renewal found the lease lost or taken over (or could not run). */
  lost(): boolean;
  /** Stop renewing and release the lease if this holder still owns it. */
  release(): Promise<void>;
}

/**
 * Keep a lease alive while its holder works: renew every ttl/3 and record a
 * loss instead of discarding it, so callers and operators can see that another
 * instance may have taken over.
 */
export function holdLease(namespace: string, key: string, token: string, ttlMs: number): HeldLease {
  let lost = false;
  const markLost = (reason: string) => {
    if (!lost) log.warn('Shared lease lost while held', { namespace, key, reason });
    lost = true;
  };
  const heartbeat = setInterval(
    () => {
      renewLease(namespace, key, token, ttlMs)
        .then((renewed) => {
          if (!renewed) markLost('taken over or expired');
        })
        .catch((error: unknown) =>
          markLost(error instanceof Error ? error.message : String(error))
        );
    },
    Math.max(Math.floor(ttlMs / 3), 1_000)
  );
  heartbeat.unref();
  return {
    lost: () => lost,
    release: async () => {
      clearInterval(heartbeat);
      await releaseLease(namespace, key, token).catch((error: unknown) =>
        log.warn('Shared lease release failed; it expires on its own', {
          namespace,
          key,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    },
  };
}

const LOCK_NAMESPACE = 'serialized-lock';
const LOCK_TTL_MS = 60_000;
const LOCK_POLL_RAMP_MS = [50, 100, 200, 400];
const LOCK_POLL_MAX_MS = 500;

/**
 * Run `fn` while holding a cross-instance lock on `key`, so callers with the
 * same key run one at a time across every backend instance.
 *
 * The lock is a lease row, not an open transaction: neither the holder nor a
 * waiter pins a pooled connection while `fn` makes slow outside calls. The
 * holder renews the lease while `fn` runs; a crashed holder's lease expires.
 * Waiters poll with a capped backoff (50ms ramping to 500ms), which is cheap because locks are per user
 * or per item. Acquisition order is not FIFO; callers that need ordering must
 * gate inside `fn` (the SMS seq gate does).
 */
export async function withSerializedLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number } = {}
): Promise<T> {
  const waitMs = opts.waitMs ?? 120_000;
  const steadyPolls = Math.ceil(waitMs / LOCK_POLL_MAX_MS);
  const token = await retryWithBackoff(() => acquireLease(LOCK_NAMESPACE, key, LOCK_TTL_MS), {
    maxRetries: LOCK_POLL_RAMP_MS.length + steadyPolls,
    fixedDelays: [...LOCK_POLL_RAMP_MS, ...Array<number>(steadyPolls).fill(LOCK_POLL_MAX_MS)],
    shouldRetryResult: (claimed) => claimed === null,
    component: `SharedLock:${key}`,
  });
  if (token === null) throw new Error(`sharedState: timed out waiting for lock ${key}`);
  const lease = holdLease(LOCK_NAMESPACE, key, token, LOCK_TTL_MS);
  try {
    return await fn();
  } finally {
    if (lease.lost()) {
      log.error('Serialized lock was lost while its holder ran; exclusion was not guaranteed', {
        key,
      });
    }
    await lease.release();
  }
}
