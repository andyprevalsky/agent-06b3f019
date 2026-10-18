import '../blackbox/benchmark-hub-overlay-env.fixture';
import assert from 'node:assert/strict';
import test, { TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  getHubObjectVersion as getObjectStrict,
  putHubObjectVersion as putObject,
  resetHubObjectStorageForTests,
} from '../../providers/benchmarkHubStorage';
import { withHubStorageOwnership } from '../../providers/benchmarkHubStorageOwnership';
function remote(t: TestContext, initial?: string, objectKey = 'index.json') {
  const objects = new Map<string, string>();
  if (initial !== undefined) objects.set(`benchmark-hub-v2/pg_owner/${objectKey}`, initial);
  const etag = (body: string) => `"${createHash('md5').update(body).digest('hex')}"`;
  const writes: PutObjectCommand['input'][] = [];
  let delayed: (() => boolean) | undefined;
  let entered!: () => void;
  const accepted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const env = {
    RENDER: 'true',
    BENCHMARK_HUB_STORAGE: 'r2',
    R2_ACCOUNT_ID: 'fixture',
    R2_ACCESS_KEY_ID: 'fixture',
    R2_SECRET_ACCESS_KEY: 'fixture',
    R2_BUCKET_TRACE_ARCHIVE: 'fixture',
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  resetHubObjectStorageForTests();
  t.after(resetHubObjectStorageForTests);
  let delay = false;
  t.mock.method(
    S3Client.prototype,
    'send',
    async (
      command: GetObjectCommand | PutObjectCommand,
      options?: { abortSignal?: AbortSignal }
    ) => {
      const key = command.input.Key!;
      if (command instanceof GetObjectCommand) {
        const body = objects.get(key);
        if (body === undefined) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return { Body: Buffer.from(body), ETag: etag(body) };
      }
      const input = command.input;
      writes.push(input);
      const commit = () => {
        const current = objects.get(key);
        if (input.IfNoneMatch === '*' && current !== undefined) return false;
        if (
          input.IfMatch !== undefined &&
          (current === undefined || etag(current) !== input.IfMatch)
        )
          return false;
        objects.set(key, String(input.Body));
        return true;
      };
      if (delay) {
        delay = false;
        delayed = commit;
        entered();
        return new Promise((_resolve, reject) =>
          options!.abortSignal!.addEventListener(
            'abort',
            () => reject(new Error('local SDK aborted')),
            { once: true }
          )
        );
      }
      if (!commit())
        throw Object.assign(new Error('CAS failed'), {
          name: 'PreconditionFailed',
        });
      return { ETag: etag(objects.get(key)!) };
    }
  );
  return {
    objects,
    writes,
    accepted,
    delay: () => {
      delay = true;
    },
    commitOld: () => delayed!(),
  };
}
for (const key of [
  'index.json',
  'runs/a.json',
  'agent-run-index.json',
  'agent-run-index-revision.json',
  'visibility/a.json',
]) {
  for (const initial of ['legacy-index', undefined, 'same']) {
    test(`accepted old PUT cannot overwrite newer ACK, including ABA (${key}/${initial ?? 'missing'})`, async (t) => {
      const server = remote(t, initial, key);
      server.delay();
      const expired = withHubStorageOwnership(async () => {
        const pending = putObject(key, 'old-index');
        void pending.catch(() => {});
        await server.accepted;
        throw new Error('SQL expired');
      });
      await assert.rejects(expired, /SQL expired/);
      const next = initial === 'same' ? 'same' : 'new-index';
      await withHubStorageOwnership(() => putObject(key, next));
      assert.equal(server.commitOld(), false);
      assert.equal(await getObjectStrict(key), next);
      assert.equal(server.writes.length, 2);
    });
  }
}
test('all mutable physical keys preserve full payload and pre-existing plain reads', async (t) => {
  remote(t, '[{"legacy":true}]');
  assert.equal(await getObjectStrict('index.json'), '[{"legacy":true}]');
  const values: Record<string, string> = {
    'index.json': '[]',
    'runs/a.json': '{"run_id":"a","tasks":[{"logs":{"messages":["full"]}}]}',
    'agent-run-index.json': '{"version":1,"agents":{}}',
    'agent-run-index-revision.json': '{"version":1,"revision":2}',
    'visibility/a.json': 'false',
  };
  await withHubStorageOwnership(async () => {
    for (const [key, body] of Object.entries(values)) {
      await putObject(key, body);
      assert.equal(await getObjectStrict(key), body);
    }
  });
});
test('changed observed ETag refuses once without refreshing or acknowledging', async (t) => {
  const server = remote(t, 'before');
  await assert.rejects(
    withHubStorageOwnership(async () => {
      assert.equal(await getObjectStrict('index.json'), 'before');
      server.objects.set('benchmark-hub-v2/pg_owner/index.json', 'foreign');
      await putObject('index.json', 'stale');
    }),
    /CAS failed/
  );
  assert.equal(server.writes.length, 1);
  assert.equal(await getObjectStrict('index.json'), 'foreign');
});

test('malformed publication envelope fails closed while arbitrary legacy fields survive', async (t) => {
  remote(
    t,
    JSON.stringify({
      format: 'rose-benchmark-hub-publication-v1',
      publication: 'id',
      payload: 42,
    })
  );
  await assert.rejects(getObjectStrict('index.json'), /Invalid Benchmark Hub publication/);
});
test('missing observed ETag refuses before write dispatch', async (t) => {
  remote(t);
  t.mock.method(S3Client.prototype, 'send', async () => ({
    Body: Buffer.from('[]'),
  }));
  await assert.rejects(
    withHubStorageOwnership(() => putObject('index.json', 'stale')),
    /no ETag/
  );
});
