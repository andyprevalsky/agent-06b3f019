/**
 * Start the supervising workflow that resumes a stopped code agent when its
 * owner cannot (agents/workflows/code_agent_resume.py): the owner finished or is
 * paused, or the code agent ran as a foreground spawn with no wake record.
 *
 *   directChatResume ─▶ start CodeAgentResumeWorkflow {agent, spawn tool call,
 *     code session, message, attachments} on the current agent generation queue
 *     └─▶ the spawn activity resumes the persistent CodeSession (paused sandbox,
 *         CLI --resume) with the message as its next turn, posting the spawn's
 *         usual rows on the owner (same tool call id: the view folds the runs)
 *
 * Idempotent per typed message: the workflow id is derived from the turn's row
 * id, so a retried send finds the same execution instead of a second run.
 *
 * Pause: the owner's pause (agentControlService.pauseAgent, the user's control)
 * also signals `pause` to its recent resume runs (recorded per agent, bounded),
 * which cancels the code activity through the spawn's normal pause path.
 *
 * Deploy order (worker generations): a run starts on the current generation's
 * queue. Until a deploy's cutover flips AgentQueuePointer, a new backend can
 * start a run on the OLD generation's queue, whose workers do not register these
 * workflow types, so the run never completes a workflow task:
 *
 *   start ─▶ store {type, request} ─▶ queue = getCurrentAgentQueue()
 *   cutover flips the pointer ─▶ broadcastGenerationHandoff ─▶ moveStrandedResumeRuns
 *   a resend of the same turn ─▶ already started ─▶ ensureResumeRunOnLiveQueue
 *     run RUNNING on a superseded queue, no completed workflow task, older than
 *     STRANDED_MIN_AGE_MS ─▶ terminate THAT run id ─▶ start the same id/type/request
 *     on the live queue (the reuse policy admits a terminated run); that run already
 *     closed ─▶ a concurrent mover replaced it: no second start
 *   a run that ever progressed hands off itself (continue-as-new) and is left alone
 *
 * The user only sees "Resuming…" until the move; no error, no polling.
 */
import type { Prisma } from '@prisma/client';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { getTemporalClient } from './temporal';
import { getCurrentAgentQueue } from './agentQueuePointer';
import { deleteEphemeral, getEphemeral, putEphemeral, withSerializedLock } from './sharedState';
import { prisma } from './database';
import { createLogger } from './logger';
import { queueServesWorkflowTypes } from './workerQueueCapabilities';

const log = createLogger('CodeAgentResume');
const RUNS_NAMESPACE = 'code-agent-resume-runs';
// Bounded per agent; renewed by every start and every pause lookup.
const RUNS_TTL_MS = 14 * 24 * 60 * 60_000;
const MAX_RUNS_PER_AGENT = 20;
// Each run's start {type, request}, so a run stranded on a superseded queue can
// be restarted on the live one with the exact request.
const REQUESTS_NAMESPACE = 'code-agent-resume-requests';
// A worker that registers these types completes the first workflow task within
// seconds; a run with none after this long is not being served by its queue.
export const STRANDED_MIN_AGE_MS = 30_000;
// temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED.
const WORKFLOW_TASK_COMPLETED_EVENT = 7;
const HISTORY_PAGE_SIZE = 20;
import type { CodeCliSettingsOverride } from './codeAgentModels';
import { resolveArchiveRoot } from './archiveRootResolver';

export const CODE_AGENT_RESUME_WORKFLOW = 'CodeAgentResumeWorkflow';

export interface CodeAgentResumeRequest {
  agent_id: string;
  user_id: string;
  model: string;
  tool_call_id: string;
  task_name: string | null;
  code_session_id: string | null;
  code_provider: 'claude' | 'codex';
  message: string;
  message_id: string;
  attachments: Array<Record<string, unknown>>;
  /** The typed turn's model / effort / speed (the first resumed turn runs on them). */
  cli_settings?: CodeCliSettingsOverride;
  /** Archive root of the agent tree (busId ?? id); stamped by startResumeRun. */
  root_agent_id?: string;
}

/** Whether a turn's supervised resume run exists (any status). */
export async function codeAgentResumeRunExists(
  agentId: string,
  messageId: string
): Promise<boolean> {
  try {
    const client = await getTemporalClient();
    await client.workflow.getHandle(`code-resume:${agentId}:${messageId}`).describe();
    return true;
  } catch {
    return false;
  }
}

/** True once the resume run exists (newly started or already running for this message). */
export async function startCodeAgentResumeWorkflow(
  request: CodeAgentResumeRequest
): Promise<{ workflowId: string }> {
  const workflowId = `code-resume:${request.agent_id}:${request.message_id}`;
  await startResumeRun(CODE_AGENT_RESUME_WORKFLOW, workflowId, request);
  await recordResumeRun(request.agent_id, workflowId);
  return { workflowId };
}

/** The live queue's workers do not register the resume workflow types (a deploy is mid-way). */
export class ResumeWorkersUpdatingError extends Error {
  constructor() {
    super("Rose's workers are updating; send again shortly");
    this.name = 'ResumeWorkersUpdatingError';
  }
}

/** Start (or find) a resume run; an already started one is moved off a superseded queue. */
async function startResumeRun(
  workflowType: string,
  workflowId: string,
  unboundRequest: CodeAgentResumeRequest | BrowserAgentResumeRequest
): Promise<void> {
  // Every LLM record the resumed run archives must land in the tree's ROOT bundle;
  // the worker stamps this root on each activity (no per-activity lookups).
  const request = {
    ...unboundRequest,
    root_agent_id:
      unboundRequest.root_agent_id ?? (await resolveArchiveRoot(unboundRequest.agent_id)),
  };
  const client = await getTemporalClient();
  const taskQueue = await getCurrentAgentQueue();
  // A held deploy keeps the pointer on workers that predate this type: never strand it.
  if (!(await queueServesWorkflowTypes(taskQueue, [workflowType]))) {
    throw new ResumeWorkersUpdatingError();
  }
  // Plain JSON (the request is exactly the workflow's serialized argument).
  const saved = JSON.parse(JSON.stringify({ workflowType, request })) as Prisma.InputJsonObject;
  await putEphemeral(REQUESTS_NAMESPACE, workflowId, saved, RUNS_TTL_MS);
  try {
    await client.workflow.start(workflowType, {
      workflowId,
      taskQueue,
      args: [request],
      // A resend of the same turn after its run finished must not run it again;
      // only a failed (or terminated, see the move below) run may be started anew.
      workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    await ensureResumeRunOnLiveQueue(workflowId).catch((moveError: unknown) =>
      log.warn('Could not check the resume run queue', {
        workflowId,
        error: moveError instanceof Error ? moveError.message : String(moveError),
      })
    );
  }
}

export type StrandedRunOutcome =
  | 'moved'
  | 'restarted'
  | 'live'
  | 'unserved'
  | 'not-running'
  | 'progressed'
  | 'young'
  | 'unknown-request'
  /** The described run closed before this caller could terminate it (another mover got there). */
  | 'moved-elsewhere';

export interface ResumeRunMoveDependencies {
  describe(workflowId: string): Promise<{
    /** The described execution (terminate targets exactly it, never a newer one). */
    runId: string;
    running: boolean;
    terminated?: boolean;
    taskQueue: string;
    startTimeMs: number;
    workflowType: string;
  } | null>;
  /**
   * Whether the run ever completed a workflow task (a worker serves its type), or
   * is a continue-as-new successor (it ran: never restart it from the original).
   */
  progressed(workflowId: string): Promise<boolean>;
  /** Whether the live queue's workers register this workflow type. */
  serves(taskQueue: string, workflowType: string): Promise<boolean>;
  /** Whether the run's owner agent still exists (a deleted owner's runs never restart). */
  ownerLive(workflowId: string): Promise<boolean>;
  loadRequest(
    workflowId: string
  ): Promise<{ workflowType: string; request: unknown; moved?: boolean } | null>;
  /** Flag the stored request: the move terminated this run (the one case a resend revives). */
  markMoved(workflowId: string, saved: { workflowType: string; request: unknown }): Promise<void>;
  /** Terminate exactly that run; false when it already closed (nothing terminated). */
  terminate(workflowId: string, runId: string, reason: string): Promise<boolean>;
  start(
    workflowType: string,
    workflowId: string,
    taskQueue: string,
    request: unknown
  ): Promise<void>;
  list(query: string): AsyncIterable<{ workflowId: string }>;
  now(): number;
}

function temporalMoveDependencies(): ResumeRunMoveDependencies {
  return {
    async describe(workflowId) {
      const client = await getTemporalClient();
      try {
        const described = await client.workflow.getHandle(workflowId).describe();
        return {
          runId: described.runId,
          running: described.status.name === 'RUNNING',
          terminated: described.status.name === 'TERMINATED',
          taskQueue: described.taskQueue,
          startTimeMs: described.startTime.getTime(),
          workflowType: described.type,
        };
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return null;
        throw error;
      }
    },
    async progressed(workflowId) {
      const client = await getTemporalClient();
      // One small first page: a stranded run has ~4 events; a served one completes
      // its first workflow task within them.
      const page = await client.workflowService.getWorkflowExecutionHistory({
        namespace: client.options.namespace,
        execution: { workflowId },
        maximumPageSize: HISTORY_PAGE_SIZE,
      });
      const events = page.history?.events ?? [];
      const started = events[0]?.workflowExecutionStartedEventAttributes;
      if (started?.continuedExecutionRunId) return true;
      return events.some((event) => Number(event.eventType) === WORKFLOW_TASK_COMPLETED_EVENT);
    },
    serves: (taskQueue, workflowType) => queueServesWorkflowTypes(taskQueue, [workflowType]),
    async ownerLive(workflowId) {
      const agentId = workflowId.split(':')[1] ?? '';
      const owner = await prisma.agent.findFirst({
        where: { id: agentId, deletedAt: null },
        select: { id: true },
      });
      return owner !== null;
    },
    loadRequest: async (workflowId) =>
      (await getEphemeral<{ workflowType: string; request: unknown; moved?: boolean }>(
        REQUESTS_NAMESPACE,
        workflowId
      )) ?? null,
    async markMoved(workflowId, saved) {
      const value = JSON.parse(JSON.stringify({ ...saved, moved: true })) as Prisma.InputJsonObject;
      await putEphemeral(REQUESTS_NAMESPACE, workflowId, value, RUNS_TTL_MS);
    },
    async terminate(workflowId, runId, reason) {
      const client = await getTemporalClient();
      try {
        await client.workflow.getHandle(workflowId, runId).terminate(reason);
        return true;
      } catch (error) {
        // That run already closed ("workflow execution already completed").
        if (error instanceof WorkflowNotFoundError) return false;
        throw error;
      }
    },
    async start(workflowType, workflowId, taskQueue, request) {
      const client = await getTemporalClient();
      await client.workflow.start(workflowType, {
        workflowId,
        taskQueue,
        args: [request],
        workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
      });
    },
    async *list(query) {
      const client = await getTemporalClient();
      for await (const execution of client.workflow.list({ query })) {
        yield { workflowId: execution.workflowId };
      }
    },
    now: () => Date.now(),
  };
}

/**
 * Move one resume run off a superseded queue when no worker there serves it (see
 * the header). `liveQueue` defaults to the current pointer. `reviveTerminated`
 * (a resend of the same turn): a run terminated by an earlier move whose restart
 * did not land starts again from its stored request.
 */
export async function ensureResumeRunOnLiveQueue(
  workflowId: string,
  liveQueue?: string,
  deps: ResumeRunMoveDependencies = temporalMoveDependencies(),
  options: { reviveTerminated?: boolean } = {}
): Promise<StrandedRunOutcome> {
  const described = await deps.describe(workflowId);
  if (described === null) return 'not-running';
  const live = liveQueue ?? (await getCurrentAgentQueue());
  if (!described.running) {
    if (options.reviveTerminated !== true || described.terminated !== true) return 'not-running';
    const saved = await deps.loadRequest(workflowId);
    if (saved?.moved !== true) return 'not-running'; // terminated for another reason (a kill)
    return restartFromRequest(workflowId, described.workflowType, live, deps, 'restarted');
  }
  if (described.taskQueue === live) return 'live';
  if (await deps.progressed(workflowId)) return 'progressed';
  if (deps.now() - described.startTimeMs < STRANDED_MIN_AGE_MS) return 'young';
  if (!(await deps.serves(live, described.workflowType))) return 'unserved';
  const saved = await deps.loadRequest(workflowId);
  if (saved === null || saved.workflowType !== described.workflowType) return 'unknown-request';
  // Only a run terminated BY this move may ever be revived (never a killed one).
  await deps.markMoved(workflowId, saved);
  // Exactly the described run: a concurrent mover (the cutover broadcast beside a
  // resend) may already have terminated it and started its replacement, which a
  // run-less terminate would kill before a second start delivered the turn twice.
  const terminated = await deps.terminate(
    workflowId,
    described.runId,
    `moved to the live agent queue ${live}: ${described.taskQueue} has no worker for ${described.workflowType}`
  );
  if (!terminated) return 'moved-elsewhere';
  return restartFromRequest(
    workflowId,
    described.workflowType,
    live,
    deps,
    'moved',
    described.taskQueue
  );
}

async function restartFromRequest(
  workflowId: string,
  workflowType: string,
  live: string,
  deps: ResumeRunMoveDependencies,
  outcome: 'moved' | 'restarted',
  from?: string
): Promise<StrandedRunOutcome> {
  if (!(await deps.serves(live, workflowType))) return 'unserved';
  // Re-read just before the start: a kill in between removed the request; a deleted
  // owner's run never restarts.
  const saved = await deps.loadRequest(workflowId);
  if (saved === null || saved.workflowType !== workflowType) return 'unknown-request';
  if (!(await deps.ownerLive(workflowId))) return 'not-running';
  try {
    await deps.start(saved.workflowType, workflowId, live, saved.request);
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
  log.info('Restarted a resume run on the live queue', { workflowId, from, to: live, outcome });
  return outcome;
}

const SAFE_QUEUE = /^[A-Za-z0-9._@:-]{1,200}$/;

/** After a cutover: every resume run stranded on `fromQueue` moves to `liveQueue`. */
export async function moveStrandedResumeRuns(
  fromQueue: string,
  liveQueue: string,
  deps: ResumeRunMoveDependencies = temporalMoveDependencies()
): Promise<{ listed: number; moved: number; failed: number }> {
  if (!SAFE_QUEUE.test(fromQueue)) throw new Error(`Unsafe task queue name: ${fromQueue}`);
  const query =
    `TaskQueue = "${fromQueue}" AND ExecutionStatus = "Running" AND ` +
    `(WorkflowType = "${CODE_AGENT_RESUME_WORKFLOW}" OR WorkflowType = "${BROWSER_AGENT_RESUME_WORKFLOW}")`;
  const report = { listed: 0, moved: 0, failed: 0 };
  for await (const { workflowId } of deps.list(query)) {
    report.listed += 1;
    try {
      if ((await ensureResumeRunOnLiveQueue(workflowId, liveQueue, deps)) === 'moved') {
        report.moved += 1;
      }
    } catch (error) {
      report.failed += 1;
      log.warn('Could not move a stranded resume run', {
        workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

export const BROWSER_AGENT_RESUME_WORKFLOW = 'BrowserAgentResumeWorkflow';

export interface BrowserAgentResumeRequest {
  agent_id: string;
  user_id: string;
  model: string;
  tool_call_id: string;
  inbox_address: string;
  goal: string;
  start_url: string | null;
  /** continue: restore the paused run's conversation; fresh: the browser tool's recovery. */
  mode: 'continue' | 'fresh';
  previous_status: string;
  previous_result: string;
  message: string;
  message_id: string;
  /** The spawn's own output schema and files (pointers resolved from the owner's messages). */
  output_schema?: Record<string, unknown> | null;
  attachments?: Array<Record<string, unknown>>;
  /** Archive root of the agent tree (busId ?? id); stamped by startResumeRun. */
  root_agent_id?: string;
}

/**
 * Start the supervised resume of a stopped browser agent
 * (agents/workflows/browser_agent_resume.py). Its id keeps the `code-resume:<agent>:`
 * generation binding (codeResumeGeneration.ts) and it is paused with the owner.
 */
export async function startBrowserAgentResumeWorkflow(
  request: BrowserAgentResumeRequest
): Promise<{ workflowId: string }> {
  const workflowId = `code-resume:${request.agent_id}:browser:${request.message_id}`;
  await startResumeRun(BROWSER_AGENT_RESUME_WORKFLOW, workflowId, request);
  await recordResumeRun(request.agent_id, workflowId);
  return { workflowId };
}

async function recordResumeRun(agentId: string, workflowId: string): Promise<void> {
  // Serialized: concurrent starts for one agent never drop each other's ids.
  await withSerializedLock(`${RUNS_NAMESPACE}:${agentId}`, async () => {
    const runs = (await getEphemeral<string[]>(RUNS_NAMESPACE, agentId)) ?? [];
    const next = [...runs.filter((id) => id !== workflowId), workflowId].slice(-MAX_RUNS_PER_AGENT);
    await putEphemeral(RUNS_NAMESPACE, agentId, next, RUNS_TTL_MS);
  });
}

/** Agent ids per visibility query (OR of their run-id prefixes). */
const VISIBILITY_BATCH = 50;

type TemporalClient = Awaited<ReturnType<typeof getTemporalClient>>;
type ListFn = (options: { query: string }) => AsyncIterable<{ workflowId: string }>;

/**
 * The agents' running resume runs: OR-batched Temporal visibility by run-id
 * prefix (`code-resume:<agentId>:`, every live run however old; ~50 agents per
 * query), plus each agent's recorded list (the fallback without visibility).
 */
async function resumeRunsOf(
  client: TemporalClient,
  agentIds: string[]
): Promise<Map<string, string[]>> {
  const runs = new Map<string, string[]>();
  for (const agentId of agentIds) {
    runs.set(agentId, (await getEphemeral<string[]>(RUNS_NAMESPACE, agentId)) ?? []);
  }
  const list = (client.workflow as { list?: ListFn }).list;
  if (typeof list !== 'function') return runs;
  for (let start = 0; start < agentIds.length; start += VISIBILITY_BATCH) {
    const batch = agentIds.slice(start, start + VISIBILITY_BATCH);
    const prefixes = batch.map((id) => `WorkflowId STARTS_WITH "code-resume:${id}:"`).join(' OR ');
    const query = `(${prefixes}) AND ExecutionStatus = "Running"`;
    try {
      for await (const execution of list.call(client.workflow, { query })) {
        const owner = batch.find((id) => execution.workflowId.startsWith(`code-resume:${id}:`));
        if (owner !== undefined) {
          runs.set(owner, [...new Set([...(runs.get(owner) ?? []), execution.workflowId])]);
        }
      }
    } catch (error) {
      log.info('Resume run visibility query unavailable; using the recorded runs', {
        agents: String(batch.length),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return runs;
}

async function forEachResumeRun(
  agentIds: string[],
  act: (client: TemporalClient, workflowId: string) => Promise<void>
): Promise<number> {
  if (agentIds.length === 0) return 0;
  const client = await getTemporalClient();
  let reached = 0;
  for (const [agentId, workflowIds] of await resumeRunsOf(client, agentIds)) {
    if (workflowIds.length === 0) continue;
    // A live lookup renews the record, so a long run stays reachable.
    await putEphemeral(
      RUNS_NAMESPACE,
      agentId,
      workflowIds.slice(-MAX_RUNS_PER_AGENT),
      RUNS_TTL_MS
    );
    for (const workflowId of workflowIds) {
      try {
        await act(client, workflowId);
        reached += 1;
      } catch (error) {
        // Finished runs reject it: nothing left to reach.
        log.info('Resume run not reached', {
          agentId,
          workflowId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return reached;
}

/** The user paused these agents (a paused tree): pause their code/browser resume runs too. */
export async function pauseCodeAgentResumeRuns(agentIds: string | string[]): Promise<number> {
  const ids = Array.isArray(agentIds) ? agentIds : [agentIds];
  return forEachResumeRun(ids, (client, workflowId) =>
    client.workflow.getHandle(workflowId).signal('pause')
  );
}

/** The agent is deleted: its resume runs end with it (before its sessions are cleaned up). */
export async function terminateCodeAgentResumeRuns(agentId: string): Promise<number> {
  // A killed run must never come back: its marker (a later message would join or
  // revive it) and its stored request go BEFORE it is terminated.
  await forgetResumeMarkers(agentId);
  return forEachResumeRun([agentId], async (client, workflowId) => {
    await deleteEphemeral(REQUESTS_NAMESPACE, workflowId);
    await client.workflow.getHandle(workflowId).terminate('owner agent deleted');
  });
}

/**
 * The agent's code (`tool:<agent>:<call>`) and browser (`<agent>:<call>`) resume markers
 * (starts_with: collation-independent; those namespaces hold only live markers).
 */
async function forgetResumeMarkers(agentId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "SharedEphemeralState"
    WHERE (namespace = 'code-agent-resume' AND starts_with(key, ${`tool:${agentId}:`}))
       OR (namespace = 'browser-agent-resume' AND starts_with(key, ${`${agentId}:`}))
  `;
}
