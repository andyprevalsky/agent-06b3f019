/**
 * Agent message service — post messages, handle user responses, file uploads.
 */

import { deliverUserMessageToWorkflow, signalUserResponse } from '../../providers/agentResume';
import { handleChatMessage } from '../../providers/chat';
import { recoverChatHandlerFailure } from '../../providers/chat/chatHandlerFailure';
import {
  broadcastCreatedMessage,
  createMessage,
  createMessageOnce,
  createUserMessageInTransaction,
  createWorkflowMessageGroup,
} from '../../providers/messages';
import { recordPersonMessage } from '../../providers/personMessageStamp';
import { type FilePointer, validateTotalSize } from '../../providers/storage';
import type { PostMessageBody } from './types';
import { isAgentAuthoredRow, withCredentialProvenance } from './credentialContext';
import * as repo from './repo';
import { withActiveBrowserSessionShareLock } from './repoBrowserTargetedMessages';
import { readTaskInboxMessages } from './agentToAgentService';
import { ownedByExternalExecution } from './agentExternalExecution';
import { createLogger } from '../../providers/logger';
import { broadcastChatReactivation } from './agentMessageReactivation';
import { resumeStoppedBrowser, stoppedAgentStatus } from './agentMessageResume';
import { findGraphRootId } from './repoGraph';

const log = createLogger('AgentMessages');

/**
 * Agent statuses whose Temporal workflow has already ended. A follow-up message
 * to any of these must resume chat mode, not signal a dead/paused workflow.
 */
export const TERMINAL_STATUSES: ReadonlyArray<string> = [
  'COMPLETED',
  'FAILED',
  'OUT_OF_CREDITS',
  'COST_LIMIT_REACHED',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the role for a message based on auth type. Returns role or error. */
function resolveRole(
  body: PostMessageBody,
  isInternal: boolean
): { role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM' } | { error: string; status: number } {
  if (isInternal) {
    if (body.role === undefined) {
      return {
        error: 'Internal messages must specify role (USER/ASSISTANT/TOOL/SYSTEM)',
        status: 400,
      };
    }
    return { role: body.role };
  }
  return { role: 'USER' };
}

/** Handle user message routing — signal workflow or run chat handler. */
async function routeUserMessage(
  agentId: string,
  messageText: string,
  authoredByWorkflow: boolean
): Promise<void> {
  const agentForChat = await repo.findAgentUnique(agentId);

  // If the agent's workflow has already ended (any terminal status), clear the
  // dead workflow id so this message falls through to chat mode instead of
  // signaling a closed/paused workflow that will never wake. Use a compare-and-set
  // on the observed status + workflow id so a concurrent reactivation (a newer
  // workflow) isn't clobbered — if 0 rows update, reload and act on fresh state.
  if (
    agentForChat?.temporalWorkflowId !== undefined &&
    agentForChat?.temporalWorkflowId !== null &&
    TERMINAL_STATUSES.includes(agentForChat.status)
  ) {
    const { count } = await repo.clearWorkflowForTerminalAgent(
      agentId,
      agentForChat.status,
      agentForChat.temporalWorkflowId,
      agentForChat.temporalFirstExecutionRunId
    );
    if (count > 0) {
      agentForChat.temporalWorkflowId = null;
      agentForChat.status = 'ACTIVE';
      // Clients still hold the finished run's status; tell them before the chat
      // turn streams (the chat Start agent button is gated on ACTIVE).
      await broadcastChatReactivation(agentId, agentForChat.busId ?? undefined);
    } else {
      const fresh = await repo.findAgentUnique(agentId);
      if (fresh !== null) {
        agentForChat.temporalWorkflowId = fresh.temporalWorkflowId;
        agentForChat.status = fresh.status;
      }
    }
  }

  if (agentForChat !== null && ownedByExternalExecution(agentForChat)) {
    // The stored row stays in the executor's trace; an external root never dispatches chat or Temporal.
    log.info('[AgentMessages] External executor owns this root; message stored without dispatch', {
      agentId,
    });
    return;
  }

  if (agentForChat?.temporalWorkflowId !== undefined && agentForChat?.temporalWorkflowId !== null) {
    // A failed signal never fails the request: the row is durable and the
    // workflow polls for it.
    const workflowId = agentForChat.temporalWorkflowId;
    if (authoredByWorkflow) await signalUserResponse(agentId, workflowId, messageText);
    else await deliverUserMessageToWorkflow(agentId, workflowId, messageText);
  } else if (agentForChat !== null && agentForChat !== undefined) {
    const rootAgentId =
      agentForChat.parentAgentId === null
        ? agentId
        : await findGraphRootId(agentId, agentForChat.userId);
    if (rootAgentId === null) throw new Error(`Chat archive root unavailable for ${agentId}`);
    handleChatMessage({
      agentId,
      rootAgentId,
      userId: agentForChat.userId,
      model: agentForChat.model,
    }).catch((err: unknown) => {
      void recoverChatHandlerFailure({
        agentId,
        userId: agentForChat.userId,
        error: err,
      });
    });
  }
}

/**
 * One agent-graph (A2A) USER row from another agent: written once per
 * idempotency key and delivered only by the call that wrote it, so a retried
 * or racing send never signals the workflow twice. An agent's message is not
 * the user's instruction to continue, so it never lifts a user pause (the
 * paused agent reads it when the user resumes it). A finished agent still
 * resumes in chat mode, as for any message.
 */
export async function deliverAgentGraphMessage(
  agentId: string,
  body: { message: string; metadata: Record<string, unknown> }
): Promise<{ created: boolean }> {
  const { created } = await createMessageOnce({
    agentId,
    text: body.message,
    role: 'USER',
    metadata: body.metadata,
  });
  if (created) {
    await routeUserMessage(agentId, buildUserMessageSignalValue(body.message, body.metadata), true);
  }
  return { created };
}

// ---------------------------------------------------------------------------
// Post message
// ---------------------------------------------------------------------------

/** The agent exists (and is the caller's, for user writes) and attachments fit. */
async function validatePostTarget(
  agentId: string,
  body: PostMessageBody,
  isInternal: boolean,
  userId?: string
): Promise<{ error: string; status: number } | null> {
  const agent = isInternal
    ? await repo.findAgentById(agentId)
    : await repo.findAgent(agentId, userId);
  if (!agent) return { error: 'Agent not found', status: 404 };
  if (body.attachments !== undefined && body.attachments.length > 0) {
    try {
      validateTotalSize(body.attachments as FilePointer[]);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Invalid attachments',
        status: 400,
      };
    }
  }
  return null;
}

/**
 * `browser_task_id` (user Browser composer) addresses one running browser task
 * of this agent. Only an ACTIVE session is reading its instructions; then the
 * stored row carries `browserTaskId` (the tag the browser's instruction read
 * already filters on) and `excludeFromModel` (the owner's model and loop skip
 * it). A paused/ended session (run over, or pause-closed after its last step)
 * would never read it, so the message is delivered to the owner as before.
 * Files only reach models through the owner, so a target with files is a 400.
 * The ACTIVE check and the insert share one row lock (see
 * createBrowserTargetedMessage), so a pause-close cannot slip between them.
 */
async function resolveBrowserTarget(
  agentId: string,
  body: PostMessageBody,
  role: string,
  isInternal: boolean
): Promise<{ browserTaskId: string } | { error: string; status: number } | null> {
  const browserTaskId = body.browser_task_id;
  if (browserTaskId === undefined) return null;
  if (isInternal || role !== 'USER') {
    return { error: 'browser_task_id is only valid on user messages', status: 400 };
  }
  if ((body.attachments?.length ?? 0) > 0 || body.file_pointer !== undefined) {
    return { error: 'browser_task_id cannot carry files; send files to the agent', status: 400 };
  }
  const task = await repo.findAgentBrowserTask(agentId, browserTaskId);
  if (task === null) return { error: 'Browser task not found', status: 404 };
  return { browserTaskId };
}

/** A Browser-composer row: the live session's, else a paused browser's resume (agentMessageResume.ts). */
async function targetedBrowserRow(
  agentId: string,
  body: PostMessageBody,
  browserTarget: { browserTaskId: string } | null
) {
  if (browserTarget === null) return null;
  const { browserTaskId } = browserTarget;
  return (
    (await createBrowserTargetedMessage(agentId, body, browserTaskId)) ??
    resumeStoppedBrowser(agentId, browserTaskId, body.message, body.metadata)
  );
}

/**
 * Store a Browser-composer message only while its session is ACTIVE, under a
 * FOR SHARE lock on that BrowserSession row. The browser's pause-close UPDATE
 * waits for this insert (so its post-close read sees the row), or commits
 * first (so the message falls back to the owner, returning null). One row
 * lock and one insert per message; broadcast after commit.
 */
async function createBrowserTargetedMessage(
  agentId: string,
  body: PostMessageBody,
  browserTaskId: string
) {
  const message = await withActiveBrowserSessionShareLock(agentId, browserTaskId, (tx) =>
    createUserMessageInTransaction(tx, {
      agentId,
      text: body.message,
      metadata: { ...(body.metadata ?? {}), browserTaskId, excludeFromModel: true },
    })
  );
  if (message !== null) {
    broadcastCreatedMessage({ agentId, text: message.text, role: 'USER' }, message);
  }
  return message;
}

/**
 * A stale TOOL write must TELL the worker it is dead.
 *
 * This used to return 200 + the fenced row so "the LLM observes the deployment
 * interruption and decides whether to retry". But the writer is an orphaned
 * activity of a terminated workflow, not the LLM: Temporal `terminate()` closes
 * a workflow without cancelling its in-flight activities, and the browser
 * activity has no cancellation poll. Handing it a success response removed the
 * only signal it could act on, so it kept stepping and every step became
 * another red chip — 15 from a single cutover in the local e2e, 105 on one prod
 * agent.
 *
 * The fenced row is still written by the generation fence, so the replacement
 * LLM still sees the interruption in its history. Only the dead worker's HTTP
 * result changes, and 409 is the same signal non-TOOL stale writes always got.
 */
function staleWorkerRejection(): { error: string; status: number } {
  return { error: 'Workflow generation is no longer current', status: 409 };
}

/**
 * Explore progress posts carry their task's inbox read (one bounded indexed
 * query) instead of a separate per-step GET /:id/agent-inbox.
 */
async function withPiggybackedInbox<T extends object>(
  agentId: string,
  body: PostMessageBody,
  isInternal: boolean,
  posted: T
): Promise<T & { pending_inbox?: Awaited<ReturnType<typeof readTaskInboxMessages>> }> {
  if (!isInternal || body.inbox === undefined) return posted;
  const pending = await readTaskInboxMessages(agentId, body.inbox.task_id, body.inbox.since);
  return { ...posted, pending_inbox: pending };
}

/**
 * Post a message to an agent (user or internal). A non-internal USER post is
 * a person's message unless `personAuthored: false` (a bot relaying alerts on
 * the owner's behalf); only person-authored posts move the sidebar recency key.
 */
export async function postMessage(
  agentId: string,
  body: PostMessageBody,
  isInternal: boolean,
  userId?: string,
  workflowGeneration?: string,
  options: { personAuthored?: boolean } = {}
) {
  body = withCredentialProvenance(body, isInternal);
  // Determine role based on auth type
  const roleResult = resolveRole(body, isInternal);
  if ('error' in roleResult) {
    return roleResult;
  }
  const { role } = roleResult;

  const invalid = await validatePostTarget(agentId, body, isInternal, userId);
  if (invalid !== null) return invalid;

  const browserTarget = await resolveBrowserTarget(agentId, body, role, isInternal);
  if (browserTarget !== null && 'error' in browserTarget) return browserTarget;
  const targeted = await targetedBrowserRow(agentId, body, browserTarget);
  // A person's message to a stopped agent resumes it: the row says from what.
  const resumedFrom =
    role === 'USER' && !isInternal && targeted === null ? await stoppedAgentStatus(agentId) : null;

  const messageParams = {
    agentId,
    text: body.message,
    role,
    metadata: resumedFrom === null ? body.metadata : { ...(body.metadata ?? {}), resumedFrom },
    filePointer: body.file_pointer as Record<string, unknown> | undefined,
  };
  let message;
  if (targeted !== null) {
    message = targeted;
  } else if (isInternal) {
    // An internal write with no X-Agent-Workflow-Generation header is
    // UNATTRIBUTED, not "generation 1". Defaulting it to the agent id
    // fabricated a real-but-wrong generation, because generation 1's Temporal
    // workflow id IS the agent id — so after any replacement every unattributed
    // write looked stale and got rewritten into the terminal
    // "Tool interrupted by deployment" error. In prod that turned one live
    // browser sub-agent into ~20 red chips while it was succeeding. An
    // unattributed write now joins the agent's CURRENT generation.
    const generation =
      workflowGeneration ?? (await repo.currentAgentWorkflowGeneration(agentId)) ?? agentId;
    const result = await createWorkflowMessageGroup(
      messageParams,
      (body.attachments ?? []) as Array<Record<string, unknown>>,
      generation
    );
    if (result.message === null) {
      return {
        error: 'Workflow generation is no longer current',
        status: 409,
      };
    }
    if (!result.accepted) return staleWorkerRejection();
    message = result.message;
  } else {
    message = await createMessage(messageParams);
    // User attachment rows are external writes and deliberately remain outside
    // the worker-generation fence.
    if (body.attachments !== undefined && body.attachments.length > 0) {
      for (const attachment of body.attachments) {
        await createMessage({
          agentId,
          text: '',
          role,
          filePointer: attachment as Record<string, unknown>,
        });
      }
    }
  }

  // Agent-authored USER rows (background-agent notifications, agent-to-agent
  // messages) are polled by the owning workflow, which already woke itself;
  // echoing them back as receive_user_response would read as user feedback.
  // A Browser-composer message belongs to that browser task: the browser reads
  // it at its next step, so the owner's loop is never signalled for it.
  // User messages lift a user pause; generation-stamped workflow writes leave it alone.
  if (role === 'USER' && targeted === null && !(isInternal && isAgentAuthoredRow(body.metadata))) {
    await routeUserMessage(
      agentId,
      buildUserMessageSignalValue(body.message, body.metadata),
      isInternal && workflowGeneration !== undefined
    );
  }
  // After delivery: the recency stamp is best-effort and never gates routing.
  if (role === 'USER' && !isInternal && options.personAuthored !== false) {
    await recordPersonMessage(message);
  }

  return withPiggybackedInbox(agentId, body, isInternal, {
    message_id: message.id,
    timestamp: message.timestamp,
    text: message.text,
    role: message.role,
  });
}
