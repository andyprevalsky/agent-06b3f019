/**
 * Explore-agent message (spawn_agent with agentType=explore). Renders
 * ExploreAgentBubble with grouped step history (passed in from MessageList).
 */
import { userFacingMessageText } from '@/lib/userFacingMessage';
import type { Message } from '../../hooks';
import type { ExploreStep } from '../../types';
import ExploreAgentBubble from '../ExploreAgentBubble';

interface ExploreBubbleProps {
  message: Message;
  exploreStepHistory?: ExploreStep[];
  thinkingStreamTokenCount?: number;
  thinkingStreamStartedAtMs?: number;
  onTypingComplete?: () => void;
}

export function ExploreBubble({
  message,
  exploreStepHistory,
  thinkingStreamTokenCount,
  thinkingStreamStartedAtMs,
  onTypingComplete,
}: ExploreBubbleProps) {
  const metadata = message.metadata;
  const toolStatus = (metadata?.toolStatus as string) || 'IN_PROGRESS';
  const visibleMessage = userFacingMessageText(message.text || '');
  const stepHistory: ExploreStep[] = (
    exploreStepHistory || [
      {
        title: (metadata?.title as string) || '',
        status: toolStatus,
        timestamp: message.timestamp,
        message: visibleMessage,
        toolName: (metadata?.toolName as string) || '',
      },
    ]
  ).map((step) => ({ ...step, message: userFacingMessageText(step.message || '') }));

  return (
    <ExploreAgentBubble
      title={(metadata?.title as string) || ''}
      fullGoal={(metadata?.fullGoal as string) || ''}
      message={visibleMessage}
      status={toolStatus as 'IN_PROGRESS' | 'FINISHED' | 'ERROR'}
      stepHistory={stepHistory}
      thinkingStreamTokenCount={thinkingStreamTokenCount}
      thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
      onTypingComplete={onTypingComplete}
    />
  );
}
