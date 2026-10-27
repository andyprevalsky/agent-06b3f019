import { CheckCircle, XCircle } from 'lucide-react';
import ThinkingAnimation from '@/components/ThinkingAnimation';
import { formatLocalDateTime, toDate } from '@/lib/localDateTime';
import { formatDuration } from './helpers';

interface WaitForTimestampChipProps {
  isInProgress: boolean;
  isComplete: boolean;
  untilTimestamp?: string;
  durationSeconds?: number;
}

export function WaitForTimestampChip({
  isInProgress,
  isComplete,
  untilTimestamp,
  durationSeconds,
}: WaitForTimestampChipProps) {
  // The same instant the label shows (a zone-less timestamp is UTC).
  const targetDate = untilTimestamp ? toDate(untilTimestamp) : null;
  const formattedTarget = untilTimestamp ? formatLocalDateTime(untilTimestamp) : null;

  let countdown = '';
  if (isInProgress && targetDate) {
    const remaining = Math.max(0, Math.floor((targetDate.getTime() - Date.now()) / 1000));
    countdown = remaining > 0 ? `${formatDuration(remaining)} left` : 'now';
  }

  return (
    <div className="animate-in fade-in duration-300">
      <div className="flex-1">
        <div className="rounded-xl border border-border bg-card/50 backdrop-blur-sm shadow-sm px-3 py-2">
          <div className="flex items-center gap-2 min-h-[24px]">
            {isInProgress ? (
              <div className="h-4 w-4 flex-shrink-0">
                <ThinkingAnimation
                  autoplay
                  loop
                  playbackSpeed={1}
                  style={{ width: 16, height: 16 }}
                />
              </div>
            ) : isComplete ? (
              <CheckCircle className="h-4 w-4 flex-shrink-0 text-emerald-400" />
            ) : (
              <XCircle className="h-4 w-4 flex-shrink-0 text-red-400" />
            )}

            <span className="text-xs font-medium text-foreground/80 flex-1 min-w-0 break-words">
              {isComplete
                ? `Waited until ${formattedTarget || 'target time'}`
                : `Waiting for ${formattedTarget || 'target time'}`}
            </span>

            {countdown && (
              <span className="text-[10px] text-muted-foreground/50 tabular-nums flex-shrink-0 whitespace-nowrap">
                {countdown}
              </span>
            )}
            {isComplete && durationSeconds && (
              <span className="text-[10px] text-muted-foreground/50 tabular-nums flex-shrink-0 whitespace-nowrap">
                {formatDuration(durationSeconds)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
