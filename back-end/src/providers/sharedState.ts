/**
 * Cross-instance shared state, backed by Postgres (the only store every
 * backend instance shares).
 *
 *   in-process Map / Set / promise chain        Postgres
 *   ───────────────────────────────────         ─────────────────────────────
 *   short-lived flow state (PKCE, ...)   ──►    putEphemeral / getEphemeral / takeEphemeral
 *   "first one wins" dedupe / leases     ──►    acquireLease / releaseLease
 *   per-key mutual exclusion             ──►    withSerializedLock
 *
 * Everything here is keyed per flow, user or item: one row or one advisory
 * lock per key, so cost grows with the work being coordinated, never with the
 * number of instances or agents. Expired rows are reaped in small batches by
 * the writers, so the table stays bounded without a cron.
 */

import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import { randomUUID } from './crypto';

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

/**
 * Run `fn` while holding a Postgres transaction-scoped advisory lock on `key`,
 * so callers with the same key run one at a time across every instance, in
 * arrival order. The lock lives on the transaction's connection and is
 * released when it ends, including on crash. `fn` uses the normal client; the
 * transaction only carries the lock.
 */
export async function withSerializedLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; maxWaitMs?: number } = {}
): Promise<T> {
  return runTransactionWithRetry(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      return fn();
    },
    { timeout: opts.timeoutMs ?? 120_000, maxWait: opts.maxWaitMs ?? 10_000 }
  );
}
