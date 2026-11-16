#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Unit tests for the interactive-transaction retry policy in
 * providers/database.ts.
 *
 * RCA repro: `createAgentTransaction` runs an interactive `prisma.$transaction`.
 * The client's `$allOperations` retry extension only wraps INDIVIDUAL queries,
 * not `$transaction(fn)`, so a momentary pool-pressure "Unable to start a
 * transaction in the given time" (P2028) surfaced straight to the caller as
 * `POST /api/agents -> 500` with no retry — flaking agent creation (and the
 * chat-lifecycle ratchet) under concurrent load even though the DB was healthy.
 *
 * `retryOnTransientTransactionStart` (extracted so it's testable without a live
 * DB) now gives interactive transactions the same transient-fault resilience.
 * These tests are the regression guard.
 */
import assert from 'node:assert';

import {
  prisma,
  runTransactionWithRetry,
  runReadOnlyTransactionWithRetry,
  isRetryableTransactionError,
  retryOnTransientTransactionStart,
} from '../../providers/database';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

function txStartTimeout(): Error {
  // Shape of the Prisma interactive-transaction start timeout.
  return Object.assign(
    new Error('Transaction API error: Unable to start a transaction in the given time.'),
    {
      code: 'P2028',
    }
  );
}

async function main(): Promise<void> {
  console.log('database transaction-retry unit tests:');

  await test('isRetryableTransactionError: P2028 (transaction start timeout) is retryable', () => {
    assert.strictEqual(isRetryableTransactionError(txStartTimeout()), true);
  });

  await test('isRetryableTransactionError: P2024 (pool timeout) is retryable', () => {
    assert.strictEqual(isRetryableTransactionError({ code: 'P2024' }), true);
  });

  await test('isRetryableTransactionError: matches canonical message with no P-code', () => {
    assert.strictEqual(
      isRetryableTransactionError(new Error('Unable to start a transaction in the given time.')),
      true
    );
  });

  await test('isRetryableTransactionError: a real query error (P2002) is NOT retryable', () => {
    assert.strictEqual(
      isRetryableTransactionError({ code: 'P2002', message: 'Unique constraint' }),
      false
    );
  });

  await test('isRetryableTransactionError: a plain error is NOT retryable', () => {
    assert.strictEqual(isRetryableTransactionError(new Error('boom')), false);
  });

  await test('isRetryableTransactionError: a MID-transaction P2028 is NOT retryable', () => {
    // P2028 also covers "Transaction already closed" — a timeout DURING the
    // body, which may have partially executed. Only the start-timeout message
    // is safe to retry; the bare P2028 code is not.
    assert.strictEqual(
      isRetryableTransactionError({
        code: 'P2028',
        message: 'Transaction API error: Transaction already closed: A query cannot be executed.',
      }),
      false
    );
  });

  await test('retries the transient start timeout, then succeeds', async () => {
    let attempts = 0;
    const result = await retryOnTransientTransactionStart(async () => {
      attempts += 1;
      if (attempts < 3) throw txStartTimeout();
      return 'ok';
    }, 5);
    assert.strictEqual(result, 'ok');
    assert.strictEqual(attempts, 3, 'should have retried twice before succeeding');
  });

  await test('does NOT retry a non-transient error — throws on the first attempt', async () => {
    let attempts = 0;
    await assert.rejects(
      retryOnTransientTransactionStart(async () => {
        attempts += 1;
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }, 5),
      /Unique constraint failed/
    );
    assert.strictEqual(attempts, 1, 'non-transient errors must not be retried');
  });

  await test('exhausts maxRetries on a persistent transient error and rethrows it', async () => {
    let attempts = 0;
    await assert.rejects(
      retryOnTransientTransactionStart(async () => {
        attempts += 1;
        throw txStartTimeout();
      }, 3),
      /Unable to start a transaction/
    );
    assert.strictEqual(attempts, 3, 'should attempt exactly maxRetries times');
  });

  await test('maxRetries <= 0 still runs the operation exactly once', async () => {
    let attempts = 0;
    const result = await retryOnTransientTransactionStart(async () => {
      attempts += 1;
      return 'ok';
    }, 0);
    assert.strictEqual(result, 'ok');
    assert.strictEqual(
      attempts,
      1,
      'a non-positive maxRetries must still run once, not zero times'
    );
  });

  await test('NaN maxRetries normalizes to the default (3 attempts), not zero', async () => {
    let attempts = 0;
    await assert.rejects(
      retryOnTransientTransactionStart(async () => {
        attempts += 1;
        throw txStartTimeout();
      }, Number.NaN),
      /Unable to start a transaction/
    );
    assert.strictEqual(
      attempts,
      3,
      'NaN must fall back to the finite default, not a zero-iteration loop'
    );
  });

  await test('Infinity maxRetries normalizes to the default (bounded), not unbounded', async () => {
    let attempts = 0;
    await assert.rejects(
      retryOnTransientTransactionStart(async () => {
        attempts += 1;
        throw txStartTimeout();
      }, Number.POSITIVE_INFINITY),
      /Unable to start a transaction/
    );
    assert.strictEqual(attempts, 3, 'Infinity must be bounded to the finite default');
  });

  await test('does NOT retry once the transaction body has entered (mid-body failure)', async () => {
    // A retryable-LOOKING error (P2024) that surfaces AFTER the callback body
    // began must not be replayed — the body may have partially executed.
    let attempts = 0;
    await assert.rejects(
      retryOnTransientTransactionStart(async (markBodyEntered) => {
        attempts += 1;
        markBodyEntered();
        throw Object.assign(new Error('Timed out fetching a new connection from the pool'), {
          code: 'P2024',
        });
      }, 5),
      /Timed out fetching a new connection/
    );
    assert.strictEqual(attempts, 1, 'a failure after body entry must never be retried');
  });

  await test('retries a pre-body failure but stops the moment the body enters', async () => {
    // First attempt fails before body entry (retry); second attempt enters the
    // body then fails with a retryable-looking error (must NOT retry).
    let attempts = 0;
    await assert.rejects(
      retryOnTransientTransactionStart(async (markBodyEntered) => {
        attempts += 1;
        if (attempts === 1) throw txStartTimeout(); // pre-body → retry
        markBodyEntered();
        throw Object.assign(new Error('Timed out fetching a new connection from the pool'), {
          code: 'P2024',
        }); // mid-body → stop
      }, 5),
      /Timed out fetching a new connection/
    );
    assert.strictEqual(attempts, 2, 'retry the pre-body failure, then stop once the body enters');
  });

  await test('transaction acquisition and body share the remaining caller deadline', async () => {
    const original = prisma.$transaction;
    const originalNow = Date.now;
    let clock = 1_000;
    const seen: { maxWait: number; timeout: number }[] = [];
    try {
      Date.now = () => clock;
      prisma.$transaction = (async (
        operation: (tx: unknown) => Promise<string>,
        options: { maxWait: number; timeout: number }
      ) => {
        seen.push(options);
        assert(options.maxWait + options.timeout <= 40);
        clock += options.maxWait;
        return operation({});
      }) as typeof prisma.$transaction;
      assert.equal(await runTransactionWithRetry(async () => 'ok', { deadlineAtMs: 1_040 }), 'ok');
      assert.deepEqual(seen, [{ maxWait: 20, timeout: 20 }]);
      clock = 1_040;
      await assert.rejects(
        runTransactionWithRetry(async () => 'late', { deadlineAtMs: 1_040 }),
        /deadline elapsed/
      );
      assert.equal(seen.length, 1, 'expired caller must not acquire a transaction');
    } finally {
      prisma.$transaction = original;
      Date.now = originalNow;
    }
  });

  await test('expired acquisition failures do not retry and mid-body deadlines do not replay writes', async () => {
    const originalNow = Date.now;
    let clock = 1_000;
    let attempts = 0;
    try {
      Date.now = () => clock;
      await assert.rejects(
        retryOnTransientTransactionStart(
          async () => {
            attempts++;
            clock = 1_050;
            throw txStartTimeout();
          },
          3,
          1_040
        ),
        /Unable to start/
      );
      assert.equal(attempts, 1);
      clock = 1_000;
      await assert.rejects(
        retryOnTransientTransactionStart(
          async (entered) => {
            attempts++;
            entered();
            throw txStartTimeout();
          },
          3,
          1_040
        ),
        /Unable to start/
      );
      assert.equal(attempts, 2);
    } finally {
      Date.now = originalNow;
    }
  });

  // Regression (deploy-agents run 43822297504): #2285 gave the read-only
  // transaction a 5 s body timeout, so during a slow-DB window (one query took
  // 5987 ms, p50 120 ms) assertWorkerDeploymentOwned failed 5 of 5 attempts with
  // P2028 "Transaction already closed ... timeout 5000 ms". Before #2285 it ran
  // under runTransactionWithRetry's 10 s body budget. Real local Postgres.
  await test('read-only transaction keeps a 10 s body budget: a 6 s body succeeds on attempt 1', async () => {
    let attempts = 0;
    const readOnly = await runReadOnlyTransactionWithRetry(async (tx) => {
      attempts++;
      await tx.$executeRaw`SELECT pg_sleep(6)`;
      const [row] = await tx.$queryRaw<Array<{ transaction_read_only: string }>>`
        SHOW transaction_read_only`;
      return row.transaction_read_only;
    });
    assert.strictEqual(attempts, 1, 'a 6 s read-only body must not time out and replay');
    assert.strictEqual(readOnly, 'on', 'the transaction must stay Postgres READ ONLY');
  });

  await prisma.$disconnect();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  ❌ ${f}`);
    process.exit(1);
  }
}

void main();
