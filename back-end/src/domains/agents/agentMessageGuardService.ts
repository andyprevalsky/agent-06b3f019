/**
 * Cheap guard on agent-to-agent messaging (send_message_to_agent),
 * after Prime's agent_messaging.rs: per sender a burst of 3 then 1 message/s;
 * per recipient at most 20 unread agent messages. Refusals are actionable 429s
 * returned to the sending tool — never silent drops.
 *
 *   sendAgentMessage ──▶ guardAgentMessage
 *       retry (same idempotency key → row exists) ──▶ allowed, nothing consumed
 *       recipient unread ≥ 20                     ──▶ 429 "<to> has 20 unread messages; …"
 *       sender bucket empty                       ──▶ 429 "Message rate limit: …"
 *
 * "Unread" = agent messages to the recipient created after its read mark. A
 * mark advances when the recipient's OWN read returns them (delivered into its
 * context): a workflow agent's message poll (internal GET /:id?since=) for
 * rows addressed to the agent, and a task inbox read (GET /:id/agent-inbox,
 * the explore progress post's piggybacked read, or a browser's per-step read
 * with browserToolCallId) for rows addressed to that task.
 *
 * 10k agents: per send one PK lookup (retry check), one bounded range read on
 * the recipient's Message(agentId, timestamp) index (≤ 20 rows past its mark)
 * and one PK UPDATE on the sender's row. Read marks are written only when a
 * read actually delivered agent messages, so writes ≤ message volume
 * (≤ 1/s per sender). No shared counter, row or in-memory map.
 */

import { idempotentMessageId } from '../../providers/messageIdempotency';
import {
  AGENT_MESSAGE_MAX_UNREAD,
  countUnreadAgentMessages,
  findAgentMessagingState,
  idempotentRowExists,
  markAgentMessagesRead,
  newestTimestamp,
  readMarkOf,
  takeAgentMessageSendToken,
} from './repoAgentMessageGuard';

export interface AgentMessageGuardRefusal {
  error: string;
  status: number;
}

/** Null when the send may proceed; otherwise the actionable refusal. */
export async function guardAgentMessage(
  target: { id: string },
  senderId: string,
  recipientTaskId: string | null,
  idempotencyKey: string,
  displayAddress: string
): Promise<AgentMessageGuardRefusal | null> {
  const retryId = idempotentMessageId({
    agentId: target.id,
    role: 'USER',
    metadata: { agentMessage: true, idempotencyKey },
  });
  if (retryId !== null && (await idempotentRowExists(retryId))) {
    return null; // an idempotent retry consumes no budget
  }
  const state = await findAgentMessagingState(target.id);
  const unread = await countUnreadAgentMessages(
    target.id,
    recipientTaskId,
    readMarkOf(state, recipientTaskId)
  );
  if (unread >= AGENT_MESSAGE_MAX_UNREAD) {
    return {
      error: `${displayAddress} has ${AGENT_MESSAGE_MAX_UNREAD} unread messages; wait for it to catch up before messaging it again.`,
      status: 429,
    };
  }
  if (!(await takeAgentMessageSendToken(senderId))) {
    return {
      error: `Message rate limit: wait a moment before messaging ${displayAddress} again.`,
      status: 429,
    };
  }
  return null;
}

interface ReadRow {
  role: string;
  timestamp: Date | string;
  metadata: unknown;
}

function agentMessageRecipientTask(row: ReadRow): string | null | undefined {
  const metadata = row.metadata;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))
    return undefined;
  const meta = metadata as Record<string, unknown>;
  if (row.role !== 'USER' || meta.agentMessage !== true) return undefined;
  return typeof meta.recipientTaskId === 'string' ? meta.recipientTaskId : null;
}

/**
 * The recipient's own read returned `rows`: advance its read mark to the
 * newest agent message delivered (`taskId` null = the agent itself). No write
 * when the read delivered none.
 */
export async function noteAgentMessagesConsumed(
  agentId: string,
  rows: ReadRow[],
  taskId: string | null
): Promise<void> {
  const delivered = rows.filter((row) => agentMessageRecipientTask(row) === taskId);
  const upTo = newestTimestamp(delivered);
  if (upTo !== null) await markAgentMessagesRead(agentId, taskId, upTo);
}
