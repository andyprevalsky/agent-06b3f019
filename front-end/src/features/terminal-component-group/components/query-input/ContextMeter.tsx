/**
 * ContextMeter — circular progress badge showing context-window usage.
 *
 * Display-only; parent owns the percentage + total-size values.
 */

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface ContextMeterProps {
  contextPercentage: number;
  contextSize: number;
  restartThreshold: number;
}

const CIRCUMFERENCE = 50.265; // 2 * π * r (r = 8)

export function ContextMeter({
  contextPercentage,
  contextSize,
  restartThreshold,
}: ContextMeterProps) {
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
