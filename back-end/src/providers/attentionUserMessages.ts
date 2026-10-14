import type { Message, Prisma } from '@prisma/client';
import { broadcastCreatedMessage, createUserMessageInTransaction } from './messages';

export class AttentionUserMessageConflictError extends Error {}

interface AuthoredReply {
  requestId: string;
  agentId: string;
  targetAgentIds?: Iterable<string>;
  userMessage?: string;
}

/** Serialize authored rows with the attention claim; broadcast after commit. */
export async function persistAttentionUserMessages(
  tx: Prisma.TransactionClient,
  reply: AuthoredReply
): Promise<{ userMessage: string | null; userMessages: Message[] }> {
  await tx.$queryRaw`SELECT id FROM "AgentAttentionRequest" WHERE id = ${reply.requestId} FOR UPDATE`;
  const where = {
    role: 'USER' as const,
    metadata: { path: ['attentionRequestId'], equals: reply.requestId },
  };
  const source = await tx.message.findFirst({ where: { ...where, agentId: reply.agentId } });
  const supplied = reply.userMessage?.trim() ? reply.userMessage : undefined;
  if (source !== null && supplied !== undefined && source.text !== supplied) {
    throw new AttentionUserMessageConflictError(
      'This request already has a different authored reply'
    );
  }
  const userMessage = supplied ?? source?.text ?? null;
  const userMessages: Message[] = [];
  if (userMessage === null) return { userMessage, userMessages };
  for (const agentId of new Set([reply.agentId, ...(reply.targetAgentIds ?? [])])) {
    const existing = await tx.message.findFirst({ where: { ...where, agentId } });
    if (existing === null) {
      userMessages.push(
        await createUserMessageInTransaction(tx, {
          agentId,
          text: userMessage,
          metadata: { source: 'attention_response', attentionRequestId: reply.requestId },
        })
      );
    }
  }
  return { userMessage, userMessages };
}

export function broadcastAttentionUserMessages(messages: Message[]): void {
  for (const message of messages) {
    broadcastCreatedMessage(
      { agentId: message.agentId, text: message.text, role: 'USER' },
      message
    );
  }
}
