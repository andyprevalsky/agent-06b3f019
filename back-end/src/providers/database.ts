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

// --- Supabase Supavisor (transaction pooler) client-connection budget --------
//
// Prod talks to Postgres through Supavisor in transaction-pooling mode (port
// 6543). Supavisor accepts at most POOLER_MAX_CLIENT_CONN *client* connections
// in total, then rejects new ones with
// `FATAL: (EMAXCONN) max client connections reached`. Each backend instance's
// Prisma pool opens up to `connection_limit` client connections against it, so
// the pooler cap — NOT Postgres `max_connections` — is the ceiling we must
// respect. The hard invariant:
//
//   backendInstances * DEPLOY_OVERLAP * (connection_limit + FAST_CACHE_POOL_LIMIT)
//     + RESERVED <= POOLER_MAX_CLIENT_CONN
//
// Notes on each term:
//   - Each backend instance holds TWO Prisma pools against the same pooler in
//     prod: this main pool, and the Fast Mode cache pool (fastCacheStore.ts,
//     which falls back to DATABASE_URL in production). Both count toward the
//     client cap, so the fast-cache pool is subtracted from the per-instance
//     budget below. fastCacheStore imports FAST_CACHE_POOL_LIMIT from here so
//     the two files can never disagree about its size.
//   - The Fly agent fleet does NOT appear here. Workers reach the DB only over
//     the backend HTTP API and hold ZERO DB connections; only *backend*
//     instances open Prisma pools. (The old code sized this to Fly's
//     max_concurrent_activities — a phantom coupling across an HTTP boundary.)
//   - DEPLOY_OVERLAP = 2: a Render rolling deploy boots the new instance before
//     draining the old, so two backend instances briefly run at once. This is
//     the ONLY time instance count exceeds BACKEND_INSTANCES, and it is exactly
//     the window the historical EMAXCONN incidents fired in.
//   - RESERVED covers the DIRECT_URL migration connection, ad-hoc scripts, and a
//     local stack doing a prod-DB sync — none of which are Prisma-pool clients.
//
// We DERIVE connection_limit from this invariant (boot-time arithmetic from
// declared capacity — no runtime coordination, nothing to race) instead of
// hardcoding a magic number that can silently violate the cap. To scale the
// backend out later, raise BACKEND_INSTANCES; the limit re-derives while the
// budget still fits — and when the declared fleet CANNOT fit under the cap
// (e.g. too many instances for the fast-cache pool to share the budget),
// derivation throws at boot rather than shipping a config that EMAXCONNs at
// the next deploy. A boot failure keeps Render on the old healthy instance;
// a silent under-floor clamp would take prod down slowly instead.
// computeProdConnectionLimit is exported so a structural test can assert the
// invariant can never regress.
const POOLER_MAX_CLIENT_CONN = intEnv('POOLER_MAX_CLIENT_CONN', 400);
const BACKEND_INSTANCES = intEnv('BACKEND_INSTANCES', 1);
const RESERVED_CLIENT_CONN = intEnv('POOLER_RESERVED_CLIENT_CONN', 40);
const DEPLOY_OVERLAP = 2; // rolling deploy transiently doubles instance count
const LOCAL_POOL_SIZE = 30; // direct Docker Postgres: each conn ~10MB, cap to avoid OOM

/** Size of the Fast Mode cache Prisma pool (fastCacheStore.ts). Lives here —
 *  next to the budget it is subtracted from — and is imported by fastCacheStore,
 *  so the invariant math and the actual pool can never drift apart. */
export const FAST_CACHE_POOL_LIMIT = intEnv('FAST_CACHE_DB_POOL', 75);

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Below this, a pool can't serve normal request concurrency — a config whose
 *  derivation lands under it is a misconfiguration, not a size to clamp to. */
const MIN_VIABLE_POOL = 10;

/**
 * Largest per-instance Prisma `connection_limit` that keeps the whole backend
 * fleet — including a 2x rolling-deploy overlap — under the Supavisor client cap.
 * Pure and exported so `pool-invariant.test.ts` can prove the cap holds.
 *
 * Throws when the declared fleet cannot fit under the cap with a viable main
 * pool (clamping to a floor instead would silently exceed the cap: the clamped
 * pools would still open floor+fastCache connections per instance, reproducing
 * the exact EMAXCONN failure this derivation exists to prevent).
 */
export function computeProdConnectionLimit(opts?: {
  maxClientConn?: number;
  backendInstances?: number;
  reserved?: number;
  deployOverlap?: number;
  fastCachePool?: number;
}): number {
  const maxClientConn = opts?.maxClientConn ?? POOLER_MAX_CLIENT_CONN;
  const backendInstances = opts?.backendInstances ?? BACKEND_INSTANCES;
  const reserved = opts?.reserved ?? RESERVED_CLIENT_CONN;
  const deployOverlap = opts?.deployOverlap ?? DEPLOY_OVERLAP;
  const fastCachePool = opts?.fastCachePool ?? FAST_CACHE_POOL_LIMIT;

  // Explicit opts bypass intEnv's guards; a zero/NaN instance count would turn
  // the division below into Infinity/NaN, which slips past the < floor check.
  for (const [name, value] of Object.entries({
    maxClientConn,
    backendInstances,
    reserved,
    deployOverlap,
    fastCachePool,
  })) {
    if (
      !Number.isFinite(value) ||
      (value <= 0 && name !== 'reserved' && name !== 'fastCachePool')
    ) {
      throw new Error(`DB pool config: ${name} must be a finite positive number, got ${value}`);
    }
    if (value < 0) {
      throw new Error(`DB pool config: ${name} must be non-negative, got ${value}`);
    }
  }

  const budget = maxClientConn - reserved;
  const perInstance = Math.floor(budget / (backendInstances * deployOverlap));
  // The fast-cache pool shares this instance's slice of the budget in prod
  // (it falls back to DATABASE_URL there), so the main pool gets the remainder.
  const derived = perInstance - fastCachePool;
  if (derived < MIN_VIABLE_POOL) {
    throw new Error(
      `DB pool budget violation: ${backendInstances} backend instance(s) x ` +
        `${deployOverlap} deploy-overlap x (main pool + fast-cache ${fastCachePool}) + ` +
        `reserved ${reserved} cannot fit under the Supavisor client cap ${maxClientConn} ` +
        `(derived main pool ${derived} < ${MIN_VIABLE_POOL}). Raise POOLER_MAX_CLIENT_CONN ` +
        `(bigger compute tier), lower BACKEND_INSTANCES/FAST_CACHE_DB_POOL, or move the ` +
        `fast-cache to its own database.`
    );
  }
  return derived;
}

// Add connection pool parameters if not already present
function getConnectionUrl(): string {
  const url = process.env.DATABASE_URL ?? '';

  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
  // Explicit override wins (e.g. a one-off script that needs a tiny pool); else
  // local uses a fixed small pool and prod derives from the pooler invariant.
  const explicit = intEnv('DB_CONNECTION_LIMIT', 0);
  const poolSize =
    explicit > 0 ? explicit : isLocal ? LOCAL_POOL_SIZE : computeProdConnectionLimit();

  const params: string[] = [];
  if (!url.includes('connection_limit')) params.push(`connection_limit=${poolSize}`);
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
