#!/usr/bin/env tsx

/**
 * Hub agent resolution must stay O(1) on an unknown in-flight UUID.
 * Official 4w creates a client-side agent-id and GETs /agents/:id before
 * POST /api/agents commits; scanning every hub bundle on that miss starves
 * Prisma and blows the 5s lifecycle ratchet.
 *
 * Run: npx tsx src/tests/unit/hub-resolve-run-id.test.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BenchmarkHubUnavailableError } from '../../providers/benchmarkHubErrors';
import {
  __resetHubResolutionCachesForTest,
  agentIdsFromHubBundle,
  applyHubRunToResolutionCaches,
  backfillHubAgentRunIndex,
  backfillHubAgentRunIndexFromCatalog,
  completedHubAgentBackfill,
  forgetHubRunFromResolutionCaches,
  hubAgentIndexAfterDelete,
  hubAgentIndexAfterPut,
  hubRunVisibleFromMarker,
  installHubAgentRunIndex,
  legacyBackfillRetryDelayMs,
  loadCompactHubAgentIndex,
  parseHubAgentRunIndex,
  parseHubAgentRunIndexRevision,
  parseHubRunBundle,
  peekHubResolutionForTest,
  recoverableHubAgentRunRevision,
  resolveHubRunIdFromAgentIndex,
  resolveHubRunIdFromIndexes,
} from '../../providers/benchmarkHubStore';

let passed = 0;
const failures: string[] = [];
const asyncCases: Array<{ name: string; fn: () => Promise<void> }> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`  fail ${name}\n`);
  }
}

function asyncTest(name: string, fn: () => Promise<void>): void {
  asyncCases.push({ name, fn });
}

test('isolated Hub run IDs reject path aliases without rejecting dotted IDs', () => {
  for (const runId of ['.', '..', 'run.v2']) {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--eval', "import('./src/providers/benchmarkHubStore.ts')"],
      {
        cwd: process.cwd(),
        env: { ...process.env, BENCHMARK_ISOLATED_RUN: 'true', BENCHMARK_RUN_ID: runId },
        encoding: 'utf8',
      }
    );
    if (runId === 'run.v2') {
      assert.equal(result.status, 0, result.stderr);
    } else {
      assert.notEqual(result.status, 0, `${runId} unexpectedly imported successfully`);
      assert.match(result.stderr, /BENCHMARK_RUN_ID must be a safe, nonempty ID/);
    }
  }
});

const runs = [
  {
    run_id: 'run-root',
    timestamp: '2026-09-01T00:00:00Z',
    suite: null,
    live: false,
    tasks: [
      {
        name: 'mass-agent',
        passed: true,
        status: 'passed',
        agent_id: 'root-agent',
        duration_seconds: 1,
        cost_cents: 0,
        world_model_mode: null,
        fast_mode: true,
        tree_agent_count: 2,
        failure_reason: null,
      },
    ],
  },
];

test('root ids resolve from the run index without a child map', () => {
  const resolved = resolveHubRunIdFromIndexes('root-agent', runs, null);
  assert.deepEqual(resolved, { kind: 'hit', runId: 'run-root' });
});

test('unknown ids are pending while the child index is still building', () => {
  const resolved = resolveHubRunIdFromIndexes('brand-new-4w-uuid', runs, null);
  assert.deepEqual(resolved, { kind: 'pending' });
});

test('unknown ids miss in O(1) once the child index exists', () => {
  const childIndex = new Map<string, string>([['gp-child', 'run-root']]);
  const resolved = resolveHubRunIdFromIndexes('brand-new-4w-uuid', runs, childIndex);
  assert.deepEqual(resolved, { kind: 'miss' });
});

test('child ids resolve from the child index after it is built', () => {
  const childIndex = new Map<string, string>([['gp-child', 'run-root']]);
  const resolved = resolveHubRunIdFromIndexes('gp-child', runs, childIndex);
  assert.deepEqual(resolved, { kind: 'hit', runId: 'run-root' });
});

test('compact agent index resolves directly at 10k-agent scale', () => {
  const agentIndex = new Map(
    Array.from({ length: 10_000 }, (_, index) => [`agent-${index}`, `run-${index}`])
  );
  assert.equal(resolveHubRunIdFromAgentIndex('agent-9999', agentIndex), 'run-9999');
  assert.equal(resolveHubRunIdFromAgentIndex('provisional-uuid', agentIndex), null);
  const src = readFileSync(join(process.cwd(), 'src/providers/benchmarkHubLookup.ts'), 'utf8');
  const start = src.indexOf('export function resolveHubRunIdFromAgentIndex');
  const body = src.slice(start, src.indexOf('/**', start + 4));
  assert.match(body, /agentIndex\?\.get\(agentId\)/);
  assert.doesNotMatch(body, /for \(|\.find\(|\.some\(/);
});

test('10k-agent persistence transitions stay compact and preserve update/delete semantics', () => {
  const agents = new Map(
    Array.from({ length: 10_000 }, (_, index) => [`agent-${index}`, `run-${index}`])
  );
  const startedAt = performance.now();
  const updated = hubAgentIndexAfterPut({ revision: 7, complete: true, agents }, false, 'run-new', [
    'agent-9999',
    'agent-new',
  ]);
  const serializedBytes = Buffer.byteLength(JSON.stringify(Object.fromEntries(updated.agents)));
  const elapsedMs = performance.now() - startedAt;
  assert.equal(updated.revision, 8);
  assert.equal(updated.agents.get('agent-9999'), 'run-new');
  assert.equal(agents.get('agent-9999'), 'run-9999');
  assert.ok(serializedBytes < 500_000, `10k compact index grew to ${serializedBytes} bytes`);
  assert.ok(elapsedMs < 1_000, `10k compact index transition took ${elapsedMs.toFixed(1)}ms`);
  const deleted = hubAgentIndexAfterDelete(updated, 'run-new');
  assert.equal(deleted.agents.has('agent-9999'), false);
  assert.equal(deleted.agents.has('agent-new'), false);
});

test('legacy backfill retries use bounded exponential backoff', () => {
  assert.equal(legacyBackfillRetryDelayMs(1), 5_000);
  assert.equal(legacyBackfillRetryDelayMs(2), 10_000);
  assert.equal(legacyBackfillRetryDelayMs(20), 5 * 60_000);
});

test('retryable Hub failures carry a 503 and retry hint', () => {
  const error = new BenchmarkHubUnavailableError('warming');
  assert.equal(error.statusCode, 503);
  assert.equal(error.retryAfterSeconds, 5);
});

test('revision floor is strict while malformed-index revision salvage trusts no mappings', () => {
  assert.equal(parseHubAgentRunIndexRevision('{"version":1,"revision":41}'), 41);
  assert.throws(
    () => parseHubAgentRunIndexRevision('{"version":1,"revision":-1}'),
    /revision floor/
  );
  assert.equal(
    recoverableHubAgentRunRevision('{"version":9,"revision":73,"agents":"corrupt"}'),
    73
  );
  assert.equal(recoverableHubAgentRunRevision('{"version":9,"revision":89}'), 89);
  assert.equal(recoverableHubAgentRunRevision('not-json'), 0);
});

test('legacy completion merges concurrent uploads and excludes concurrent deletes', () => {
  const merged = completedHubAgentBackfill(
    {
      revision: 4,
      complete: false,
      agents: new Map([
        ['reused-agent', 'run-new'],
        ['current-agent', 'run-current'],
      ]),
    },
    new Map([
      ['reused-agent', 'run-old'],
      ['legacy-agent', 'run-legacy'],
      ['deleted-agent', 'run-deleted'],
    ]),
    [
      { run_id: 'run-new', uploaded_at: '2026-10-08T22:50:00Z' },
      { run_id: 'run-current', uploaded_at: '2026-10-08T22:45:00Z' },
      { run_id: 'run-legacy', uploaded_at: '2026-07-16T01:38:37Z' },
    ]
  );
  assert.equal(merged.complete, true);
  assert.equal(merged.agents.get('reused-agent'), 'run-new');
  assert.equal(merged.agents.get('legacy-agent'), 'run-legacy');
  assert.equal(merged.agents.has('deleted-agent'), false);
});

test('visibility markers preserve legacy runs and fail closed on malformed values', () => {
  assert.equal(hubRunVisibleFromMarker(null), true);
  assert.equal(hubRunVisibleFromMarker('true'), true);
  assert.equal(hubRunVisibleFromMarker('false'), false);
  assert.equal(hubRunVisibleFromMarker('malformed'), false);
});

test('compact index schema rejects malformed metadata and entries', () => {
  assert.throws(
    () => parseHubAgentRunIndex('{"version":1,"complete":true,"agents":{}}'),
    /Invalid Benchmark Hub agent-run index/
  );
  assert.throws(
    () => parseHubAgentRunIndex('{"version":1,"revision":0,"agents":{}}'),
    /Invalid Benchmark Hub agent-run index/
  );
  assert.throws(
    () => parseHubAgentRunIndex('{"version":1,"revision":-1,"complete":true,"agents":{}}'),
    /Invalid Benchmark Hub agent-run index/
  );
  assert.throws(
    () =>
      parseHubAgentRunIndex(
        '{"version":1,"revision":1,"complete":true,"agents":{"agent":"../run"}}'
      ),
    /Invalid Benchmark Hub agent-run index entry/
  );
  assert.deepEqual(
    parseHubAgentRunIndex('{"version":1,"revision":1,"complete":true,"agents":{"agent":"run-1"}}'),
    { revision: 1, complete: true, agents: new Map([['agent', 'run-1']]) }
  );
});

test('strict run bundle schema rejects valid JSON that cannot contain agent ids', () => {
  assert.throws(() => parseHubRunBundle('[]'), /Invalid Benchmark Hub run bundle/);
  assert.throws(() => parseHubRunBundle('{}'), /Invalid Benchmark Hub run bundle/);
  assert.throws(() => parseHubRunBundle('{"tasks":"corrupt"}'), /Invalid Benchmark Hub run bundle/);
  assert.deepEqual(parseHubRunBundle('{"tasks":[]}'), { tasks: [] });
});

test('authoritative refresh clears stale hit cache and rejects an older revision', () => {
  __resetHubResolutionCachesForTest();
  applyHubRunToResolutionCaches('run-old', ['reused-agent'], 1);
  assert.equal(
    installHubAgentRunIndex({
      revision: 2,
      complete: true,
      agents: new Map([['reused-agent', 'run-new']]),
    }),
    true
  );
  assert.deepEqual(peekHubResolutionForTest('reused-agent'), {
    cachedRunId: undefined,
    childRunId: 'run-new',
  });
  applyHubRunToResolutionCaches('run-local', ['reused-agent'], 3);
  assert.equal(
    installHubAgentRunIndex({
      revision: 2,
      complete: true,
      agents: new Map([['reused-agent', 'run-new']]),
    }),
    false
  );
  assert.deepEqual(peekHubResolutionForTest('reused-agent'), {
    cachedRunId: 'run-local',
    childRunId: 'run-local',
  });
  __resetHubResolutionCachesForTest();
});

asyncTest('cold complete-index load is awaited and transient failure is not legacy', async () => {
  __resetHubResolutionCachesForTest();
  let loaded = false;
  const complete = await loadCompactHubAgentIndex(async () => {
    await Promise.resolve();
    loaded = true;
    return {
      revision: 1,
      complete: true,
      agents: new Map([['archived-agent', 'archived-run']]),
    };
  });
  assert.equal(loaded, true);
  assert.deepEqual(complete, { kind: 'ready' });
  assert.equal(peekHubResolutionForTest('archived-agent').childRunId, 'archived-run');

  __resetHubResolutionCachesForTest();
  const failed = await loadCompactHubAgentIndex(async () => {
    throw new Error('synthetic R2 transport failure');
  });
  assert.deepEqual(failed, { kind: 'error' });
  assert.equal(peekHubResolutionForTest('archived-agent').childRunId, undefined);
});

asyncTest('failed legacy bundle read cannot publish complete=true', async () => {
  let persisted = false;
  await assert.rejects(
    backfillHubAgentRunIndex(
      runs,
      async () => {
        throw new Error('synthetic bundle read failure');
      },
      new Map(),
      async (agents) => {
        persisted = true;
        return { revision: 1, complete: true, agents };
      }
    ),
    /synthetic bundle read failure/
  );
  assert.equal(persisted, false);
});

asyncTest('failed legacy catalog read cannot publish complete=true', async () => {
  let persisted = false;
  await assert.rejects(
    backfillHubAgentRunIndexFromCatalog(
      async () => {
        throw new Error('synthetic catalog transport failure');
      },
      async () => ({}),
      new Map(),
      async (agents) => {
        persisted = true;
        return { revision: 1, complete: true, agents };
      }
    ),
    /synthetic catalog transport failure/
  );
  assert.equal(persisted, false);
});

test('findAgentAcrossRuns does not scan every bundle on the request path', () => {
  const src = readFileSync(join(process.cwd(), 'src/providers/benchmarkHubLookup.ts'), 'utf8');
  const start = src.indexOf('export async function findAgentAcrossRuns');
  assert.ok(start >= 0);
  const body = src.slice(start, src.indexOf('export function ancestorsFromHubTree'));
  assert.equal(
    /for \(const run of index\) \{\s*const view = await getRunAgent/.test(body),
    false,
    'Pass-2 per-request bundle scan must not return'
  );
  assert.doesNotMatch(body, /listRuns\(\)|indexedRunIds|for \(const run of index\)/);
  assert.match(body, /const load = await startCompactIndexLoad\(\)/);
  assert.match(body, /resolveHubRunIdFromAgentIndex\(agentId, childIdToRun\)/);
});

test('child lookup loads a persisted compact index and legacy backfill yields per bundle', () => {
  const lookupSource = readFileSync(
    join(process.cwd(), 'src/providers/benchmarkHubLookup.ts'),
    'utf8'
  );
  const buildStart = lookupSource.indexOf('export async function buildHubAgentIdIndex');
  const buildEnd = lookupSource.indexOf('export async function backfillHubAgentRunIndex');
  const buildBody = lookupSource.slice(buildStart, buildEnd);
  assert.match(buildBody, /await yieldToEventLoop\(\)/);
  assert.match(lookupSource, /loadHubAgentRunIndex/);
  assert.match(lookupSource, /persistHubAgentRunBackfill/);
  assert.match(lookupSource, /AGENT_INDEX_REFRESH_MS/);

  const storeSource = readFileSync(
    join(process.cwd(), 'src/providers/benchmarkHubStore.ts'),
    'utf8'
  );
  const agentIndexSource = readFileSync(
    join(process.cwd(), 'src/providers/benchmarkHubAgentIndex.ts'),
    'utf8'
  );
  const storageSource = readFileSync(
    join(process.cwd(), 'src/providers/benchmarkHubStorage.ts'),
    'utf8'
  );
  assert.match(storageSource, /node:fs\/promises/);
  assert.match(storeSource, /agent-run-index\.json/);
  assert.match(storeSource, /agent-run-index-revision\.json/);
  assert.match(storeSource, /index\.revision < durableRevisionFloor/);
  assert.match(storeSource, /revisionFloorMalformed/);
  assert.match(agentIndexSource, /revision: \(current\?\.revision \?\? 0\) \+ 1/);
  assert.match(storeSource, /await writeAgentRunIndex\(agentIndex\)/);
  assert.match(storeSource, /visibility\/\$\{runId\}\.json/);
  assert.match(storeSource, /getObjectStrict/);
  assert.match(storeSource, /getRunBundleStrict/);
  assert.match(storeSource, /export async function listRunsStrict/);
  assert.doesNotMatch(storageSource, /fs\.(?:readFile|writeFile|mkdir|rename)Sync/);

  assert.match(storeSource, /export const putRun = coalesceHubRunPuts\(storeRun\)/);
  const putStart = storeSource.indexOf('async function storeRun');
  const putEnd = storeSource.indexOf('export async function persistHubAgentRunBackfill');
  assert.ok(putStart >= 0 && putEnd > putStart, 'the actual persistence owner must be present');
  const putBody = storeSource.slice(putStart, putEnd);
  assert.match(putBody, /await listRunsStrict\(\)/);
  assert.ok(
    putBody.lastIndexOf("putObject(`visibility/${runId}.json`, 'true')") >
      putBody.indexOf('writeAgentRunIndex(agentIndex)'),
    'upload visibility must publish after bundle/catalog/reverse-index writes'
  );
  const deleteStart = storeSource.indexOf('export async function deleteRun');
  const deleteBody = storeSource.slice(deleteStart);
  assert.match(deleteBody, /await listRunsStrict\(\)/);
  const bundleRead = deleteBody.indexOf('getRunBundleStrict(run.run_id, run)');
  const tombstone = deleteBody.indexOf("putObject(`visibility/${target.run_id}.json`, 'false')");
  const catalogWrite = deleteBody.indexOf("putObject('index.json'");
  assert.ok(bundleRead >= 0 && tombstone >= 0 && catalogWrite >= 0);
  assert.ok(
    bundleRead < tombstone,
    'delete must validate the bundle before publishing its tombstone'
  );
  assert.match(deleteBody, /readAgentRunIndexForMutation\(next\)/);
  assert.ok(tombstone < catalogWrite, 'delete tombstone must publish before catalog removal');
});

test('GET /ancestors does not walk the hub archive on an empty live CTE', () => {
  const src = readFileSync(join(process.cwd(), 'src/domains/agents/routes.ts'), 'utf8');
  assert.match(src, /getAncestors\(req\.params\.id\)/);
  assert.equal(
    /getAncestors\(req\.params\.id,\s*canReadBenchmarkArchive/.test(src),
    false,
    'ancestors hub walk re-opens the official 4w create race'
  );
});

test('pointer-route blackbox uses the isolated TEST_BASE_URL first', () => {
  const src = readFileSync(
    join(process.cwd(), 'src/tests/blackbox/agent-queue-pointer-route.blackbox.ts'),
    'utf8'
  );
  assert.match(src, /TEST_BASE_URL/);
  assert.ok(
    src.indexOf('TEST_BASE_URL') < src.indexOf('BACKEND_URL'),
    'dotenv BACKEND_URL=3001 must not win over the coverage backend'
  );
});

test('hub resolution caches prefer the newest upload and drop deleted runs', () => {
  __resetHubResolutionCachesForTest();
  const bundle = {
    tasks: [
      {
        agent_id: 'root-agent',
        logs: { tree: { 'gp-child': { parent_agent_id: 'root-agent' } } },
      },
    ],
  };
  assert.deepEqual(agentIdsFromHubBundle(bundle).sort(), ['gp-child', 'root-agent']);
  applyHubRunToResolutionCaches('run-old', ['gp-child']);
  assert.equal(peekHubResolutionForTest('gp-child').cachedRunId, 'run-old');
  applyHubRunToResolutionCaches('run-new', ['gp-child']);
  assert.equal(peekHubResolutionForTest('gp-child').cachedRunId, 'run-new');
  const afterUpload = resolveHubRunIdFromIndexes(
    'gp-child',
    [
      {
        run_id: 'run-new',
        timestamp: '2026-09-01T00:00:00Z',
        suite: null,
        live: false,
        tasks: [
          {
            name: 'mass-agent',
            passed: true,
            status: 'passed',
            agent_id: 'root-agent',
            duration_seconds: 1,
            cost_cents: 0,
            world_model_mode: null,
            fast_mode: true,
            tree_agent_count: 2,
            failure_reason: null,
          },
        ],
      },
    ],
    new Map([['gp-child', 'run-new']])
  );
  assert.deepEqual(afterUpload, { kind: 'hit', runId: 'run-new' });
  forgetHubRunFromResolutionCaches('run-new', ['gp-child']);
  const afterDelete = resolveHubRunIdFromIndexes('gp-child', [], new Map());
  assert.deepEqual(afterDelete, { kind: 'miss' });
  __resetHubResolutionCachesForTest();
});

test('findAgentAcrossRuns drops compact-index pointers whose bundle is unavailable', () => {
  const src = readFileSync(join(process.cwd(), 'src/providers/benchmarkHubLookup.ts'), 'utf8');
  const start = src.indexOf('export async function findAgentAcrossRuns');
  const body = src.slice(start, src.indexOf('export function ancestorsFromHubTree'));
  assert.match(body, /await getRunAgent\(runId, agentId\)/);
  assert.match(body, /if \(view !== null\)/);
  assert.match(src, /forgetHubRunFromResolutionCaches/);
  assert.match(src, /applyHubRunToResolutionCaches/);
  assert.match(body, /throw new BenchmarkHubUnavailableError/);
  const viewSource = readFileSync(join(process.cwd(), 'src/providers/benchmarkHubView.ts'), 'utf8');
  assert.match(viewSource, /if \(visible === null\)/);
  assert.match(viewSource, /throw new BenchmarkHubUnavailableError/);
  assert.match(viewSource, /getRunBundleForAgentLookup\(runId\)/);
});

async function finish(): Promise<void> {
  for (const { name, fn } of asyncCases) {
    try {
      await fn();
      passed += 1;
      process.stdout.write(`  ok ${name}\n`);
    } catch (err: unknown) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      process.stdout.write(`  fail ${name}\n`);
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(`\nhub resolve run id: ${passed} passed\n`);
}

void finish();
