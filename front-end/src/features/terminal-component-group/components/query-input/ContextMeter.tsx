/**
 * ContextMeter — circular progress badge showing context-window usage.
 *
 * Display-only; parent owns the percentage + total-size values.
 * variant 'nub' (Rose Desktop tab): bare white "N%" in 10px mono with the
 * instant "Context window used" tooltip. restartThreshold 0 = window unknown (a code
 * agent before its first turn result): the tokens used ("87k") with an exact tooltip.
 */

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { NUB_ITEM_CLASS, NUB_TEXT_CLASS, NubTip } from './NubTip';

interface ContextMeterProps {
  contextPercentage: number;
  contextSize: number;
  restartThreshold: number;
  variant?: 'badge' | 'nub';
}

const CIRCUMFERENCE = 50.265; // 2 * π * r (r = 8)

/** 87169 → "87k", 1200000 → "1.2M"; under 1000 stays exact. */
function compactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

export function ContextMeter({
  contextPercentage,
  contextSize,
  restartThreshold,
  variant = 'badge',
}: ContextMeterProps) {
  if (variant === 'nub') {
    // A window of 0 is unknown (a code agent before its first turn result): show the
    // tokens used instead of a percentage of nothing.
    const known = restartThreshold > 0;
    const text = known ? `${contextPercentage.toFixed(0)}%` : `${compactTokens(contextSize)}`;
    const label = known
      ? `Context window used: ${contextPercentage.toFixed(0)}%`
      : `Context used: ${contextSize.toLocaleString()} tokens`;
    return (
      <NubTip label={known ? 'Context window used' : 'Context used (window unknown)'}>
        <span
          tabIndex={0}
          data-nub-item
          data-testid="nub-context"
          aria-label={label}
          className={cn(NUB_ITEM_CLASS, NUB_TEXT_CLASS, 'cursor-default')}
        >
          {text}
        </span>
      </NubTip>
    );
  }
  const dashOffset = CIRCUMFERENCE - (CIRCUMFERENCE * contextPercentage) / 100;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>
          <Badge
            variant="outline"
            className="flex items-center gap-2 text-muted-foreground text-xs font-mono px-2 py-1"
          >
            <span>{contextPercentage.toFixed(0)}%</span>
            <svg className="transform -rotate-90" viewBox="0 0 20 20" width="16" height="16">
              <circle
                className="fill-none stroke-muted-foreground/30 opacity-70"
                cx="10"
                cy="10"
                r="8"
                strokeWidth="3"
              />
              <circle
                className="fill-none stroke-muted-foreground transition-all duration-200"
                cx="10"
                cy="10"
                r="8"
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={CIRCUMFERENCE.toString()}
                strokeDashoffset={dashOffset}
                style={{ transition: 'stroke-dashoffset 200ms ease' }}
              />
            </svg>
          </Badge>
        </div>
      </TooltipTrigger>
      <TooltipContent className="z-[100]">
        <p className="text-xs font-mono">
          {contextSize.toLocaleString()} / {restartThreshold.toLocaleString()} context used
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
