/**
 * Resume of a STOPPED code agent from its own view (directChatService.ts). The
 * persistent CodeSession keeps the sandbox and the CLI conversation, so a typed
 * turn never fails on a stopped code agent; it starts the spawn's next run with
 * the turn as its next input (CLI --resume), under the same spawn tool call:
 *
 *   later run of the spawn live ───────────────▶ deliver there (caller)
 *   a resume of the spawn already starting ────▶ queued in its startup row
 *                                                (startupTurns.ts), in order
 *   owner running + background code task ──────▶ the owner's wake
 *                                                (receive_agent_message from_user)
 *   owner finished / paused, foreground spawn ─▶ CodeAgentResumeWorkflow
 *
 * Every path answers `queued` and persists the turn row with `resume_requested`
 * (deterministic id) after its run is started, so the FE's resume state beside
 * the turn's time always has a run behind it. Shared error type and row metadata.
 */
import { createLogger } from '../../providers/logger';
import { idempotentMessageId } from '../../providers/messageIdempotency';
import { signalAgentMessage } from '../../providers/agentResume';
import { deleteEphemeral, getEphemeral, putEphemeral } from '../../providers/sharedState';
import {
  clearPublishedStartupTask,
  enqueueStartupTurn,
  startupTurnsKey,
} from '../../providers/codeSessions/startupTurns';
import {
  codeAgentResumeRunExists,
  ensureResumeRunOnLiveQueue,
} from '../../providers/codeAgentResumeWorkflow';
import { startCodeAgentResumeWorkflowOrRefuse } from './directChatResumeStart';
import { listedBackgroundTasks } from '../agents/agentTreeBackgroundTasks';
import { TERMINAL_STATUSES } from '../agents/statusBroadcastWorkflowId';
import { findCodeSessionForToolCall } from '../agents/repoGraph';
import { hasCreditsRemaining } from '../../providers/credits';
import * as repo from './repo';
import {
  cliSettingsOf,
  DirectChatError,
  liveSession,
  persistQueued,
  postResumeFailure,
  resumeRow,
  type DirectTurnResult,
  type LiveSession,
  type OwnedSession,
  type ResumeParams,
} from './directChatRows';
import {
  isOwnedAttachmentPath,
  type DirectAttachment,
} from '../../providers/codeSessions/directTurnAttachments';

const log = createLogger('ClaudeCodeDirectChat');

export {
  DirectChatError,
  liveSession,
  type DirectTurnResult,
  type LiveSession,
  type OwnedSession,
  type ResumeParams,
};
export { directTurnMetadata, persistedTurnResult } from './directChatRows';

/** A later run of the same spawn (a resumed task keeps its tool call id) that is live now. */
export async function liveRunOfSpawn(
  session: OwnedSession,
  toolCallId: string | undefined
): Promise<LiveSession | null> {
  if (toolCallId === undefined) return null;
  const latest = await findCodeSessionForToolCall(session.agentId, toolCallId, null);
  if (latest === null || latest.id === session.id) return null;
  return liveSession({
    ...session,
    id: latest.id,
    status: latest.status,
    streamUrl: latest.streamUrl,
  });
}

type Owner = NonNullable<Awaited<ReturnType<typeof repo.findAgentForCodeResume>>>;
type TaskEntry = ReturnType<typeof listedBackgroundTasks>[number];

/** A resume in flight for one spawn (`since` = when it was requested). */
interface ResumeMarker {
  messageId: string;
  since: string;
  /** Set once its run was started: a marker never started is a start that crashed. */
  started?: boolean;
}
/** A start that has not confirmed within this long is treated as crashed. */
const UNSTARTED_MARKER_MS = 60_000;
const RESUME_NAMESPACE = 'code-agent-resume';

/** Why no resume may spend now (the owner's cost limit, the user's credits), or null. */
async function spendRefusal(owner: Owner): Promise<DirectChatError | null> {
  if (owner.status === 'COST_LIMIT_REACHED') {
    return new DirectChatError(
      409,
      'CODE_SESSION_OWNER_COST_LIMIT',
      "Couldn't resume: its Rose agent reached its cost limit. Raise the limit to continue."
    );
  }
  // The user's live balance, never a stale OUT_OF_CREDITS status (credits may be back).
  if (!(await hasCreditsRemaining(owner.userId))) {
    return new DirectChatError(
      409,
      'CODE_SESSION_OUT_OF_CREDITS',
      "Couldn't resume: you're out of credits. Add credits to continue."
    );
  }
  return null;
}
const RESUME_MARKER_TTL_MS = 2 * 60 * 60_000;

/** The owner's own workflow can start the background task's next run. */
function ownerCanWake(owner: Owner, task: TaskEntry): boolean {
  return (
    task.type === 'code' &&
    task.wakeable === true &&
    !TERMINAL_STATUSES.has(owner.status) &&
    owner.status !== 'PAUSED' &&
    owner.temporalWorkflowId !== null
  );
}

/** Another message's resume of this spawn is still starting (no newer session yet). */
async function resumeStarting(
  owner: Owner,
  task: TaskEntry | undefined,
  key: string,
  toolCallId: string,
  messageId: string
): Promise<boolean> {
  if (task?.status === 'running') return true;
  const marker = await getEphemeral<ResumeMarker>(RESUME_NAMESPACE, key);
  if (marker === undefined || marker.messageId === messageId) return false;
  const since = new Date(marker.since);
  if (marker.started !== true && Date.now() - since.getTime() > UNSTARTED_MARKER_MS) {
    // Its row was persisted but its run never started (a crash): turns start anew.
    await deleteEphemeral(RESUME_NAMESPACE, key);
    return false;
  }
  const latest = await findCodeSessionForToolCall(owner.id, toolCallId, null);
  if (latest !== null && latest.createdAt >= since) return false;
  // A refused / failed resume ended it: later turns start a new one (and carry
  // the turns that queued behind the failed one), never wait for its TTL.
  if ((await repo.findResumeEndRow(owner.id, toolCallId, since)) !== null) {
    await deleteEphemeral(RESUME_NAMESPACE, key);
    return false;
  }
  return true;
}

/** The turn's attachments, owner-checked before anything is queued or started. */
function checkedAttachments(
  attachments: DirectAttachment[] | undefined,
  userId: string
): Array<Record<string, unknown>> {
  if (!(attachments ?? []).every((item) => isOwnedAttachmentPath(item.storage_path, userId))) {
    throw new DirectChatError(400, 'INVALID_ATTACHMENT', 'Could not accept these attachments');
  }
  return (attachments ?? []).map((attachment) => ({ ...attachment }));
}

async function liveSessionById(base: OwnedSession, taskId: string): Promise<LiveSession | null> {
  const found = await repo.findSessionForDirectChat(taskId);
  return found === null || found.agentId !== base.agentId ? null : liveSession(found);
}

/**
 * The turn waits in the spawn's startup row and reaches the resumed CLI right
 * after the first resuming turn, in arrival order (drainStartupTurns).
 */
async function queueBehindResume(
  params: ResumeParams,
  toolCallId: string,
  attachments: Array<Record<string, unknown>>
): Promise<DirectTurnResult | { live: LiveSession }> {
  const outcome = await enqueueStartupTurn(
    startupTurnsKey(params.session.agentId, toolCallId),
    {
      key: `user:${params.clientMessageId}`,
      text: params.text,
      original: params.text,
      sender: { id: params.userId, label: 'You' },
      toolCallId,
      user: {
        clientMessageId: params.clientMessageId,
        userId: params.userId,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(params.settings ? { settings: params.settings } : {}),
      },
    },
    {
      findStarted: async (publishedTaskId) =>
        publishedTaskId !== null && publishedTaskId !== params.session.id
          ? liveSessionById(params.session, publishedTaskId)
          : null,
      admit: async () => {},
    }
  );
  if (outcome.status === 'started') return { live: outcome.session };
  if (outcome.status === 'full') {
    throw new DirectChatError(
      409,
      'CODE_SESSION_RESUME_QUEUE_FULL',
      'This code agent is resuming and holds the most messages it can. Send again once it runs.'
    );
  }
  log.info('Direct turn queued behind a code agent resume', {
    taskId: params.session.id,
    clientMessageId: params.clientMessageId,
    position: String(outcome.position),
  });
  return persistQueued(params, toolCallId);
}

/** Start the run that resumes the code agent with this turn (owner wake or supervisor). */
async function startResumeRun(args: {
  params: ResumeParams;
  owner: Owner;
  task: TaskEntry | undefined;
  toolCallId: string;
  messageId: string;
  attachments: Array<Record<string, unknown>>;
}): Promise<'owner' | 'supervisor'> {
  const { params, owner, task, toolCallId, messageId, attachments } = args;
  const cliSettings = cliSettingsOf(params.settings);
  if (task !== undefined && ownerCanWake(owner, task)) {
    const signalled = await signalAgentMessage(
      owner.id,
      owner.temporalWorkflowId ?? '',
      messageId,
      {
        wake_task_id: task.address,
        message: params.text,
        continue_conversation: true,
        from_user: true,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(cliSettings ? { cli_settings: cliSettings } : {}),
      }
    );
    if (signalled) return 'owner';
    throw new DirectChatError(
      502,
      'CODE_SESSION_RESUME_UNREACHABLE',
      'Could not reach its Rose agent to resume this code agent. Your draft is kept.'
    );
  }
  await startCodeAgentResumeWorkflowOrRefuse({
    agent_id: owner.id,
    user_id: owner.userId,
    model: owner.model,
    tool_call_id: toolCallId,
    task_name: params.session.taskName ?? task?.task_name ?? null,
    code_session_id: params.session.codeSessionId ?? null,
    code_provider: params.provider,
    message: params.text,
    message_id: messageId,
    attachments,
    ...(cliSettings ? { cli_settings: cliSettings } : {}),
  });
  return 'supervisor';
}

/**
 * The user typed to a stopped code agent: queue behind a resume already
 * starting, else start one. `{ live }` when a later run turned live meanwhile
 * (the caller delivers to it directly).
 */
export async function resumeStoppedCodeAgent(
  params: ResumeParams
): Promise<DirectTurnResult | { live: LiveSession }> {
  const { session, toolCallId } = params;
  if (toolCallId === undefined) {
    throw new DirectChatError(
      409,
      'CODE_SESSION_NOT_RESUMABLE',
      'This code agent has no spawn record to resume from. Ask Rose to continue the work.'
    );
  }
  const owner = await repo.findAgentForCodeResume(session.agentId);
  if (owner === null) {
    throw new DirectChatError(404, 'CODE_SESSION_NOT_FOUND', 'Code session not found');
  }
  // No run may spend past the owner's cost limit or without credits.
  const refusal = await spendRefusal(owner);
  if (refusal !== null) throw refusal;
  const attachments = checkedAttachments(params.attachments, params.userId);
  const key = startupTurnsKey(session.agentId, toolCallId);
  const task = listedBackgroundTasks(owner).find(
    (entry) => entry.address.replace(/\.run\d+$/, '') === toolCallId
  );
  const messageId = idempotentMessageId(resumeRow(params, toolCallId));
  if (messageId === null) throw new Error('direct turn rows are idempotent');
  if (await resumeStarting(owner, task, key, toolCallId, messageId)) {
    return queueBehindResume(params, toolCallId, attachments);
  }
  // A new resume: the earlier run's published session must not read as this
  // run's; turns queued behind an earlier failed resume stay and reach this run.
  await clearPublishedStartupTask(key);
  const marker: ResumeMarker = { messageId, since: new Date().toISOString() };
  await putEphemeral(RESUME_NAMESPACE, key, { ...marker }, RESUME_MARKER_TTL_MS);
  // The turn row first: its "Resuming…" precedes any (fast) refusal row.
  const queued = await persistQueued(params, toolCallId);
  let via: 'owner' | 'supervisor';
  try {
    via = await startResumeRun({ params, owner, task, toolCallId, messageId, attachments });
    await putEphemeral(RESUME_NAMESPACE, key, { ...marker, started: true }, RESUME_MARKER_TTL_MS);
  } catch (error) {
    await deleteEphemeral(RESUME_NAMESPACE, key);
    await postResumeFailure(params.session.agentId, toolCallId, error);
    throw error;
  }
  log.info('Direct turn resumes a stopped code agent', {
    taskId: session.id,
    agentId: session.agentId,
    clientMessageId: params.clientMessageId,
    via,
  });
  return queued;
}

/**
 * A resend of a turn whose resume never started (its row persisted, then a
 * crash before the run): start it again with the same message id. The run's
 * reuse policy (supervisor) and the wake's message-id dedupe (owner) make a
 * second start of a run that does exist a no-op.
 */
export async function restartStalledResume(params: ResumeParams, rowAt: Date): Promise<void> {
  const { session, toolCallId } = params;
  if (toolCallId === undefined) return;
  const owner = await repo.findAgentForCodeResume(session.agentId);
  if (owner === null || (await spendRefusal(owner)) !== null) return;
  const latest = await findCodeSessionForToolCall(owner.id, toolCallId, null);
  if (latest !== null && latest.createdAt >= rowAt) return; // its run is up
  if ((await repo.findResumeEndRow(owner.id, toolCallId, rowAt)) !== null) return; // it ended
  const messageId = idempotentMessageId(resumeRow(params, toolCallId));
  if (messageId === null) return;
  if (await codeAgentResumeRunExists(owner.id, messageId)) {
    // Its supervised run exists: stranded on a superseded queue, it moves to the live
    // one; terminated by a move whose restart did not land, it starts again.
    const id = `code-resume:${owner.id}:${messageId}`;
    const outcome = await ensureResumeRunOnLiveQueue(id, undefined, undefined, {
      reviveTerminated: true,
    });
    return log.info('Resend found its supervised resume run', { messageId, outcome });
  }
  const task = listedBackgroundTasks(owner).find(
    (entry) => entry.address.replace(/\.run\d+$/, '') === toolCallId
  );
  const attachments = checkedAttachments(params.attachments, params.userId);
  await startResumeRun({ params, owner, task, toolCallId, messageId, attachments });
  log.info('Restarted a code agent resume that never started', {
    taskId: session.id,
    clientMessageId: params.clientMessageId,
  });
}
