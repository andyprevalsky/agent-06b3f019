/**
 * STATE MACHINE: ToolMessage
 *
 * [COLLAPSED]
 *   - header is always visible
 *   - progress/countdown/simulated/action rows render from tool status metadata
 *   - if expandable header is clicked -> [EXPANDED]
 *
 * [EXPANDED]
 *   - body renders MarkdownText when hasMessage && shouldBeExpanded
 *   - content is vertically scrollable, horizontally constrained, and wraps
 *     long unbroken tool output such as URLs and serialized action summaries
 *   - header click -> [COLLAPSED]
 *
 * Derived state lives in useToolMessageState. Countdown lives in useCountdown.
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
    <div className="flex min-w-0 max-w-full flex-col gap-1">
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
        <div className="min-w-0 max-w-full overflow-hidden transition-all duration-200">
          <div className="min-w-0 max-w-full pr-2 pl-4 border-l-2 border-border max-h-[300px] overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
            <MarkdownText
              text={data.message}
              shouldAnimate={false}
              className="tool-message-markdown min-w-0 max-w-full text-sm text-muted-foreground"
            />
          </div>
        </div>
      )}
    </div>
  );
});
