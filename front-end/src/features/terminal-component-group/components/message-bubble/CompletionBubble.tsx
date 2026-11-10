/**
 * Final-summary tool message → CompletionSummaryCard + optional FeedbackBanner.
 *
 * Calls onTypingComplete immediately since the card doesn't animate text.
 */
import { cn } from '@/lib/utils';
import type { Message } from '../../hooks';
import type { CompletionSummaryData, FeedbackData } from '../../types';
import { CompletionSummaryCard } from '../CompletionSummaryCard';
import { FeedbackBanner } from '../FeedbackBanner';

interface CompletionBubbleProps {
  message: Message;
  shouldType?: boolean;
  compact?: boolean;
  onTypingComplete?: () => void;
  onSubmitFeedback?: (feedback: FeedbackData) => Promise<void>;
}

export function CompletionBubble({
  message,
  shouldType,
  compact = false,
  onTypingComplete,
  onSubmitFeedback,
}: CompletionBubbleProps) {
  if (shouldType && onTypingComplete) {
    requestAnimationFrame(() => onTypingComplete());
  }
  const completionData = message.metadata?.completionSummary as CompletionSummaryData | undefined;
  if (!completionData) return null;
  if (
    !completionData.error &&
    completionData.presentation?.version === 1 &&
    completionData.presentation.mode === 'value' &&
    typeof completionData.answerText === 'string'
  ) {
    return (
      <div className="space-y-3">
        <div className="whitespace-pre-wrap break-words" data-final-answer>
          {completionData.answerText}
        </div>
        {onSubmitFeedback && <FeedbackBanner onSubmit={onSubmitFeedback} />}
      </div>
    );
  }

  return (
    <div className={cn('flex', !compact && 'gap-3', 'animate-in fade-in duration-300')}>
      <div className="flex-1 min-w-0 space-y-3">
        <CompletionSummaryCard data={completionData} />
        {onSubmitFeedback && <FeedbackBanner onSubmit={onSubmitFeedback} />}
      </div>
    </div>
  );
}
