import type { Message, Prisma } from '@prisma/client';
import { broadcastCreatedMessage, createUserMessageInTransaction } from './messages';
import { recordPersonMessage } from './personMessageStamp';
import { prisma } from './database';
import {
  assertAttentionWorkflowTargets,
  type AttentionWorkflowTarget,
} from './attentionWorkflowTargets';

export class AttentionUserMessageConflictError extends Error {}
export class AttentionUserMessageForbiddenError extends Error {}

export function attentionRequestWorkflowTargets(request: {
  agentId: string;
  workflowId: string;
  metadata?: unknown;
}): AttentionWorkflowTarget[] {
  const metadata = request.metadata;
  const waiters =
    metadata !== null &&
    typeof metadata === 'object' &&
    'gateWaiters' in metadata &&
    Array.isArray(metadata.gateWaiters)
      ? metadata.gateWaiters
      : [];
  return [
    { agentId: request.agentId, workflowId: request.workflowId },
    ...waiters.filter(
      (waiter): waiter is AttentionWorkflowTarget =>
        waiter !== null &&
        typeof waiter === 'object' &&
        typeof waiter.agentId === 'string' &&
        typeof waiter.workflowId === 'string' &&
        waiter.agentId.length > 0 &&
        waiter.workflowId.length > 0
    ),
  ];
}

export async function assertAttentionAgentOwnership(
  userId: string,
  agentIds: Iterable<string>,
  db: Pick<Prisma.TransactionClient, 'agent'> = prisma
): Promise<void> {
  const ids = [...new Set(agentIds)];
  const owned = await db.agent.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true },
  });
  if (owned.length !== ids.length) {
    throw new AttentionUserMessageForbiddenError(
      'Attention targets must belong to the request owner'
    );
  }
}

interface AuthoredReply {
  requestId: string;
  agentId: string;
  targetAgentIds?: Iterable<string>;
  userMessage?: string;
}

/** Native browser task identity from the locked request, never from reply text. */
function attentionBrowserTaskId(metadata: unknown): string | undefined {
  if (metadata === null || typeof metadata !== 'object') return undefined;
  const values = metadata as Record<string, unknown>;
  const candidates = [
    values.browserTaskId,
    ...(['authAssistance', 'requestUserAuthentication'] as const).map((key) => {
      const auth = values[key];
      return auth !== null && typeof auth === 'object' && 'browserSessionId' in auth
        ? auth.browserSessionId
        : undefined;
    }),
  ];
  return candidates.find((value): value is string => typeof value === 'string' && value.length > 0);
}

/** Serialize authored rows with the attention claim; broadcast after commit. */
export async function persistAttentionUserMessages(
  tx: Prisma.TransactionClient,
  reply: AuthoredReply
): Promise<{ userMessage: string | null; userMessages: Message[] }> {
  const [request] = await tx.$queryRaw<
    Array<{ userId: string; agentId: string; workflowId: string; metadata: unknown }>
  >`
    SELECT "userId", "agentId", "workflowId", metadata FROM "AgentAttentionRequest" WHERE id = ${reply.requestId} FOR UPDATE`;
  if (request === undefined || request.agentId !== reply.agentId) {
    throw new AttentionUserMessageForbiddenError('Attention request ownership is invalid');
  }
  const browserTaskId = attentionBrowserTaskId(request.metadata);
  const targetAgentIds = new Set([request.agentId, ...(reply.targetAgentIds ?? [])]);
  await assertAttentionAgentOwnership(request.userId, targetAgentIds, tx);
  await assertAttentionWorkflowTargets(
    tx,
    request.userId,
    attentionRequestWorkflowTargets(request)
  );
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
  for (const agentId of targetAgentIds) {
    const existing = await tx.message.findFirst({ where: { ...where, agentId } });
    if (existing === null) {
      userMessages.push(
        await createUserMessageInTransaction(tx, {
          agentId,
          text: userMessage,
          metadata: {
            source: 'attention_response',
            attentionRequestId: reply.requestId,
            ...(agentId === request.agentId && browserTaskId !== undefined
              ? { browserTaskId }
              : {}),
          },
        })
      );
    }
  }
  return { userMessage, userMessages };
}

/** After commit: broadcast each authored reply and stamp the sidebar recency key. */
export function broadcastAttentionUserMessages(messages: Message[]): void {
  for (const message of messages) {
    broadcastCreatedMessage(
      { agentId: message.agentId, text: message.text, role: 'USER' },
      message
    );
    void recordPersonMessage(message);
  }
}
