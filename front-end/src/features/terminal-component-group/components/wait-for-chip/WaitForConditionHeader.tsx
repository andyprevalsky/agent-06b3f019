/**
 * STATE MACHINE: WaitForConditionHeader
 *
 * IN_PROGRESS → animated icon + "Waiting for" + Checking/Next badge
 * FINISHED    → green check + "Waited for" + Complete badge
 * ERROR       → red X + "Stopped waiting for" + Stopped badge
 * COLLAPSED ↔ EXPANDED is reflected by the disclosure chevron.
 */

import { CheckCircle, ChevronRight, Clock, XCircle } from 'lucide-react';
import ThinkingAnimation from '@/components/ThinkingAnimation';
import { cn } from '@/lib/utils';
import { formatDuration } from './helpers';

function HeaderIcon({
  isInProgress,
  isError,
  conditionMet,
}: {
  isInProgress: boolean;
  isError: boolean;
  conditionMet: boolean | undefined;
}) {
  if (isInProgress) {
    return (
      <div className="h-4 w-4 flex-shrink-0">
        <ThinkingAnimation autoplay loop playbackSpeed={1} style={{ width: 16, height: 16 }} />
      </div>
    );
  }
  if (isError) return <XCircle className="h-4 w-4 flex-shrink-0 text-red-400" />;
  if (conditionMet) return <CheckCircle className="h-4 w-4 flex-shrink-0 text-emerald-400" />;
  return <Clock className="h-4 w-4 flex-shrink-0 text-amber-400" />;
}

function buildHeaderTitle(isComplete: boolean, isError: boolean, description: string): string {
  if (isComplete) return `Waited for ${description}`;
  if (isError) return `Stopped waiting for ${description}`;
  return `Waiting for ${description}`;
}

function buildContextText(checkCount: number, checkIntervalSeconds?: number): string {
  const parts: string[] = [];
  if (checkCount > 0) parts.push(`${checkCount} check${checkCount === 1 ? '' : 's'}`);
  if (checkIntervalSeconds) parts.push(`every ${formatDuration(checkIntervalSeconds)}`);
  return parts.join(' · ');
}

export function WaitForConditionHeader({
  description,
  isInProgress,
  isComplete,
  isError,
  conditionMet,
  checkCount,
  checkIntervalSeconds,
  statusBadge,
  showExpandChevron,
  isExpanded,
  onToggle,
}: {
  description: string;
  isInProgress: boolean;
  isComplete: boolean;
  isError: boolean;
  conditionMet: boolean | undefined;
  checkCount: number;
  checkIntervalSeconds?: number;
  statusBadge: string;
  showExpandChevron: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const headerTitle = buildHeaderTitle(isComplete, isError, description);
  const contextText = buildContextText(checkCount, checkIntervalSeconds);
  return (
    <div
      className="flex min-h-[40px] cursor-pointer select-none items-center gap-2 px-3 py-2"
      onClick={onToggle}
    >
      <HeaderIcon isInProgress={isInProgress} isError={isError} conditionMet={conditionMet} />
      <span className="min-w-0 truncate text-xs font-medium text-foreground/80">
        {headerTitle.replace(/\n/g, ' ')}
      </span>
      {contextText && (
        <span className="hidden min-w-0 truncate border-l border-border/60 pl-2 text-[10px] text-muted-foreground/55 sm:block">
          {contextText}
        </span>
      )}
      <span className="ml-auto flex-shrink-0 whitespace-nowrap rounded-full bg-muted/60 px-2 py-1 text-[10px] font-medium tabular-nums text-muted-foreground/70">
        {statusBadge}
      </span>
      {showExpandChevron && (
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground/40 transition-transform',
            isExpanded && 'rotate-90',
          )}
        />
      )}
    </div>
  );
}
