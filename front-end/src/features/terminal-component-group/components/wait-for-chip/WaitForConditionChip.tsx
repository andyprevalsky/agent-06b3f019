import { CheckCircle, ChevronRight, Clock, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import ThinkingAnimation from '@/components/ThinkingAnimation';
import type { WaitForCheck } from '../../types';
import { formatDuration, timeAgo } from './helpers';
import { InlineExploreChip } from './InlineExploreChip';

export interface WaitForConditionChipProps {
  title: string;
  condition: string;
  isInProgress: boolean;
  isComplete: boolean;
  isError: boolean;
  conditionMet: boolean | undefined;
  checks: WaitForCheck[];
  liveCheck?: WaitForCheck;
  pastChecks: WaitForCheck[];
  completedChecks: number;
  checkIntervalSeconds?: number;
  totalChecksCompleted?: number;
  thinkingStreamTokenCount?: number;
  thinkingStreamStartedAtMs?: number;
}

function useNextCheckCountdown(params: {
  isInProgress: boolean;
  checkIntervalSeconds?: number;
  checks: WaitForCheck[];
  liveCheck?: WaitForCheck;
}): string {
  const { isInProgress, checkIntervalSeconds, checks, liveCheck } = params;
  const [nextCheckIn, setNextCheckIn] = useState('');
  const [, setTick] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    const update = () => {
      if (isInProgress && checkIntervalSeconds) {
        const latestFinished = [...checks].reverse().find((c) => c.status === 'FINISHED');

        if (liveCheck) {
          setNextCheckIn('checking...');
        } else if (latestFinished?.timestamp) {
          const lastCheckTime = new Date(latestFinished.timestamp).getTime();
          const nextCheckTime = lastCheckTime + checkIntervalSeconds * 1000;
          const remaining = Math.max(0, Math.floor((nextCheckTime - Date.now()) / 1000));
          setNextCheckIn(remaining > 0 ? `next in ${formatDuration(remaining)}` : 'checking...');
        } else {
          setNextCheckIn('checking...');
        }
      }
      setTick((t) => t + 1);
    };

    update();
    if (isInProgress) {
      intervalRef.current = setInterval(update, 1000);
      return () => clearInterval(intervalRef.current);
    }
  }, [isInProgress, checkIntervalSeconds, checks, liveCheck]);

  return nextCheckIn;
}

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
      <div className="h-4 w-4 flex-shrink-0 mt-0.5">
        <ThinkingAnimation autoplay loop playbackSpeed={1} style={{ width: 16, height: 16 }} />
      </div>
    );
  }
  if (isError) return <XCircle className="h-4 w-4 flex-shrink-0 text-red-400 mt-0.5" />;
  if (conditionMet)
    return <CheckCircle className="h-4 w-4 flex-shrink-0 text-emerald-400 mt-0.5" />;
  return <Clock className="h-4 w-4 flex-shrink-0 text-amber-400 mt-0.5" />;
}

function CheckStatusIcon({
  isError,
  checkPassed,
  checkFailed,
}: {
  isError: boolean;
  checkPassed: boolean;
  checkFailed: boolean;
}) {
  if (checkPassed) return <CheckCircle className="h-3 w-3 flex-shrink-0 text-emerald-400/70" />;
  if (isError || checkFailed) return <XCircle className="h-3 w-3 flex-shrink-0 text-red-400/50" />;
  return <span className="h-3 w-3 flex-shrink-0 rounded-full border border-muted-foreground/30" />;
}

function CheckHistoryRow({
  check,
  index,
  thinkingStreamTokenCount,
  thinkingStreamStartedAtMs,
}: {
  check: WaitForCheck;
  index: number;
  thinkingStreamTokenCount: number;
  thinkingStreamStartedAtMs?: number;
}) {
  const isError = check.status === 'ERROR';
  const checkPassed = check.conditionMet === true;
  const checkFailed = check.conditionMet === false;
  const checkLabel = `Check ${check.checkNum || index + 1}`;
  const ago = check.timestamp ? timeAgo(check.timestamp) : '';

  return (
    <div>
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <CheckStatusIcon isError={isError} checkPassed={checkPassed} checkFailed={checkFailed} />
        <span className="text-[11px] text-muted-foreground/70 flex-1">
          {checkLabel}
          {ago && <span className="text-muted-foreground/40"> · {ago}</span>}
        </span>
      </div>

      {check.explore && (
        <InlineExploreChip
          explore={check.explore}
          isLive={false}
          thinkingStreamTokenCount={thinkingStreamTokenCount}
          thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
        />
      )}
    </div>
  );
}

function CheckHistory({
  pastChecks,
  thinkingStreamTokenCount,
  thinkingStreamStartedAtMs,
}: {
  pastChecks: WaitForCheck[];
  thinkingStreamTokenCount: number;
  thinkingStreamStartedAtMs?: number;
}) {
  return (
    <div className="border-t border-border/40">
      <div className="px-3 pt-2 pb-1">
        <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">
          Check History
        </span>
      </div>

      <div className="max-h-[400px] overflow-y-auto">
        {pastChecks.map((check, i) => (
          <CheckHistoryRow
            key={`check-${check.timestamp}-${i}`}
            check={check}
            index={i}
            thinkingStreamTokenCount={thinkingStreamTokenCount}
            thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
          />
        ))}
      </div>
    </div>
  );
}

function buildRightParts(params: {
  isInProgress: boolean;
  isComplete: boolean;
  isError: boolean;
  completedChecks: number;
  totalChecksCompleted?: number;
  nextCheckIn: string;
}): string[] {
  const { isInProgress, isComplete, isError, completedChecks, totalChecksCompleted, nextCheckIn } =
    params;
  const parts: string[] = [];
  if (isInProgress) {
    if (completedChecks > 0) {
      parts.push(`${completedChecks} check${completedChecks !== 1 ? 's' : ''}`);
    }
    if (nextCheckIn) parts.push(nextCheckIn);
  }
  if (isComplete || isError) {
    const total = totalChecksCompleted || completedChecks;
    parts.push(`${total} check${total !== 1 ? 's' : ''}`);
  }
  return parts;
}

function ConditionHeader({
  isInProgress,
  isError,
  conditionMet,
  headerTitle,
  rightParts,
  showExpandChevron,
  isExpanded,
  onToggle,
}: {
  isInProgress: boolean;
  isError: boolean;
  conditionMet: boolean | undefined;
  headerTitle: string;
  rightParts: string[];
  showExpandChevron: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="flex items-start gap-2 min-h-[24px] px-3 py-2 cursor-pointer select-none"
      onClick={onToggle}
    >
      <HeaderIcon isInProgress={isInProgress} isError={isError} conditionMet={conditionMet} />

      <div className="flex-1 min-w-0">
        <span className="text-xs font-medium text-foreground/80">
          {headerTitle.replace(/\n/g, ' ')}
        </span>
      </div>

      {rightParts.length > 0 && (
        <span className="text-[10px] text-muted-foreground/50 tabular-nums flex-shrink-0 whitespace-nowrap mt-0.5">
          {rightParts.join(' \u00b7 ')}
        </span>
      )}

      {showExpandChevron && (
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 transition-transform text-muted-foreground/40 mt-0.5',
            isExpanded && 'rotate-90',
          )}
        />
      )}
    </div>
  );
}

function LiveCheckSection({
  liveCheck,
  showCheckHistory,
  thinkingStreamTokenCount,
  thinkingStreamStartedAtMs,
}: {
  liveCheck: WaitForCheck;
  showCheckHistory: boolean;
  thinkingStreamTokenCount: number;
  thinkingStreamStartedAtMs?: number;
}) {
  if (!liveCheck.explore) return null;
  return (
    <>
      {showCheckHistory && (
        <div className="border-t border-border/40 px-3 pt-2 pb-1">
          <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">
            Current Check
          </span>
        </div>
      )}
      <InlineExploreChip
        explore={liveCheck.explore}
        isLive={true}
        thinkingStreamTokenCount={thinkingStreamTokenCount}
        thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
      />
    </>
  );
}

function buildHeaderTitle(params: {
  isComplete: boolean;
  isError: boolean;
  title: string;
  condition: string;
}): string {
  const { isComplete, isError, title, condition } = params;
  if (isComplete) return `Waited for ${condition}`;
  if (isError) return title || `Error waiting for ${condition}`;
  return `Waiting for ${condition}`;
}

export function WaitForConditionChip({
  title,
  condition,
  isInProgress,
  isComplete,
  isError,
  conditionMet,
  checks,
  liveCheck,
  pastChecks,
  completedChecks,
  checkIntervalSeconds,
  totalChecksCompleted,
  thinkingStreamTokenCount = 0,
  thinkingStreamStartedAtMs,
}: WaitForConditionChipProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const nextCheckIn = useNextCheckCountdown({
    isInProgress,
    checkIntervalSeconds,
    checks,
    liveCheck,
  });

  const toggleExpanded = useCallback(() => setIsExpanded((prev) => !prev), []);

  const rightParts = buildRightParts({
    isInProgress,
    isComplete,
    isError,
    completedChecks,
    totalChecksCompleted,
    nextCheckIn,
  });
  const headerTitle = buildHeaderTitle({ isComplete, isError, title, condition });
  const showCheckHistory = isExpanded && pastChecks.length > 0;

  return (
    <div className="animate-in fade-in duration-300">
      <div className="flex-1">
        <div className="rounded-xl border border-border bg-card/50 backdrop-blur-sm shadow-sm overflow-hidden">
          <ConditionHeader
            isInProgress={isInProgress}
            isError={isError}
            conditionMet={conditionMet}
            headerTitle={headerTitle}
            rightParts={rightParts}
            showExpandChevron={pastChecks.length > 0}
            isExpanded={isExpanded}
            onToggle={toggleExpanded}
          />

          {showCheckHistory && (
            <CheckHistory
              pastChecks={pastChecks}
              thinkingStreamTokenCount={thinkingStreamTokenCount}
              thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
            />
          )}

          {liveCheck && (
            <LiveCheckSection
              liveCheck={liveCheck}
              showCheckHistory={showCheckHistory}
              thinkingStreamTokenCount={thinkingStreamTokenCount}
              thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
            />
          )}
        </div>
      </div>
    </div>
  );
}
