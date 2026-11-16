import { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import dotenv from 'dotenv';
import { createLogger } from './logger';
import { retryWithBackoff } from './retry';
import { currentTraceContext } from './tracing';
import { testEntrypointDatabaseRefusal } from '../utils/localDatabaseUrl';
import { demoCacheEnv } from './demoCacheEnv';

// Ensure env vars are loaded before accessing DATABASE_URL
dotenv.config();

const log = createLogger('Prisma');

/**
 * Why a query from this process must be refused, or null. A test file run
 * directly (`npx tsx src/tests/...`) skips the runners that point DATABASE_URL
 * at local Postgres, so dotenv hands it back-end/.env's production pooler; unit
 * tests wrote fixture rows to prod that way on 2026-10-23 and 2026-10-27.
 * Importing this module stays harmless (structural tests only read config).
 */
export function testEntryRemoteDatabaseReason(
  entry: string | undefined = process.argv[1],
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const allowRemote =
    env.BACKEND_UNIT_ALLOW_REMOTE_DB === '1' || env.BLACKBOX_TEST_ALLOW_REMOTE_DATABASE === '1';
  return testEntrypointDatabaseRefusal(entry, env.DATABASE_URL, allowRemote ? '1' : undefined);
}

const TEST_ENTRY_REMOTE_DATABASE = testEntryRemoteDatabaseReason();
const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Retryable Prisma error codes:
// P1001 - Can't reach database server
// P1017 - Server has closed the connection (Supabase pooler idle timeout)
// P2024 - Timed out fetching a new connection from the pool
const RETRYABLE_ERROR_CODES = new Set(['P1001', 'P1017', 'P2024']);

// Non-idempotent writes must not replay after an ambiguous committed response.
// Keep the same guarded/traced client and pool, with isolated async-call policy.
const queryRetriesDisabled = new AsyncLocalStorage<boolean>();

export function withoutQueryRetry<T>(operation: () => Promise<T>): Promise<T> {
  return queryRetriesDisabled.run(true, async () => {
    const result = await operation();
    return result;
  });
}

/** Transient connection/pool faults that a single query may safely retry. */
function isRetryableQueryError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code);
}

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
  maxRetries = 3,
  deadlineAtMs?: number
): Promise<T> {
  let bodyEntered = false;
  return retryWithBackoff(
    () => {
      if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs)
        throw new Error('Transaction deadline elapsed before acquisition');
      bodyEntered = false; // reset per attempt
      return run(() => {
        bodyEntered = true;
      });
    },
    {
      maxRetries: normalizeMaxRetries(maxRetries),
      initialBackoffMs: 100,
      isRetryable: (error) =>
        !bodyEntered &&
        (deadlineAtMs === undefined || Date.now() < deadlineAtMs) &&
        isRetryableTransactionError(error),
      ...(deadlineAtMs === undefined
        ? {}
        : {
            getBackoffDelayMs: (_error: unknown, attempt: number) =>
              Math.min(100 * 2 ** (attempt - 1), Math.max(0, deadlineAtMs - Date.now())),
          }),
      component: 'PrismaTx',
    }
  );
}

/**
 * A transaction that Postgres itself holds read-only (`SET TRANSACTION READ
 * ONLY`), so replaying it after the body started cannot duplicate a write.
 * Unlike runTransactionWithRetry it therefore also retries a database error
 * raised mid-body (run 43785616839: a cutover ownership check died on its
 * database connection while ownership itself held). Errors the body throws
 * itself (plain `Error`s such as a lost lease) are decisions, not transport
 * failures, and are never retried. The body keeps runTransactionWithRetry's
 * 10 s budget: a 5 s budget timed out every attempt (P2028) of a healthy
 * ownership check during a slow-DB window (run 43822297504, one query 5987 ms).
 * Default configured waits, body timeouts and backoff total 45.75 s
 * (3 x (5 s + 10 s) + 0.25 s + 0.5 s). This is budget accounting, not a
 * wall-clock guarantee: an in-flight query or advisory-lock wait can outlast
 * Prisma's callback timeout. The cutover controller's 60 s subprocess timeout
 * also covers other work; assert-mutable runs a second transaction.
 */
export async function runReadOnlyTransactionWithRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { maxRetries?: number; initialBackoffMs?: number } = {}
): Promise<T> {
  return retryWithBackoff(
    () =>
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return fn(tx);
        },
        { maxWait: 5_000, timeout: 10_000 }
      ),
    {
      maxRetries: normalizeMaxRetries(options.maxRetries ?? 3),
      initialBackoffMs: options.initialBackoffMs ?? 250,
      isRetryable: isPrismaDatabaseError,
      component: 'PrismaReadOnlyTx',
    }
  );
}

function isPrismaDatabaseError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientInitializationError
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
//   backendInstances * DEPLOY_OVERLAP * (connection_limit + DEMO_CACHE_POOL_LIMIT)
//     + RESERVED + NONPROD <= POOLER_MAX_CLIENT_CONN
//
// Notes on each term:
//   - Each backend instance holds TWO Prisma pools against the same pooler in
//     prod: this main pool, and the DEMO cache pool (demoCacheStore.ts,
//     which falls back to DATABASE_URL in production). Both count toward the
//     client cap, so the demo-cache pool is subtracted from the per-instance
//     budget below. demoCacheStore imports DEMO_CACHE_POOL_LIMIT from here so
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
//   - NONPROD is the slice left for dev and benchmark stacks, which reach the
//     same pooler as the same user for the shared DEMO cache: a 50-guest DEMO
//     fleet at 4 clients plus five stacks at 20 = 300. Production used to
//     budget the whole cap for itself during a deploy overlap, so any such
//     client could push it into EMAXCONN (2026-10-10/11).
//
// We DERIVE connection_limit from this invariant (boot-time arithmetic from
// declared capacity — no runtime coordination, nothing to race) instead of
// hardcoding a magic number that can silently violate the cap. To scale the
// backend out later, raise BACKEND_INSTANCES; the limit re-derives while the
// budget still fits — and when the declared fleet CANNOT fit under the cap
// (e.g. too many instances for the demo-cache pool to share the budget),
// derivation throws at boot rather than shipping a config that EMAXCONNs at
// the next deploy. A boot failure keeps Render on the old healthy instance;
// a silent under-floor clamp would take prod down slowly instead.
// computeProdConnectionLimit is exported so a structural test can assert the
// invariant can never regress.
const POOLER_MAX_CLIENT_CONN = intEnv('POOLER_MAX_CLIENT_CONN', 1000);
const BACKEND_INSTANCES = intEnv('BACKEND_INSTANCES', 1);
const RESERVED_CLIENT_CONN = nonNegativeIntEnv('POOLER_RESERVED_CLIENT_CONN', 40);
// 0 hands the whole slice back to production in an emergency.
const NONPROD_CLIENT_BUDGET = nonNegativeIntEnv('POOLER_NONPROD_CLIENT_BUDGET', 300);
const DEPLOY_OVERLAP = 2; // rolling deploy transiently doubles instance count
const LOCAL_POOL_SIZE = 30; // direct Docker Postgres: each conn ~10MB, cap to avoid OOM

/** Size of the DEMO cache Prisma pool (demoCacheStore.ts). Lives here —
 *  next to the budget it is subtracted from — and is imported by demoCacheStore,
 *  so the invariant math and the actual pool can never drift apart. */
export const DEMO_CACHE_POOL_LIMIT = intEnvValue(demoCacheEnv('DEMO_CACHE_DB_POOL'), 75);

function intEnv(name: string, fallback: number): number {
  return intEnvValue(process.env[name], fallback);
}

function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function intEnvValue(raw: string | undefined, fallback: number): number {
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
 * pools would still open floor+demoCache connections per instance, reproducing
 * the exact EMAXCONN failure this derivation exists to prevent).
 */
export function computeProdConnectionLimit(opts?: {
  maxClientConn?: number;
  backendInstances?: number;
  reserved?: number;
  deployOverlap?: number;
  demoCachePool?: number;
  nonProdBudget?: number;
}): number {
  const maxClientConn = opts?.maxClientConn ?? POOLER_MAX_CLIENT_CONN;
  const backendInstances = opts?.backendInstances ?? BACKEND_INSTANCES;
  const reserved = opts?.reserved ?? RESERVED_CLIENT_CONN;
  const deployOverlap = opts?.deployOverlap ?? DEPLOY_OVERLAP;
  const demoCachePool = opts?.demoCachePool ?? DEMO_CACHE_POOL_LIMIT;
  const nonProdBudget = opts?.nonProdBudget ?? NONPROD_CLIENT_BUDGET;

  // Explicit opts bypass intEnv's guards; a zero/NaN instance count would turn
  // the division below into Infinity/NaN, which slips past the < floor check.
  for (const [name, value] of Object.entries({
    maxClientConn,
    backendInstances,
    reserved,
    deployOverlap,
    demoCachePool,
    nonProdBudget,
  })) {
    if (
      !Number.isFinite(value) ||
      (value <= 0 && name !== 'reserved' && name !== 'demoCachePool' && name !== 'nonProdBudget')
    ) {
      throw new Error(`DB pool config: ${name} must be a finite positive number, got ${value}`);
    }
    if (value < 0) {
      throw new Error(`DB pool config: ${name} must be non-negative, got ${value}`);
    }
  }

  const budget = maxClientConn - reserved - nonProdBudget;
  const perInstance = Math.floor(budget / (backendInstances * deployOverlap));
  // The demo-cache pool shares this instance's slice of the budget in prod
  // (it falls back to DATABASE_URL there), so the main pool gets the remainder.
  const derived = perInstance - demoCachePool;
  if (derived < MIN_VIABLE_POOL) {
    throw new Error(
      `DB pool budget violation: ${backendInstances} backend instance(s) x ` +
        `${deployOverlap} deploy-overlap x (main pool + demo-cache ${demoCachePool}) + ` +
        `reserved ${reserved} + non-production ${nonProdBudget} cannot fit under the Supavisor client cap ${maxClientConn} ` +
        `(derived main pool ${derived} < ${MIN_VIABLE_POOL}). Raise POOLER_MAX_CLIENT_CONN ` +
        `(bigger compute tier), lower BACKEND_INSTANCES/DEMO_CACHE_DB_POOL, or move the ` +
        `demo-cache to its own database.`
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

/** Connections this process's Prisma pool may open: the `connection_limit` in effect. */
export function databasePoolLimit(): number {
  const match = /[?&]connection_limit=(\d+)/.exec(getConnectionUrl());
  return match ? Number(match[1]) : LOCAL_POOL_SIZE;
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
        if (TEST_ENTRY_REMOTE_DATABASE !== null) throw new Error(TEST_ENTRY_REMOTE_DATABASE);
        return retryWithBackoff(
          async () => {
            const trace = currentTraceContext();
            const queryStart = Date.now();
            const logQuery = (status: 'ok' | 'error') =>
              log.info('db.query', {
                span_name: 'db.query',
                parent_span_id: trace?.span_id,
                request_id: trace?.request_id,
                agent_id: trace?.agent_id,
                model,
                operation,
                duration_ms: Date.now() - queryStart,
                status,
              });
            try {
              const result = await query(args);
              logQuery('ok');
              return result;
            } catch (error: unknown) {
              logQuery('error');
              throw error;
            }
          },
          {
            maxRetries: queryRetriesDisabled.getStore() === true ? 1 : 3,
            initialBackoffMs: 100,
            isRetryable: isRetryableQueryError,
            component: `Prisma ${model ?? 'raw'}.${operation}`,
          }
        );
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
  options?: { maxWait?: number; timeout?: number; maxRetries?: number; deadlineAtMs?: number }
): Promise<T> {
  return retryOnTransientTransactionStart(
    (markBodyEntered) => {
      let maxWait = options?.maxWait ?? 5_000;
      let timeout = options?.timeout ?? 10_000;
      if (options?.deadlineAtMs !== undefined) {
        const remaining = Math.floor(options.deadlineAtMs - Date.now());
        if (!Number.isFinite(remaining) || remaining < 2)
          throw new Error('Transaction deadline elapsed before acquisition');
        // Acquisition and body share the caller's remaining budget. Prisma
        // owns cancellation/rollback; no detached Promise.race can keep writing.
        maxWait = Math.min(maxWait, Math.floor(remaining / 2));
        timeout = Math.min(timeout, remaining - maxWait);
      }
      return prisma.$transaction(
        (tx) => {
          // The callback has now started — any failure from here on may have
          // partially executed, so it must not be retried.
          markBodyEntered();
          return fn(tx);
        },
        {
          maxWait,
          timeout,
        }
      );
    },
    options?.maxRetries ?? 3,
    options?.deadlineAtMs
  );
}
