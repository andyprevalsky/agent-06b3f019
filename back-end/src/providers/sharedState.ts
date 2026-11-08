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

/** Which of `keys` hold a live value. Bounded by the caller's candidate list. */
export async function liveEphemeralKeys(namespace: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await prisma.$queryRaw<Array<{ key: string }>>`
    SELECT key FROM "SharedEphemeralState"
    WHERE namespace = ${namespace} AND key = ANY(${keys}::text[]) AND "expiresAt" > now()
  `;
  return new Set(rows.map((row) => row.key));
}

/** Delete a value whether or not it is still live. */
export async function deleteEphemeral(namespace: string, key: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "SharedEphemeralState" WHERE namespace = ${namespace} AND key = ${key}
  `;
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
 *
 * The token is minted before the statement, so the query layer's retry on a
 * dropped connection (P1001/P1017) replays the same token: an INSERT that
 * committed before its reply was lost then matches its own claim instead of
 * reporting it as another instance's.
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
        OR "SharedEphemeralState".value->>'token' = ${token}
    RETURNING key
  `;
  return rows.length === 1 ? token : null;
}

/** Store `value` only if no live row holds `key` (an expired row is replaced). Atomic. */
export async function insertEphemeralIfAbsent(
  namespace: string,
  key: string,
  value: Prisma.InputJsonValue,
  ttlMs: number
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ key: string }>>`
    INSERT INTO "SharedEphemeralState" (namespace, key, value, "expiresAt")
    VALUES (${namespace}, ${key}, ${JSON.stringify(value)}::jsonb, now() + ${ttlInterval(ttlMs)})
    ON CONFLICT (namespace, key) DO UPDATE
      SET value = EXCLUDED.value, "expiresAt" = EXCLUDED."expiresAt", "createdAt" = now()
      WHERE "SharedEphemeralState"."expiresAt" <= now()
    RETURNING key
  `;
  return rows.length === 1;
}

/** Replace a lease's value only while `token` still owns it. Returns false when it does not. */
export async function replaceLeaseValue(
  namespace: string,
  key: string,
  token: string,
  value: Prisma.InputJsonValue,
  ttlMs: number
): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE "SharedEphemeralState"
    SET value = ${JSON.stringify(value)}::jsonb, "expiresAt" = now() + ${ttlInterval(ttlMs)}
    WHERE namespace = ${namespace} AND key = ${key} AND value->>'token' = ${token}
  `;
  return count === 1;
}

/** Release a lease only if `token` still owns it (a taken-over lease is left alone). */
export async function releaseLease(namespace: string, key: string, token: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "SharedEphemeralState"
    WHERE namespace = ${namespace} AND key = ${key} AND value->>'token' = ${token}
  `;
}

/**
 * SQL predicate that is true only while `token` still owns the live lease, for
 * fencing a write in the same statement: a holder that lost its lease (stalled
 * past the TTL, taken over elsewhere) cannot land a late write.
 */
export function leaseHeldPredicate(namespace: string, key: string, token: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "SharedEphemeralState" lease
    WHERE lease.namespace = ${namespace} AND lease.key = ${key}
      AND lease.value->>'token' = ${token} AND lease."expiresAt" > now()
  )`;
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

export interface SerializedLock {
  token: string;
  /** Include in the same SQL statement as a write that must not survive lock loss. */
  predicate: Prisma.Sql;
  assertHeld(): Promise<void>;
}

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
  fn: (lock: SerializedLock) => Promise<T>,
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
    const predicate = leaseHeldPredicate(LOCK_NAMESPACE, key, token);
    return await fn({
      token,
      predicate,
      assertHeld: async () => {
        const [row] = await prisma.$queryRaw<Array<{ held: boolean }>>`SELECT ${predicate} AS held`;
        if (lease.lost() || row?.held !== true) throw new Error(`Serialized lock lost: ${key}`);
      },
    });
  } finally {
    if (lease.lost()) {
      log.error('Serialized lock was lost while its holder ran; exclusion was not guaranteed', {
        key,
      });
    }
    await lease.release();
  }
}

/** A value taken from a shared sequence, with the token that took it. */
export interface SequenceReservation {
  value: number;
  token: string;
}

/**
 * Take the next value (0, 1, 2, ...) of a sequence every instance shares.
 * One atomic UPSERT: a live row increments, an absent or expired row restarts
 * at 0. The token is minted before the statement, so a query-layer replay of a
 * committed statement whose reply was lost returns the same value instead of
 * skipping one.
 */
export async function nextSequenceValue(
  namespace: string,
  key: string,
  ttlMs: number
): Promise<SequenceReservation> {
  await reapExpired();
  const token = randomUUID();
  const rows = await prisma.$queryRaw<Array<{ next: number }>>`
    INSERT INTO "SharedEphemeralState" (namespace, key, value, "expiresAt")
    VALUES (${namespace}, ${key}, jsonb_build_object('n', 1, 'token', ${token}::text),
            now() + ${ttlInterval(ttlMs)})
    ON CONFLICT (namespace, key) DO UPDATE
      SET value = CASE
            WHEN "SharedEphemeralState".value->>'token' = ${token} THEN "SharedEphemeralState".value
            WHEN "SharedEphemeralState"."expiresAt" <= now() THEN EXCLUDED.value
            ELSE jsonb_build_object(
              'n', (("SharedEphemeralState".value->>'n')::int + 1), 'token', ${token}::text)
          END,
          "expiresAt" = EXCLUDED."expiresAt"
    RETURNING (value->>'n')::int AS next
  `;
  const next = rows[0]?.next;
  if (typeof next !== 'number')
    throw new Error(`sharedState: sequence ${namespace}/${key} not advanced`);
  return { value: next - 1, token };
}

/**
 * Return a taken value when nothing was taken after it: the sequence moves back
 * only while `token` still holds the latest value. A later reservation (on any
 * instance) keeps its own value, exactly like the per-process counter it replaces.
 */
export async function releaseSequenceValue(
  namespace: string,
  key: string,
  reservation: SequenceReservation
): Promise<void> {
  if (reservation.value === 0) {
    await prisma.$executeRaw`
      DELETE FROM "SharedEphemeralState"
      WHERE namespace = ${namespace} AND key = ${key} AND value->>'token' = ${reservation.token}
        AND (value->>'n')::int = 1
    `;
    return;
  }
  await prisma.$executeRaw`
    UPDATE "SharedEphemeralState"
    SET value = jsonb_build_object('n', ${reservation.value}::int, 'token', NULL)
    WHERE namespace = ${namespace} AND key = ${key} AND value->>'token' = ${reservation.token}
      AND (value->>'n')::int = ${reservation.value + 1}
  `;
}
