/** Shared approval selection for ordinary and native code conversations. */
import type { Message } from './api/types';
import type { RequestPaymentCardPayload } from './realtime-types';

export interface PendingApproval {
  attentionRequestId: string;
  question: string;
  imageUrl: string | null;
  requestPaymentCard?: RequestPaymentCardPayload;
  requestingAgent?: unknown;
}

/** `requestingAgent` of an approval row (top level, else the approval payload's copy). */
function requestingAgentOf(message: Message): { requestingAgent?: unknown } {
  const metadata = message.metadata;
  const nested: unknown = metadata?.requestUserApproval?.requestingAgent;
  const requestingAgent = metadata?.requestingAgent ?? nested;
  return requestingAgent !== undefined ? { requestingAgent } : {};
}

export function derivePendingApproval(messages: Message[]): PendingApproval | null {
  const attentionByToolCallId = new Map<string, Message>();

  for (const m of messages) {
    if (!m.metadata?.isUserAttentionMessage) continue;
    const toolCallId = m.metadata?.toolCallId;
    if (!toolCallId) continue;

    const existing = attentionByToolCallId.get(toolCallId);
    if (!existing || new Date(m.timestamp) > new Date(existing.timestamp)) {
      attentionByToolCallId.set(toolCallId, m);
    }
  }

  const activeApproval = Array.from(attentionByToolCallId.values()).find(
    (m) =>
      m.metadata?.toolStatus === 'IN_PROGRESS' && m.metadata?.requestUserApproval?.toolApproval,
  );

  if (!activeApproval) return null;

  const attentionRequestId = activeApproval.metadata?.requestUserApproval?.attentionRequestId;
  if (!attentionRequestId) {
    console.warn('Active approval found but missing attentionRequestId:', activeApproval.metadata);
    return null;
  }

  return {
    attentionRequestId,
    question: activeApproval.text || '',
    imageUrl: activeApproval.metadata?.imageUrl || null,
    requestPaymentCard: activeApproval.metadata?.requestUserApproval?.requestPaymentCard,
    ...requestingAgentOf(activeApproval),
  };
}
