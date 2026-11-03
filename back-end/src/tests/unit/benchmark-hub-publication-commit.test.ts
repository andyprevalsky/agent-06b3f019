/** Actual Store + SDK boundary regressions for immutable publication commit. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
const epoch = 'publication_commit_v1';
const legacy = 'benchmark-hub/';
const fresh = `benchmark-hub-v2/${epoch}/`;
const etag = (raw: string) => `"${createHash('sha256').update(raw).digest('hex')}"`;
const bundle = (id: string) => ({
  run_id: id,
  timestamp: '2026-10-17T00:00:00Z',
  tasks: [
    {
      name: 'fixture-task',
      status: 'completed',
      logs: { messages: ['full transcript sentinel'], extra: { retained: true } },
    },
  ],
});
const row = (id: string) => ({ ...bundle(id), live: false });

async function fixture(t: TestContext) {
  // Importing the real store imports Prisma: refuse any remote URL before that import.
  for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
    const url = new URL(process.env[key] || '');
    assert.ok(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname), `${key} must be local`);
    assert.ok(
      url.pathname.length > 1 && !['/postgres', '/template0', '/template1'].includes(url.pathname),
      `${key} must name an isolated local test database`
    );
  }
  const env = {
    RENDER: 'true',
    BENCHMARK_HUB_STORAGE: 'r2',
    BENCHMARK_HUB_STORAGE_EPOCH: epoch,
    BENCHMARK_HUB_V2_WRITES: 'true',
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
  const storage = await import(
    process.env.BENCHMARK_HUB_COMPAT_STORAGE_SOURCE_PATH || '../../providers/benchmarkHubStorage'
  );
  const ownership = await import('../../providers/benchmarkHubStorageOwnership');
  const store = await import('../../providers/benchmarkHubStore');
  const { prisma } = await import('../../providers/database');
  storage.resetHubObjectStorageForTests();
  store._resetForTests();
  t.after(async () => {
    store._resetForTests();
    storage.resetHubObjectStorageForTests();
    await prisma.$disconnect();
  });
  const objects = new Map<string, string>();
  const commands: Array<{
    method: string;
    key: string;
    body?: string;
    ifMatch?: string;
    ifNoneMatch?: string;
  }> = [];
  let fail: ((key: string, body: string) => boolean) | undefined;
  let failAfter: ((key: string, body: string) => boolean) | undefined;
  t.mock.method(
    S3Client.prototype,
    'send',
    async (command: GetObjectCommand | HeadObjectCommand | PutObjectCommand) => {
      const input = command.input;
      const key = input.Key!;
      assert.equal(input.Bucket, 'fixture');
      if (!(command instanceof PutObjectCommand)) {
        commands.push({ method: command instanceof HeadObjectCommand ? 'HEAD' : 'GET', key });
        const raw = objects.get(key);
        if (raw === undefined)
          throw Object.assign(new Error('fixture missing'), { name: 'NoSuchKey' });
        if (command.input.IfNoneMatch === etag(raw)) {
          throw Object.assign(new Error('fixture not modified'), {
            $metadata: { httpStatusCode: 304 },
          });
        }
        return { Body: Buffer.from(raw), ETag: etag(raw) };
      }
      const body = String(command.input.Body);
      commands.push({
        method: 'PUT',
        key,
        body,
        ifMatch: command.input.IfMatch,
        ifNoneMatch: command.input.IfNoneMatch,
      });
      if (fail?.(key, body)) throw new Error('fixture publication failure');
      // Real object-store semantics: unconditional legacy PUTs are accepted too.
      const previous = objects.get(key);
      if (
        (command.input.IfNoneMatch === '*' && previous !== undefined) ||
        (command.input.IfMatch !== undefined &&
          (previous === undefined || etag(previous) !== command.input.IfMatch))
      ) {
        throw Object.assign(new Error('fixture CAS rejected'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        });
      }
      objects.set(key, body);
      if (failAfter?.(key, body)) throw new Error('fixture accepted write but response lost');
      return { ETag: etag(body) };
    }
  );
  function seed(ids: string[] = ['old']) {
    objects.set(legacy + 'index.json', JSON.stringify(ids.map(row)));
    objects.set(
      legacy + 'agent-run-index.json',
      JSON.stringify({ version: 1, revision: 7, complete: true, agents: {} })
    );
    objects.set(
      legacy + 'agent-run-index-revision.json',
      JSON.stringify({ version: 1, revision: 7 })
    );
    for (const id of ids) {
      objects.set(legacy + `runs/${id}.json`, JSON.stringify(bundle(id)));
      objects.set(legacy + `visibility/${id}.json`, 'true');
    }
  }
  function document() {
    const raw = objects.get(fresh + 'index.json');
    assert.ok(raw);
    const wire = JSON.parse(raw);
    return JSON.parse(wire.payload);
  }
  async function publish(id: string) {
    return store.putRun(bundle(id));
  }
  return {
    storage,
    ownership,
    store,
    objects,
    commands,
    seed,
    document,
    publish,
    failAfterPut: (fn?: typeof failAfter) => {
      failAfter = fn;
    },
    failPut: (fn?: typeof fail) => {
      fail = fn;
    },
  };
}

// New process, real Store/Prisma, identical saved wire objects; no warm cache can mask a fault.
function coldRead(objects: Map<string, string>, ids: string[]) {
  const stdout = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const { createHash } = require('node:crypto');
    const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
    const objects = new Map(input.objects);
    S3Client.prototype.send = async function(command) {
      if (command instanceof PutObjectCommand) throw new Error('cold reader attempted a write');
      const raw = objects.get(command.input.Key);
      if (raw === undefined) throw Object.assign(new Error('missing'), {name:'NoSuchKey'});
      return {Body:Buffer.from(raw), ETag:'"'+createHash('sha256').update(raw).digest('hex')+'"'};
    };
    (async () => {
      const store = require('./src/providers/benchmarkHubStore.ts');
      const storage = require('./src/providers/benchmarkHubStorage.ts');
      const catalog = await store.listRunsStrict();
      const bodies = {};
      for (const id of input.ids) {
        const raw = await storage.getObjectStrict('runs/'+id+'.json');
        Object.defineProperty(bodies,id,{value:raw===null?null:JSON.parse(raw),enumerable:true});
      }
      const index = await store.loadHubAgentRunIndex();
      console.log('COLD_RESULT='+JSON.stringify({catalog,bodies,agents:index?[...index.agents].sort():[]}));
      await require('./src/providers/database.ts').prisma.$disconnect();
    })().catch(e=>{console.error(e);process.exitCode=1;});
  `,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      input: JSON.stringify({ objects: [...objects], ids }),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    }
  );
  const line = stdout.split('\n').find((line) => line.startsWith('COLD_RESULT='));
  assert.ok(line, 'cold process did not return a committed reader snapshot');
  return JSON.parse(line.slice('COLD_RESULT='.length));
}
function packet(id: string, version: string, agent: string) {
  return {
    ...bundle(id),
    version,
    tasks: bundle(id).tasks.map((task) => ({
      ...task,
      agent_id: agent,
      logs: { messages: [`complete nested transcript ${version}`], extra: { retained: true } },
    })),
  };
}
function logical(body: string): unknown {
  let value = JSON.parse(body);
  if (value && typeof value === 'object' && typeof value.payload === 'string')
    value = JSON.parse(value.payload);
  return value;
}

test('prototype-shaped run IDs and ordinary peers survive actual concurrent publication and cold reads', async (t) => {
  const f = await fixture(t);
  f.seed([]);
  await Promise.all(
    ['__proto__', 'ordinary-a', 'ordinary-b'].map((id) =>
      f.store.putRun(packet(id, 'v1', `agent-${id}`))
    )
  );
  await f.store.putRun(packet('ordinary-a', 'v2', 'agent-a-next'));
  const cold = coldRead(f.objects, ['__proto__', 'ordinary-a', 'ordinary-b']);
  assert.deepEqual(cold.catalog.map((r: { run_id: string }) => r.run_id).sort(), [
    '__proto__',
    'ordinary-a',
    'ordinary-b',
  ]);
  assert.equal(cold.bodies.__proto__.version, 'v1');
  assert.equal(cold.bodies['ordinary-a'].version, 'v2');
  assert.ok(Object.hasOwn(f.document().claims, '__proto__'));
  assert.equal(f.document().claims.__proto__.state, 'published');
  assert.equal(
    ({} as { state?: string }).state,
    undefined,
    'publication must not mutate Object.prototype'
  );
});

test('failed body, index, marker and final CAS preserve the prior ACK and archive across a process restart', async (t) => {
  const f = await fixture(t);
  f.seed(['legacy']);
  f.objects.set(
    legacy + 'runs/legacy.json',
    JSON.stringify(packet('legacy', 'legacy-v1', 'agent-legacy'))
  );
  f.objects.set(
    legacy + 'agent-run-index.json',
    JSON.stringify({
      version: 1,
      revision: 7,
      complete: true,
      agents: { 'agent-legacy': 'legacy' },
    })
  );
  await f.store.putRun(packet('ack', 'v1', 'agent-old'));
  const ids = ['ack', 'legacy', 'brand-new'];
  const before = coldRead(f.objects, ids);
  const archive = [...f.objects].filter(([key]) => key.startsWith(legacy));
  for (const phase of ['body', 'index', 'marker', 'catalog']) {
    f.failPut((key, body) => {
      const value = logical(body);
      if (phase === 'catalog') return key === fresh + 'index.json';
      if (phase === 'marker') return value === true;
      if (phase === 'index')
        return !!value && typeof value === 'object' && Object.hasOwn(value, 'agents');
      return !!value && typeof value === 'object' && Object.hasOwn(value, 'run_id');
    });
    const outcomes = await Promise.allSettled(
      ids.map((id) => f.store.putRun(packet(id, 'v2', `new-${id}`)))
    );
    assert.ok(
      outcomes.every((r) => r.status === 'rejected'),
      `${phase} failure must not ACK any attempted publication`
    );
    f.failPut();
    f.store._resetForTests();
    assert.deepEqual(
      coldRead(f.objects, ids),
      before,
      `${phase}: last ACK/catalog/body/lookup and unclaimed legacy must survive`
    );
    for (const [key, value] of archive)
      assert.equal(f.objects.get(key), value, 'legacy archive mutated');
  }
  await f.store.putRun(packet('ack', 'v2', 'agent-new'));
  const after = coldRead(f.objects, ids);
  assert.equal(after.bodies.ack.version, 'v2');
  assert.deepEqual(after.bodies.ack.tasks[0].logs.messages, ['complete nested transcript v2']);
  assert.equal(new Map(after.agents).get('agent-new'), 'ack');
  assert.equal(
    new Map(after.agents).has('agent-old'),
    false,
    'old membership must disappear atomically'
  );
  assert.equal(after.bodies['brand-new'], null, 'failed new publication became visible');
  // A response can be lost AFTER the conditional store committed: no rollback fiction.
  const preAmbiguous = coldRead(f.objects, ids);
  const prePublication = f.document().claims.ack.publication;
  f.failAfterPut((key) => key === fresh + 'index.json');
  await Promise.allSettled([f.store.putRun(packet('ack', 'v3', 'agent-ambiguous'))]);
  f.failAfterPut();
  f.store._resetForTests();
  const ambiguous = coldRead(f.objects, ids);
  if (ambiguous.bodies.ack.version === 'v2') assert.deepEqual(ambiguous, preAmbiguous);
  else {
    assert.equal(ambiguous.bodies.ack.version, 'v3');
    assert.equal(new Map(ambiguous.agents).get('agent-ambiguous'), 'ack');
    assert.equal(new Map(ambiguous.agents).has('agent-new'), false);
    assert.equal(
      ambiguous.catalog.find((r: { run_id: string }) => r.run_id === 'ack').tasks[0].agent_id,
      'agent-ambiguous'
    );
  }
  const ambiguousPublication = f.document().claims.ack.publication;
  await f.store.putRun(packet('ack', 'v4', 'agent-retry'));
  const retry = coldRead(f.objects, ids);
  assert.equal(retry.bodies.ack.version, 'v4');
  assert.equal(new Map(retry.agents).get('agent-retry'), 'ack');
  assert.notEqual(f.document().claims.ack.publication, prePublication);
  assert.notEqual(
    f.document().claims.ack.publication,
    ambiguousPublication,
    'retry must stage a fresh private UUID'
  );
});

test('600-member group deletion commits one catalog CAS and a failed commit leaves every member visible', async (t) => {
  const f = await fixture(t);
  const ids = Array.from({ length: 600 }, (_, i) => `member-${i}`);
  f.seed(ids);
  const bundles = ids.map((id, i) => ({
    ...bundle(id),
    group_run_id: 'cohort',
    group_member_id: `m${i}`,
    group_run_number: i + 1,
    group_total: 600,
    group_timestamp: '2026-10-17T00:00:00Z',
  }));
  f.objects.set(legacy + 'index.json', JSON.stringify(bundles.map((b) => ({ ...b, live: false }))));
  for (const b of bundles) f.objects.set(legacy + `runs/${b.run_id}.json`, JSON.stringify(b));
  f.objects.set(
    legacy + 'agent-run-index.json',
    JSON.stringify({
      version: 1,
      revision: 7,
      complete: true,
      agents: { first: ids[0], last: ids[599] },
    })
  );
  const selected = [ids[0], ids[599]];
  const beforeDelete = coldRead(f.objects, selected);
  f.failPut((key) => key === fresh + 'index.json');
  await assert.rejects(f.store.deleteRun('cohort'));
  f.failPut();
  f.store._resetForTests();
  assert.deepEqual(
    coldRead(f.objects, [])
      .catalog.map((r: { run_id: string }) => r.run_id)
      .sort(),
    [...ids].sort()
  );
  assert.deepEqual(
    coldRead(f.objects, selected),
    beforeDelete,
    'failed delete must retain first/last bodies and lookup, not catalog alone'
  );
  const at = f.commands.length;
  assert.equal(await f.store.deleteRun('cohort'), true);
  const writes = f.commands
    .slice(at)
    .filter((c) => c.method === 'PUT' && c.key === fresh + 'index.json');
  assert.equal(writes.length, 1, 'deleting 600 members must publish exactly one catalog CAS');
  assert.ok(writes[0].ifMatch || writes[0].ifNoneMatch, 'catalog publication must be conditional');
  const reads = f.commands.length;
  f.store._resetForTests();
  assert.deepEqual(await f.store.listRunsStrict(), []);
  assert.ok(
    !f.commands.slice(reads).some((c) => c.method !== 'PUT' && c.key.includes('/visibility/')),
    'catalog suppression must not enumerate per-run visibility'
  );
  assert.deepEqual(coldRead(f.objects, []).catalog, []);
});

test('legacy zero-task group member with a non-array task list is still deletable', async (t) => {
  const f = await fixture(t);
  f.seed(['peer']);
  // Pre-2026-10 writers stored a non-array task list verbatim and cataloged zero tasks.
  const legacyBody = {
    run_id: 'legacy-empty',
    timestamp: '2026-09-01T00:00:00Z',
    group_run_id: 'legacy-group',
    tasks: { invalid: true },
  };
  const peer = { ...bundle('peer'), group_run_id: 'legacy-group' };
  f.objects.set(legacy + 'runs/legacy-empty.json', JSON.stringify(legacyBody));
  f.objects.set(legacy + 'runs/peer.json', JSON.stringify(peer));
  f.objects.set(
    legacy + 'index.json',
    JSON.stringify([
      { ...peer, live: false },
      { ...legacyBody, tasks: [], live: false },
      row('unrelated'),
    ])
  );
  f.objects.set(legacy + 'runs/unrelated.json', JSON.stringify(bundle('unrelated')));
  // A strict read without the zero-task summary still refuses the malformed body.
  await assert.rejects(f.store.getRunBundleStrict('legacy-empty'), /Invalid Benchmark Hub run/);
  assert.equal(await f.store.deleteRun('legacy-group'), true);
  f.store._resetForTests();
  assert.deepEqual(
    (await f.store.listRunsStrict()).map((r) => r.run_id),
    ['unrelated']
  );
  assert.deepEqual(
    coldRead(f.objects, []).catalog.map((r: { run_id: string }) => r.run_id),
    ['unrelated']
  );
});
