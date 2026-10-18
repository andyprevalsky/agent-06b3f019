import assert from 'node:assert/strict';
import test, { TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { HttpRequest } from '@smithy/core/protocols';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  deferred,
  loadDeclaration,
  loadOwner,
  putBoundary,
} from './benchmark-hub-admission.testkit';
import {
  assertHubStorageOwnership,
  ownedHubStorageRequest,
  withHubStorageOwnership,
  HUB_SQL_TIMEOUT_MS,
} from '../../providers/benchmarkHubStorageOwnership';

function clock(t: TestContext) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  return {
    expire: () => {
      now = HUB_SQL_TIMEOUT_MS + 1;
    },
  };
}
function storage<T>(name: string, bindings: Record<string, unknown>): T {
  const previous = process.env.BENCHMARK_HUB_OWNER_SOURCE_PATH;
  process.env.BENCHMARK_HUB_OWNER_SOURCE_PATH = `${process.cwd()}/src/providers/benchmarkHubStorage.ts`;
  try {
    const versions = new Map([['benchmark-hub-v2/owner/runs/fixture.json', null]]);
    return loadDeclaration<T>(name, {
      EPOCH: 'owner',
      KEY_PREFIX: 'benchmark-hub-v2/owner',
      WRITES_ENABLED: true,
      randomUUID,
      hubStorageVersions: () => versions,
      assertHubStorageOwnership,
      ownedHubStorageRequest,
      Buffer,
      process: { env: { R2_BUCKET_TRACE_ARCHIVE: 'fixture' } },
      LOCAL_DIR: '/fixture-never-used',
      // The isolated-R2 scope is an imported boundary; production scope is inactive here.
      isolatedObjectKey: () => null,
      isolatedR2Prefix: () => null,
      ...bindings,
    });
  } finally {
    if (previous === undefined) delete process.env.BENCHMARK_HUB_OWNER_SOURCE_PATH;
    else process.env.BENCHMARK_HUB_OWNER_SOURCE_PATH = previous;
  }
}
test('expired SQL lock wait cannot dispatch the first object write', async (t) => {
  const time = clock(t);
  let dispatched = 0;
  const owner = loadOwner({
    $transaction: async (body) =>
      body({
        $executeRaw: async () => {
          time.expire();
        },
      }),
  });
  await assert.rejects(
    owner(() =>
      ownedHubStorageRequest(async () => {
        dispatched++;
      })
    ),
    /budget expired/
  );
  assert.equal(dispatched, 0);
});
test('post-await guard prevents catalog publication and next same-run body', async (t) => {
  const time = clock(t);
  const writes: string[] = [];
  const owner = loadOwner({
    $transaction: async (body) => body({ $executeRaw: async () => {} }),
  });
  await assert.rejects(
    owner(async () => {
      await ownedHubStorageRequest(async () => {
        writes.push('first-body');
        time.expire();
      });
      await ownedHubStorageRequest(async () => {
        writes.push('next-body');
      });
      await ownedHubStorageRequest(async () => {
        writes.push('index');
      });
    }),
    /budget expired/
  );
  assert.deepEqual(writes, ['first-body']);
});
test('SQL rejection drains started SDK work before releasing local FIFO admission', async () => {
  const gate = deferred();
  const entered = deferred();
  const events: string[] = [];
  let transactions = 0;
  const owner = loadOwner({
    $transaction: async (body) => {
      transactions++;
      if (transactions === 1) {
        const work = body({ $executeRaw: async () => {} });
        void work.catch(() => {});
        await entered.promise;
        throw new Error('SQL expired');
      }
      return body({ $executeRaw: async () => {} });
    },
  });
  const first = owner(async () => {
    await ownedHubStorageRequest(async (signal) => {
      signal!.addEventListener(
        'abort',
        () => {
          events.push('abort');
        },
        { once: true }
      );
      entered.resolve();
      await gate.promise;
      events.push('settled');
    });
  });
  const rejected = assert.rejects(first, /SQL expired/);
  await entered.promise;
  const next = owner(async () => {
    events.push('next');
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['abort']);
  gate.resolve();
  await rejected;
  await next;
  assert.deepEqual(events, ['abort', 'settled', 'next']);
});
test('real Smithy handler destroys the local request before later publication', async (t) => {
  const time = clock(t);
  let destroyed = 0;
  let dispatches = 0;
  const entered = deferred();
  const request = new EventEmitter() as EventEmitter & {
    end: () => void;
    destroy: () => void;
    write: () => boolean;
  };
  request.end = () => {
    entered.resolve();
  };
  request.write = () => true;
  request.destroy = () => {
    destroyed++;
    request.emit('close');
  };
  t.mock.method(https, 'request', () => {
    dispatches++;
    return request;
  });
  const handler = new NodeHttpHandler({
    connectionTimeout: 0,
    requestTimeout: 0,
  });
  const putObject = storage<(key: string, data: string) => Promise<void>>('putHubObjectVersion', {
    r2Configured: () => true,
    process: { env: { R2_BUCKET_TRACE_ARCHIVE: 'fixture' } },
    PutObjectCommand,
    getS3Client: () => ({
      send: (command: PutObjectCommand, options: { abortSignal?: AbortSignal }) =>
        handler.handle(
          new HttpRequest({
            protocol: 'https:',
            hostname: 'fixture.invalid',
            path: '/',
            method: 'PUT',
            headers: {},
            body: command.input.Body as string,
          }),
          options
        ),
    }),
  });
  const result = withHubStorageOwnership(async () => {
    const pending = putObject('runs/fixture.json', 'fixture');
    await entered.promise;
    time.expire();
    assert.throws(assertHubStorageOwnership, /budget expired/);
    await pending;
    throw new Error('must not reach publication');
  });
  await assert.rejects(result, /aborted|budget expired/);
  assert.equal(dispatches, 1);
  assert.equal(destroyed, 1);
});
test('stream body cancellation joins the stream and getObject cannot swallow expiry', async (t) => {
  // Node 22 accepts options; the owning installed Node typings predate that API.
  Reflect.apply(t.mock.timers.enable, t.mock.timers, [{ apis: ['setTimeout'] }]);
  let body: Readable | undefined;
  const entered = deferred();
  const getObject = storage<(key: string) => Promise<string | null>>('getObject', {
    r2Configured: () => true,
    getS3Client: () => ({
      send: async () => {
        body = new Readable({
          read() {
            entered.resolve();
          },
        });
        return { Body: body };
      },
    }),
    GetObjectCommand: class {},
  });
  const pending = withHubStorageOwnership(() => getObject('runs/fixture.json'));
  await Promise.race([
    entered.promise,
    pending.then(() => {
      throw new Error('read finished before stream consumption');
    }),
  ]);
  t.mock.timers.tick(HUB_SQL_TIMEOUT_MS);
  await assert.rejects(pending, /budget expired|ownership ended/);
  assert.equal(body!.destroyed, true);
});
test('unscoped storage remains usable and scoped success preserves the result', async () => {
  assert.equal(await ownedHubStorageRequest(async (signal) => signal === undefined), true);
  assert.equal(
    await withHubStorageOwnership(() => ownedHubStorageRequest(async (signal) => !signal!.aborted)),
    true
  );
});

test('expired transaction rejects queued outcomes without cache updates or acknowledgement', async (t) => {
  const time = clock(t);
  const boundary = putBoundary(
    async () => {},
    async () => {
      time.expire();
    }
  );
  const outcomes = await Promise.allSettled(
    ['a', 'b'].map((run_id) => boundary.putRun({ run_id, tasks: [] }))
  );
  assert.ok(outcomes.every((outcome) => outcome.status === 'rejected'));
  assert.equal(boundary.stats().cacheUpdates, 0);
});

test('expiry drains all eight started lanes and never starts the ninth write', async (t) => {
  const time = clock(t);
  const entered = deferred();
  let started = 0;
  let settled = 0;
  const inLanes = loadDeclaration<
    (items: number[], write: (item: number) => Promise<void>) => Promise<void>
  >('inLanes', { Promise });
  const result = withHubStorageOwnership(async () => {
    const lanes = inLanes(
      Array.from({ length: 16 }, (_, n) => n),
      () =>
        ownedHubStorageRequest(
          (signal) =>
            new Promise<void>((_resolve, reject) => {
              started++;
              if (started === 8) entered.resolve();
              signal!.addEventListener(
                'abort',
                () => {
                  settled++;
                  reject(signal!.reason);
                },
                { once: true }
              );
            })
        )
    );
    await entered.promise;
    time.expire();
    assert.throws(assertHubStorageOwnership, /budget expired/);
    await lanes;
  });
  await assert.rejects(result, /budget expired/);
  assert.equal(started, 8);
  assert.equal(settled, 8);
});
