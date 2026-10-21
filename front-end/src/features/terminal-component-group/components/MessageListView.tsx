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
 *   Live web_search chip in a turn that already searched --> folded into that
 *     turn's single search row (WebSearchGroupItem), not rendered at the tail
 *   Any task + web client --> preview banner --> open app | automatic download fallback
 *   Any task + Mac client ---------------------> no preview banner
 *   <=1 thinking stream --> one indicator; >1 streams --> one per stream
 *   Root view --> CodeAgentWaitStatus under the chips (Rose Desktop only; renders
 *     nothing when no code agent is live or asking)
 *
 * MOBILE ENTRY ANIMATION:
 * The container scope lets CSS disable only direct message root entry
 * animations on mobile while preserving nested chip/SVG/text animations and
 * non-message panel flashes.
 */
import type { AgentDetail, Message, StreamingBubble, StreamingTool } from '../hooks';
import { getClientSource } from '@/lib/clientSource';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { withLiveTrajectory } from './trajectoryLiveMessages';
import type { ExploreStep, FeedbackData, WaitForCheck } from '../types';
import {
  buildStreamingMetricsBySubAgentId,
  type FilteredStreamingState,
} from './useMessageFiltering';
import type { MessageAnimationState } from './useMessageList';
import { ChatModeActions } from './ChatModeActions';
import { CodeAgentWaitStatus } from './CodeAgentWaitStatus';
import { MessageListItems } from './MessageListItems';
import { StatusBanners, WebPreviewBanner } from './StatusBanners';
import { ThinkingIndicator } from './ThinkingIndicator';
import { StreamingTools, StreamingAttentionBubble } from './StreamingMessageItems';
import { shouldShowStreamingAttention } from './streamingAttentionVisibility';
import type { WebSearchTurnGrouping } from './webSearchTurnGroups';

const EMPTY_STREAMING_METRICS = { charCount: 0 };

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
  webSearchGrouping: WebSearchTurnGrouping;
  exploreStepMap: Map<string, ExploreStep[]>;
  waitForCheckMap: Map<string, WaitForCheck[]>;
  streaming: FilteredStreamingState;
  streamingBubbles: Map<string, StreamingBubble>;
  streamingTools: Map<string, StreamingTool>;
  animation: MessageAnimationState;
  animatedTokenCount: number;
  onAddCredits?: () => void;
  onIncreaseCostLimit?: () => void;
  onNavigateToAgent?: (agentId: string) => void;
  onSubmitFeedback?: (feedback: FeedbackData) => Promise<void>;
  onSendMessage: (text: string) => void | Promise<void>;
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
    const tokenCount = Math.round(Math.max(bubble.charCount ?? 0, bubble.text.length) / 4);
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

function thinkingTokenCount(
  metrics: ReturnType<typeof buildStreamingMetricsBySubAgentId>,
  subAgentId: string | undefined,
): number {
  return Math.round((metrics.get(subAgentId ?? '') ?? EMPTY_STREAMING_METRICS).charCount / 4);
}

/** Live tool chips for the list tail; web searches folded into a turn's row are left out. */
function tailTools(tools: Map<string, StreamingTool>, grouping: WebSearchTurnGrouping) {
  return [...tools.values()].filter(
    (tool) => !grouping.foldedStreamingToolCallIds.has(tool.tool_call_id),
  );
}

function TrajectoryItems({
  props,
  metrics,
  compressWork,
}: {
  props: MessageListViewProps;
  metrics: ReturnType<typeof buildStreamingMetricsBySubAgentId>;
  compressWork: boolean;
}) {
  const {
    agent,
    filteredMessages,
    webSearchGrouping,
    streaming,
    animation,
    selectedAgentId,
    onSendMessage,
    compact,
    onSubmitFeedback,
    onNavigateToAgent,
    exploreStepMap,
    waitForCheckMap,
    thinkingVisible,
    subAgentId,
    animatedTokenCount,
  } = props;
  const streamingMetricsBySubAgentId = metrics;
  return (
    <MessageListItems
      groupAgentMessages={subAgentId === undefined}
      compressWork={compressWork}
      workStatus={agent?.status}
      workEndedAt={agent?.updated_at}
      activityIndicator={
        thinkingVisible && (
          <ThinkingIndicators
            visible={thinkingVisible}
            compact
            streaming={streaming}
            streamingTokenCount={thinkingTokenCount(streamingMetricsBySubAgentId, subAgentId)}
            animatedTokenCount={animatedTokenCount}
          />
        )
      }
      filteredMessages={
        compressWork
          ? withLiveTrajectory(
              filteredMessages,
              tailTools(streaming.tools, webSearchGrouping),
              thinkingVisible,
              streaming.streamStartedAtMs,
              agent?.status,
            )
          : filteredMessages
      }
      webSearchGrouping={webSearchGrouping}
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
      streamingMetricsBySubAgentId={streamingMetricsBySubAgentId}
    />
  );
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
    webSearchGrouping,
    streaming,
    streamingBubbles,
    streamingTools,
    animatedTokenCount,
    onAddCredits,
    onIncreaseCostLimit,
    onSendMessage,
  } = props;

  const compressWork = useRoseDesktop() && subAgentId === undefined;
  const showMainBanners = showStatusBanners && subAgentId === undefined;
  const showAttention = shouldShowStreamingAttention(streaming.attention, subAgentId);
  const showWebPreview = showMainBanners && agent !== null && getClientSource() === 'WEB';
  const streamingMetricsBySubAgentId = buildStreamingMetricsBySubAgentId(
    streamingBubbles,
    streamingTools,
  );

  return (
    <div ref={containerRef} className={`${containerClassName} mobile-disable-message-entry-spawn`}>
      <TrajectoryItems
        props={props}
        metrics={streamingMetricsBySubAgentId}
        compressWork={compressWork}
      />
      {subAgentId === undefined && <CodeAgentWaitStatus />}
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
      {!compressWork && (
        <StreamingTools tools={tailTools(streaming.tools, webSearchGrouping)} compact={compact} />
      )}
      <ThinkingIndicators
        visible={thinkingVisible && !compressWork}
        compact={compact}
        streaming={streaming}
        streamingTokenCount={thinkingTokenCount(streamingMetricsBySubAgentId, subAgentId)}
        animatedTokenCount={animatedTokenCount}
      />
      <div ref={scrollEndRef} />
    </div>
  );
}
