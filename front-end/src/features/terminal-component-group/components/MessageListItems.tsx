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
 *
 * ROSE DESKTOP (flag on; stock rendering otherwise):
 *   send_message_to_user from a code agent (requestingAgent) → "<agent> · via
 *     send_message_to_user" above it; its inlineView {view, versionId} renders as above
 *   display media rows (ASSISTANT + file_pointer + display.kind 'media') → consecutive
 *     rows of one requester form ONE DisplayMediaGroup at the first row (gallery +
 *     sandboxed HTML frames); the other rows render nothing
 *   pinned question (display.placement 'pinned') → not inline; PinnedQuestionMount shows it
 *   metadata.a2a (USER or TOOL agent_message row) → AgentToAgentRow, never a user bubble
 */
import { useEffect, type ReactNode } from 'react';
import { InlineUserView, parseInlineViewMetadata } from '@/features/user-ui';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';

import MessageBubble from './MessageBubble';
import type { Message } from '../hooks';
import type { ExploreStep, FeedbackData, WaitForCheck } from '../types';
import {
  resolveSubAgentStreamingMetrics,
  type SubAgentStreamingMetrics,
} from './useMessageFiltering';
import { WebSearchGroupItem } from './WebSearchGroupItem';
import {
  isSendMessageToUserRow,
  messageRequester,
  parseAgentToAgentMessage,
  type AgentToAgentMessage,
  parsePinnedQuestion,
} from '../hooks/codeAgentContract';
import { AgentToAgentRow } from './AgentToAgentRow';
import { CodeAgentAttribution } from './CodeAgentAttribution';
import { EMPTY_WEB_SEARCH_GROUPING, type WebSearchTurnGrouping } from './webSearchTurnGroups';

import { DisplayMediaListItem } from './rose-apps/AgentDisplayMessage';

import type { useAgentExchangeGroups } from './useAgentExchangeGroups';
import { AgentExchangeGroup } from './AgentExchangeGroup';
import { TrajectoryWorkGroup } from './TrajectoryWorkGroup';
import { useMessageListProjection } from './useMessageListProjection';

interface MessageListItemsProps {
  /** GP lists opt in; native sessions can supply one projection across chunks. */
  groupAgentMessages?: boolean;
  compressWork?: boolean;
  workStatus?: string;
  workEndedAt?: string;
  activityIndicator?: ReactNode;
  agentExchangeProjection?: ReturnType<typeof useAgentExchangeGroups> & { viewerId?: string };
  filteredMessages: Message[];
  streamingMessageIds?: ReadonlySet<string>;
  currentAnimatingId: string | null;
  onAnimationComplete: () => void;
  onNavigateToAgent?: (agentId: string) => void;
  selectedAgentId: string | null;
  onSendMessage?: (text: string) => void | Promise<void>;
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
  'filteredMessages' | 'webSearchGrouping' | 'groupAgentMessages'
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

/** Agent-to-agent row in the trajectory; completes the typing chain like other bubbles. */
function AgentToAgentListItem({
  message,
  a2a,
  shouldType,
  onTypingComplete,
}: {
  message: Message;
  a2a: AgentToAgentMessage;
  shouldType: boolean;
  onTypingComplete: () => void;
}) {
  useEffect(() => {
    if (shouldType) onTypingComplete();
  }, [shouldType, onTypingComplete]);
  return (
    <div
      data-message-id={message.message_id}
      data-message-role={message.role}
      data-message-kind="agent-to-agent"
      className="min-w-0 max-w-full"
    >
      <AgentToAgentRow a2a={a2a} />
    </div>
  );
}

/** Stock message row (plus the Rose Desktop code-agent attribution). */
function StockMessageListItem({
  roseDesktop,
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
  streamingMessageIds,
}: MessageListItemProps & { roseDesktop: boolean }) {
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
  const requester = roseDesktop ? messageRequester(message.metadata) : null;
  const attribution =
    requester?.kind === 'code_agent' && isSendMessageToUserRow(message.metadata) ? requester : null;

  return (
    <div
      data-message-id={message.message_id}
      data-message-role={message.role}
      data-message-kind={isFinalAnswer ? 'final-answer' : undefined}
      data-message-state={
        streamingMessageIds?.has(message.message_id)
          ? 'streaming'
          : isFinalAnswer
            ? 'canonical'
            : undefined
      }
      data-tool-call-id={toolCallId}
      data-tool-name={toolName}
      data-tool-status={toolStatus}
      data-agent-start-phase={agentStartPhase}
      className="min-w-0 max-w-full"
    >
      {attribution && <CodeAgentAttribution requester={attribution} />}
      <MessageBubble
        message={message}
        isStreaming={streamingMessageIds?.has(message.message_id) === true}
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

/**
 * Rose Desktop routes a pinned question (shown above the query box instead) and
 * agent-to-agent rows away from the stock bubble; everything else is stock.
 */
function MessageListItem(props: MessageListItemProps) {
  const roseDesktop = useRoseDesktop();
  const { message } = props;
  if (roseDesktop && parsePinnedQuestion(message.metadata)) return null;
  const a2a = roseDesktop ? parseAgentToAgentMessage(message) : null;
  if (a2a) {
    return (
      <AgentToAgentListItem
        message={message}
        a2a={
          props.compressWork
            ? {
                ...a2a,
                direction:
                  a2a.from.id === props.selectedAgentId
                    ? 'sent'
                    : a2a.to.id === props.selectedAgentId
                      ? 'received'
                      : undefined,
              }
            : a2a
        }
        shouldType={message.message_id === props.currentAnimatingId}
        onTypingComplete={props.onAnimationComplete}
      />
    );
  }
  return <StockMessageListItem {...props} roseDesktop={roseDesktop} />;
}

export function MessageListItems({
  filteredMessages,
  webSearchGrouping = EMPTY_WEB_SEARCH_GROUPING,
  agentExchangeProjection,
  ...itemProps
}: MessageListItemsProps) {
  const { visibleMessages, openDisplay, displayGrouping, localExchanges, workGroups } =
    useMessageListProjection({
      ...itemProps,
      filteredMessages,
      groupAgentMessages: itemProps.groupAgentMessages ?? false,
      compressWork: itemProps.compressWork ?? false,
    });
  const { groups: exchangeGroups, now } = agentExchangeProjection ?? localExchanges;
  return visibleMessages.map((message) => {
    const workGroup = workGroups.groupsByLeadId.get(message.message_id);
    if (workGroup)
      return (
        <TrajectoryWorkGroup
          key={workGroup.key}
          group={workGroup}
          indicator={itemProps.activityIndicator}
          renderMessage={(row) => (
            <MessageListItem message={row} {...itemProps} currentAnimatingId={null} />
          )}
        />
      );
    if (workGroups.foldedIds.has(message.message_id)) return null;
    const exchangeGroup = exchangeGroups.groupsByLeadId.get(message.message_id);
    if (exchangeGroup)
      return (
        <AgentExchangeGroup
          key={exchangeGroup.key}
          group={exchangeGroup}
          viewerId={agentExchangeProjection?.viewerId ?? itemProps.selectedAgentId}
          now={now}
        />
      );
    if (exchangeGroups.foldedIds.has(message.message_id)) return null;
    if (webSearchGrouping.hiddenMessageIds.has(message.message_id)) return null;
    if (displayGrouping.hiddenMessageIds.has(message.message_id)) return null;
    const displayItems = displayGrouping.groupsByLeadId.get(message.message_id);
    if (displayItems) {
      return (
        <DisplayMediaListItem
          key={message.message_id}
          message={message}
          items={displayItems}
          onOpen={openDisplay ? () => openDisplay(message) : undefined}
          agentId={itemProps.selectedAgentId || undefined}
          shouldType={message.message_id === itemProps.currentAnimatingId}
          onTypingComplete={itemProps.onAnimationComplete}
        />
      );
    }
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
    return <MessageListItem key={getMessageRenderKey(message)} message={message} {...itemProps} />;
  });
}
