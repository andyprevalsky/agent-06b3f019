/**
 * Hook that derives BrowserStatusBar view-model from AgentContext messages.
 *
 * Consolidates the memoized derivations that used to live inline inside
 * BrowserStatusBar.tsx so the component file stays under the 300-line cap.
 */

import { useMemo } from 'react';
import { useAgentContext, type Message } from '../../hooks';
import type {
  BrowserStatusBarViewModel,
  OutputSchemaRef,
  PendingWriteLockApproval,
  StepProgress,
} from './types';

interface RequestUserApprovalMeta {
  writePermission?: boolean;
  attentionRequestId?: string;
}

function readRequestUserApproval(m: Message): RequestUserApprovalMeta | undefined {
  const meta = m.metadata;
  if (!meta) return undefined;
  const raw = meta.requestUserApproval;
  if (raw && typeof raw === 'object') {
    return raw as RequestUserApprovalMeta;
  }
  return undefined;
}

function extractStepProgress(browserMessages: Message[]): StepProgress | null {
  for (let i = browserMessages.length - 1; i >= 0; i--) {
    const msg = browserMessages[i];
    const stepsTaken = msg.metadata?.steps_taken;
    const totalSteps = msg.metadata?.total_steps;
    if (typeof stepsTaken === 'number' && typeof totalSteps === 'number') {
      return { stepsTaken, totalSteps };
    }
  }
  return null;
}

function extractPendingApproval(messages: Message[]): PendingWriteLockApproval | null {
  const approvalMessage = messages.find((m) => {
    if (m.metadata?.toolStatus !== 'IN_PROGRESS') return false;
    const approval = readRequestUserApproval(m);
    return approval?.writePermission === true && typeof approval.attentionRequestId === 'string';
  });
  if (!approvalMessage) return null;

  const attentionRequestId = readRequestUserApproval(approvalMessage)?.attentionRequestId;
  if (!attentionRequestId) return null;

  const hasFinishedMessage = messages.some((m) => {
    if (m.metadata?.toolStatus !== 'FINISHED') return false;
    return readRequestUserApproval(m)?.attentionRequestId === attentionRequestId;
  });
  if (hasFinishedMessage) return null;

  return {
    attentionRequestId,
    question: approvalMessage.text || 'Approve this write action?',
  };
}

export function useBrowserStatusBarState(taskId: string): BrowserStatusBarViewModel {
  const { messages } = useAgentContext();

  const browserMessages = useMemo(
    () => messages.filter((m) => m.metadata?.task_id === taskId),
    [messages, taskId],
  );

  const lastMessage = browserMessages[browserMessages.length - 1];
  const lastActionType =
    typeof lastMessage?.metadata?.action_type === 'string'
      ? lastMessage.metadata.action_type
      : undefined;
  const lastActionTitle =
    typeof lastMessage?.metadata?.title === 'string'
      ? lastMessage.metadata.title
      : 'Browser session active';

  const isDisconnected = useMemo(
    () => browserMessages.some((m) => m.metadata?.action_type === 'session_paused'),
    [browserMessages],
  );

  const outputSchema = useMemo<OutputSchemaRef | undefined>(() => {
    const initMessage = browserMessages.find((m) => m.metadata?.output_schema);
    const raw = initMessage?.metadata?.output_schema;
    if (raw && typeof raw === 'object') {
      return raw as OutputSchemaRef;
    }
    return undefined;
  }, [browserMessages]);

  const stepProgress = useMemo(() => extractStepProgress(browserMessages), [browserMessages]);
  const pendingWriteLockApproval = useMemo(() => extractPendingApproval(messages), [messages]);

  return {
    browserMessages,
    lastActionType,
    lastActionTitle,
    isDisconnected,
    outputSchema,
    stepProgress,
    pendingWriteLockApproval,
  };
}
