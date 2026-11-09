/**
 * Hook that derives BrowserStatusBar view-model from AgentContext messages.
 *
 * Consolidates the memoized derivations that used to live inline inside
 * BrowserStatusBar.tsx so the component file stays under the 300-line cap.
 */

import { readPhoneTarget, readCriticalReason } from '@/lib/api/phoneAttention';
import { useMemo } from 'react';
import { BROWSER_INIT_ACTION_TYPES } from '@/lib/backendToolNames';
import { useAgentContext, type Message } from '../../hooks';
import type {
  BrowserSessionMetadata,
  PendingAuthAssistance,
  BrowserStatusBarViewModel,
  OutputSchemaRef,
  PendingWriteLockApproval,
  StepProgress,
} from './types';

interface RequestUserApprovalMeta {
  writePermission?: boolean;
  attentionRequestId?: string;
}

interface RequestUserAuthenticationMeta {
  requestId?: string;
  taskId?: string;
  authRealm?: string;
  liveViewUrl?: string;
  target?: unknown;
  criticalReason?: unknown;
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

function readRequestUserAuthentication(m: Message): RequestUserAuthenticationMeta | undefined {
  const meta = m.metadata;
  if (!meta) return undefined;
  const raw = meta.requestUserAuthentication;
  if (raw && typeof raw === 'object') {
    return raw as RequestUserAuthenticationMeta;
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

function extractBrowserSessionMetadata(browserMessages: Message[]): BrowserSessionMetadata | null {
  for (let i = browserMessages.length - 1; i >= 0; i--) {
    const raw = browserMessages[i].metadata?.browser_session_metadata;
    if (raw && typeof raw === 'object') {
      return raw as BrowserSessionMetadata;
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

function extractPendingAuthAssistance(
  messages: Message[],
  taskId: string,
): PendingAuthAssistance | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const auth = readRequestUserAuthentication(message);
    if (!auth) continue;

    const authTaskId = auth.taskId ?? message.metadata?.task_id;
    if (authTaskId !== taskId) continue;
    if (message.metadata?.toolStatus !== 'IN_PROGRESS') return null;
    const target = readPhoneTarget(auth.target);
    if (!auth.requestId || (!auth.liveViewUrl && !target)) return null;
    if (target && target.browserTaskId !== taskId) return null;

    return {
      requestId: auth.requestId,
      authRealm: auth.authRealm,
      request: auth.authRealm
        ? `Sign in to ${auth.authRealm} so I can continue`
        : 'Complete the sign-in so I can continue',
      liveViewUrl: target ? undefined : auth.liveViewUrl,
      target,
      criticalReason: readCriticalReason(auth.criticalReason),
    };
  }

  return null;
}

export function useBrowserStatusBarState(taskId: string): BrowserStatusBarViewModel {
  const { messages, inspectionContext, selectedAgentId, isLoadingAgent } = useAgentContext();

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

  const isDisconnected = useMemo(() => {
    const orderedMessages = browserMessages
      .map((message, index) => ({ message, index, timestamp: Date.parse(message.timestamp) }))
      .sort((left, right) => {
        const leftTimestamp = Number.isFinite(left.timestamp) ? left.timestamp : 0;
        const rightTimestamp = Number.isFinite(right.timestamp) ? right.timestamp : 0;
        return leftTimestamp - rightTimestamp || left.index - right.index;
      });
    for (let index = orderedMessages.length - 1; index >= 0; index -= 1) {
      const message = orderedMessages[index].message;
      if (message.metadata?.action_type === 'session_paused') return true;
      if (
        typeof message.metadata?.browser_url === 'string' &&
        BROWSER_INIT_ACTION_TYPES.has(message.metadata.action_type ?? '')
      ) {
        return false;
      }
    }
    return false;
  }, [browserMessages]);

  const outputSchema = useMemo<OutputSchemaRef | undefined>(() => {
    const initMessage = [...browserMessages].reverse().find((m) => m.metadata?.output_schema);
    const raw = initMessage?.metadata?.output_schema;
    if (raw && typeof raw === 'object') {
      return raw as OutputSchemaRef;
    }
    return undefined;
  }, [browserMessages]);

  const browserSessionMetadata = useMemo(
    () => extractBrowserSessionMetadata(browserMessages),
    [browserMessages],
  );
  const stepProgress = useMemo(() => extractStepProgress(browserMessages), [browserMessages]);
  const pendingWriteLockApproval = useMemo(() => extractPendingApproval(messages), [messages]);
  const pendingAuthAssistance = useMemo(
    () => extractPendingAuthAssistance(messages, taskId),
    [messages, taskId],
  );

  return {
    readOnly: inspectionContext != null || (selectedAgentId !== null && isLoadingAgent),
    browserMessages,
    lastActionType,
    lastActionTitle,
    isDisconnected,
    outputSchema,
    browserSessionMetadata,
    stepProgress,
    pendingWriteLockApproval,
    pendingAuthAssistance,
  };
}
