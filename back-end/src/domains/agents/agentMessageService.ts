/**
 * Agent message service — post messages, handle user responses, file uploads.
 */

import { getTemporalClient } from '../../providers/temporal';
import { handleChatMessage } from '../../providers/chat';
import { createMessage } from '../../providers/messages';
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
import { alertError } from '../../providers/errorAlert';
import type { PostMessageBody } from './types';
import * as repo from './repo';

const log = createLogger('Agents');

/**
 * Agent statuses whose Temporal workflow has already ended. A follow-up message
 * to any of these must resume chat mode, not signal a dead/paused workflow.
 */
const TERMINAL_STATUSES: ReadonlyArray<string> = [
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
async function routeUserMessage(agentId: string, messageText: string): Promise<void> {
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
      agentForChat.temporalWorkflowId
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
    // Agent mode: signal Temporal workflow
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agentForChat.temporalWorkflowId);
      await handle.signal('receive_user_response', messageText);
    } catch (error) {
      // Don't fail the request if signaling fails - workflow will eventually poll
      log.error('Failed to signal workflow', {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (agentForChat !== null && agentForChat !== undefined) {
    handleChatMessage({
      agentId,
      userId: agentForChat.userId,
      model: agentForChat.model,
    }).catch(async (err: unknown) => {
      log.error('Chat handler error in message route', {
        agent_id: agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      alertError({
        source: 'chat',
        message: err instanceof Error ? err.message : String(err),
        agentId,
        userId: agentForChat.userId,
        stack: err instanceof Error ? err.stack : undefined,
      });
      // Fail loud, not silent: without this the user gets a 201 and then nothing
      // (the prod symptom). Surface an assistant message so the UI shows the
      // failure instead of an unresponsive chat.
      try {
        await createMessage({
          agentId,
          role: 'ASSISTANT',
          text: "Sorry — I couldn't generate a response just now. Please try again.",
          metadata: { error: true, source: 'chat_handler_failure' },
        });
      } catch (persistErr) {
        log.error('Failed to persist chat-failure notice', {
          agent_id: agentId,
          error: persistErr instanceof Error ? persistErr.message : String(persistErr),
        });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Post message
// ---------------------------------------------------------------------------

/** Post a message to an agent (user or internal). */
export async function postMessage(
  agentId: string,
  body: PostMessageBody,
  isInternal: boolean,
  userId?: string
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

  // Create the text message (optionally with file_pointer for single-file messages)
  const message = await createMessage({
    agentId,
    text: body.message,
    role,
    metadata: body.metadata,
    filePointer: body.file_pointer as Record<string, unknown> | undefined,
    enforceCurrentWorkflowGeneration: isInternal,
  });

  // Create separate messages for each file attachment (OAI-style)
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

  // If this is a USER message, either signal workflow or run chat handler
  if (role === 'USER') {
    await routeUserMessage(agentId, buildUserMessageSignalValue(body.message, body.metadata));
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

/** Get a signed URL for a file attachment. */
export async function getAttachmentSignedUrl(userId: string, storagePath: string) {
  // Verify the storage path belongs to this user (files are stored under userId/)
  if (!storagePath.startsWith(`${userId}/`)) {
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
