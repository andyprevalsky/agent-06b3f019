/**
 * Generic tool card.
 *
 * Composition:
 *   ToolMessageHeader    -> icon + title + chevron
 *   progress bar         -> optional, shown when progressComplete + IN_PROGRESS
 *   countdown / simulated -> attention-request auto-answer UX
 *   SendIMessageAction   -> when actionMetadata targets sendSmsThroughIMessage
 *   expanded body        -> MarkdownText when hasMessage && shouldBeExpanded
 *
 * Expand/collapse + progress handled by useToolMessageState.
 * Countdown handled by useCountdown.
 */
import { memo } from 'react';
import { MarkdownText } from '../MarkdownText';
import type { ToolMessageData } from './types';
import { useCountdown } from './useCountdown';
import { useToolMessageState } from './useToolMessageState';
import { ToolMessageHeader } from './ToolMessageHeader';
import { SendIMessageAction } from './SendIMessageAction';

interface ToolMessageProps {
  data: ToolMessageData;
  shouldType?: boolean;
  onComplete?: () => void;
}

export const ToolMessage = memo(function ToolMessage({
  data,
  shouldType = false,
  onComplete,
}: ToolMessageProps) {
  const state = useToolMessageState(data, shouldType, onComplete);
  const countdownSeconds = useCountdown({
    status: data.status,
    timeout: data.timeout,
    startTime: data.startTime,
  });
  const showIMessageAction =
    data.actionMetadata &&
    (data.actionMetadata as { onSuccess?: string }).onSuccess === 'sendSmsThroughIMessage';

  return (
    <div className="flex flex-col gap-1">
      <ToolMessageHeader
        data={data}
        titleText={state.titleText}
        isThought={state.isThought}
        hasMessage={state.hasMessage}
        isExpandable={state.isExpandable}
        showChevron={state.showChevron}
        shouldBeExpanded={state.shouldBeExpanded}
        onToggle={state.toggle}
      />

      {state.showProgressBar && state.progressPercent !== undefined && (
        <div className="w-[180px] h-[4px] bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, state.progressPercent))}%` }}
          />
        </div>
      )}

      {countdownSeconds !== null && countdownSeconds > 0 && data.status === 'IN_PROGRESS' && (
        <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
          Auto-answering in {countdownSeconds}s
        </span>
      )}

      {data.simulated && data.status === 'FINISHED' && (
        <span className="text-xs text-amber-600 dark:text-amber-400">(Auto-answered)</span>
      )}

      {showIMessageAction && data.actionMetadata && (
        <SendIMessageAction actionMetadata={data.actionMetadata} />
      )}

      {state.hasMessage && state.shouldBeExpanded && (
        <div className="overflow-hidden transition-all duration-200">
          <div className="pr-2 pl-4 border-l-2 border-border max-h-[300px] overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
            <MarkdownText
              text={data.message}
              shouldAnimate={false}
              className="text-sm text-muted-foreground"
            />
          </div>
        </div>
      )}
    </div>
  );
});
