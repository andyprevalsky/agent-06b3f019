/** Actual Prisma query extension with a lazy PrismaPromise-shaped fake; no DB. */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

type Query = () => Promise<unknown>;
type Hook = (call: {
  operation: string;
  model?: string;
  args: unknown;
  query: Query;
}) => Promise<unknown>;
let hook: Hook;
const queryLogs: Record<string, unknown>[] = [];
class FakePrismaClient {
  $extends(extension: { query: { $allOperations: Hook } }) {
    hook = extension.query.$allOperations;
    return this;
  }
}

// Prisma promises start only when awaited. Resolving this outside the scoped
// callback would silently lose a no-retry AsyncLocalStorage context.
function lazyQuery(query: Query): Promise<unknown> {
  return {
    then(resolve, reject) {
      return Promise.resolve()
        .then(() => hook({ operation: '$queryRaw', args: {}, query }))
        .then(resolve, reject);
    },
    [Symbol.toStringTag]: 'PrismaPromise',
  } as Promise<unknown>;
}

async function main(): Promise<void> {
  await mock.module('@prisma/client', { namedExports: { PrismaClient: FakePrismaClient } });
  await mock.module('../../providers/logger', {
    namedExports: {
      createLogger: () => ({
        info: (_message: string, data: Record<string, unknown>) => queryLogs.push(data),
        warn: () => undefined,
        error: () => undefined,
      }),
    },
  });
  await mock.module('../../providers/tracing', {
    namedExports: { currentTraceContext: () => ({ span_id: 'synthetic-span' }) },
  });
  const database = await import('../../providers/database');
  // Before the API exists, execute the original query path to reproduce the
  // actual extension replay, rather than failing merely on a missing symbol.
  const scoped =
    (
      database as typeof database & {
        withoutQueryRetry?: <T>(operation: () => Promise<T>) => Promise<T>;
      }
    ).withoutQueryRetry ?? (<T>(operation: () => Promise<T>) => operation());

  test('ambiguous committed raw increment is never replayed, including lazy execution', async () => {
    let balance = 100;
    let calls = 0;
    const ambiguous = Object.assign(new Error('synthetic ambiguous committed result'), {
      code: 'P1017',
    });
    let caught: unknown;
    try {
      await scoped(() =>
        lazyQuery(async () => {
          balance += 200;
          if (++calls === 1) throw ambiguous;
          return balance;
        })
      );
    } catch (error) {
      caught = error;
    }
    assert.equal(balance, 300, `raw increment replayed: ${calls} executions`);
    assert.equal(calls, 1);
    assert.equal(caught, ambiguous);
    assert(
      queryLogs.some(
        (row) =>
          row.operation === '$queryRaw' &&
          row.parent_span_id === 'synthetic-span' &&
          row.status === 'error'
      )
    );
  });

  test('ordinary queries keep transient retries after a scoped rejection', async () => {
    let calls = 0;
    const result = await lazyQuery(async () => {
      if (++calls === 1)
        throw Object.assign(new Error('synthetic acquisition fault'), { code: 'P1001' });
      return 'observed';
    });
    assert.equal(result, 'observed');
    assert.equal(calls, 2);
  });

  test('concurrent no-retry and ordinary queries have isolated retry policies', async () => {
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let guardedCalls = 0;
    let ordinaryCalls = 0;
    const guarded = Promise.resolve(
      scoped(() =>
        lazyQuery(async () => {
          guardedCalls++;
          started();
          await barrier;
          throw Object.assign(new Error('synthetic committed disconnect'), { code: 'P1017' });
        })
      )
    );
    await entered;
    const ordinary = lazyQuery(async () => {
      if (++ordinaryCalls === 1)
        throw Object.assign(new Error('synthetic pool fault'), { code: 'P2024' });
      return 'ordinary';
    });
    release();
    const results = await Promise.allSettled([guarded, ordinary]);
    assert.equal(results[0].status, 'rejected');
    assert.deepEqual(results[1], { status: 'fulfilled', value: 'ordinary' });
    assert.equal(guardedCalls, 1);
    assert.equal(ordinaryCalls, 2);
  });
}
void main();
