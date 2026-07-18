import { type Prisma, PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { createLogger } from './logger';
import { retryWithBackoff } from './retry';
import { currentTraceContext } from './tracing';

// Ensure env vars are loaded before accessing DATABASE_URL
dotenv.config();

const log = createLogger('Prisma');
const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Retryable Prisma error codes:
// P1001 - Can't reach database server
// P1017 - Server has closed the connection (Supabase pooler idle timeout)
// P2024 - Timed out fetching a new connection from the pool
const RETRYABLE_ERROR_CODES = new Set(['P1001', 'P1017', 'P2024']);

// A retry of an interactive transaction is ONLY safe when the failure provably
// happened BEFORE the callback body ran — otherwise a retry could double any
// non-DB side effects the body performed. So we retry exactly two provably
// pre-body conditions:
//
//   1. The start-timeout message "Unable to start a transaction in the given
//      time" — the interactive `$transaction(fn)` never acquired a connection
//      within maxWait under momentary pool pressure, so the body never began.
//      This is one variant of P2028; we deliberately match the MESSAGE, not the
//      P2028 code, because other P2028s (e.g. "Transaction already closed" — a
//      timeout DURING the body) may have partially executed and are NOT safe to
//      blindly retry in a general helper.
//   2. Connection-acquisition errors that fire before the body: P2024 (pool
//      fetch timeout), P1001 (can't reach DB), P1017 (server closed connection).
//      For an interactive transaction these surface while establishing the
//      connection, i.e. before the callback runs.
export function isRetryableTransactionError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown };
  if (typeof e.message === 'string' && e.message.includes('Unable to start a transaction')) {
    return true;
  }
  return typeof e.code === 'string' && RETRYABLE_ERROR_CODES.has(e.code);
}

/** Normalize a caller-supplied retry count to a finite integer >= 1, so a NaN
 *  (zero attempts → reject with undefined) or Infinity (unbounded) can't slip
 *  through to the retry loop. */
function normalizeMaxRetries(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 3;
}

/**
 * Bounded retry for an interactive transaction that can hit a transient
 * transaction-START failure. Delegates to the canonical retryWithBackoff
 * (providers/retry.ts).
 *
 * `run` receives a `markBodyEntered` callback that it MUST invoke the instant
 * the transaction callback body begins executing. A retryable-looking error
 * (P2024/P1001/P1017, or the start-timeout message) is only actually retried
 * when the body did NOT enter this attempt — because those same conditions can
 * also surface AFTER the callback started (a mid-body query fetching a
 * connection, the server dropping the connection, etc.), and replaying a
 * partially-executed callback is unsafe. Gating on body entry means we retry
 * exactly the failures proven to occur before any side effect ran.
 *
 * Extracted from runTransactionWithRetry so the policy is unit-testable without
 * a live database (inject any `run`).
 */
export async function retryOnTransientTransactionStart<T>(
  run: (markBodyEntered: () => void) => Promise<T>,
  maxRetries = 3
): Promise<T> {
  let bodyEntered = false;
  return retryWithBackoff(
    () => {
      bodyEntered = false; // reset per attempt
      return run(() => {
        bodyEntered = true;
      });
    },
    {
      maxRetries: normalizeMaxRetries(maxRetries),
      initialBackoffMs: 100,
      isRetryable: (error) => !bodyEntered && isRetryableTransactionError(error),
      component: 'PrismaTx',
    }
  );
}

// Add connection pool parameters if not already present
function getConnectionUrl(): string {
  const url = process.env.DATABASE_URL ?? '';

  // Production (Supabase pooler) can handle 250 connections; local Docker Postgres
  // uses direct connections that each consume ~10MB, so cap at 30 to avoid OOM.
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
  const defaultPoolSize = isLocal ? 30 : 250;

  const params: string[] = [];
  if (!url.includes('connection_limit')) params.push(`connection_limit=${defaultPoolSize}`);
  if (!url.includes('pool_timeout')) params.push('pool_timeout=30');

  if (params.length === 0) return url;

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${params.join('&')}`;
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
    // Connection pool configuration for Supabase Transaction Pooler (port 6543)
    datasources: {
      db: {
        url: getConnectionUrl(),
      },
    },
  }).$extends({
    query: {
      async $allOperations({ operation, model, args, query }) {
        const maxRetries = 3;
        let lastError;

        // eslint-disable-next-line no-restricted-syntax -- Prisma $extends middleware can't use retryWithBackoff (wraps query(args) inside $allOperations)
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          const trace = currentTraceContext();
          const queryStart = Date.now();
          try {
            const result = await query(args);
            log.info('db.query', {
              span_name: 'db.query',
              parent_span_id: trace?.span_id,
              request_id: trace?.request_id,
              agent_id: trace?.agent_id,
              model,
              operation,
              duration_ms: Date.now() - queryStart,
              status: 'ok',
            });
            return result;
          } catch (error: unknown) {
            log.info('db.query', {
              span_name: 'db.query',
              parent_span_id: trace?.span_id,
              request_id: trace?.request_id,
              agent_id: trace?.agent_id,
              model,
              operation,
              duration_ms: Date.now() - queryStart,
              status: 'error',
            });
            lastError = error;
            const prismaError = error as { code?: string };

            if (
              typeof prismaError.code === 'string' &&
              RETRYABLE_ERROR_CODES.has(prismaError.code) &&
              attempt < maxRetries
            ) {
              log.warn(
                `${prismaError.code} on ${model}.${operation} (attempt ${attempt}/${maxRetries}), retrying...`
              );
              await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
              continue;
            }

            throw error;
          }
        }

        throw lastError;
      },
    },
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/**
 * Run an interactive transaction with bounded retry on transient
 * transaction-START failures.
 *
 * The `$allOperations` retry extension above only wraps INDIVIDUAL queries — it
 * does NOT intercept `prisma.$transaction(fn)`. So when the pool is momentarily
 * saturated, the interactive transaction fails to start with P2028 "Unable to
 * start a transaction in the given time" and that surfaces straight to the
 * caller as a hard error (e.g. `POST /api/agents` → 500) with no retry. Under
 * concurrent load (a fan-out or the chat-lifecycle ratchet spinning up many
 * agents at once) this makes agent creation flaky even though the DB is healthy.
 *
 * This wrapper gives interactive transactions the same transient-fault
 * resilience the per-query path already has, but only retries failures proven
 * to occur BEFORE the callback body ran (see retryOnTransientTransactionStart):
 * it marks body entry from inside the `$transaction` callback, so a mid-body
 * failure is never replayed. A slightly larger `maxWait` gives the start more
 * headroom, and backoff lets the pool drain between attempts.
 */
export async function runTransactionWithRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number; maxRetries?: number }
): Promise<T> {
  return retryOnTransientTransactionStart(
    (markBodyEntered) =>
      prisma.$transaction(
        (tx) => {
          // The callback has now started — any failure from here on may have
          // partially executed, so it must not be retried.
          markBodyEntered();
          return fn(tx);
        },
        {
          maxWait: options?.maxWait ?? 5_000,
          timeout: options?.timeout ?? 10_000,
        }
      ),
    options?.maxRetries ?? 3
  );
}
