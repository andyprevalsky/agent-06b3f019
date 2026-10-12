/** A fleet-wide burst of terminal uploads must share catalog cycles at the single Hub writer. */
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { _resetForTests, loadHubAgentRunIndex, putRun } from '../../providers/benchmarkHubStore';

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
export async function concurrentFinalBurst(): Promise<void> {
  const sender = S3Client.prototype as unknown as {
    send: (command: unknown) => Promise<unknown>;
  };
  const originalSend = sender.send;
  const prefix = `burst-${process.pid}`;
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
  sender.send = async (command) => {
    const input = (command as { input: { Bucket: string; Key: string; Body?: string } }).input;
    assert.equal(input.Bucket, 'offline');
    if (command?.constructor?.name === 'GetObjectCommand') {
      if (input.Key === 'benchmark-hub/index.json') catalogReads += 1;
      const value = objects.get(input.Key);
      if (value === undefined)
        throw Object.assign(new Error('fixture absent'), { name: 'NoSuchKey' });
      return { Body: Buffer.from(value) };
    }
    assert.equal(command?.constructor?.name, 'PutObjectCommand');
    if (input.Key === 'benchmark-hub/index.json') catalogWrites += 1;
    if (input.Key === `benchmark-hub/runs/${prefix}-holder.json`) {
      holderWriting.resolve();
      await releaseHolder.promise;
    }
    objects.set(input.Key, input.Body!);
    return {};
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
    const finals = Array.from({ length: 40 }, (_, i) => putRun(final(i), { live: false }));
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
      2,
      `40 queued finals must share one catalog cycle after the holder; saw ${catalogWrites} catalog writes`
    );
    assert.equal(catalogReads, 2, 'each catalog cycle reads the catalog once');
    assert.ok(results.every((summary) => summary.live === false));
    const index = JSON.parse(objects.get('benchmark-hub/index.json')!) as Array<{
      run_id: string;
      live: boolean;
      tasks: Array<{ status: string }>;
    }>;
    assert.equal(index.length, 42, 'group record, holder and forty finals');
    for (let i = 0; i < 40; i += 1) {
      const run = index.find((entry) => entry.run_id === `${prefix}-final-${i}`);
      assert.equal(run?.live, false);
      assert.equal(run?.tasks[0]?.status, 'INFRA_ERROR');
      assert.deepEqual(
        JSON.parse(objects.get(`benchmark-hub/runs/${prefix}-final-${i}.json`)!).tasks,
        final(i).tasks
      );
      assert.equal(objects.get(`benchmark-hub/visibility/${prefix}-final-${i}.json`), 'true');
    }
    assert.equal(index.find((entry) => entry.run_id === `${prefix}-group`)?.live, true);
    const agentIndex = await loadHubAgentRunIndex();
    assert.ok(agentIndex !== null);
    assert.equal(agentIndex.revision, 42, 'one revision per committed upload');
    for (let i = 0; i < 40; i += 2) {
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
