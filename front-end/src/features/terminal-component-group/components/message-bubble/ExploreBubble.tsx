/**
 * Explore-agent message (spawn_agent with agentType=explore). Renders
 * ExploreAgentBubble with grouped step history (passed in from MessageList).
 */
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
  const stepHistory: ExploreStep[] = exploreStepHistory || [
    {
      title: (metadata?.title as string) || '',
      status: toolStatus,
      timestamp: message.timestamp,
      message: message.text || '',
      toolName: (metadata?.toolName as string) || '',
    },
  ];

  return (
    <ExploreAgentBubble
      title={(metadata?.title as string) || ''}
      fullGoal={(metadata?.fullGoal as string) || ''}
      message={message.text || ''}
      status={toolStatus as 'IN_PROGRESS' | 'FINISHED' | 'ERROR'}
      stepHistory={stepHistory}
      thinkingStreamTokenCount={thinkingStreamTokenCount}
      thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
      onTypingComplete={onTypingComplete}
    />
  );
}
