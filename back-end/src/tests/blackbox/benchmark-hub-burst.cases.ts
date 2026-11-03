import './benchmark-hub-overlay-env.fixture';
/** A fleet-wide burst of terminal uploads must share catalog cycles at the single Hub writer. */
import assert from 'node:assert/strict';
import {
  commitObject,
  logicalObject,
  objectETag,
  type HubObjectInput,
} from './benchmark-hub-r2.fixture';
import { S3Client } from '@aws-sdk/client-s3';
import {
  _resetForTests,
  loadHubAgentRunIndex,
  listRunsStrict,
  putRun,
} from '../../providers/benchmarkHubStore';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Production 2026-10-12 (LIVE50 trial 1): about forty fleet controllers posted
 * their terminal bundles within two minutes. Each upload re-read and rewrote the
 * whole 7.7 MB catalog and 2.7 MB agent index under the global lock (~3.1 s per
 * write), so the queue outgrew the client's 30 s response window and three
 * finals that the Hub later committed were reported as failed. Uploads queued
 * behind one writer must commit together in one catalog read-modify-write; one
 * invalid upload in that cycle rejects only itself.
 */
export async function concurrentFinalBurst(count = 40): Promise<void> {
  const sender = S3Client.prototype as unknown as {
    send: (command: unknown) => Promise<unknown>;
  };
  const originalSend = sender.send;
  const prefix = `burst-${process.pid}-${count}`;
  const objects = new Map<string, string>([
    [
      'benchmark-hub/index.json',
      JSON.stringify([
        {
          run_id: `${prefix}-group`,
          timestamp: '2026-10-12T20:21:54.000Z',
          uploaded_at: '2026-10-12T20:21:55.000Z',
          live: true,
          tasks: [],
          run_group: { members: [], status: 'running' },
        },
      ]),
    ],
    ['benchmark-hub/agent-run-index-revision.json', JSON.stringify({ version: 1, revision: 1 })],
    [
      'benchmark-hub/agent-run-index.json',
      JSON.stringify({ version: 1, revision: 1, complete: true, agents: {} }),
    ],
  ]);
  const holderWriting = deferred();
  const releaseHolder = deferred();
  let catalogReads = 0;
  let catalogWrites = 0;
  let pendingWrites = 0;
  let publishedWrites = 0;
  let activeBundleWrites = 0;
  let peakBundleWrites = 0;
  const cycleSizes: number[] = [];
  let publishedRunIds = new Set([`${prefix}-group`]);
  sender.send = async (command) => {
    const input = (command as { input: HubObjectInput }).input;
    assert.equal(input.Bucket, 'offline');
    if (command?.constructor?.name === 'HeadObjectCommand') {
      const value = objects.get(input.Key);
      if (value === undefined)
        throw Object.assign(new Error('fixture absent'), { name: 'NotFound' });
      return { ETag: objectETag(value) };
    }
    if (command?.constructor?.name === 'GetObjectCommand') {
      if (input.Key === 'benchmark-hub-v2/pg_owner/index.json') catalogReads += 1;
      const value = objects.get(input.Key);
      if (value === undefined)
        throw Object.assign(new Error('fixture absent'), { name: 'NoSuchKey' });
      return { Body: Buffer.from(value), ETag: objectETag(value) };
    }
    assert.equal(command?.constructor?.name, 'PutObjectCommand');
    if (input.Key === 'benchmark-hub-v2/pg_owner/index.json') {
      catalogWrites += 1;
      const document = JSON.parse(JSON.parse(input.Body!).payload);
      const pending = Object.values(document.claims).filter(
        (claim) => (claim as { state: string }).state === 'pending'
      ).length;
      assert.ok(pending <= 64, 'one pending cohort may claim at most64 uploads');
      if (pending) pendingWrites++;
      else publishedWrites++;
      const entries = JSON.parse(logicalObject(input.Body!)) as Array<{ run_id: string }>;
      cycleSizes.push(entries.filter((run) => !publishedRunIds.has(run.run_id)).length);
      publishedRunIds = new Set(entries.map((run) => run.run_id));
    }
    if (input.Key.startsWith('benchmark-hub-v2/pg_owner/runs/')) {
      activeBundleWrites += 1;
      peakBundleWrites = Math.max(peakBundleWrites, activeBundleWrites);
      await new Promise((resolve) => setImmediate(resolve));
      activeBundleWrites -= 1;
    }
    if (input.Key === `benchmark-hub-v2/pg_owner/runs/${prefix}-holder.json`) {
      holderWriting.resolve();
      await releaseHolder.promise;
    }
    const committed = commitObject(objects, input);
    return committed;
  };
  // The fleet's terminal shape: one released task, half with a root agent.
  const final = (i: number) => ({
    run_id: `${prefix}-final-${i}`,
    timestamp: `2026-10-12T20:22:${String(i).padStart(2, '0')}+00:00`,
    suite: 'cloud-fleet',
    source: 'direct-cloud-fleet',
    status: 'failed',
    tasks: [
      {
        name: `task-${i}`,
        passed: false,
        status: 'INFRA_ERROR',
        failure_reason: 'no current run artifact produced',
        lifecycle_stage: 'released',
        logs: {
          messages: [
            { role: 'assistant', message: `complete transcript ${i}: ` + 'λ\n'.repeat(2000) },
          ],
          tree: {
            [`child-${i}`]: {
              parent_agent_id: `root-${i}`,
              messages: [{ role: 'assistant', message: `complete child transcript ${i}` }],
            },
          },
        },
        ...(i % 2 === 0
          ? { agent_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }
          : {}),
      },
    ],
  });
  let uploads: Promise<unknown> | undefined;
  try {
    const holder = putRun(
      { run_id: `${prefix}-holder`, tasks: [{ name: 'holder', status: 'running' }] },
      { live: true }
    );
    await holderWriting.promise;
    const finals = Array.from({ length: count }, (_, i) => putRun(final(i), { live: false }));
    const collision = putRun({ run_id: `${prefix}-group`, tasks: [] }, { live: false }).then(
      () => 'stored',
      (error: unknown) => String(error)
    );
    uploads = Promise.allSettled([holder, ...finals, collision]);
    releaseHolder.resolve();
    const results = await Promise.all(finals);
    await holder;
    assert.equal(
      await collision,
      'Error: Benchmark Hub group ID collides with a physical run',
      'an invalid member must reject alone'
    );
    assert.equal(
      catalogWrites,
      2 * (1 + Math.ceil((count + 1) / 64)),
      `${count} queued finals must share bounded catalog cycles after the holder; saw ${catalogWrites} catalog writes`
    );
    const cycles = 1 + Math.ceil((count + 1) / 64);
    assert.equal(pendingWrites, cycles);
    assert.equal(publishedWrites, cycles);
    assert.equal(
      catalogReads,
      4 * cycles,
      'one logical snapshot, pending CAS observation, published CAS observation, plus paired metadata claim read per cohort'
    );
    assert.ok(
      cycleSizes.every((size) => size <= 64),
      'a publication may store at most 64 uploads'
    );
    assert.ok(peakBundleWrites <= 8, 'bundle publication must use at most eight lanes');
    assert.equal(activeBundleWrites, 0, 'all write lanes settle before acknowledgement');
    assert.ok(results.every((summary) => summary.live === false));
    const index = (await listRunsStrict()) as Array<{
      run_id: string;
      live: boolean;
      tasks: Array<{ status: string }>;
    }>;
    assert.equal(index.length, count + 2, 'group record, holder and every final');
    for (let i = 0; i < count; i += 1) {
      const run = index.find((entry) => entry.run_id === `${prefix}-final-${i}`);
      assert.equal(run?.live, false);
      assert.equal(run?.tasks[0]?.status, 'INFRA_ERROR');
      assert.deepEqual(
        JSON.parse(
          logicalObject(objects.get(`benchmark-hub-v2/pg_owner/runs/${prefix}-final-${i}.json`)!)
        ).tasks,
        final(i).tasks
      );
      assert.equal(
        logicalObject(
          objects.get(`benchmark-hub-v2/pg_owner/visibility/${prefix}-final-${i}.json`)!
        ),
        'true'
      );
    }
    assert.equal(index.find((entry) => entry.run_id === `${prefix}-group`)?.live, true);
    const agentIndex = await loadHubAgentRunIndex();
    assert.ok(agentIndex !== null);
    assert.equal(agentIndex.revision, count + 2, 'one revision per committed upload');
    for (let i = 0; i < count; i += 2) {
      assert.equal(
        agentIndex.agents.get(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
        `${prefix}-final-${i}`
      );
    }
  } finally {
    releaseHolder.resolve();
    await Promise.allSettled([uploads]);
    sender.send = originalSend;
    _resetForTests();
  }
}
