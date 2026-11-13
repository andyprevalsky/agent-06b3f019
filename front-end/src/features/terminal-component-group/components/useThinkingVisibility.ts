/**
 * STATE MACHINE: thinking visibility
 *
 * [HIDDEN] -- active agent + no plan/tool/blocker for 800ms --> [VISIBLE]
 * [VISIBLE] -- persisted or ephemeral tool starts -----------> [HIDDEN]
 * [VISIBLE] -- plan/blocker/terminal state/assistant arrives -> [HIDDEN]
 * [HIDDEN] -- chat mode, last persisted ASSISTANT, no stream -> stay [HIDDEN]
 *             (hung start_superintelligence: reasoning saved, no Cloud Agent chip)
 * [HIDDEN] -- root stream starts alongside background child -> [VISIBLE]
 *             (child progress does not own the root's model call)
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { AgentDetail, Message } from '../hooks';
import { isBackgroundSpawnRow } from '../hooks/backgroundSpawnRows';

interface UseThinkingVisibilityOptions {
  showThinkingIndicator: boolean;
  agent: AgentDetail | null;
  filteredMessages: Message[];
  isChatMode: boolean;
  hasLiveThinkingStream: boolean;
  hasStreamingPlan: boolean;
  hasStreamingTools: boolean;
  selectedAgentId: string | null;
  assistantInsertedRef: MutableRefObject<boolean>;
}

function isLastAttentionBlocking(last: Message | undefined, isChatMode: boolean): boolean {
  if (!last?.metadata?.isUserAttentionMessage) return false;
  if (isChatMode) return true;
  const isQuestion = (last.metadata?.sendMessageToUser as { isQuestion?: boolean } | undefined)
    ?.isQuestion;
  const toolApproval = (
    last.metadata?.requestUserApproval as { toolApproval?: boolean } | undefined
  )?.toolApproval;
  return isQuestion === true || toolApproval === true;
}

function computeShouldShow(opts: UseThinkingVisibilityOptions): boolean {
  const {
    showThinkingIndicator,
    agent,
    filteredMessages,
    isChatMode,
    hasLiveThinkingStream,
    hasStreamingPlan,
    hasStreamingTools,
  } = opts;
  if (!showThinkingIndicator) return false;

  const isAgentActive =
    agent &&
    agent.status !== 'PAUSED' &&
    agent.status !== 'COMPLETED' &&
    agent.status !== 'FAILED' &&
    agent.status !== 'OUT_OF_CREDITS' &&
    agent.status !== 'COST_LIMIT_REACHED';
  if (!isAgentActive) return false;

  const last = filteredMessages[filteredMessages.length - 1];
  if (isLastAttentionBlocking(last, isChatMode)) return false;

  const hasInProgressTool = filteredMessages.some(
    (m) =>
      m.role === 'TOOL' &&
      m.metadata?.toolStatus === 'IN_PROGRESS' &&
      !m.metadata?.isUserAttentionMessage &&
      !(hasLiveThinkingStream && isBackgroundSpawnRow(m)),
  );
  if (hasInProgressTool || hasStreamingPlan || hasStreamingTools) return false;

  if (hasLiveThinkingStream) return true;

  // Chat escalation persists the router ASSISTANT before the Cloud Agent chip.
  // If that persist is the last durable row and nothing is streaming, the
  // handler is not making progress — keep Thinking hidden instead of shimmering
  // forever on ACTIVE + null workflow.
  if (isChatMode && last?.role === 'ASSISTANT') return false;

  return true;
}

export function useThinkingVisibility(opts: UseThinkingVisibilityOptions): boolean {
  const { selectedAgentId, assistantInsertedRef } = opts;
  const [thinkingVisible, setThinkingVisible] = useState(false);
  const prevAgentIdRef = useRef<string | null>(selectedAgentId);
  const showDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shouldShow = computeShouldShow(opts);
  const shouldDismissPersistedThinking =
    opts.hasStreamingPlan || opts.agent?.status === 'COMPLETED';

  useEffect(() => {
    if (showDebounceRef.current) {
      clearTimeout(showDebounceRef.current);
      showDebounceRef.current = null;
    }

    if (prevAgentIdRef.current !== selectedAgentId) {
      prevAgentIdRef.current = selectedAgentId;
      setThinkingVisible(shouldShow);
      assistantInsertedRef.current = false;
      return;
    }

    if (shouldDismissPersistedThinking) {
      setThinkingVisible(false);
      return;
    }

    if (assistantInsertedRef.current) {
      setThinkingVisible(false);
      assistantInsertedRef.current = false;
      return;
    }

    if (!shouldShow && thinkingVisible) {
      setThinkingVisible(false);
      return;
    }

    if (shouldShow && !thinkingVisible) {
      showDebounceRef.current = setTimeout(() => setThinkingVisible(true), 800);
    }

    return () => {
      if (showDebounceRef.current) {
        clearTimeout(showDebounceRef.current);
        showDebounceRef.current = null;
      }
    };
  }, [
    shouldShow,
    shouldDismissPersistedThinking,
    selectedAgentId,
    assistantInsertedRef,
    thinkingVisible,
  ]);

  return thinkingVisible;
}
