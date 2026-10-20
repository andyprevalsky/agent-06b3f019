/**
 * Terminal feature — pure derivation functions.
 *
 * Stateless helpers that compute derived values from terminal state.
 * Used by hooks and components via useMemo. No React hooks here.
 */

import { DEFAULT_CONTEXT_WINDOW, PAUSED_STATUSES } from '../config';
import type { Agent, AgentDetail, Message, Model, PendingApproval, PendingGate } from '../types';

// ── Context window helpers ────────────────────────────────────────────────

export function getModelContextWindow(model: string, models: Model[]): number {
  const modelData = models.find((m) => m.id === model);
  if (modelData?.contextLength) {
    return modelData.contextLength;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

export function getContextPercentage(agent: AgentDetail, models: Model[]): number {
  const maxWindow = getModelContextWindow(agent.model, models);
  const restartThreshold = Math.round(maxWindow * 0.8);
  return Math.min(100, (agent.context_size / restartThreshold) * 100);
}

// ── Message deduplication ─────────────────────────────────────────────────

function getMessageOrderTimestamp(message: Message): number {
  const metadata = message.metadata;
  const firstTimestamp =
    typeof metadata?.firstTimestamp === 'string'
      ? metadata.firstTimestamp
      : typeof metadata?.startedAt === 'string' && metadata?.plannedToolName === 'reasoning'
        ? metadata.startedAt
        : message.timestamp;
  const orderedMs = new Date(firstTimestamp).getTime();
  if (Number.isFinite(orderedMs)) return orderedMs;
  return new Date(message.timestamp).getTime();
}

export function deduplicateToolMessages(messages: Message[]): Message[] {
  const sortedMessages = messages
    .filter((m) => m.role !== 'TOOL' || m.metadata?.toolName !== 'agent_init')
    .sort((a, b) => getMessageOrderTimestamp(a) - getMessageOrderTimestamp(b));

  const toolMessageMap = new Map<string, { message: Message; firstTimestamp: string }>();
  const nonToolMessages: Message[] = [];

  sortedMessages.forEach((message) => {
    if (message.role === 'TOOL') {
      const toolCallId = message.metadata?.toolCallId;

      if (!toolCallId) {
        console.error('Tool message missing toolCallId in metadata:', message);
        nonToolMessages.push(message);
        return;
      }

      const existing = toolMessageMap.get(toolCallId);

      if (existing) {
        const isAttention = !!message.metadata?.isUserAttentionMessage;
        toolMessageMap.set(toolCallId, {
          message: isAttention ? { ...message, message_id: existing.message.message_id } : message,
          firstTimestamp: existing.firstTimestamp,
        });
      } else {
        toolMessageMap.set(toolCallId, {
          message,
          firstTimestamp: message.timestamp,
        });
      }
    } else {
      nonToolMessages.push(message);
    }
  });

  const deduplicatedToolMessages = Array.from(toolMessageMap.values()).map(
    ({ message, firstTimestamp }) => ({
      ...message,
      timestamp: firstTimestamp,
    }),
  );

  const deduplicatedMessages = [...nonToolMessages, ...deduplicatedToolMessages];
  deduplicatedMessages.sort((a, b) => getMessageOrderTimestamp(a) - getMessageOrderTimestamp(b));

  return deduplicatedMessages;
}

// ── Agent sorting ─────────────────────────────────────────────────────────

export function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    if (a.status === 'COMPLETED' && b.status !== 'COMPLETED') return 1;
    if (a.status !== 'COMPLETED' && b.status === 'COMPLETED') return -1;
    const aIsPaused = (PAUSED_STATUSES as readonly string[]).includes(a.status);
    const bIsPaused = (PAUSED_STATUSES as readonly string[]).includes(b.status);
    if (aIsPaused && !bIsPaused) return 1;
    if (!aIsPaused && bIsPaused) return -1;
    return b.progress - a.progress;
  });
}

export { computeActiveBrowserPanels } from '@/lib/browserPanelLifecycle';

// ── Approval derivation ──────────────────────────────────────────────────

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
    ...(activeApproval.metadata?.from_code_agent !== undefined
      ? { fromCodeAgent: activeApproval.metadata.from_code_agent }
      : {}),
  };
}

export function deriveHasActiveAttentionRequest(messages: Message[]): boolean {
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

  return Array.from(attentionByToolCallId.values()).some(
    (m) => m.metadata?.toolStatus === 'IN_PROGRESS',
  );
}

// ── Gate derivation ──────────────────────────────────────────────────────

export function derivePendingGates(messages: Message[]): PendingGate[] {
  const gateByKey = new Map<string, Message>();

  for (const m of messages) {
    if (!m.metadata?.gate) continue;
    const gateRecord = m.metadata.gate as { gateKey?: unknown };
    const attentionRequestId = m.metadata.attentionRequestId;
    if (typeof attentionRequestId !== 'string') continue;

    const key = typeof gateRecord.gateKey === 'string' ? gateRecord.gateKey : attentionRequestId;
    const existing = gateByKey.get(key);
    if (!existing || new Date(m.timestamp) > new Date(existing.timestamp)) {
      gateByKey.set(key, m);
    }
  }

  return Array.from(gateByKey.values())
    .filter((m) => m.metadata?.toolStatus === 'IN_PROGRESS')
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .map((m) => ({
      attentionRequestId: m.metadata?.attentionRequestId as string,
      gate: m.metadata?.gate as PendingGate['gate'],
    }));
}
