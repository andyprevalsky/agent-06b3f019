/**
 * Presentational shell for MessageList. Receives all state/derived values
 * as props; performs no hook calls of its own. Extracted to keep the
 * MessageList top-level function body below the 80-line strict limit.
 */
import type { AgentDetail, Message } from '../hooks';
import type { ExploreStep, FeedbackData, WaitForCheck } from '../types';
import type { FilteredStreamingState } from './useMessageFiltering';
import type { MessageAnimationState } from './useMessageList';
import { ChatModeActions } from './ChatModeActions';
import { MessageListItems } from './MessageListItems';
import { StatusBanners, WebPreviewBanner } from './StatusBanners';
import { ThinkingIndicator } from './ThinkingIndicator';
import { StreamingTools, StreamingAttentionBubble } from './StreamingMessageItems';

export interface MessageListViewProps {
  containerRef: React.RefObject<HTMLDivElement>;
  scrollEndRef: React.RefObject<HTMLDivElement>;
  containerClassName: string;
  subAgentId: string | undefined;
  compact: boolean;
  showStatusBanners: boolean;
  thinkingVisible: boolean;
  chatActionsVisible: boolean;
  agent: AgentDetail | null;
  selectedAgentId: string | null;
  filteredMessages: Message[];
  exploreStepMap: Map<string, ExploreStep[]>;
  waitForCheckMap: Map<string, WaitForCheck[]>;
  streaming: FilteredStreamingState;
  animation: MessageAnimationState;
  animatedCharCount: number;
  onAddCredits?: () => void;
  onIncreaseCostLimit?: () => void;
  onNavigateToAgent?: (agentId: string) => void;
  onSubmitFeedback?: (feedback: FeedbackData) => Promise<void>;
  onSendMessage: (text: string) => void;
}

export function MessageListView(props: MessageListViewProps) {
  const {
    containerRef,
    scrollEndRef,
    containerClassName,
    subAgentId,
    compact,
    showStatusBanners,
    thinkingVisible,
    chatActionsVisible,
    agent,
    selectedAgentId,
    filteredMessages,
    exploreStepMap,
    waitForCheckMap,
    streaming,
    animation,
    animatedCharCount,
    onAddCredits,
    onIncreaseCostLimit,
    onNavigateToAgent,
    onSubmitFeedback,
    onSendMessage,
  } = props;

  const showMainBanners = showStatusBanners && subAgentId === undefined;
  const showAttention =
    streaming.attention !== null && subAgentId === undefined && streaming.bubbles.size > 0;
  const showWebPreview = showMainBanners && agent?.source === 'WEB';

  return (
    <div ref={containerRef} className={containerClassName}>
      <MessageListItems
        filteredMessages={filteredMessages}
        currentAnimatingId={animation.currentAnimatingId}
        onAnimationComplete={animation.handleAnimationComplete}
        onNavigateToAgent={onNavigateToAgent}
        selectedAgentId={selectedAgentId}
        onSendMessage={onSendMessage}
        compact={compact}
        onSubmitFeedback={onSubmitFeedback}
        exploreStepMap={exploreStepMap}
        waitForCheckMap={waitForCheckMap}
        streamingPlanCharCount={streaming.plan?.char_count}
      />
      {chatActionsVisible && (
        <ChatModeActions filteredMessages={filteredMessages} selectedAgentId={selectedAgentId} />
      )}
      {showMainBanners && (
        <StatusBanners
          agent={agent}
          onAddCredits={onAddCredits}
          onIncreaseCostLimit={onIncreaseCostLimit}
        />
      )}
      {thinkingVisible && (
        <ThinkingIndicator
          compact={compact}
          isClaudeStreaming={streaming.isClaude || streaming.isGpt}
          streamingCharCount={streaming.charCount}
          animatedCharCount={animatedCharCount}
        />
      )}
      <StreamingTools tools={[...streaming.tools.values()]} compact={compact} />
      {showAttention && streaming.attention && (
        <StreamingAttentionBubble attention={streaming.attention} onSendMessage={onSendMessage} />
      )}
      {showWebPreview && <WebPreviewBanner />}
      <div ref={scrollEndRef} />
    </div>
  );
}
