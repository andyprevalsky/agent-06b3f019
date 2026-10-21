/**
 * STATE MACHINE: MessageList
 *
 * MESSAGE ANIMATION QUEUE (see useMessageAnimationBuffer):
 * [IDLE] --> buffer pulls one message at a time --> [ANIMATING] --> [IDLE]
 * Any selected-agent transition clears the local queue before paint.
 *
 * MESSAGE FILTERING (see useFilteredMessages -> deduplicateToolMessages):
 * ├─ Filter by subAgentId (main chat vs sub-agent panels)
 * ├─ Filter out SYSTEM role messages
 * ├─ Filter out hidden messages (metadata.hidden === true)
 * ├─ Deduplicate tool messages by toolCallId
 * ├─ Group explore agent messages by taskId
 * └─ Group wait_for messages by toolCallId (preserve check history)
 *
 * THINKING DISPLAY (see useThinkingVisibility):
 * ├─ 800ms debounce before showing
 * ├─ Hide immediately when agent state becomes terminal, blocking, or tool-active
 * ├─ Assistant INSERT hides the indicator and resets persistence for the next turn
 * └─ Orange gradient when any streaming LLM bubble/tool has direct Claude/GPT token metadata
 *
 * AUTO-SCROLL (see useStreamingAutoScroll):
 * Sub-agent panels only; scrolls to bottom on new messages / streaming.
 *
 * SUB-AGENT TREE MERGING (see useSubAgentTreeMerge):
 * All spawn_sub_agent messages sharing a busId collapse to one.
 */

import { useMemo, useRef } from 'react';
import type { FeedbackData } from '../types';
import { useAgentContext, type Message } from '../hooks';
import { MessageListView } from './MessageListView';
import type { FilteredStreamingState } from './useMessageFiltering';
import { useMessageListState, type MessageAnimationState } from './useMessageList';

interface MessageListProps {
  /** Filter messages by subAgentId. undefined = main chat. */
  subAgentId?: string;
  /** Container className for layout customization. */
  containerClassName?: string;
  /** Show status banners (paused, completed, out of credits). */
  showStatusBanners?: boolean;
  /** Show thinking indicator. */
  showThinkingIndicator?: boolean;
  /** Compact mode removes left spacers for tighter layouts. */
  compact?: boolean;
  /** Callback when user clicks "Add Credits" on out-of-credits banner. */
  onAddCredits?: () => void;
  /** Callback when user clicks "Increase Cost Limit" on cost-limit banner. */
  onIncreaseCostLimit?: () => void;
  /** Callback when navigating to a sub-agent. */
  onNavigateToAgent?: (agentId: string) => void;
  /** Callback when user submits feedback. */
  onSubmitFeedback?: (feedback: FeedbackData) => Promise<void>;
}

interface ChatModeActionsVisibleParams {
  showStatusBanners: boolean;
  subAgentId: string | undefined;
  isChatMode: boolean;
  filteredMessages: Message[];
  streaming: FilteredStreamingState;
  animation: MessageAnimationState;
  agentStatus: string | undefined;
}

function computeChatModeActionsVisible({
  showStatusBanners,
  subAgentId,
  isChatMode,
  filteredMessages,
  streaming,
  animation,
  agentStatus,
}: ChatModeActionsVisibleParams): boolean {
  if (!showStatusBanners || subAgentId !== undefined || !isChatMode) return false;
  const last = filteredMessages[filteredMessages.length - 1];
  const isComplete =
    last?.role === 'TOOL' &&
    last.metadata?.toolStatus === 'FINISHED' &&
    last.metadata?.toolName === 'send_message_to_user';
  const notStreaming = streaming.bubbles.size === 0 && streaming.tools.size === 0;
  const notAnimating = !animation.isAnimating && animation.messageBufferLength === 0;
  return !!isComplete && notStreaming && notAnimating && agentStatus === 'ACTIVE';
}

export function MessageList({
  subAgentId,
  containerClassName = 'w-full min-w-0 max-w-4xl mx-auto flex flex-col gap-4 pb-32 relative z-20',
  showStatusBanners = true,
  showThinkingIndicator = true,
  compact = false,
  onAddCredits,
  onIncreaseCostLimit,
  onNavigateToAgent,
  onSubmitFeedback,
}: MessageListProps) {
  const ctx = useAgentContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);

  const state = useMessageListState({ ctx, subAgentId, showThinkingIndicator, scrollEndRef });
  const { filtered, filteredMessages, streaming, animation, animatedTokenCount, thinkingVisible } =
    state;

  const chatActionsVisible = useMemo(
    () =>
      computeChatModeActionsVisible({
        showStatusBanners,
        subAgentId,
        isChatMode: ctx.isChatMode,
        filteredMessages,
        streaming,
        animation,
        agentStatus: ctx.agent?.status,
      }),
    [
      showStatusBanners,
      subAgentId,
      ctx.isChatMode,
      ctx.agent?.status,
      filteredMessages,
      streaming,
      animation,
    ],
  );

  return (
    <MessageListView
      containerRef={containerRef}
      scrollEndRef={scrollEndRef}
      containerClassName={containerClassName}
      subAgentId={subAgentId}
      compact={compact}
      showStatusBanners={showStatusBanners}
      thinkingVisible={thinkingVisible}
      chatActionsVisible={chatActionsVisible}
      agent={ctx.agent}
      selectedAgentId={ctx.selectedAgentId}
      filteredMessages={filteredMessages}
      webSearchGrouping={state.webSearchGrouping}
      exploreStepMap={filtered.exploreStepMap}
      waitForCheckMap={filtered.waitForCheckMap}
      streaming={streaming}
      streamingBubbles={ctx.streamingBubbles}
      streamingTools={ctx.streamingTools}
      animation={animation}
      animatedTokenCount={animatedTokenCount}
      onAddCredits={onAddCredits}
      onIncreaseCostLimit={onIncreaseCostLimit}
      onNavigateToAgent={onNavigateToAgent}
      onSubmitFeedback={onSubmitFeedback}
      onSendMessage={state.handleSendMessage}
    />
  );
}

export default MessageList;
