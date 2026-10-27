#!/usr/bin/env tsx
import assert from 'node:assert';
import {
  AGENT_WORKFLOW_TYPE,
  broadcastGenerationHandoff,
  GENERATION_HANDOFF_SIGNAL,
  generationHandoffBroadcastQuery,
  type GenerationHandoffBroadcastDependencies,
} from '../../providers/generationHandoffBroadcast';
import { createTestHarness } from './trace-archive-test-utils'; // pragma: allowlist secret

const { test, finish } = createTestHarness('generation handoff broadcast unit tests');

const OLD = 'navi-agent-tasks-pool-aaaaaaaaaaaa@111111111111';
const LIVE = 'navi-agent-tasks-pool-bbbbbbbbbbbb@222222222222';

type Execution = { workflowId: string; taskQueue: string; status: string; type: string };

/** Temporal visibility + signal RPC fake that evaluates the exact query the broadcaster sends. */
function fakeTemporal(
  executions: Execution[],
  options: { gone?: Set<string>; failing?: Set<string> } = {}
) {
  let clock = 0;
  const signals: Array<{ workflowId: string; signal: string; arg: string; batchAt: number }> = [];
  const sleeps: number[] = [];
  const queries: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const deps: GenerationHandoffBroadcastDependencies = {
    async *list(query: string) {
      queries.push(query);
      const match =
        /^TaskQueue = "([^"]+)" AND ExecutionStatus = "Running" AND WorkflowType = "([^"]+)"$/.exec(
          query
        );
      assert.ok(match, `unexpected visibility query ${query}`);
      for (const execution of executions) {
        if (
          execution.taskQueue === match[1] &&
          execution.status === 'Running' &&
          execution.type === match[2]
        )
          yield { workflowId: execution.workflowId };
      }
    },
    async signal(workflowId: string, signal: string, arg: string) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      clock += 1; // 1ms per RPC
      signals.push({ workflowId, signal, arg, batchAt: clock });
      if (options.failing?.has(workflowId)) throw new Error('transient RPC failure');
      return options.gone?.has(workflowId) ? 'gone' : 'signalled';
    },
    async sleep(ms: number) {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, signals, sleeps, queries, maxInFlight: () => maxInFlight };
}

function executionsFixture(): Execution[] {
  const rows: Execution[] = [];
  for (let i = 0; i < 250; i += 1)
    rows.push({
      workflowId: `old-${i}`,
      taskQueue: OLD,
      status: 'Running',
      type: AGENT_WORKFLOW_TYPE,
    });
  rows.push({
    workflowId: 'live-1',
    taskQueue: LIVE,
    status: 'Running',
    type: AGENT_WORKFLOW_TYPE,
  });
  rows.push({
    workflowId: 'old-done',
    taskQueue: OLD,
    status: 'Completed',
    type: AGENT_WORKFLOW_TYPE,
  });
  rows.push({
    workflowId: 'old-other-type',
    taskQueue: OLD,
    status: 'Running',
    type: 'WorkerDeploymentActivation',
  });
  rows.push({
    workflowId: 'other-queue',
    taskQueue: 'navi-agent-tasks-local',
    status: 'Running',
    type: AGENT_WORKFLOW_TYPE,
  });
  return rows;
}

async function main(): Promise<void> {
  await test('signals exactly the running AgentWorkflows on the old queue, in rate-limited batches', async () => {
    const fake = fakeTemporal(executionsFixture());
    const report = await broadcastGenerationHandoff(
      { fromQueue: OLD, liveQueue: LIVE, batchSize: 100, signalsPerSecond: 200 },
      fake.deps
    );
    assert.deepStrictEqual(fake.queries, [generationHandoffBroadcastQuery(OLD)]);
    const ids = fake.signals.map((row) => row.workflowId).sort();
    assert.deepStrictEqual(ids, Array.from({ length: 250 }, (_, i) => `old-${i}`).sort());
    assert.ok(
      fake.signals.every((row) => row.signal === GENERATION_HANDOFF_SIGNAL && row.arg === LIVE)
    );
    assert.strictEqual(report.batches, 3);
    assert.ok(fake.maxInFlight() <= 100, `batch concurrency ${fake.maxInFlight()} exceeds 100`);
    // 100 signals at 200/s must take >= 500ms per batch (minus the RPC time already spent).
    assert.deepStrictEqual(fake.sleeps, [400, 400, 200]);
    assert.deepStrictEqual(
      {
        listed: report.listed,
        signalled: report.signalled,
        gone: report.gone,
        failed: report.failed,
      },
      { listed: 250, signalled: 250, gone: 0, failed: 0 }
    );
    assert.strictEqual(report.truncated, false);
  });

  await test('duplicates are signalled once; finished and failing workflows do not stop the sweep', async () => {
    const rows = executionsFixture().slice(0, 5);
    rows.push({ ...rows[0] });
    const fake = fakeTemporal(rows, { gone: new Set(['old-1']), failing: new Set(['old-2']) });
    const report = await broadcastGenerationHandoff({ fromQueue: OLD, liveQueue: LIVE }, fake.deps);
    assert.strictEqual(fake.signals.length, 5);
    assert.deepStrictEqual(
      {
        listed: report.listed,
        signalled: report.signalled,
        gone: report.gone,
        failed: report.failed,
      },
      { listed: 5, signalled: 3, gone: 1, failed: 1 }
    );
  });

  await test('the deadline truncates the sweep instead of blocking the deploy', async () => {
    const fake = fakeTemporal(executionsFixture());
    const report = await broadcastGenerationHandoff(
      { fromQueue: OLD, liveQueue: LIVE, batchSize: 50, signalsPerSecond: 100, deadlineMs: 600 },
      fake.deps
    );
    assert.strictEqual(report.truncated, true);
    assert.ok(report.signalled > 0 && report.signalled < 250, `signalled ${report.signalled}`);
    assert.strictEqual(report.signalled, fake.signals.length);
  });

  await test('refuses identical or unsafe queues before any visibility call', async () => {
    const fake = fakeTemporal(executionsFixture());
    await assert.rejects(
      broadcastGenerationHandoff({ fromQueue: LIVE, liveQueue: LIVE }, fake.deps)
    );
    await assert.rejects(
      broadcastGenerationHandoff({ fromQueue: 'q" OR TaskQueue = "x', liveQueue: LIVE }, fake.deps)
    );
    await assert.rejects(
      broadcastGenerationHandoff({ fromQueue: OLD, liveQueue: 'bad queue' }, fake.deps)
    );
    assert.strictEqual(fake.queries.length, 0);
  });

  finish();
}

void main();
