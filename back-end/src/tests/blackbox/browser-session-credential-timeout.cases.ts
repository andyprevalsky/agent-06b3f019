import { mock } from 'node:test';
import type { Browser } from 'playwright';
import { prisma } from '../../providers/database';
import {
  prepareSessionCredentials,
  SessionCredentialInjectionError,
} from '../../domains/browser-session/service';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function isOriginPayloadScript(script: string): boolean {
  return (
    script.includes('Symbol.for("rose.origin-state.') && script.includes('localStorage.setItem')
  );
}

/** Fake only SQL transport for the CDP-phase fixture; native SQL is tested below. */
export function mockOriginPayloadSql(rows: Array<{ id: string; entries: unknown }>) {
  const payloads = new Map(rows.map((row) => [row.id, Buffer.from(JSON.stringify(row.entries))]));
  const original = prisma.$transaction.bind(prisma);
  return mock.method(prisma, '$transaction', (...args: unknown[]) => {
    const options = args[1] as { timeout?: number; maxWait?: number } | undefined;
    if (options?.timeout !== 25) return Reflect.apply(original, prisma, args);
    assert(options.maxWait === 25, 'CDP fixture changed the native SQL budget');
    const callback = args[0] as (tx: unknown) => Promise<unknown>;
    return callback({
      $executeRawUnsafe: async (query: string) => {
        assert(
          query.startsWith('CREATE TEMP TABLE') || query.startsWith('ALTER TABLE'),
          'unexpected SQL setup'
        );
        return 0;
      },
      $queryRawUnsafe: async (query: string, id: string) => {
        const payload = payloads.get(id);
        assert(payload, 'SQL fixture requested a foreign origin');
        if (query.includes('WITH serialized AS MATERIALIZED'))
          return [{ rawBytes: payload.byteLength }];
        assert(query.includes('SELECT substring(payload'), 'unexpected SQL payload read');
        return [{ chunk: payload, totalLength: payload.byteLength }];
      },
    });
  });
}

function nativeSqlFault() {
  const started = deferred();
  const finished = deferred();
  let selected = false;
  let nativeError: unknown;
  const original = prisma.$transaction.bind(prisma);
  const transaction = mock.method(prisma, '$transaction', (...args: unknown[]) => {
    const options = args[1] as { timeout?: number; maxWait?: number } | undefined;
    if (selected || options?.timeout !== 25) return Reflect.apply(original, prisma, args);
    assert(options.maxWait === 25, 'native inverse changed SQL maxWait');
    selected = true;
    const callback = args[0] as (tx: unknown) => Promise<unknown>;
    return original(async (tx) => {
      started.resolve();
      await tx.$queryRawUnsafe('SELECT pg_sleep(0.05)');
      return callback(tx);
    }, options)
      .catch((error) => {
        nativeError = error;
        throw error;
      })
      .finally(finished.resolve);
  });
  return {
    started,
    finished,
    transaction,
    get error() {
      return nativeError;
    },
  };
}

function nativeSqlBrowser() {
  const originEntered = deferred();
  let browserMutations = 0;
  let originMutations = 0;
  let callerBrowserCloseCount = 0;
  const browser = {
    contexts: () => [
      {
        addCookies: async () => {
          browserMutations += 1;
        },
        addInitScript: async (script: string) => {
          browserMutations += 1;
          if (isOriginPayloadScript(script)) {
            originMutations += 1;
            originEntered.resolve();
          }
        },
        newPage: async () => {
          browserMutations += 1;
          throw new Error('native SQL failure reached page acquisition');
        },
        evaluate: async (script: string) => {
          if (isOriginPayloadScript(script)) {
            originMutations += 1;
            originEntered.resolve();
          }
        },
      },
    ],
    close: async () => {
      callerBrowserCloseCount += 1;
      throw new Error('native SQL inverse closed caller-owned browser');
    },
  } as unknown as Browser;
  return {
    browser,
    originEntered,
    get mutations() {
      return browserMutations;
    },
    get callerCloses() {
      return callerBrowserCloseCount;
    },
    get origins() {
      return originMutations;
    },
  };
}

async function nativeSqlInverse(sessionId: string, userId: string, earlyExpiry: boolean) {
  const fault = nativeSqlFault();
  const { started, finished, transaction } = fault;
  const observation = nativeSqlBrowser();
  const { browser, originEntered } = observation;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const preparation = prepareSessionCredentials(
      sessionId,
      userId,
      'https://shop.example.co.uk/login',
      { browser }
    ).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await Promise.race([
      started.promise,
      preparation.then(() => {
        throw new Error('native SQL was not selected');
      }),
    ]);
    const mutationsAtSqlStart = observation.mutations;
    if (earlyExpiry) mock.timers.tick(25);
    const outcome = await preparation;
    assert(observation.callerCloses === 0, 'preparation closed caller-owned browser');
    await finished.promise;
    assert(observation.callerCloses === 0, 'native SQL settlement closed caller-owned browser');
    assert(
      fault.error &&
        typeof fault.error === 'object' &&
        'code' in fault.error &&
        fault.error.code === 'P2028',
      'native 25ms SQL expiry was not exercised'
    );
    assert(observation.origins === 0, 'SQL expiry reached origin payload');
    if (earlyExpiry) {
      assert(
        'error' in outcome && outcome.error instanceof SessionCredentialInjectionError,
        'early SQL expiry lost typed error'
      );
      assert(
        outcome.error.message === 'Browser state injection timed out after 25ms',
        'early expiry changed state budget'
      );
      assert(
        outcome.error.credentialPayload.auth_realm === 'example.co.uk',
        'early expiry lost target inventory'
      );
      assert(
        observation.mutations === mutationsAtSqlStart,
        'early SQL expiry allowed browser mutation'
      );
    } else {
      let rejected = false;
      try {
        await Promise.race([
          originEntered.promise,
          Promise.resolve().then(() => {
            throw new Error('origin payload not entered');
          }),
        ]);
      } catch (error) {
        rejected = error instanceof Error && error.message === 'origin payload not entered';
      }
      assert(
        rejected && 'value' in outcome && observation.mutations > mutationsAtSqlStart,
        'unrelated scrollbar falsely satisfied origin phase'
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert(observation.callerCloses === 0, 'late callback closed caller-owned browser');
    assert(
      observation.origins === 0 && (!earlyExpiry || observation.mutations === mutationsAtSqlStart),
      'SQL completion allowed late browser mutation'
    );
    console.log(
      `PASS native SQL expiry early=${earlyExpiry} code=P2028 originPayload=0 observation.mutationsAfterSqlStart=${observation.mutations - mutationsAtSqlStart}`
    );
  } finally {
    transaction.mock.restore();
    mock.timers.reset();
  }
}

export async function verifyNativeSqlTimeoutInverses(sessionId: string, userId: string) {
  const previous = process.env.BROWSER_STATE_INJECTION_TIMEOUT_MS;
  process.env.BROWSER_STATE_INJECTION_TIMEOUT_MS = '25';
  try {
    await nativeSqlInverse(sessionId, userId, false);
    await nativeSqlInverse(sessionId, userId, true);
  } finally {
    if (previous === undefined) delete process.env.BROWSER_STATE_INJECTION_TIMEOUT_MS;
    else process.env.BROWSER_STATE_INJECTION_TIMEOUT_MS = previous;
  }
}
