/**
 * STATE MACHINE: ToolMessageHeader
 *
 * [STATIC]
 *   - shows icon + title; a thought appends its recorded generation
 *     (duration · ↓ tokens · tok/s) when its producer recorded one
 *
 * [TOGGLEABLE] (hasMessage && isExpandable)
 *   - header receives click handler
 *   - chevron is shown when showChevron is true
 *   - title wraps inside the tool row instead of forcing horizontal overflow
 */
import { cn } from '@/lib/utils';
import { ChevronRight, Maximize2 } from 'lucide-react';
import { ToolMessageIcon } from './ToolMessageIcon';
import { ThoughtGenerationMetric } from '../ThoughtGenerationMetric';
import type { ToolMessageData } from './types';

interface ToolMessageHeaderProps {
  data: ToolMessageData;
  titleText: string;
  isThought: boolean;
  hasMessage: boolean;
  isExpandable: boolean;
  showChevron: boolean;
  shouldBeExpanded: boolean;
  onToggle: () => void;
}

export function ToolMessageHeader({
  data,
  titleText,
  isThought,
  hasMessage,
  isExpandable,
  showChevron,
  shouldBeExpanded,
  onToggle,
}: ToolMessageHeaderProps) {
  const canToggle = hasMessage && isExpandable;
  const titleClassName = cn(
    'text-sm font-medium',
    isThought &&
      data.status === 'IN_PROGRESS' &&
      'animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent',
    isThought && data.status !== 'IN_PROGRESS' && 'text-foreground',
    !isThought && data.error && 'text-red-600 dark:text-red-400',
    !isThought &&
      !data.error &&
      data.status === 'IN_PROGRESS' &&
      'animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent',
    !isThought && !data.error && data.status === 'FINISHED' && 'text-foreground',
  );
  const authTaskId = data.authAssistance?.taskId;

  return (
    <div
      className={cn(
        'flex min-w-0 max-w-full items-center gap-2',
        canToggle && 'cursor-pointer hover:opacity-80 transition-opacity',
      )}
      onClick={canToggle ? onToggle : undefined}
    >
      <ToolMessageIcon
        isThought={isThought}
        status={data.status}
        toolName={data.toolName}
        actionType={data.actionType}
        error={data.error}
        codeProvider={data.codeProvider}
      />
      <span className={cn('min-w-0 break-words', titleClassName)}>
        {isThought ? (data.status === 'IN_PROGRESS' ? 'Thinking' : 'Thought') : titleText}
      </span>
      {isThought && data.generation && <ThoughtGenerationMetric generation={data.generation} />}
      {authTaskId && data.status === 'IN_PROGRESS' && (
        <button
          type="button"
          className="ml-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          onClick={(event) => {
            event.stopPropagation();
            openBrowserFullscreen(authTaskId);
          }}
        >
          <Maximize2 className="h-3.5 w-3.5" />
          Open Browser
        </button>
      )}
      {showChevron && (
        <ChevronRight
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform duration-75',
            shouldBeExpanded && 'rotate-90',
          )}
        />
      )}
    </div>
  );
}

function openBrowserFullscreen(taskId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('browser-id', taskId);
  window.history.replaceState({}, '', url.toString());
  window.dispatchEvent(new CustomEvent('navi-open-browser', { detail: { taskId } }));
}
