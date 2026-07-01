/**
 * Terminal feature — pure derivation functions.
 *
 * Stateless helpers that compute derived values from terminal state.
 * Used by hooks and components via useMemo. No React hooks here.
 */

import { DEFAULT_CONTEXT_WINDOW, PAUSED_STATUSES } from '../config';
import type {
  Agent,
  AgentDetail,
  Message,
  Model,
  BrowserPanelData,
  PendingApproval,
} from '../types';

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

export function deduplicateToolMessages(messages: Message[]): Message[] {
  const sortedMessages = messages
    .filter((m) => m.role !== 'TOOL' || m.metadata?.toolName !== 'agent_init')
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

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
  deduplicatedMessages.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

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

// ── Browser panels ────────────────────────────────────────────────────────

export function computeActiveBrowserPanels(messages: Message[]): BrowserPanelData[] {
  const panels: BrowserPanelData[] = [];
  const browserTaskIds = new Set<string>();
  const pausedBrowserToolCallIds = new Set<string>();

  messages.forEach((m) => {
    const taskId = m.metadata?.task_id;
    if (taskId && m.metadata?.toolName === 'spawn_browser_agent') {
      browserTaskIds.add(taskId);
    }
    const toolCallId = m.metadata?.toolCallId;
    if (
      toolCallId &&
      m.metadata?.toolName === 'spawn_browser_agent' &&
      m.metadata?.action_type === 'session_paused'
    ) {
      pausedBrowserToolCallIds.add(toolCallId);
    }
  });

  browserTaskIds.forEach((taskId) => {
    const taskMessages = messages.filter((m) => m.metadata?.task_id === taskId);
    const initMessage = taskMessages.find(
      (m) => m.metadata?.action_type === 'browser' || m.metadata?.action_type === 'system',
    );
    const lastMessage = taskMessages[taskMessages.length - 1];
    const initToolCallId = initMessage?.metadata?.toolCallId;

    const hasTerminalTaskMessage = taskMessages.some(
      (m) =>
        m.metadata?.action_type === 'task_complete' || m.metadata?.action_type === 'session_paused',
    );

    const isComplete =
      hasTerminalTaskMessage ||
      lastMessage?.metadata?.action_type === 'task_complete' ||
      lastMessage?.metadata?.action_type === 'session_paused' ||
      (typeof initToolCallId === 'string' && pausedBrowserToolCallIds.has(initToolCallId));

    if (!isComplete && initMessage) {
      panels.push({
        taskId,
        browserUrl: initMessage.metadata?.browser_url || '',
      });
    }
  });

  return panels;
}

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
