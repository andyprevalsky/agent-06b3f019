#!/usr/bin/env tsx
/** Cold Hub readers must observe a committed index or a durable failure. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { prisma } from '../../providers/database';
import {
  _resetForTests,
  loadHubAgentRunIndex,
  findAgentAcrossRuns,
  applyHubRunToResolutionCaches,
  putRun,
} from '../../providers/benchmarkHubStore';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function publicationRead(failIndexWrite: boolean): Promise<void> {
  const sender = S3Client.prototype as unknown as {
    send: (command: unknown) => Promise<unknown>;
  };
  const originalSend = sender.send;
  const objects = new Map<string, string>([
    ['benchmark-hub/index.json', '[]'],
    ['benchmark-hub/agent-run-index-revision.json', JSON.stringify({ version: 1, revision: 1 })],
    [
      'benchmark-hub/agent-run-index.json',
      JSON.stringify({ version: 1, revision: 1, complete: true, agents: {} }),
    ],
  ]);
  const floorPublished = deferred();
  const releaseWriter = deferred();
  sender.send = async (command) => {
    const input = (command as { input: { Bucket: string; Key: string; Body?: string } }).input;
    assert.equal(input.Bucket, 'offline');
    if (command?.constructor?.name === 'GetObjectCommand') {
      const value = objects.get(input.Key);
      if (value === undefined)
        throw Object.assign(new Error('fixture absent'), { name: 'NoSuchKey' });
      return { Body: Buffer.from(value) };
    }
    assert.equal(command?.constructor?.name, 'PutObjectCommand');
    assert.equal(typeof input.Body, 'string');
    if (input.Key === 'benchmark-hub/agent-run-index.json' && failIndexWrite) {
      throw new Error('fixture index publication failed');
    }
    objects.set(input.Key, input.Body!);
    if (input.Key === 'benchmark-hub/agent-run-index-revision.json') {
      floorPublished.resolve();
      await releaseWriter.promise;
    }
    return {};
  };
  let writer: Promise<unknown> | undefined;
  let reader: Promise<unknown> | undefined;
  try {
    writer = putRun({ run_id: `index-read-${process.pid}`, tasks: [] }).then(
      () => ({ kind: 'stored' }),
      (error: unknown) => ({ kind: 'error', error: String(error) })
    );
    await Promise.race([
      floorPublished.promise,
      writer.then((result) => {
        throw new Error(`Writer missed publication barrier: ${JSON.stringify(result)}`);
      }),
    ]);
    let settled = false;
    reader = loadHubAgentRunIndex().then(
      (snapshot) => {
        settled = true;
        return { kind: 'ready', revision: snapshot?.revision };
      },
      (error: unknown) => {
        settled = true;
        return { kind: 'error', error: String(error) };
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      settled,
      false,
      `Read exposed partial publication: ${JSON.stringify(settled ? await reader : null)}`
    );
    releaseWriter.resolve();
    if (failIndexWrite) {
      assert.deepEqual(await writer, {
        kind: 'error',
        error: 'Error: fixture index publication failed',
      });
      assert.deepEqual(await reader, {
        kind: 'error',
        error: 'Error: Benchmark Hub agent-run index trails its durable revision floor',
      });
      await assert.rejects(loadHubAgentRunIndex(), /trails its durable revision floor/);
    } else {
      assert.deepEqual(await writer, { kind: 'stored' });
      assert.deepEqual(await reader, { kind: 'ready', revision: 2 });
    }
  } finally {
    releaseWriter.resolve();
    await Promise.allSettled([writer, reader]);
    sender.send = originalSend;
    _resetForTests();
  }
}

async function failedReadBackoff(mode: 'error' | 'legacy' | 'stale'): Promise<void> {
  const sender = S3Client.prototype as unknown as { send: (command: unknown) => Promise<unknown> };
  let reads = 0;
  let now = 1_000_000;
  let unavailable = true;
  const clock = mock.method(Date, 'now', () => now);
  const transport = mock.method(sender, 'send', async (command: unknown) => {
    assert.equal(command?.constructor?.name, 'GetObjectCommand');
    const key = (command as { input: { Key: string } }).input.Key;
    if (key === 'benchmark-hub/index.json') throw new Error('fixture legacy catalog unavailable');
    reads += 1;
    if (unavailable && mode === 'error') throw new Error('fixture storage unavailable');
    const revision = unavailable ? 7 : 13;
    return {
      Body: Buffer.from(
        JSON.stringify(
          key.endsWith('-revision.json')
            ? { version: 1, revision }
            : { version: 1, revision, complete: !unavailable || mode !== 'legacy', agents: {} }
        )
      ),
    };
  });
  try {
    if (mode === 'stale') applyHubRunToResolutionCaches('ahead-replica', [], 12);
    const expectedError = mode === 'legacy' ? /index is warming/ : /temporarily unavailable/;
    await Promise.all(
      Array.from({ length: 100 }, (_, id) =>
        assert.rejects(findAgentAcrossRuns(`concurrent-${id}`), expectedError)
      )
    );
    assert.equal(reads, 2, 'Concurrent cold reads were not coalesced');
    for (let id = 0; id < 10; id += 1) {
      await assert.rejects(findAgentAcrossRuns(`sequential-${id}`), expectedError);
    }
    assert.equal(reads, 2, 'Persistent failure retried shared storage for every agent request');
    now += 5_001;
    await Promise.all(
      Array.from({ length: 100 }, (_, id) =>
        assert.rejects(findAgentAcrossRuns(`retry-after-backoff-${id}`), expectedError)
      )
    );
    assert.equal(reads, 4, 'Read did not retry after the existing refresh interval');
    unavailable = false;
    now += 5_001;
    assert.equal(await findAgentAcrossRuns('recovered-miss'), null);
    assert.equal(reads, 6, 'Recovery did not read the committed compact snapshot');
    for (let id = 0; id < 100; id += 1) {
      assert.equal(await findAgentAcrossRuns(`healthy-miss-${id}`), null);
    }
    assert.equal(reads, 6, 'Healthy cached misses performed shared storage reads');
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    transport.mock.restore();
    clock.mock.restore();
    _resetForTests();
  }
}

async function main(): Promise<void> {
  const fixtureEnv = {
    RENDER: 'true',
    BENCHMARK_HUB_STORAGE: 'r2',
    R2_ACCOUNT_ID: 'offline',
    R2_ACCESS_KEY_ID: 'offline',
    R2_SECRET_ACCESS_KEY: 'offline',
    R2_BUCKET_TRACE_ARCHIVE: 'offline',
  };
  const originalEnv = new Map(Object.keys(fixtureEnv).map((key) => [key, process.env[key]]));
  const failures: string[] = [];
  Object.assign(process.env, fixtureEnv);
  _resetForTests();
  try {
    for (const failIndexWrite of [false, true]) {
      const label = failIndexWrite
        ? 'failed publication remains retryable'
        : 'concurrent committed publication is readable';
      try {
        await publicationRead(failIndexWrite);
        console.log(`PASS: ${label}`);
      } catch (error: unknown) {
        failures.push(`${label}: ${String(error)}`);
        console.error(`FAIL: ${failures.at(-1)}`);
      }
    }
    for (const mode of ['error', 'legacy', 'stale'] as const) {
      try {
        await failedReadBackoff(mode);
        console.log(`PASS: ${mode} reads coalesce, back off, and recover`);
      } catch (error: unknown) {
        failures.push(`${mode} read backoff: ${String(error)}`);
        console.error(`FAIL: ${failures.at(-1)}`);
      }
    }
    assert.deepEqual(failures, []);
  } finally {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetForTests();
    await prisma.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
