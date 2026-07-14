/**
 * STATE MACHINE: MessageListView render tail
 *
 * [TOOL ACTIVE] -> render tool last; thinking hidden
 * [FINAL ANSWER STREAM] -> render attention independently of thinking state
 * [NO TOOL + THINKING] -> render banners, then thinking last
 * [IDLE] -> render persisted content only
 *
 * Presentational shell for MessageList. Receives all state/derived values
 * as props; performs no hook calls of its own. Extracted to keep the
 * MessageList top-level function body below the 80-line strict limit.
 *
 * STATE MACHINE:
 *   Any task + web client --> preview banner --> open app | automatic download fallback
 *   Any task + Mac client ---------------------> no preview banner
 *   <=1 thinking stream --> one indicator; >1 streams --> one per stream
 *
 * MOBILE ENTRY ANIMATION:
 * The container scope lets CSS disable only direct message root entry
 * animations on mobile while preserving nested chip/SVG/text animations and
 * non-message panel flashes.
 */
import type { AgentDetail, Message } from '../hooks';
import { getClientSource } from '@/lib/clientSource';
import type { ExploreStep, FeedbackData, WaitForCheck } from '../types';
import type { FilteredStreamingState } from './useMessageFiltering';
import type { MessageAnimationState } from './useMessageList';
import { ChatModeActions } from './ChatModeActions';
import { MessageListItems } from './MessageListItems';
import { StatusBanners, WebPreviewBanner } from './StatusBanners';
import { ThinkingIndicator } from './ThinkingIndicator';
import { StreamingTools, StreamingAttentionBubble } from './StreamingMessageItems';
import { shouldShowStreamingAttention } from './streamingAttentionVisibility';

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
  animatedTokenCount: number;
  onAddCredits?: () => void;
  onIncreaseCostLimit?: () => void;
  onNavigateToAgent?: (agentId: string) => void;
  onSubmitFeedback?: (feedback: FeedbackData) => Promise<void>;
  onSendMessage: (text: string) => void;
}

interface ThinkingIndicatorsProps {
  visible: boolean;
  compact: boolean;
  streaming: FilteredStreamingState;
  streamingTokenCount: number;
  animatedTokenCount: number;
}

function ThinkingIndicators({
  visible,
  compact,
  streaming,
  streamingTokenCount,
  animatedTokenCount,
}: ThinkingIndicatorsProps) {
  if (!visible) return null;
  const bubbles = [...streaming.bubbles.entries()].sort(([, a], [, b]) => {
    return (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0);
  });
  if (bubbles.length <= 1) {
    const singleBubble = bubbles[0]?.[1];
    return (
      <ThinkingIndicator
        compact={compact}
        isClaudeStreaming={
          singleBubble
            ? singleBubble.isClaude === true || singleBubble.isGpt === true
            : streaming.isClaude || streaming.isGpt
        }
        streamStartedAtMs={singleBubble ? singleBubble.startedAtMs : streaming.streamStartedAtMs}
        streamingTokenCount={streamingTokenCount}
        animatedTokenCount={animatedTokenCount}
      />
    );
  }
  return bubbles.map(([streamId, bubble]) => {
    const tokenCount = Math.round(bubble.text.length / 4);
    return (
      <ThinkingIndicator
        key={`thinking-${streamId}`}
        compact={compact}
        isClaudeStreaming={bubble.isClaude === true || bubble.isGpt === true}
        streamStartedAtMs={bubble.startedAtMs}
        streamingTokenCount={tokenCount}
        animatedTokenCount={tokenCount}
      />
    );
  });
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
    animatedTokenCount,
    onAddCredits,
    onIncreaseCostLimit,
    onNavigateToAgent,
    onSubmitFeedback,
    onSendMessage,
  } = props;

  const showMainBanners = showStatusBanners && subAgentId === undefined;
  const showAttention = shouldShowStreamingAttention(streaming.attention, subAgentId);
  const showWebPreview = showMainBanners && agent !== null && getClientSource() === 'WEB';
  const thinkingStreamTokenCount = Math.round(streaming.charCount / 4);

  return (
    <div ref={containerRef} className={`${containerClassName} mobile-disable-message-entry-spawn`}>
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
        streamingPlanStartedAtMs={streaming.plan?.startedAtMs}
        thinkingStreamTokenCount={thinkingStreamTokenCount}
        thinkingStreamStartedAtMs={streaming.streamStartedAtMs}
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
      {showAttention && streaming.attention && (
        <StreamingAttentionBubble attention={streaming.attention} onSendMessage={onSendMessage} />
      )}
      {showWebPreview && agent !== null && <WebPreviewBanner agentId={agent.agent_id} />}
      <StreamingTools tools={[...streaming.tools.values()]} compact={compact} />
      <ThinkingIndicators
        visible={thinkingVisible}
        compact={compact}
        streaming={streaming}
        streamingTokenCount={thinkingStreamTokenCount}
        animatedTokenCount={animatedTokenCount}
      />
      <div ref={scrollEndRef} />
    </div>
  );
}
