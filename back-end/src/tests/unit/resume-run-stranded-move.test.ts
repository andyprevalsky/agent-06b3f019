#!/usr/bin/env tsx
/**
 * A code/browser resume run a new backend started on the OLD worker generation's
 * queue before a deploy's cutover flipped AgentQueuePointer never completes a
 * workflow task there (those workers do not register the resume workflow types).
 * After the flip it must restart on the live queue with its exact request, both
 * from the cutover's handoff broadcast and from a resend of the same turn; a run
 * that ever progressed (a worker serves it) or is still starting is left alone.
 */
import assert from 'node:assert';
import {
  BROWSER_AGENT_RESUME_WORKFLOW,
  CODE_AGENT_RESUME_WORKFLOW,
  ensureResumeRunOnLiveQueue,
  moveStrandedResumeRuns,
  STRANDED_MIN_AGE_MS,
  type ResumeRunMoveDependencies,
} from '../../providers/codeAgentResumeWorkflow';
import {
  broadcastGenerationHandoff,
  type GenerationHandoffBroadcastDependencies,
} from '../../providers/generationHandoffBroadcast';
import { createTestHarness } from './trace-archive-test-utils'; // pragma: allowlist secret

const { test, finish } = createTestHarness('stranded resume run move unit tests');

const OLD = 'navi-agent-tasks-pool-aaaaaaaaaaaa@111111111111';
const LIVE = 'navi-agent-tasks-pool-bbbbbbbbbbbb@222222222222';
const NOW = 1_000_000_000;

interface Run {
  workflowId: string;
  /** Temporal's execution id; one workflow id has one execution per start. */
  runId?: string;
  workflowType: string;
  taskQueue: string;
  running: boolean;
  terminated?: boolean;
  startTimeMs: number;
  progressed: boolean;
}

function fakeTemporal(
  runs: Run[],
  saved: Record<string, { workflowType: string; request: unknown; moved?: boolean }>,
  unserved: Set<string> = new Set(),
  deletedOwners: Set<string> = new Set()
) {
  const terminated: string[] = [];
  const terminatedRuns: string[] = [];
  let nextRun = 0;
  for (const run of runs) run.runId ??= `run-${(nextRun += 1)}`;
  // Like Temporal: a workflow id resolves to its newest execution.
  const newest = (workflowId: string) =>
    runs.filter((candidate) => candidate.workflowId === workflowId).at(-1);
  const started: Array<{
    workflowType: string;
    workflowId: string;
    taskQueue: string;
    request: unknown;
  }> = [];
  const queries: string[] = [];
  const deps: ResumeRunMoveDependencies = {
    async describe(workflowId) {
      const run = newest(workflowId);
      return run ? { ...run, runId: run.runId! } : null;
    },
    async progressed(workflowId) {
      return runs.find((candidate) => candidate.workflowId === workflowId)?.progressed === true;
    },
    async loadRequest(workflowId) {
      return saved[workflowId] ?? null;
    },
    async markMoved(workflowId, savedRequest) {
      saved[workflowId] = { ...savedRequest, moved: true } as never;
    },
    async terminate(workflowId, runId) {
      // A call without a known run id targets the newest execution (Temporal's run-less handle).
      const run =
        runs.find(
          (candidate) => candidate.workflowId === workflowId && candidate.runId === runId
        ) ?? newest(workflowId)!;
      if (!run.running) return false; // "workflow execution already completed"
      terminated.push(workflowId);
      terminatedRuns.push(run.runId!);
      run.running = false;
      run.terminated = true;
      return true;
    },
    async start(workflowType, workflowId, taskQueue, request) {
      started.push({ workflowType, workflowId, taskQueue, request });
      runs.push({
        workflowId,
        runId: `run-${(nextRun += 1)}`,
        workflowType,
        taskQueue,
        running: true,
        startTimeMs: NOW,
        progressed: false,
      });
    },
    async *list(query) {
      queries.push(query);
      const match =
        /^TaskQueue = "([^"]+)" AND ExecutionStatus = "Running" AND \(WorkflowType = "([^"]+)" OR WorkflowType = "([^"]+)"\)$/.exec(
          query
        );
      assert.ok(match, `unexpected visibility query ${query}`);
      for (const run of [...runs]) {
        if (
          run.running &&
          run.taskQueue === match[1] &&
          [match[2], match[3]].includes(run.workflowType)
        ) {
          yield { workflowId: run.workflowId };
        }
      }
    },
    async serves(taskQueue) {
      return !unserved.has(taskQueue);
    },
    async ownerLive(workflowId) {
      return !deletedOwners.has(workflowId);
    },
    now: () => NOW,
  };
  return { deps, terminated, terminatedRuns, started, queries, runs };
}

const OLD_ENOUGH = NOW - STRANDED_MIN_AGE_MS - 1;

async function main(): Promise<void> {
  await test('a resend moves a stranded run to the live queue with its exact request', async () => {
    const request = { agent_id: 'a', message_id: 'm', message: 'continue' };
    const fake = fakeTemporal(
      [
        {
          workflowId: 'code-resume:a:m',
          workflowType: CODE_AGENT_RESUME_WORKFLOW,
          taskQueue: OLD,
          running: true,
          startTimeMs: OLD_ENOUGH,
          progressed: false,
        },
      ],
      { 'code-resume:a:m': { workflowType: CODE_AGENT_RESUME_WORKFLOW, request } }
    );
    const outcome = await ensureResumeRunOnLiveQueue('code-resume:a:m', LIVE, fake.deps);
    assert.strictEqual(outcome, 'moved');
    assert.deepStrictEqual(fake.terminated, ['code-resume:a:m']);
    assert.deepStrictEqual(fake.started, [
      {
        workflowType: CODE_AGENT_RESUME_WORKFLOW,
        workflowId: 'code-resume:a:m',
        taskQueue: LIVE,
        request,
      },
    ]);
  });

  await test('leaves live, progressed, young, finished and unknown runs alone', async () => {
    const base = { workflowType: CODE_AGENT_RESUME_WORKFLOW, running: true, progressed: false };
    const fake = fakeTemporal(
      [
        { ...base, workflowId: 'live', taskQueue: LIVE, startTimeMs: OLD_ENOUGH },
        {
          ...base,
          workflowId: 'served',
          taskQueue: OLD,
          startTimeMs: OLD_ENOUGH,
          progressed: true,
        },
        { ...base, workflowId: 'young', taskQueue: OLD, startTimeMs: NOW - 1000 },
        { ...base, workflowId: 'done', taskQueue: OLD, startTimeMs: OLD_ENOUGH, running: false },
        { ...base, workflowId: 'unsaved', taskQueue: OLD, startTimeMs: OLD_ENOUGH },
      ],
      {}
    );
    const outcomes = [];
    for (const id of ['live', 'served', 'young', 'done', 'unsaved', 'missing']) {
      outcomes.push(await ensureResumeRunOnLiveQueue(id, LIVE, fake.deps));
    }
    assert.deepStrictEqual(outcomes, [
      'live',
      'progressed',
      'young',
      'not-running',
      'unknown-request',
      'not-running',
    ]);
    assert.deepStrictEqual(fake.terminated, []);
    assert.deepStrictEqual(fake.started, []);
  });

  await test('a live queue whose workers lack the type: nothing is terminated or moved', async () => {
    const fake = fakeTemporal(
      [
        {
          workflowId: 'code-resume:a:m',
          workflowType: CODE_AGENT_RESUME_WORKFLOW,
          taskQueue: OLD,
          running: true,
          startTimeMs: OLD_ENOUGH,
          progressed: false,
        },
      ],
      { 'code-resume:a:m': { workflowType: CODE_AGENT_RESUME_WORKFLOW, request: {} } },
      new Set([LIVE])
    );
    assert.strictEqual(
      await ensureResumeRunOnLiveQueue('code-resume:a:m', LIVE, fake.deps),
      'unserved'
    );
    assert.deepStrictEqual(fake.terminated, []);
    assert.deepStrictEqual(fake.started, []);
  });

  await test('a resend revives only a run the move terminated, never a killed one', async () => {
    const request = { agent_id: 'a', message_id: 'm' };
    const terminatedRun = (workflowId: string): Run => ({
      workflowId,
      workflowType: CODE_AGENT_RESUME_WORKFLOW,
      taskQueue: OLD,
      running: false,
      terminated: true,
      startTimeMs: OLD_ENOUGH,
      progressed: false,
    });
    const fake = fakeTemporal([terminatedRun('moved'), terminatedRun('killed')], {
      moved: { workflowType: CODE_AGENT_RESUME_WORKFLOW, request, moved: true },
      killed: { workflowType: CODE_AGENT_RESUME_WORKFLOW, request },
    });
    // Only a resend revives (never the cutover sweep or a plain check).
    assert.strictEqual(await ensureResumeRunOnLiveQueue('moved', LIVE, fake.deps), 'not-running');
    const revive = { reviveTerminated: true };
    assert.strictEqual(
      await ensureResumeRunOnLiveQueue('moved', LIVE, fake.deps, revive),
      'restarted'
    );
    assert.strictEqual(
      await ensureResumeRunOnLiveQueue('killed', LIVE, fake.deps, revive),
      'not-running'
    );
    assert.deepStrictEqual(
      fake.started.map((start) => [start.workflowId, start.taskQueue]),
      [['moved', LIVE]]
    );
  });

  await test('a moved run whose owner was deleted in between is never restarted', async () => {
    const request = { agent_id: 'a', message_id: 'm' };
    const fake = fakeTemporal(
      [
        {
          workflowId: 'moved',
          workflowType: CODE_AGENT_RESUME_WORKFLOW,
          taskQueue: OLD,
          running: false,
          terminated: true,
          startTimeMs: OLD_ENOUGH,
          progressed: false,
        },
      ],
      { moved: { workflowType: CODE_AGENT_RESUME_WORKFLOW, request, moved: true } },
      new Set(),
      new Set(['moved'])
    );
    assert.strictEqual(
      await ensureResumeRunOnLiveQueue('moved', LIVE, fake.deps, { reviveTerminated: true }),
      'not-running'
    );
    assert.deepStrictEqual(fake.started, []);
  });

  await test('two concurrent movers: only the described run is terminated, the replacement survives', async () => {
    // The cutover broadcast and a resend both see the stranded run; the broadcast
    // moves it first, then the resend acts on what it described before that.
    const fake = fakeTemporal(
      [
        {
          workflowId: 'code-resume:a:m',
          workflowType: CODE_AGENT_RESUME_WORKFLOW,
          taskQueue: OLD,
          running: true,
          startTimeMs: OLD_ENOUGH,
          progressed: false,
        },
      ],
      { 'code-resume:a:m': { workflowType: CODE_AGENT_RESUME_WORKFLOW, request: { n: 1 } } }
    );
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let described = () => {};
    const describedOnce = new Promise<void>((resolve) => (described = resolve));
    const resendDeps: ResumeRunMoveDependencies = {
      ...fake.deps,
      async describe(workflowId) {
        const result = await fake.deps.describe(workflowId);
        described();
        await gate;
        return result;
      },
    };
    const resend = ensureResumeRunOnLiveQueue('code-resume:a:m', LIVE, resendDeps);
    await describedOnce;
    const broadcast = await moveStrandedResumeRuns(OLD, LIVE, fake.deps);
    release();
    assert.deepStrictEqual(broadcast, { listed: 1, moved: 1, failed: 0 });
    assert.strictEqual(await resend, 'moved-elsewhere');
    assert.deepStrictEqual(fake.terminatedRuns, ['run-1'], 'never the replacement');
    assert.deepStrictEqual(
      fake.started.map((start) => start.taskQueue),
      [LIVE],
      'the turn is delivered once'
    );
    assert.strictEqual(fake.runs.filter((run) => run.running).length, 1);
  });

  await test('the move flags the stored request before it terminates the run', async () => {
    const saved = { 'code-resume:a:m': { workflowType: CODE_AGENT_RESUME_WORKFLOW, request: {} } };
    const fake = fakeTemporal(
      [
        {
          workflowId: 'code-resume:a:m',
          workflowType: CODE_AGENT_RESUME_WORKFLOW,
          taskQueue: OLD,
          running: true,
          startTimeMs: OLD_ENOUGH,
          progressed: false,
        },
      ],
      saved
    );
    assert.strictEqual(
      await ensureResumeRunOnLiveQueue('code-resume:a:m', LIVE, fake.deps),
      'moved'
    );
    assert.strictEqual((saved['code-resume:a:m'] as { moved?: boolean }).moved, true);
  });

  await test('after a cutover every stranded code and browser run moves; others stay', async () => {
    const stranded = { running: true, progressed: false, startTimeMs: OLD_ENOUGH, taskQueue: OLD };
    const fake = fakeTemporal(
      [
        { ...stranded, workflowId: 'code-resume:a:1', workflowType: CODE_AGENT_RESUME_WORKFLOW },
        {
          ...stranded,
          workflowId: 'code-resume:b:browser:2',
          workflowType: BROWSER_AGENT_RESUME_WORKFLOW,
        },
        {
          ...stranded,
          workflowId: 'code-resume:c:3',
          workflowType: CODE_AGENT_RESUME_WORKFLOW,
          progressed: true,
        },
        { ...stranded, workflowId: 'agent-x', workflowType: 'AgentWorkflow' },
      ],
      {
        'code-resume:a:1': { workflowType: CODE_AGENT_RESUME_WORKFLOW, request: { n: 1 } },
        'code-resume:b:browser:2': {
          workflowType: BROWSER_AGENT_RESUME_WORKFLOW,
          request: { n: 2 },
        },
      }
    );
    const report = await moveStrandedResumeRuns(OLD, LIVE, fake.deps);
    assert.deepStrictEqual(report, { listed: 3, moved: 2, failed: 0 });
    assert.deepStrictEqual(
      fake.started.map((start) => [start.workflowId, start.taskQueue]),
      [
        ['code-resume:a:1', LIVE],
        ['code-resume:b:browser:2', LIVE],
      ]
    );
    await assert.rejects(moveStrandedResumeRuns('q" OR TaskQueue = "x', LIVE, fake.deps));
  });

  await test('the handoff broadcast runs the move after signalling and reports it', async () => {
    const calls: Array<[string, string]> = [];
    const deps: GenerationHandoffBroadcastDependencies = {
      async *list() {
        // no AgentWorkflow executions
      },
      async signal() {
        return 'signalled';
      },
      async sleep() {},
      now: () => 0,
      async moveResumeRuns(fromQueue, liveQueue) {
        calls.push([fromQueue, liveQueue]);
        return { moved: 2, failed: 1 };
      },
    };
    const report = await broadcastGenerationHandoff({ fromQueue: OLD, liveQueue: LIVE }, deps);
    assert.deepStrictEqual(calls, [[OLD, LIVE]]);
    assert.strictEqual(report.resumeRunsMoved, 2);
    assert.strictEqual(report.resumeRunsFailed, 1);
  });

  finish();
}

void main();
