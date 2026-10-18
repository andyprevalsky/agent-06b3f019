/** Actual Hub storage/store with local PostgreSQL and an SDK wire-boundary fixture. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const epoch = 'reader_compatibility_v1';
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
      logs: {
        messages: ['full transcript sentinel'],
        extra: { retained: true },
      },
    },
  ],
});
const row = (id: string) => ({ ...bundle(id), live: false });

/** Execute the exact baseline declaration, not a compatible replacement parser. */
function baseline(name: string, file = 'benchmarkHubStore.ts') {
  const source = execFileSync(
    'git',
    ['show', `1577af0fdec6db02bb26aa05ba99596e66e99eff:back-end/src/providers/${file}`],
    { encoding: 'utf8' }
  );
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
  );
  assert.ok(declaration, `Missing baseline declaration ${name}`);
  const context = vm.createContext({
    exports: {},
    JSON,
    Object,
    Array,
    Number,
    Map,
    Set,
    ...(name === 'parseRunCatalog'
      ? {
          normalizeAgentId: baseline('normalizeAgentId', 'benchmarkHubRunProjection.ts'),
        }
      : {}),
  });
  vm.runInContext(
    ts.transpileModule(declaration.getText() + `\nglobalThis.reader = ${name};`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    context
  );
  return context.reader as (raw: string | null) => unknown;
}

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
  t.mock.method(
    S3Client.prototype,
    'send',
    async (command: GetObjectCommand | HeadObjectCommand | PutObjectCommand) => {
      const input = command.input;
      const key = input.Key!;
      assert.equal(input.Bucket, 'fixture');
      if (!(command instanceof PutObjectCommand)) {
        commands.push({
          method: command instanceof HeadObjectCommand ? 'HEAD' : 'GET',
          key,
        });
        const raw = objects.get(key);
        if (raw === undefined)
          throw Object.assign(new Error('fixture missing'), {
            name: 'NoSuchKey',
          });
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
    failPut: (fn?: typeof fail) => {
      fail = fn;
    },
  };
}

test('new writes use only the fresh domain; unclaimed legacy bytes stay raw and unchanged', async (t) => {
  const f = await fixture(t);
  f.seed(['wire']);
  // A fresh module process proves the activation floor precedes even an absorbed write.
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
    const assert = require('node:assert/strict');
    const { createHash } = require('node:crypto');
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const objects = new Map(JSON.parse(require('node:fs').readFileSync(0, 'utf8')));
    let calls = 0;
    S3Client.prototype.send = async function(command) {
      calls++;
      assert.ok(!(command instanceof PutObjectCommand), 'read-only activation must never PUT');
      const raw = objects.get(command.input.Key);
      if (raw === undefined) throw Object.assign(new Error('missing'), {name:'NoSuchKey'});
      return {Body:Buffer.from(raw), ETag:'"'+createHash('sha256').update(raw).digest('hex')+'"'};
    };
    (async () => {
      const store = require('./src/providers/benchmarkHubStore.ts');
      const storage = require('./src/providers/benchmarkHubStorage.ts');
      const terminal = JSON.parse(objects.get('benchmark-hub/runs/wire.json'));
      for (const action of [
        () => store.putRun({...terminal, live:true, tasks:terminal.tasks.map(t=>({...t,status:'running'}))}),
        () => store.putRun({run_id:'wire', tasks:'invalid'}),
        () => store.deleteRun('wire'),
      ]) await assert.rejects(action, e => e.name === 'BenchmarkHubUnavailableError' &&
          e.statusCode === 503 && e.retryAfterSeconds === 5);
      assert.equal(calls, 0, 'maintenance rejection must precede remote reads and absorption');
      assert.equal(JSON.parse(await storage.getObjectStrict('index.json'))[0].run_id, 'wire');
      assert.ok(calls > 0, 'reads remain available during mutation maintenance');
      await require('./src/providers/database.ts').prisma.$disconnect();
    })().catch(e => { console.error(e); process.exitCode=1; });
  `,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, BENCHMARK_HUB_V2_WRITES: 'false' },
      input: JSON.stringify([...f.objects]),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    }
  );
  const old = new Map(f.objects);
  await assert.rejects(
    f.ownership.withHubStorageOwnership(() =>
      f.storage.putObject('runs/wire.json', JSON.stringify(bundle('wire')))
    ),
    /no private publication/,
    'direct body writes cannot bypass private publication staging'
  );
  await f.ownership.withHubStorageOwnership(async () => {
    assert.deepEqual(
      JSON.parse((await f.storage.getObjectStrict('runs/wire.json'))!),
      bundle('wire')
    );
    await f.storage.beginHubPublications(['wire']);
    await f.storage.putObject('runs/wire.json', JSON.stringify(bundle('wire')));
  });
  const writes = f.commands.filter((c) => c.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.match(
    writes[0].key,
    new RegExp('^' + fresh + 'publications/[A-Za-z0-9-]+/body-[A-Za-z0-9-]+\\.json$')
  );
  assert.equal(writes[0].ifNoneMatch, '*');
  assert.equal(writes[0].ifMatch, undefined);
  for (const [key, value] of old) assert.equal(f.objects.get(key), value);
  assert.equal(JSON.parse((await f.storage.getObjectStrict('index.json'))!)[0].run_id, 'wire');
});

test('legacy raw catalog, bundle and visibility keep exact baseline reader semantics', async (t) => {
  const f = await fixture(t);
  f.seed(['old']);
  const rawCatalog = await f.storage.getObjectStrict('index.json');
  assert.equal(
    (await f.store.listRunsStrict())[0].run_id,
    'old',
    'the relocated production parser remains on the actual Store reader path'
  );
  // The actual baseline catalog maps its actual baseline task normalization.
  const parsed = baseline('parseRunCatalog')(rawCatalog) as Array<{
    run_id: string;
  }>;
  assert.equal(parsed[0].run_id, 'old');
  const rawBundle = await f.storage.getObjectStrict('runs/old.json');
  assert.deepEqual(baseline('parseHubRunBundle')(rawBundle), bundle('old'));
  const visible = baseline('hubRunVisibleFromMarker');
  assert.equal(visible(await f.storage.getObjectStrict('visibility/old.json')), true);
  assert.equal(
    visible(' true\n'),
    false,
    'do not invent whitespace compatibility for old visibility readers'
  );
  f.objects.set(legacy + 'visibility/old.json', 'false');
  assert.equal(visible(await f.storage.getObjectStrict('visibility/old.json')), false);
});

test('invalid payload cannot persist PENDING or suppress a readable legacy run', async (t) => {
  const f = await fixture(t);
  f.seed(['old']);
  await assert.rejects(f.store.putRun({ ...bundle('old'), tasks: 'invalid' }), /Invalid/);
  assert.equal(f.commands.filter((c) => c.method === 'PUT').length, 0);
  assert.equal((await f.store.listRunsStrict())[0].run_id, 'old');
  assert.deepEqual(await f.store.getRunBundleStrict('old'), bundle('old'));
});

test('body failure preserves the prior legacy view without ACK; retry publishes the same immutable domain', async (t) => {
  const f = await fixture(t);
  f.seed(['old', 'untouched']);
  f.failPut(
    (key) => key.startsWith(fresh + 'publications/') && /\/body-[A-Za-z0-9-]+\.json$/.test(key)
  );
  await assert.rejects(f.publish('old'), /fixture publication failure/);
  assert.equal(
    f.objects.has(fresh + 'index.json'),
    false,
    'failed private staging must not publish a catalog claim'
  );
  assert.deepEqual((await f.store.listRunsStrict()).map((r) => r.run_id).sort(), [
    'old',
    'untouched',
  ]);
  assert.deepEqual(JSON.parse((await f.storage.getObjectStrict('runs/old.json'))!), bundle('old'));
  assert.equal(
    f.commands.some((c) => c.method === 'PUT' && c.key === fresh + 'index.json'),
    false
  );
  f.failPut();
  await f.publish('old');
  const doc = f.document();
  assert.equal(doc.claims.old.state, 'published');
  assert.ok(doc.claims.old.body_etag);
  assert.equal((await f.store.getRunBundleStrict('old')).run_id, 'old');
  assert.deepEqual(
    (await f.store.getRunBundleStrict('old')).tasks,
    bundle('old').tasks,
    'full nested transcript survives the new publication adapter'
  );
  const logicalCatalog = await f.storage.getObjectStrict('index.json');
  assert.equal((baseline('parseRunCatalog')(logicalCatalog) as unknown[]).length, 2);
  assert.throws(
    () => baseline('parseRunCatalog')(f.objects.get(fresh + 'index.json')!),
    /Invalid/,
    'new physical catalog is not old-reader compatible; activation requires the new adapter'
  );
  assert.ok(f.commands.filter((c) => c.method === 'PUT').every((c) => c.key.startsWith(fresh)));
});

test('published claim binds body version and visibility; corruption never falls through to legacy', async (t) => {
  const f = await fixture(t);
  f.seed(['old']);
  await f.publish('old');
  const claim = f.document().claims.old;
  const bodyKey = fresh + claim.body_key;
  const markerKey = fresh + claim.visibility_key;
  const body = f.objects.get(bodyKey)!;
  const marker = f.objects.get(markerKey)!;
  f.objects.delete(markerKey);
  let at = f.commands.length;
  await assert.rejects(f.storage.getObjectStrict('runs/old.json'), /visibility/);
  assert.ok(!f.commands.slice(at).some((c) => c.key === legacy + 'runs/old.json'));
  f.objects.set(markerKey, marker);
  f.objects.set(
    bodyKey,
    JSON.stringify({
      format: 'rose-benchmark-hub-publication-v1',
      publication: 'foreign',
      payload: JSON.stringify(bundle('old')),
    })
  );
  at = f.commands.length;
  await assert.rejects(f.storage.getObjectStrict('runs/old.json'), /body|publication/);
  assert.ok(!f.commands.slice(at).some((c) => c.key === legacy + 'runs/old.json'));
  f.objects.set(bodyKey, body);
});

test('hidden claims permanently mask legacy reinsertion without per-run visibility scans', async (t) => {
  const f = await fixture(t);
  f.seed(['old', 'untouched']);
  await f.ownership.withHubStorageOwnership(async () => {
    await f.storage.putObject('visibility/old.json', 'false');
    await f.storage.putObject('index.json', '[]');
  });
  assert.equal(f.document().claims.old.state, 'hidden');
  f.objects.set(legacy + 'index.json', JSON.stringify([row('old'), row('untouched')]));
  const at = f.commands.length;
  assert.deepEqual(
    (await f.store.listRunsStrict()).map((r) => r.run_id),
    ['untouched']
  );
  assert.ok(!f.commands.slice(at).some((c) => /\/visibility\//.test(c.key)));
  assert.equal(await f.storage.getObjectStrict('runs/old.json'), null);
  assert.equal(await f.storage.getObjectStrict('visibility/old.json'), 'false');
});

test('domain-complete agent index retains unclaimed legacy mapping and drops claimed removed membership', async (t) => {
  const f = await fixture(t);
  f.seed(['old', 'untouched']);
  f.objects.set(
    legacy + 'agent-run-index.json',
    JSON.stringify({
      version: 1,
      revision: 7,
      complete: true,
      agents: { removed: 'old', archived: 'untouched' },
    })
  );
  // Persist an existing-format PENDING claim to retain backward-reader fail-closed coverage.
  // Current writers stage privately and never expose this intermediate state.
  f.objects.set(
    fresh + 'index.json',
    JSON.stringify({
      format: 'benchmark-hub-overlay-v1',
      epoch,
      revision: 1,
      runs: [],
      claims: {
        old: { state: 'pending', publication: 'reader-compatibility-pending' },
      },
    })
  );
  const pendingAt = f.commands.length;
  await assert.rejects(f.storage.getObjectStrict('runs/old.json'), /pending/);
  assert.ok(!f.commands.slice(pendingAt).some((c) => c.key === legacy + 'runs/old.json'));
  for (const state of ['pending', 'hidden']) {
    if (state === 'hidden')
      await f.ownership.withHubStorageOwnership(async () => {
        await f.storage.putObject('visibility/old.json', 'false');
        await f.storage.putObject('index.json', '[]');
      });
    assert.equal(f.objects.has(fresh + 'agent-run-index.json'), false);
    assert.equal(f.objects.has(fresh + 'agent-run-index-revision.json'), false);
    const outcome = await f.storage.getObjectStrict('agent-run-index.json').then(
      (raw) => ({ raw }),
      (error) => ({ error })
    );
    if ('error' in outcome) {
      assert.match(String(outcome.error), /pending|incomplete|warming|publication/i);
    } else {
      assert.equal(
        JSON.parse(outcome.raw!).agents.removed,
        undefined,
        `${state} claim must suppress legacy membership before the first new-domain agent index exists`
      );
    }
  }
  // A separate fresh fixture phase exercises published indexes and both revision domains.
  f.objects.clear();
  f.commands.length = 0;
  f.storage.resetHubObjectStorageForTests();
  f.store._resetForTests();
  f.seed(['old', 'untouched']);
  f.objects.set(
    legacy + 'agent-run-index.json',
    JSON.stringify({
      version: 1,
      revision: 7,
      complete: true,
      agents: { removed: 'old', archived: 'untouched' },
    })
  );
  await f.publish('old');
  const index = JSON.parse((await f.storage.getObjectStrict('agent-run-index.json'))!);
  assert.equal(index.agents.archived, 'untouched');
  assert.equal(
    index.agents.removed,
    undefined,
    'a legacy membership removed by claimed new body must not survive'
  );
  assert.equal(index.complete, true);
  const originalIndex = baseline(
    'parseHubAgentRunIndex',
    'benchmarkHubAgentIndex.ts'
  )(JSON.stringify(index)) as { agents: Map<string, string> };
  assert.equal(originalIndex.agents.get('archived'), 'untouched');
  const revision = await f.storage.getObjectStrict('agent-run-index-revision.json');
  assert.ok(
    (baseline('parseHubAgentRunIndexRevision', 'benchmarkHubAgentIndex.ts')(revision) as number) >=
      0
  );
  f.objects.set(
    legacy + 'agent-run-index.json',
    JSON.stringify({
      version: 1,
      revision: 9,
      complete: true,
      agents: { newerArchived: 'untouched' },
    })
  );
  f.objects.set(
    legacy + 'agent-run-index-revision.json',
    JSON.stringify({ version: 1, revision: 9 })
  );
  const refreshed = JSON.parse((await f.storage.getObjectStrict('agent-run-index.json'))!);
  assert.equal(refreshed.agents.newerArchived, 'untouched');
  assert.ok(index._hub_cache_version.includes(epoch));
  assert.notEqual(
    refreshed._hub_cache_version,
    index._hub_cache_version,
    'legacy-only revision changes must invalidate the new-domain resolution cache'
  );
  assert.equal(
    refreshed.agents.archived,
    undefined,
    'unclaimed legacy mapping copied through a new-domain write must not become authoritative forever'
  );
  f.objects.set(
    legacy + 'agent-run-index-revision.json',
    JSON.stringify({ version: 1, revision: 10 })
  );
  await assert.rejects(
    f.storage.getObjectStrict('agent-run-index.json'),
    /revision|floor|warming|incomplete|trail/i,
    'a legacy index trailing its independently committed floor is UNKNOWN, not a valid map'
  );
  f.objects.set(
    legacy + 'agent-run-index-revision.json',
    JSON.stringify({ version: 1, revision: 9 })
  );
  f.objects.set(
    legacy + 'agent-run-index.json',
    JSON.stringify({
      version: 1,
      revision: 9,
      complete: true,
      agents: { removed: 'old', archived: 'untouched' },
    })
  );
  const committedIndex = f.document().agent_index;
  f.objects.delete(fresh + committedIndex.index.key);
  f.objects.delete(fresh + committedIndex.revision.key);
  const missingPublished = await f.storage.getObjectStrict('agent-run-index.json').then(
    (raw) => ({ raw }),
    (error) => ({ error })
  );
  if ('error' in missingPublished)
    assert.match(String(missingPublished.error), /pending|incomplete|warming|publication|missing/i);
  else
    assert.equal(
      JSON.parse(missingPublished.raw!).agents.removed,
      undefined,
      'published claim must not resurrect legacy membership after loss of both new-domain index objects'
    );
});

test('legacy unconditional writer may alter archive but cannot overwrite a new-domain ACK', async (t) => {
  const f = await fixture(t);
  f.seed(['old']);
  await f.publish('old');
  const saved = new Map([...f.objects].filter(([key]) => key.startsWith(fresh)));
  // Explicitly exercise accepted unconditional PUT, rather than a fixture that forbids it.
  await new S3Client({
    region: 'auto',
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
  }).send(
    new PutObjectCommand({
      Bucket: 'fixture',
      Key: legacy + 'runs/old.json',
      Body: JSON.stringify({ ...bundle('old'), stale: true }),
    })
  );
  await new S3Client({
    region: 'auto',
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
  }).send(
    new PutObjectCommand({
      Bucket: 'fixture',
      Key: legacy + 'index.json',
      Body: JSON.stringify([row('old')]),
    })
  );
  assert.equal(JSON.parse(f.objects.get(legacy + 'runs/old.json')!).stale, true);
  for (const [key, value] of saved) assert.equal(f.objects.get(key), value);
  assert.equal((await f.store.getRunBundleStrict('old')).stale, undefined);
  assert.equal(f.commands.filter((c) => c.method === 'PUT' && c.key.startsWith(legacy)).length, 2);
});

test('batch claim and final catalog publication are shared; catalog reads do not enumerate visibility', async (t) => {
  const f = await fixture(t);
  f.seed([]);
  await Promise.all(Array.from({ length: 12 }, (_, i) => f.publish(`new-${i}`)));
  const writes = f.commands.filter((c) => c.method === 'PUT');
  const catalogs = writes.filter((c) => c.key === fresh + 'index.json');
  assert.ok(catalogs.length <= 4, `12 concurrent jobs wrote ${catalogs.length} catalogs`);
  assert.equal(Object.values(f.document().claims).length, 12);
  const at = f.commands.length;
  assert.equal((await f.store.listRunsStrict()).length, 12);
  assert.ok(!f.commands.slice(at).some((c) => /\/visibility\//.test(c.key)));
  assert.ok(writes.every((c) => c.key.startsWith(fresh)));
});
