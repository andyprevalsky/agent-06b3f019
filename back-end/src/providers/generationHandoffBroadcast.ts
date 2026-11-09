/**
 * Push the generation cutover to workflows idling on the superseded queue.
 *
 *   deploy flips AgentQueuePointer (setCurrentAgentQueue)
 *        │
 *        ▼
 *   broadcastGenerationHandoff({ fromQueue, liveQueue })
 *        │ visibility: TaskQueue=<from> AND Running AND WorkflowType=AgentWorkflow (paged)
 *        │ batches of `batchSize`, at most `signalsPerSecond`, bounded by `deadlineMs`
 *        ▼
 *   signal generation_handoff_available(liveQueue) per workflow id
 *        ▼
 *   agents/helpers/wait_condition_or_handoff.py: idle parks wake, read the
 *   pointer once (continuation admission) and continue_as_new.
 *        +
 *   moveStrandedResumeRuns(fromQueue, liveQueue): a code/browser resume run a
 *   new backend started on the old queue before the flip (its workers lack
 *   those workflow types) restarts on the live queue (codeAgentResumeWorkflow.ts).
 *
 * 10k agents: O(agents) signals once per deploy instead of one pointer
 * activity + backend read per waiting agent every 30s. Best-effort by design:
 * a missed workflow still hands off at its next run_agent turn or at the
 * workflow's idle safety re-check, so a failed or truncated broadcast never
 * blocks the deploy.
 */
import { WorkflowNotFoundError } from '@temporalio/client';
import { getTemporalClient, withTemporalControlDeadline } from './temporal';
import { moveStrandedResumeRuns } from './codeAgentResumeWorkflow';

export const GENERATION_HANDOFF_SIGNAL = 'generation_handoff_available';
export const AGENT_WORKFLOW_TYPE = 'AgentWorkflow';
const SAFE_QUEUE = /^[A-Za-z0-9._@:-]{1,200}$/;

export interface GenerationHandoffBroadcastOptions {
  fromQueue: string;
  liveQueue: string;
  batchSize?: number;
  signalsPerSecond?: number;
  deadlineMs?: number;
}

export interface GenerationHandoffBroadcastDependencies {
  list(query: string): AsyncIterable<{ workflowId: string }>;
  signal(workflowId: string, signal: string, arg: string): Promise<'signalled' | 'gone'>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Restart resume runs stranded on the old queue (absent: skipped, e.g. in tests). */
  moveResumeRuns?(fromQueue: string, liveQueue: string): Promise<{ moved: number; failed: number }>;
}

export interface GenerationHandoffBroadcastReport {
  fromQueue: string;
  liveQueue: string;
  listed: number;
  signalled: number;
  gone: number;
  failed: number;
  batches: number;
  truncated: boolean;
  resumeRunsMoved: number;
  resumeRunsFailed: number;
}

export function generationHandoffBroadcastQuery(fromQueue: string): string {
  if (!SAFE_QUEUE.test(fromQueue)) throw new Error(`Unsafe task queue name: ${fromQueue}`);
  return `TaskQueue = "${fromQueue}" AND ExecutionStatus = "Running" AND WorkflowType = "${AGENT_WORKFLOW_TYPE}"`;
}

function temporalDependencies(): GenerationHandoffBroadcastDependencies {
  return {
    async *list(query: string) {
      const client = await getTemporalClient();
      for await (const execution of client.workflow.list({ query })) {
        yield { workflowId: execution.workflowId };
      }
    },
    async signal(workflowId: string, signal: string, arg: string) {
      const client = await getTemporalClient();
      try {
        // No run id: a workflow that continued as new on the same old queue
        // after listing still receives it; one already on the live queue ignores it.
        await withTemporalControlDeadline(client, () =>
          client.workflow.getHandle(workflowId).signal(signal, arg)
        );
        return 'signalled';
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return 'gone';
        throw error;
      }
    },
    sleep: (ms: number) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
    moveResumeRuns: (fromQueue, liveQueue) => moveStrandedResumeRuns(fromQueue, liveQueue),
  };
}

export async function broadcastGenerationHandoff(
  options: GenerationHandoffBroadcastOptions,
  deps: GenerationHandoffBroadcastDependencies = temporalDependencies()
): Promise<GenerationHandoffBroadcastReport> {
  const { fromQueue, liveQueue } = options;
  if (!SAFE_QUEUE.test(liveQueue)) throw new Error(`Unsafe task queue name: ${liveQueue}`);
  if (fromQueue === liveQueue) throw new Error('Source and live queues are identical');
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 100));
  const signalsPerSecond = Math.max(1, options.signalsPerSecond ?? 200);
  const deadlineAt = deps.now() + Math.max(1, options.deadlineMs ?? 120_000);
  const report: GenerationHandoffBroadcastReport = {
    fromQueue,
    liveQueue,
    listed: 0,
    signalled: 0,
    gone: 0,
    failed: 0,
    batches: 0,
    truncated: false,
    resumeRunsMoved: 0,
    resumeRunsFailed: 0,
  };
  const seen = new Set<string>();
  let batch: string[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const started = deps.now();
    const outcomes = await Promise.allSettled(
      batch.map((id) => deps.signal(id, GENERATION_HANDOFF_SIGNAL, liveQueue))
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') report.failed += 1;
      else if (outcome.value === 'gone') report.gone += 1;
      else report.signalled += 1;
    }
    report.batches += 1;
    const minimumMs = (batch.length / signalsPerSecond) * 1000;
    batch = [];
    const waitMs = minimumMs - (deps.now() - started);
    if (waitMs > 0) await deps.sleep(waitMs);
  };
  for await (const { workflowId } of deps.list(generationHandoffBroadcastQuery(fromQueue))) {
    if (deps.now() >= deadlineAt) {
      report.truncated = true;
      break;
    }
    if (seen.has(workflowId)) continue;
    seen.add(workflowId);
    report.listed += 1;
    batch.push(workflowId);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  if (deps.moveResumeRuns) {
    try {
      const moved = await deps.moveResumeRuns(fromQueue, liveQueue);
      report.resumeRunsMoved = moved.moved;
      report.resumeRunsFailed = moved.failed;
    } catch {
      // Best-effort like the signals: a resend of the turn moves the run too.
      report.resumeRunsFailed += 1;
    }
  }
  return report;
}
