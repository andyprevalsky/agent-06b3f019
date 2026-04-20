/**
 * STATE MACHINE: MessageListItems
 *
 * Pure presentational map that renders one MessageBubble per filtered message.
 * Receives pre-computed metadata (step history, wait-for checks, plan char
 * count) from MessageList so this component stays focused on render.
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
}

function resolvePlanCharCount(
  message: Message,
  streamingPlanCharCount: number | undefined,
): number | undefined {
  if (message.metadata?.toolName !== 'set_plan') return undefined;
  if (message.metadata?.toolStatus !== 'IN_PROGRESS') return undefined;
  return streamingPlanCharCount;
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
}: MessageListItemsProps) {
  return (
    <>
      {filteredMessages.map((message) => (
        <div
          key={message.message_id}
          data-message-id={message.message_id}
          data-message-role={message.role}
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
            planCharCount={resolvePlanCharCount(message, streamingPlanCharCount)}
          />
        </div>
      ))}
    </>
  );
}
