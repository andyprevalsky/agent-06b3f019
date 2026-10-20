/**
 * STATE MACHINE: MessageListItems
 *
 * Pure presentational map that renders one MessageBubble per filtered message.
 * Receives pre-computed metadata (step history, wait-for checks, plan char
 * count, stream count) from MessageList so this component stays focused on
 * render. A keyed final-answer stream is replaced only by the canonical TOOL
 * message with the same toolCallId, so selectors expose both identities.
 * Tool name/status and cloud-agent start phase are exposed as inert data
 * attributes for end-to-end route verification.
 *
 * INLINE USER VIEW: a message whose metadata carries a valid `inlineView`
 * renders InlineUserView beneath its bubble (sandboxed frame pinned to the
 * message's own version; poster/summary when offscreen, over the live-frame
 * cap, or in safe mode).
 *
 * With a web-search grouping, a turn's searches render as one row at the first
 * search's position (WebSearchGroupItem); the other searches render nothing.
 */
import { InlineUserView, parseInlineViewMetadata } from '@/features/user-ui';

import MessageBubble from './MessageBubble';
import type { Message } from '../hooks';
import type { ExploreStep, FeedbackData, WaitForCheck } from '../types';
import {
  resolveSubAgentStreamingMetrics,
  type SubAgentStreamingMetrics,
} from './useMessageFiltering';
import { WebSearchGroupItem } from './WebSearchGroupItem';
import { EMPTY_WEB_SEARCH_GROUPING, type WebSearchTurnGrouping } from './webSearchTurnGroups';

interface MessageListItemsProps {
  filteredMessages: Message[];
  currentAnimatingId: string | null;
  onAnimationComplete: () => void;
  onNavigateToAgent?: (agentId: string) => void;
  selectedAgentId: string | null;
  onSendMessage?: (text: string) => void;
  compact?: boolean;
  onSubmitFeedback?: (feedback: FeedbackData) => Promise<void>;
  exploreStepMap: Map<string, ExploreStep[]>;
  waitForCheckMap: Map<string, WaitForCheck[]>;
  streamingPlanCharCount?: number;
  streamingPlanStartedAtMs?: number;
  streamingMetricsBySubAgentId: Map<string, SubAgentStreamingMetrics>;
  webSearchGrouping?: WebSearchTurnGrouping;
}

type MessageListItemProps = Omit<
  MessageListItemsProps,
  'filteredMessages' | 'webSearchGrouping'
> & {
  message: Message;
};

function resolveMessageThinkingMetrics(
  message: Message,
  streamingMetricsBySubAgentId: Map<string, SubAgentStreamingMetrics>,
): { thinkingStreamTokenCount?: number; thinkingStreamStartedAtMs?: number } {
  const taskId = message.metadata?.taskId;
  if (message.metadata?.agentType === 'explore' && typeof taskId === 'string') {
    const metrics = resolveSubAgentStreamingMetrics(taskId, streamingMetricsBySubAgentId);
    return {
      thinkingStreamTokenCount: Math.round(metrics.charCount / 4),
      thinkingStreamStartedAtMs: metrics.streamStartedAtMs,
    };
  }
  return {};
}

function resolvePlanCharCount(
  message: Message,
  streamingPlanCharCount: number | undefined,
): number | undefined {
  if (message.metadata?.toolName !== 'set_plan') return undefined;
  if (message.metadata?.toolStatus !== 'IN_PROGRESS') return undefined;
  return streamingPlanCharCount;
}

function getMessageRenderKey(message: Message): string {
  const toolName = message.metadata?.toolName;
  const toolCallId = message.metadata?.toolCallId;
  if (toolName === 'spawn_claude_code_agent' && typeof toolCallId === 'string' && toolCallId) {
    return `code-agent:${toolCallId}`;
  }
  return message.message_id;
}

function MessageListItem({
  message,
  currentAnimatingId,
  onAnimationComplete,
  onNavigateToAgent,
  selectedAgentId,
  onSendMessage,
  compact,
  onSubmitFeedback,
  exploreStepMap,
  waitForCheckMap,
  streamingPlanCharCount,
  streamingPlanStartedAtMs,
  streamingMetricsBySubAgentId,
}: MessageListItemProps) {
  const planCharCount = resolvePlanCharCount(message, streamingPlanCharCount);
  const thinkingMetrics = resolveMessageThinkingMetrics(message, streamingMetricsBySubAgentId);
  const isFinalAnswer = message.metadata?.isUserAttentionMessage === true;
  const toolCallId =
    typeof message.metadata?.toolCallId === 'string' ? message.metadata.toolCallId : undefined;
  const toolName =
    typeof message.metadata?.toolName === 'string' ? message.metadata.toolName : undefined;
  const toolStatus =
    typeof message.metadata?.toolStatus === 'string' ? message.metadata.toolStatus : undefined;
  const rawAgentStartPhase = message.metadata?.startPhase;
  const agentStartPhase =
    toolName === 'cloud_agent' &&
    (rawAgentStartPhase === 'plan' || rawAgentStartPhase === 'execute')
      ? rawAgentStartPhase
      : undefined;
  const inlineView = parseInlineViewMetadata(message.metadata?.inlineView);

  return (
    <div
      data-message-id={message.message_id}
      data-message-role={message.role}
      data-message-kind={isFinalAnswer ? 'final-answer' : undefined}
      data-message-state={isFinalAnswer ? 'canonical' : undefined}
      data-tool-call-id={toolCallId}
      data-tool-name={toolName}
      data-tool-status={toolStatus}
      data-agent-start-phase={agentStartPhase}
      className="min-w-0 max-w-full"
    >
      <MessageBubble
        message={message}
        shouldType={message.message_id === currentAnimatingId}
        onTypingComplete={onAnimationComplete}
        onNavigateToAgent={onNavigateToAgent}
        agentId={selectedAgentId || undefined}
        onSendMessage={selectedAgentId ? onSendMessage : undefined}
        compact={compact}
        onSubmitFeedback={onSubmitFeedback}
        exploreStepHistory={exploreStepMap.get(message.message_id)}
        waitForChecks={waitForCheckMap.get(message.message_id)}
        planCharCount={planCharCount}
        planStreamStartedAtMs={planCharCount !== undefined ? streamingPlanStartedAtMs : undefined}
        thinkingStreamTokenCount={thinkingMetrics.thinkingStreamTokenCount}
        thinkingStreamStartedAtMs={thinkingMetrics.thinkingStreamStartedAtMs}
        streamingMetricsBySubAgentId={streamingMetricsBySubAgentId}
      />
      {inlineView && <InlineUserView inlineView={inlineView} messageId={message.message_id} />}
    </div>
  );
}

export function MessageListItems({
  filteredMessages,
  webSearchGrouping = EMPTY_WEB_SEARCH_GROUPING,
  ...itemProps
}: MessageListItemsProps) {
  return (
    <>
      {filteredMessages.map((message) => {
        if (webSearchGrouping.hiddenMessageIds.has(message.message_id)) return null;
        const group = webSearchGrouping.groupsByLeadId.get(message.message_id);
        if (group) {
          return (
            <WebSearchGroupItem
              key={`web-search-group:${group.key}`}
              group={group}
              currentAnimatingId={itemProps.currentAnimatingId}
              onAnimationComplete={itemProps.onAnimationComplete}
              agentId={itemProps.selectedAgentId || undefined}
              compact={itemProps.compact}
            />
          );
        }
        return (
          <MessageListItem key={getMessageRenderKey(message)} message={message} {...itemProps} />
        );
      })}
    </>
  );
}
