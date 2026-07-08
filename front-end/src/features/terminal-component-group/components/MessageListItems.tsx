/**
 * STATE MACHINE: MessageListItems
 *
 * Pure presentational map that renders one MessageBubble per filtered message.
 * Receives pre-computed metadata (step history, wait-for checks, plan char
 * count, stream count) from MessageList so this component stays focused on
 * render.
 */
import MessageBubble from './MessageBubble';
import type { Message } from '../hooks';
import type { ExploreStep, FeedbackData, WaitForCheck } from '../types';

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
  thinkingStreamTokenCount?: number;
  thinkingStreamStartedAtMs?: number;
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

export function MessageListItems({
  filteredMessages,
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
  thinkingStreamTokenCount,
  thinkingStreamStartedAtMs,
}: MessageListItemsProps) {
  return (
    <>
      {filteredMessages.map((message) => {
        const planCharCount = resolvePlanCharCount(message, streamingPlanCharCount);

        return (
          <div
            key={getMessageRenderKey(message)}
            data-message-id={message.message_id}
            data-message-role={message.role}
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
              planStreamStartedAtMs={
                planCharCount !== undefined ? streamingPlanStartedAtMs : undefined
              }
              thinkingStreamTokenCount={thinkingStreamTokenCount}
              thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
            />
          </div>
        );
      })}
    </>
  );
}
