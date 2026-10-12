#!/usr/bin/env tsx
/**
 * Cold Hub readers must observe a committed index or a durable failure, and a
 * fleet's queued live snapshots must not delay a final upload behind them.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { prisma } from '../../providers/database';
import {
  _resetForTests,
  backfillHubAgentRunIndexFromCatalog,
  getRunBundleStrict,
  listRunsStrict,
  loadHubAgentRunIndex,
  findAgentAcrossRuns,
  applyHubRunToResolutionCaches,
  persistHubAgentRunBackfill,
  putRun,
} from '../../providers/benchmarkHubStore';
import {
  delayedStartingRetryAcrossProcesses,
  startingRetryWorker,
} from './benchmark-hub-starting-retry.cases';

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

/**
 * Production 2026-10-08: an aborted agent-index PUT left the compact index one
 * revision behind its floor. Every later write rebuilt the whole archive inside
 * the writer lock and aborted on a legacy task-less bundle, so no Hub write could
 * commit again. The next write must repair without reading archived bundles, a
 * backfill scanned before that repair must not declare completion, and a fresh
 * out-of-lock backfill must complete over legacy bundles.
 */
async function writeAfterInconsistentIndex(agentIndexDocument: 'trailing' | 'malformed') {
  const sender = S3Client.prototype as unknown as {
    send: (command: unknown) => Promise<unknown>;
  };
  const originalSend = sender.send;
  const prefix = `repair-${process.pid}`;
  const archived = Array.from({ length: 40 }, (_, i) => `${prefix}-archived-${i}`);
  const summary = (runId: string, minute: number, agentId?: string) => ({
    run_id: runId,
    timestamp: `2026-10-08T22:${String(minute).padStart(2, '0')}:00.000Z`,
    uploaded_at: `2026-10-08T22:${String(minute).padStart(2, '0')}:30.000Z`,
    live: false,
    tasks: agentId === undefined ? [] : [{ name: 'task', agent_id: agentId }],
  });
  const catalog = [
    summary(`${prefix}-unindexed`, 59, 'agent-unindexed'),
    ...archived.map((runId, i) => summary(runId, 58 - i, `agent-${i}`)),
    summary(`${prefix}-legacy-error`, 1),
  ];
  const objects = new Map<string, string>([
    ['benchmark-hub/index.json', JSON.stringify(catalog)],
    ['benchmark-hub/agent-run-index-revision.json', JSON.stringify({ version: 1, revision: 8 })],
    [
      'benchmark-hub/agent-run-index.json',
      agentIndexDocument === 'trailing'
        ? JSON.stringify({
            version: 1,
            revision: 7,
            complete: true,
            agents: {
              ...Object.fromEntries(archived.map((runId, i) => [`agent-${i}`, runId])),
              'child-shared': archived[0],
              'agent-deleted': `${prefix}-deleted`,
            },
          })
        : '{"version":1,"revision":7,"complete":true,"agents":{"agent-0":',
    ],
    [
      `benchmark-hub/runs/${prefix}-unindexed.json`,
      JSON.stringify({
        run_id: `${prefix}-unindexed`,
        tasks: [
          {
            agent_id: 'agent-unindexed',
            logs: {
              tree: {
                'child-unindexed': { parent_agent_id: 'agent-unindexed' },
                // An evidence projection reuses a child id from an older run.
                'child-shared': { parent_agent_id: 'agent-unindexed' },
              },
            },
          },
        ],
      }),
    ],
    ...archived.map((runId, i): [string, string] => [
      `benchmark-hub/runs/${runId}.json`,
      JSON.stringify({
        run_id: runId,
        tasks: [
          {
            agent_id: `agent-${i}`,
            ...(i === 0
              ? { logs: { tree: { 'child-shared': { parent_agent_id: 'agent-0' } } } }
              : {}),
          },
        ],
      }),
    ]),
    // Shape of the 2026-07 hub-poller error bundles still in the production archive.
    [
      `benchmark-hub/runs/${prefix}-legacy-error.json`,
      JSON.stringify({ error: 'dispatch failed', run_id: `${prefix}-legacy-error`, code: 1 }),
    ],
  ]);
  const archivedBundleReads: string[] = [];
  let countingReads = true;
  sender.send = async (command) => {
    const input = (command as { input: { Bucket: string; Key: string; Body?: string } }).input;
    assert.equal(input.Bucket, 'offline');
    if (command?.constructor?.name === 'GetObjectCommand') {
      if (countingReads && input.Key.startsWith(`benchmark-hub/runs/${prefix}-`)) {
        archivedBundleReads.push(input.Key);
      }
      const value = objects.get(input.Key);
      if (value === undefined)
        throw Object.assign(new Error('fixture absent'), { name: 'NoSuchKey' });
      return { Body: Buffer.from(value) };
    }
    assert.equal(command?.constructor?.name, 'PutObjectCommand');
    objects.set(input.Key, input.Body!);
    return {};
  };
  try {
    await putRun({ run_id: `${prefix}-next`, tasks: [{ agent_id: 'agent-next' }] });
    assert.deepEqual(archivedBundleReads, [], 'a locked write must not scan archived bundles');
    countingReads = false;
    const repaired = await loadHubAgentRunIndex();
    assert.ok(repaired !== null);
    assert.equal(repaired.revision, 9, 'repair publishes above the durable floor');
    assert.equal(repaired.complete, false, 'mappings lost by the failed write are unknown');
    assert.equal(repaired.repairedRevision, 8);
    assert.equal(repaired.agents.get('agent-next'), `${prefix}-next`);
    assert.equal(
      repaired.agents.has('agent-deleted'),
      false,
      'pointers to absent runs are dropped'
    );
    assert.equal(repaired.agents.get('agent-0'), archived[0], 'catalog roots are re-derived');
    assert.equal(repaired.agents.get('agent-unindexed'), `${prefix}-unindexed`);
    assert.equal(repaired.agents.has('child-unindexed'), false, 'lost children await backfill');
    const stale = await persistHubAgentRunBackfill(new Map(), 7);
    assert.equal(stale.complete, false, 'a scan from before the repair cannot complete');
    const seed = await loadHubAgentRunIndex();
    assert.ok(seed !== null);
    const backfilled = await backfillHubAgentRunIndexFromCatalog(
      listRunsStrict,
      getRunBundleStrict,
      new Map(seed.agents),
      (agents) => persistHubAgentRunBackfill(agents, seed.revision)
    );
    assert.equal(backfilled.complete, true, 'backfill completes over legacy task-less bundles');
    assert.equal(backfilled.revision, 11);
    assert.equal(backfilled.agents.get('child-unindexed'), `${prefix}-unindexed`);
    assert.equal(
      backfilled.agents.get('child-shared'),
      `${prefix}-unindexed`,
      'the newest upload wins a reused child id over a stale salvaged mapping'
    );
    assert.equal(backfilled.agents.get('agent-39'), archived[39]);
    assert.equal(backfilled.agents.get('agent-next'), `${prefix}-next`);
    assert.equal(backfilled.agents.has('agent-deleted'), false);
  } finally {
    sender.send = originalSend;
    _resetForTests();
  }
}

async function queuedUploadAdmission(
  bundle: Record<string, unknown> = { tasks: [] },
  live = false,
  expected = ['holder', 'final', 'snapshot-a', 'snapshot-b']
): Promise<void> {
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
  const prefix = `admission-${process.pid}`;
  const holderWriting = deferred();
  const releaseHolder = deferred();
  const bundleWrites: string[] = [];
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
    const runId = /^benchmark-hub\/runs\/(.+)\.json$/.exec(input.Key)?.[1];
    if (runId !== undefined) {
      bundleWrites.push(runId.slice(prefix.length + 1));
      if (runId === `${prefix}-holder`) {
        holderWriting.resolve();
        await releaseHolder.promise;
      }
    }
    objects.set(input.Key, input.Body!);
    return {};
  };
  const upload = (name: string, snapshot: boolean) =>
    putRun(
      { ...(name === 'final' ? bundle : { tasks: [] }), run_id: `${prefix}-${name}` },
      { live: snapshot }
    );
  let uploads: Promise<unknown> | undefined;
  try {
    const holder = upload('holder', true);
    await holderWriting.promise;
    uploads = Promise.all([
      holder,
      upload('snapshot-a', true),
      upload('snapshot-b', true),
      upload('final', live),
    ]);
    releaseHolder.resolve();
    await uploads;
    assert.deepEqual(bundleWrites, expected);
    const index = JSON.parse(objects.get('benchmark-hub/index.json')!) as Array<{
      run_id: string;
      live: boolean;
    }>;
    assert.equal(index.find((run) => run.run_id === `${prefix}-final`)?.live, live);
  } finally {
    releaseHolder.resolve();
    await Promise.allSettled([uploads]);
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
    for (const advancement of ['status', 'root', 'tree'] as const) {
      try {
        const peers = await delayedStartingRetryAcrossProcesses(advancement);
        console.log(
          `PASS: delayed starting retry preserves ${advancement}; native peers ${peers.join(',')} joined`
        );
      } catch (error: unknown) {
        failures.push(`delayed starting retry preserves ${advancement}: ${String(error)}`);
        console.error(`FAIL: ${failures.at(-1)}`);
      }
    }
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
    for (const agentIndexDocument of ['trailing', 'malformed'] as const) {
      const label = `write after a ${agentIndexDocument} agent index repairs without an archive scan`;
      try {
        await writeAfterInconsistentIndex(agentIndexDocument);
        console.log(`PASS: ${label}`);
      } catch (error: unknown) {
        failures.push(`${label}: ${String(error)}`);
        console.error(`FAIL: ${failures.at(-1)}`);
      }
    }
    try {
      await queuedUploadAdmission();
      console.log('PASS: a final upload is admitted ahead of queued live snapshots');
    } catch (error: unknown) {
      failures.push(`final upload admission: ${String(error)}`);
      console.error(`FAIL: ${failures.at(-1)}`);
    }
    const starting = {
      timestamp: '2026-10-07T23:52:38.764044+00:00',
      suite: 'agent-payment-production-abandonment',
      source: 'benchmark-runner',
      tasks: [{ name: 'agent-payment-production-abandonment', status: 'starting' }],
    };
    const snapshotOrder = ['holder', 'snapshot-a', 'snapshot-b', 'final'];
    for (const [label, bundle, expected] of [
      ['required starting registration precedes queued snapshots', starting, undefined],
      [
        'already-owned starting progress retains snapshot admission',
        { ...starting, tasks: [{ ...starting.tasks[0], agent_id: 'fixture-owned-agent' }] },
        snapshotOrder,
      ],
      [
        'mixed running progress retains snapshot admission',
        { ...starting, tasks: [...starting.tasks, { name: 'fixture-running', status: 'running' }] },
        snapshotOrder,
      ],
    ] as const) {
      try {
        await queuedUploadAdmission(bundle, true, expected);
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
const run = process.env.BENCHMARK_HUB_STARTING_RETRY_WORKER === '1' ? startingRetryWorker : main;
run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
