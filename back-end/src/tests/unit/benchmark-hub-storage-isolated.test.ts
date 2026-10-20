import assert from 'node:assert/strict';
import test, { TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  getHubObjectVersion,
  getObject,
  getObjectStrict,
  putHubObjectVersion,
  putObject,
  resetHubObjectStorageForTests,
} from '../../providers/benchmarkHubStorage';
import { withHubStorageOwnership } from '../../providers/benchmarkHubStorageOwnership';
import { commitObject, objectETag } from '../blackbox/benchmark-hub-r2.fixture';
const id = `hubxp_${'a'.repeat(32)}`;
function scope(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-isolation-control-'));
  const intent = path.join(dir, 'scope.json');
  const proof = {
    schema: 'benchmark-hub-r2-isolation-v1',
    mode: 'r2-isolated',
    run_id: id,
    bucket: 'fixture',
  };
  fs.writeFileSync(intent, JSON.stringify(proof), { mode: 0o444 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = { ...process.env };
  Object.assign(process.env, {
    BENCHMARK_HUB_STORAGE: 'r2-isolated',
    BENCHMARK_ISOLATED_RUN: 'true',
    BENCHMARK_RUN_ID: id,
    BENCHMARK_HUB_ISOLATION_INTENT: intent,
    R2_ACCOUNT_ID: 'fixture',
    R2_ACCESS_KEY_ID: 'fixture',
    R2_SECRET_ACCESS_KEY: 'fixture',
    R2_BUCKET_TRACE_ARCHIVE: 'fixture',
    RENDER: 'false',
  });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  // Only the external uid metadata is mocked. File bytes, no-follow opening,
  // size/mode/link validation and all storage code remain real. The activation
  // caller must separately provide and prove an actual root-owned intent.
  const fstat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (...args: Parameters<typeof fs.fstatSync>) => {
    const stat = Reflect.apply(fstat, fs, args) as fs.Stats;
    stat.uid = 0;
    return stat;
  });
  // A regression to local fallback must succeed at its I/O boundary so the
  // refusal assertions fail, without overwriting any real local Hub evidence.
  t.mock.method(fs.promises, 'mkdir', async () => undefined);
  t.mock.method(fs.promises, 'writeFile', async () => undefined);
  t.mock.method(fs.promises, 'rename', async () => undefined);
  t.mock.method(fs.promises, 'readFile', async () => {
    throw Object.assign(new Error('absent local fixture'), { code: 'ENOENT' });
  });
  resetHubObjectStorageForTests();
  t.after(resetHubObjectStorageForTests);
  const objects = new Map<string, string>();
  const keys: string[] = [];
  t.mock.method(
    S3Client.prototype,
    'send',
    async (command: GetObjectCommand | HeadObjectCommand | PutObjectCommand) => {
      const input = command.input;
      keys.push(input.Key!);
      if (command instanceof PutObjectCommand)
        return commitObject(objects, {
          ...input,
          Key: input.Key!,
          Body: String(command.input.Body),
        });
      const raw = objects.get(input.Key!);
      if (raw === undefined) throw Object.assign(new Error('absent'), { name: 'NotFound' });
      return {
        ETag: objectETag(raw),
        ...(command instanceof GetObjectCommand ? { Body: Buffer.from(raw) } : {}),
      };
    }
  );
  return { intent, proof, keys, objects };
}
test('explicit isolated real R2 keeps all five key families outside production without Render', async (t) => {
  const fixture = scope(t);
  const keys = [
    'index.json',
    'runs/a.json',
    'agent-run-index.json',
    'agent-run-index-revision.json',
    'visibility/a.json',
  ];
  await withHubStorageOwnership(async () => {
    for (const key of keys) {
      await putObject(key, '{"full":"payload"}');
      assert.equal(await getObjectStrict(key), '{"full":"payload"}');
    }
  });
  assert.equal(process.env.RENDER, 'false');
  assert.equal(fixture.objects.size, 5);
  assert.ok(fixture.keys.every((key) => key.startsWith(`benchmark-hub-isolated/${id}/`)));
  assert.ok(fixture.keys.every((key) => !key.startsWith('benchmark-hub/')));
  assert.deepEqual(
    [...fixture.objects.keys()],
    keys.map((key) => `benchmark-hub-isolated/${id}/${key}`)
  );
});
for (const field of [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_TRACE_ARCHIVE',
  'BENCHMARK_RUN_ID',
  'BENCHMARK_ISOLATED_RUN',
  'BENCHMARK_HUB_ISOLATION_INTENT',
]) {
  test(`isolated R2 refuses missing ${field} before I/O or local fallback`, async (t) => {
    const fixture = scope(t);
    delete process.env[field];
    await assert.rejects(putObject('index.json', '[]'));
    assert.deepEqual(fixture.keys, []);
  });
}
for (const invalid of [
  '',
  '.',
  '..',
  'production',
  `hubxp_${'a'.repeat(31)}`,
  `hubxp_${'A'.repeat(32)}`,
  `${id}/../production`,
]) {
  test(`isolated R2 refuses unsafe ID ${JSON.stringify(invalid)}`, async (t) => {
    const fixture = scope(t);
    process.env.BENCHMARK_RUN_ID = invalid;
    await assert.rejects(getObjectStrict('index.json'));
    assert.deepEqual(fixture.keys, []);
  });
}
for (const [field, value] of [
  ['run_id', `hubxp_${'b'.repeat(32)}`],
  ['bucket', 'foreign'],
  ['mode', 'local'],
  ['schema', 'foreign'],
]) {
  test(`isolated R2 refuses foreign proof ${field}`, async (t) => {
    const fixture = scope(t);
    fs.chmodSync(fixture.intent, 0o644);
    fs.writeFileSync(fixture.intent, JSON.stringify({ ...fixture.proof, [field]: value }));
    await assert.rejects(putObject('index.json', '[]'), /binding refused/);
    assert.deepEqual(fixture.keys, []);
  });
}
test('isolated R2 refuses symlink intent before storage access', async (t) => {
  const fixture = scope(t);
  const link = `${fixture.intent}.link`;
  fs.symlinkSync(fixture.intent, link);
  process.env.BENCHMARK_HUB_ISOLATION_INTENT = link;
  await assert.rejects(putObject('index.json', '[]'));
  assert.deepEqual(fixture.keys, []);
});
test('isolated R2 refuses writable or non-root intent', async (t) => {
  const fixture = scope(t);
  fs.chmodSync(fixture.intent, 0o666);
  await assert.rejects(putObject('index.json', '[]'), /ownership refused/);
  fs.chmodSync(fixture.intent, 0o444);
  const current = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (...args: Parameters<typeof fs.fstatSync>) => {
    const stat = Reflect.apply(current, fs, args) as fs.Stats;
    stat.uid = 12345;
    return stat;
  });
  await assert.rejects(putObject('index.json', '[]'), /ownership refused/);
  assert.deepEqual(fixture.keys, []);
});
test('default Render keeps the original production prefix and ignores isolation proof', async (t) => {
  const fixture = scope(t);
  process.env.BENCHMARK_HUB_STORAGE = 'r2';
  process.env.RENDER = 'true';
  delete process.env.BENCHMARK_HUB_ISOLATION_INTENT;
  // Without an activated storage epoch the production legacy prefix is a
  // read-only archive: publication pauses before any object I/O.
  await assert.rejects(
    withHubStorageOwnership(() => putObject('index.json', '[]')),
    /paused pending storage epoch activation/
  );
  assert.deepEqual(fixture.keys, []);
  assert.equal(await withHubStorageOwnership(() => getObjectStrict('index.json')), null);
  assert.deepEqual(fixture.keys, ['benchmark-hub/index.json']);
  assert.equal(fixture.objects.size, 0);
});
test('normal local mode ignores R2 credentials and isolation intent', async (t) => {
  const fixture = scope(t);
  process.env.BENCHMARK_HUB_STORAGE = 'local';
  process.env.RENDER = 'true';
  process.env.BENCHMARK_HUB_ISOLATION_INTENT = '/missing';
  assert.equal(await getObjectStrict(`absent-${id}.json`), null);
  assert.deepEqual(fixture.keys, []);
});

for (const name of [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_TRACE_ARCHIVE',
]) {
  test(`isolated R2 refuses blank credential ${name}`, async (t) => {
    const fixture = scope(t);
    process.env[name] = '  ';
    await assert.rejects(putObject('index.json', '[]'), /credentials are incomplete/);
    assert.deepEqual(fixture.keys, []);
  });
}
test('isolated R2 refuses false isolated flag and relative intent', async (t) => {
  const fixture = scope(t);
  process.env.BENCHMARK_ISOLATED_RUN = 'false';
  await assert.rejects(putObject('index.json', '[]'));
  process.env.BENCHMARK_ISOLATED_RUN = 'true';
  process.env.BENCHMARK_HUB_ISOLATION_INTENT = 'relative.json';
  await assert.rejects(putObject('index.json', '[]'));
  assert.deepEqual(fixture.keys, []);
});
for (const fault of ['hardlink', 'directory', 'oversize', 'malformed']) {
  test(`isolated R2 refuses ${fault} intent`, async (t) => {
    const fixture = scope(t);
    if (fault === 'hardlink') fs.linkSync(fixture.intent, `${fixture.intent}.hardlink`);
    if (fault === 'directory')
      process.env.BENCHMARK_HUB_ISOLATION_INTENT = path.dirname(fixture.intent);
    if (fault === 'oversize' || fault === 'malformed') {
      fs.chmodSync(fixture.intent, 0o644);
      fs.writeFileSync(fixture.intent, fault === 'oversize' ? 'x'.repeat(4097) : '{');
    }
    await assert.rejects(putObject('index.json', '[]'));
    assert.deepEqual(fixture.keys, []);
  });
}

for (const key of [
  'benchmark-hub/index.json',
  '../index.json',
  '/index.json',
  'runs/../../index.json',
  'agent-run-index.json/foreign',
]) {
  test(`isolated R2 refuses foreign object key ${key}`, async (t) => {
    const fixture = scope(t);
    await assert.rejects(putObject(key, '[]'), /outside the Hub scope/);
    assert.deepEqual(fixture.keys, []);
  });
}

test('permissive Hub reads do not swallow invalid isolated scope credentials', async (t) => {
  const fixture = scope(t);
  delete process.env.R2_ACCOUNT_ID;
  await assert.rejects(getObject('index.json'), /credentials are incomplete/);
  assert.deepEqual(fixture.keys, []);
});
test('permissive Hub reads refuse foreign isolated object keys', async (t) => {
  const fixture = scope(t);
  await assert.rejects(getObject('../index.json'), /outside the Hub scope/);
  assert.deepEqual(fixture.keys, []);
});

test('isolated R2 refuses production-prefixed object version helpers before I/O', async (t) => {
  const fixture = scope(t);
  await withHubStorageOwnership(async () => {
    await assert.rejects(putHubObjectVersion('index.json', '[]'), /unavailable in isolated R2/);
    await assert.rejects(getHubObjectVersion('index.json'), /unavailable in isolated R2/);
  });
  assert.deepEqual(fixture.keys, []);
  assert.equal(fixture.objects.size, 0);
});

test('invalid isolated configuration refuses during actual module startup', () => {
  const module = path.resolve(__dirname, '../../providers/benchmarkHubStorage.ts');
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', `require(${JSON.stringify(module)})`],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        BENCHMARK_HUB_STORAGE: 'r2-isolated',
        BENCHMARK_ISOLATED_RUN: 'false',
        RENDER: 'false',
      },
      encoding: 'utf8',
    }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires an isolated run and a root-issued scope ID/);
});

for (const status of [403, 503]) {
  test(`isolated Hub reads propagate SDK ${status} failures`, async (t) => {
    scope(t);
    const failure = Object.assign(new Error(`SDK ${status}`), {
      $metadata: { httpStatusCode: status },
    });
    t.mock.method(S3Client.prototype, 'send', async () => {
      throw failure;
    });
    await assert.rejects(getObject('index.json'), (error) => error === failure);
  });
}
test('isolated Hub reads return null for confirmed SDK 404 within the private prefix', async (t) => {
  const fixture = scope(t);
  t.mock.method(S3Client.prototype, 'send', async (command: GetObjectCommand) => {
    fixture.keys.push(command.input.Key!);
    throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } });
  });
  assert.equal(await getObject('index.json'), null);
  assert.deepEqual(fixture.keys, [`benchmark-hub-isolated/${id}/index.json`]);
});
