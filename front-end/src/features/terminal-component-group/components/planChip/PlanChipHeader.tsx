import { ChevronDown, FileText, ArrowDown, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PlanChipHeaderProps {
  title: string;
  hasContent: boolean;
  isExpanded: boolean;
  isError: boolean;
  isStreaming: boolean;
  charCount: number;
  animatedCharCount: number;
  onToggle: () => void;
}

export function PlanChipHeader({
  title,
  hasContent,
  isExpanded,
  isError,
  isStreaming,
  charCount,
  animatedCharCount,
  onToggle,
}: PlanChipHeaderProps) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        'w-full flex items-center justify-between px-3 py-2.5 text-left',
        !hasContent && 'cursor-default',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        {isError ? (
          <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0" />
        ) : (
          <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        )}

        <span
          className={cn(
            'text-sm font-medium truncate',
            isError && 'text-destructive',
            isStreaming &&
              'animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent',
            !isStreaming && !isError && 'text-foreground',
          )}
        >
          {title}
        </span>

        {isStreaming && charCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground ml-auto">
            <ArrowDown className="w-3 h-3" />
            <span className="tabular-nums">{animatedCharCount.toLocaleString()}</span>
          </span>
        )}
      </div>

      {hasContent && (
        <ChevronDown
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform duration-200 flex-shrink-0',
            isExpanded && 'rotate-180',
          )}
        />
      )}
    </button>
  );
}
