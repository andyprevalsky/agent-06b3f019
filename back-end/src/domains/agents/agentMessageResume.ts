/**
 * A person's message to an agent that stopped resumes it (Andy 2026-11-08), and
 * its row records that so the bubble shows the resume beside its time:
 *
 *   Rose agent COMPLETED / FAILED / OUT_OF_CREDITS / COST_LIMIT_REACHED / PAUSED
 *     → the usual chat resume / pause lift (agentMessageService.routeUserMessage);
 *       the row carries `resumedFrom: <status>` (FE: Resuming… → Delivered at the
 *       agent's next row)
 *   a stopped browser (Browser composer, its session not ACTIVE) resumes THAT
 *   browser; the row carries `browserResume` + the spawn's `toolCallId` (FE:
 *   Resuming… → Starting browser… → Delivered | Couldn't resume: <reason>):
 *     a resume of it already starting → the row joins that run's inbox (read at
 *       its next step), nothing new starts
 *     owner running + its background browser paused → owner wake,
 *       continue_conversation: the archived conversation + provider session
 *     owner running + its background browser finished → owner wake for a fresh
 *       conversation with the earlier goal and result (the browser tool's own
 *       recovery: a finished run keeps no conversation)
 *     owner finished / paused, or a foreground browser → BrowserAgentResumeWorkflow
 *       (continue when the session was paused, else fresh), same rules
 *   no spawn record for the browser → null: the message goes to the owner
 *
 * 10k agents: one indexed agent read per person message, plus one message
 * lookup and one signal for a browser resume. Nothing fans in.
 */
import { createMessage } from '../../providers/messages';
import { signalAgentMessage } from '../../providers/agentResume';
import { deleteEphemeral, getEphemeral, putEphemeral } from '../../providers/sharedState';
import {
  ensureResumeRunOnLiveQueue,
  startBrowserAgentResumeWorkflow,
} from '../../providers/codeAgentResumeWorkflow';
import { createLogger } from '../../providers/logger';
import { hasCreditsRemaining } from '../../providers/credits';
import { listedBackgroundTasks } from './agentTreeBackgroundTasks';
import { TERMINAL_STATUSES } from './statusBroadcastWorkflowId';
import * as repo from './repoMessageResume';

const log = createLogger('AgentMessageResume');
const STOPPED_STATUSES = new Set([...TERMINAL_STATUSES, 'PAUSED']);

/** The stopped status a person's message resumes the agent from, or null when it runs. */
export async function stoppedAgentStatus(agentId: string): Promise<string | null> {
  const agent = await repo.findAgentStatus(agentId);
  return agent !== null && STOPPED_STATUSES.has(agent.status) ? agent.status : null;
}

/** The spawn tool call and recorded goal / start URL of a browser task (from its first row). */
async function browserSpawn(agentId: string, browserTaskId: string) {
  const row = await repo.findBrowserTaskFirstRow(agentId, browserTaskId);
  const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
  const toolCallId =
    typeof metadata.toolCallId === 'string' ? metadata.toolCallId.split(':')[0] : '';
  if (toolCallId === '') return null;
  return {
    toolCallId,
    goal: typeof metadata.goal === 'string' ? metadata.goal : '',
    startUrl: typeof metadata.start_url === 'string' ? metadata.start_url : null,
  };
}

/** A resume of one browser in flight: later messages join its run's inbox. */
interface BrowserResumeMarker {
  inbox: string;
  since: string;
  /** Set once its run was started: a marker never started is a start that crashed. */
  started?: boolean;
  /** The supervised resume run (absent for an owner wake). */
  runWorkflowId?: string;
}
/** A start that has not confirmed within this long is treated as crashed. */
const UNSTARTED_MARKER_MS = 60_000;
const RESUME_NAMESPACE = 'browser-agent-resume';

/** Why no resume may spend now (the owner's cost limit, the user's live credits), or null. */
async function spendRefusal(owner: { status: string; userId: string }): Promise<string | null> {
  if (owner.status === 'COST_LIMIT_REACHED') {
    return 'its Rose agent reached its cost limit; raise the limit to continue';
  }
  if (!(await hasCreditsRemaining(owner.userId)))
    return "you're out of credits; add credits to continue";
  return null;
}
const RESUME_MARKER_TTL_MS = 2 * 60 * 60_000;

type Owner = NonNullable<Awaited<ReturnType<typeof repo.findAgentForBrowserResume>>>;
type TaskEntry = ReturnType<typeof listedBackgroundTasks>[number];

/** The owner's own workflow can start the task's next run (it holds a wake record for it). */
function ownerCanWake(owner: Owner, task: TaskEntry): boolean {
  return (
    task.wakeable === true &&
    owner.temporalWorkflowId !== null &&
    !STOPPED_STATUSES.has(owner.status)
  );
}

/** The person's row: UI-only, on `inbox` when the resumed run reads it there. */
function personRow(
  agentId: string,
  text: string,
  metadata: Record<string, unknown> | undefined,
  browserTaskId: string,
  toolCallId: string,
  inbox: string | null
) {
  return createMessage({
    agentId,
    role: 'USER',
    text,
    metadata: {
      ...(metadata ?? {}),
      browserTaskId,
      excludeFromModel: true,
      browserResume: true,
      toolCallId,
      ...(inbox !== null
        ? { agentMessage: true, recipientTaskId: inbox, fromAgentPath: 'the user' }
        : {}),
    },
  });
}

/** The resume could not start: the person's message reads "Couldn't resume: <reason>". */
async function postBrowserFailure(agentId: string, toolCallId: string, reason: string) {
  await createMessage({
    agentId,
    role: 'TOOL',
    text: reason,
    metadata: {
      toolName: 'spawn_browser_agent',
      toolCallId,
      toolStatus: 'ERROR',
      title: 'Browser could not resume',
      excludeFromModel: true,
      browserResume: 'failed',
    },
  });
}

/** The spawn's recorded goal, output schema and files (a background spawn's started row). */
async function spawnExtras(agentId: string, toolCallId: string) {
  const args = (await repo.findBackgroundSpawnArgs(agentId, toolCallId)) ?? {};
  const names = Array.isArray(args.attachments)
    ? args.attachments.filter((name): name is string => typeof name === 'string')
    : [];
  return {
    goal: typeof args.goal === 'string' && args.goal !== '' ? args.goal : null,
    outputSchema:
      args.output_schema !== null && typeof args.output_schema === 'object'
        ? (args.output_schema as Record<string, unknown>)
        : null,
    attachments: await repo.findOwnerFilePointers(agentId, names),
  };
}

/** Its run started: the marker (when there is one) stops counting as a possible crash. */
async function markStarted(key: string): Promise<void> {
  const marker = await getEphemeral<BrowserResumeMarker>(RESUME_NAMESPACE, key);
  if (marker !== undefined) {
    await putEphemeral(RESUME_NAMESPACE, key, { ...marker, started: true }, RESUME_MARKER_TTL_MS);
  }
}

/** The marker of a resume still starting (no failure since), or null. */
async function resumeInFlight(agentId: string, toolCallId: string, key: string) {
  const marker = await getEphemeral<BrowserResumeMarker>(RESUME_NAMESPACE, key);
  if (marker === undefined) return null;
  if (
    marker.started !== true &&
    Date.now() - new Date(marker.since).getTime() > UNSTARTED_MARKER_MS
  ) {
    // Its message was stored but its run never started (a crash): messages start anew.
    await deleteEphemeral(RESUME_NAMESPACE, key);
    return null;
  }
  // A failure or the resumed run's own end releases it: later messages start anew.
  if (
    (await repo.findBrowserResumeEndSince(agentId, toolCallId, new Date(marker.since))) !== null
  ) {
    await deleteEphemeral(RESUME_NAMESPACE, key);
    return null;
  }
  return marker;
}

/** Start the browser's resumed run (owner wake or supervised); a failure becomes the message's reason. */
async function startBrowserResume(args: {
  owner: Owner;
  task: TaskEntry | undefined;
  byOwner: boolean;
  mode: 'continue' | 'fresh';
  spawn: { toolCallId: string; goal: string; startUrl: string | null };
  row: { id: string };
  text: string;
  runInbox: string;
  key: string;
  previous: { text: string } | null;
}): Promise<void> {
  const { owner, task, byOwner, mode, spawn, row, text, runInbox, key, previous } = args;
  const agentId = owner.id;
  const { toolCallId } = spawn;
  try {
    if (byOwner && task !== undefined) {
      const signalled = await signalAgentMessage(owner.id, owner.temporalWorkflowId ?? '', row.id, {
        wake_task_id: task.address,
        message: text,
        continue_conversation: mode === 'continue',
        from_user: true,
      });
      if (!signalled) throw new Error('its Rose agent could not be reached');
    } else {
      const extras = await spawnExtras(agentId, toolCallId);
      await startBrowserAgentResumeWorkflow({
        agent_id: agentId,
        user_id: owner.userId,
        model: owner.model,
        tool_call_id: toolCallId,
        inbox_address: runInbox,
        goal: extras.goal ?? (spawn.goal !== '' ? spawn.goal : (task?.goal ?? '')),
        start_url: spawn.startUrl,
        mode,
        previous_status: task?.status ?? 'completed',
        previous_result: previous?.text ?? '',
        message: text,
        message_id: row.id,
        ...(extras.outputSchema !== null ? { output_schema: extras.outputSchema } : {}),
        attachments: extras.attachments,
      });
    }
    await markStarted(key);
  } catch (error) {
    await deleteEphemeral(RESUME_NAMESPACE, key);
    await postBrowserFailure(
      agentId,
      toolCallId,
      error instanceof Error ? error.message : 'the browser could not be started'
    );
  }
}

/**
 * The Browser composer's message to a stopped browser: resume THAT browser (see
 * the module comment). Null only when the browser has no spawn record.
 */
export async function resumeStoppedBrowser(
  agentId: string,
  browserTaskId: string,
  text: string,
  metadata: Record<string, unknown> | undefined
) {
  const owner = await repo.findAgentForBrowserResume(agentId);
  const spawn = owner === null ? null : await browserSpawn(agentId, browserTaskId);
  if (owner === null || spawn === null) return null;
  const { toolCallId } = spawn;
  const refusal = await spendRefusal(owner);
  if (refusal !== null) {
    // No run may spend past the owner's cost limit or without credits: say so.
    const row = await personRow(agentId, text, metadata, browserTaskId, toolCallId, null);
    await postBrowserFailure(agentId, toolCallId, refusal);
    return row;
  }
  const key = `${agentId}:${toolCallId}`;
  const task = listedBackgroundTasks(owner).find(
    (entry) => entry.type === 'browser' && entry.address.replace(/\.run\d+$/, '') === toolCallId
  );
  const starting = await resumeInFlight(agentId, toolCallId, key);
  if (starting !== null || task?.status === 'running') {
    if (starting?.runWorkflowId !== undefined) {
      // A supervised run stranded on a superseded queue moves; one terminated by a
      // move whose restart did not land starts again. Then the message joins it.
      await ensureResumeRunOnLiveQueue(starting.runWorkflowId, undefined, undefined, {
        reviveTerminated: true,
      }).catch((error: unknown) =>
        log.warn('Could not check the browser resume run queue', {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
    const inbox = starting?.inbox ?? task?.address ?? toolCallId;
    return personRow(agentId, text, metadata, browserTaskId, toolCallId, inbox);
  }
  const session = await repo.findBrowserSessionStatus(browserTaskId);
  const mode: 'continue' | 'fresh' =
    (task?.status ?? (session?.status === 'PAUSED' ? 'paused' : 'completed')) === 'paused'
      ? 'continue'
      : 'fresh';
  const previous = mode === 'fresh' ? await repo.findLatestFinishedRow(agentId, toolCallId) : null;
  // continue: the paused run's own inbox; fresh: a new inbox (the goal carries the text).
  const inbox = mode === 'continue' ? (task?.address ?? toolCallId) : null;
  const row = await personRow(agentId, text, metadata, browserTaskId, toolCallId, inbox);
  const runInbox = inbox ?? `${toolCallId}.resume-${row.id.slice(0, 8)}`;
  const byOwner = task !== undefined && ownerCanWake(owner, task);
  // The marker names the inbox the resumed run reads. The owner's fresh run reads
  // its own `<id>.run<n>` (the tree state lists it as running): no marker then.
  if (!byOwner || mode === 'continue') {
    await putEphemeral(
      RESUME_NAMESPACE,
      key,
      {
        inbox: runInbox,
        since: new Date().toISOString(),
        ...(byOwner ? {} : { runWorkflowId: `code-resume:${agentId}:browser:${row.id}` }),
      },
      RESUME_MARKER_TTL_MS
    );
  }
  await startBrowserResume({
    owner,
    task,
    byOwner,
    mode,
    spawn,
    row,
    text,
    runInbox,
    key,
    previous,
  });
  return row;
}
