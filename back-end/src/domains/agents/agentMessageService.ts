/**
 * Agent message service — post messages, handle user responses, file uploads.
 */

import { deliverUserMessageToWorkflow, signalUserResponse } from '../../providers/agentResume';
import { handleChatMessage } from '../../providers/chat';
import { recoverChatHandlerFailure } from '../../providers/chat/chatHandlerFailure';
import {
  createMessage,
  createMessageOnce,
  createWorkflowMessageGroup,
} from '../../providers/messages';
import {
  type FilePointer,
  processUploadedFile,
  validateTotalSize,
  getSignedUrl,
} from '../../providers/storage';
import {
  generateResponseSchema,
  type ResponseSchemaDirectAuth,
} from '../../providers/setResponseSchema';
import { createLogger } from '../../providers/logger';
import type { PostMessageBody } from './types';
import * as repo from './repo';

const log = createLogger('Agents');

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

export function buildUserMessageSignalValue(
  messageText: string,
  metadata: Record<string, unknown> | undefined
): string {
  const idempotencyKey = metadata?.idempotencyKey;
  if (metadata?.isResponseSchemaUpdate === true && typeof idempotencyKey === 'string') {
    return JSON.stringify({
      internal_type: 'response_schema_update',
      idempotency_key: idempotencyKey,
    });
  }
  return messageText;
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
    } else {
      const fresh = await repo.findAgentUnique(agentId);
      if (fresh !== null) {
        agentForChat.temporalWorkflowId = fresh.temporalWorkflowId;
        agentForChat.status = fresh.status;
      }
    }
  }

  if (agentForChat?.temporalWorkflowId !== undefined && agentForChat?.temporalWorkflowId !== null) {
    // A failed signal never fails the request: the row is durable and the
    // workflow polls for it.
    const workflowId = agentForChat.temporalWorkflowId;
    if (authoredByWorkflow) await signalUserResponse(agentId, workflowId, messageText);
    else await deliverUserMessageToWorkflow(agentId, workflowId, messageText);
  } else if (agentForChat !== null && agentForChat !== undefined) {
    handleChatMessage({
      agentId,
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
 * Every USER message sent to an agent lifts a user pause, whoever sends it.
 * Only rows the agent's own workflow writes (internal writes stamped with its
 * generation: response-schema context, OTP relays, sub-agent auto-replies)
 * leave the pause alone, because they can land after the user paused.
 */
async function deliverUserMessage(
  agentId: string,
  body: PostMessageBody,
  authoredByWorkflow: boolean
): Promise<void> {
  const signalValue = buildUserMessageSignalValue(body.message, body.metadata);
  await routeUserMessage(agentId, signalValue, authoredByWorkflow);
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

/** Post a message to an agent (user or internal). */
export async function postMessage(
  agentId: string,
  body: PostMessageBody,
  isInternal: boolean,
  userId?: string,
  workflowGeneration?: string
) {
  // Determine role based on auth type
  const roleResult = resolveRole(body, isInternal);
  if ('error' in roleResult) {
    return roleResult;
  }
  const { role } = roleResult;

  // Verify agent exists
  if (isInternal) {
    const agent = await repo.findAgentById(agentId);
    if (!agent) {
      return { error: 'Agent not found', status: 404 };
    }
  } else {
    const agent = await repo.findAgent(agentId, userId);
    if (!agent) {
      return { error: 'Agent not found', status: 404 };
    }
  }

  // Validate attachments if provided
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

  const messageParams = {
    agentId,
    text: body.message,
    role,
    metadata: body.metadata,
    filePointer: body.file_pointer as Record<string, unknown> | undefined,
  };
  let message;
  if (isInternal) {
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

  if (role === 'USER') {
    await deliverUserMessage(agentId, body, isInternal && workflowGeneration !== undefined);
  }

  return {
    message_id: message.id,
    timestamp: message.timestamp,
    text: message.text,
    role: message.role,
  };
}

// ---------------------------------------------------------------------------
// File uploads (deprecated - use /api/upload)
// ---------------------------------------------------------------------------

/** Upload a file attachment for an agent. */
export async function uploadAttachment(
  userId: string,
  agentId: string,
  file: { buffer: Buffer; originalname: string; mimetype: string }
) {
  const filePointer = await processUploadedFile(
    userId,
    file.buffer,
    file.originalname,
    file.mimetype
  );

  log.info('Uploaded file', {
    user_id: userId,
    filename: filePointer.original_filename,
    size_bytes: filePointer.size_bytes,
    agent_id: agentId,
  });

  return { file_pointer: filePointer };
}

/** True when the requester may mint a signed URL for this storage path. */
export function canAccessAttachmentPath(args: {
  requesterUserId: string;
  storagePath: string;
  agentOwnerUserId?: string;
  isAdmin: boolean;
}): boolean {
  if (args.storagePath.startsWith(`${args.requesterUserId}/`)) {
    return true;
  }
  // Admins can inspect other users' agents (same as GET /agents/:id) but may
  // only sign files stored under that agent's owner — not arbitrary prefixes.
  return (
    args.isAdmin &&
    typeof args.agentOwnerUserId === 'string' &&
    args.agentOwnerUserId.length > 0 &&
    args.storagePath.startsWith(`${args.agentOwnerUserId}/`)
  );
}

/** Get a signed URL for a file attachment. */
export async function getAttachmentSignedUrl(
  userId: string,
  storagePath: string,
  access: { agentId?: string; isAdmin?: boolean } = {}
) {
  let agentOwnerUserId: string | undefined;
  if (access.isAdmin === true && typeof access.agentId === 'string' && access.agentId.length > 0) {
    const agent = await repo.findAgentById(access.agentId);
    agentOwnerUserId = agent?.userId;
  }
  if (
    !canAccessAttachmentPath({
      requesterUserId: userId,
      storagePath,
      agentOwnerUserId,
      isAdmin: access.isAdmin === true,
    })
  ) {
    return { error: 'Access denied to this file', status: 403 };
  }

  // Generate signed URL (1 hour expiry)
  const signedUrl = await getSignedUrl(storagePath, 3600);

  return {
    signed_url: signedUrl,
    expires_in: 3600,
  };
}

// ---------------------------------------------------------------------------
// Batch message lookup (context pointer resolution)
// ---------------------------------------------------------------------------

const MAX_BATCH_SIZE = 50;

/** Fetch messages by IDs for context pointer resolution. Scoped to user's agents. */
export async function getMessagesBatch(ids: unknown, userId: string) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: 'ids must be a non-empty array', status: 400 };
  }

  if (ids.length > MAX_BATCH_SIZE) {
    return { error: `Maximum ${MAX_BATCH_SIZE} IDs per batch request`, status: 400 };
  }

  const messages = await repo.findMessagesByIds(ids as string[], userId);
  return { messages };
}

// ---------------------------------------------------------------------------
// Generate response schema
// ---------------------------------------------------------------------------

/** Generate response schema for a goal (used by browser agent). */
export async function generateSchema(goal: string, directAuth?: ResponseSchemaDirectAuth) {
  return generateResponseSchema(goal, { directAuth });
}

// ---------------------------------------------------------------------------
// Batch fetch messages
// ---------------------------------------------------------------------------

/** Fetch messages by IDs, scoped to the requesting user. */
export async function batchFetchMessages(ids: string[], userId: string) {
  const messages = await repo.findMessagesByIds(ids, userId);
  return { messages };
}
