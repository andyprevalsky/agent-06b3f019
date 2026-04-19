/**
 * Title row for a tool card — icon + label + optional expand chevron.
 */
import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';
import { ToolMessageIcon } from './ToolMessageIcon';
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

  return (
    <div
      className={cn(
        'flex items-center gap-2',
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
      />
      <span className={titleClassName}>
        {isThought ? (data.status === 'IN_PROGRESS' ? 'Thinking' : 'Thought') : titleText}
      </span>
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
