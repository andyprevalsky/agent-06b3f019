/**
 * STATE MACHINE: WaitForConditionChip
 *
 * COLLAPSED (default)
 *   Header only: concise description + real polling context + status badge.
 *   No Explore implementation detail is visible.
 *       ↕ click header
 * EXPANDED
 *   Header + newest-first check history.
 *   Each check composes its status and the existing InlineExploreChip on one row.
 *   Explore expansion and nested tool-step expansion remain owned by InlineExploreChip.
 *
 * Runtime status:
 *   IN_PROGRESS + live check → Checking
 *   IN_PROGRESS, no live check → Next in Xm
 *   FINISHED + conditionMet → Complete
 *   ERROR → Stopped
 */

import { CheckCircle, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WaitForCheck } from '../../types';
import { formatDuration, timeAgo } from './helpers';
import { InlineExploreChip } from './InlineExploreChip';
import { WaitForConditionHeader } from './WaitForConditionHeader';

export interface WaitForConditionChipProps {
  description: string;
  isInProgress: boolean;
  isComplete: boolean;
  isError: boolean;
  conditionMet: boolean | undefined;
  checks: WaitForCheck[];
  liveCheck?: WaitForCheck;
  completedChecks: number;
  currentCheckNum?: number;
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
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    const update = () => {
      if (!isInProgress || !checkIntervalSeconds) return;
      const latestFinished = [...checks].reverse().find((check) => check.status === 'FINISHED');

      if (liveCheck) {
        setNextCheckIn('Checking');
        return;
      }
      if (!latestFinished?.timestamp) {
        setNextCheckIn('Checking');
        return;
      }

      const lastCheckTime = new Date(latestFinished.timestamp).getTime();
      const nextCheckTime = lastCheckTime + checkIntervalSeconds * 1000;
      const remaining = Math.max(0, Math.floor((nextCheckTime - Date.now()) / 1000));
      setNextCheckIn(remaining > 0 ? `Next in ${formatDuration(remaining)}` : 'Checking');
    };

    update();
    if (isInProgress) {
      intervalRef.current = setInterval(update, 1000);
      return () => clearInterval(intervalRef.current);
    }
  }, [isInProgress, checkIntervalSeconds, checks, liveCheck]);

  return nextCheckIn;
}

function CheckStatusIcon({ check }: { check: WaitForCheck }) {
  if (check.conditionMet === true) {
    return <CheckCircle className="h-3 w-3 flex-shrink-0 text-emerald-400" />;
  }
  if (check.status === 'ERROR') {
    return <XCircle className="h-3 w-3 flex-shrink-0 text-red-400/70" />;
  }
  if (check.conditionMet === false) {
    return <XCircle className="h-3 w-3 flex-shrink-0 text-muted-foreground/45" />;
  }
  return <span className="h-3 w-3 flex-shrink-0 rounded-full border border-blue-400/60" />;
}

function getCheckState(check: WaitForCheck): string {
  if (check.conditionMet === true) return 'Condition met';
  if (check.status === 'ERROR') return 'Check failed';
  if (check.conditionMet === false) return 'Condition not met';
  if (check.status === 'IN_PROGRESS') return 'Checking now';
  return 'Check complete';
}

function CheckLeadingContent({
  check,
  fallbackNumber,
}: {
  check: WaitForCheck;
  fallbackNumber: number;
}) {
  const ago = check.timestamp ? timeAgo(check.timestamp) : '';
  return (
    <span
      data-testid={`wait-for-check-${check.checkNum || fallbackNumber}`}
      className="flex min-w-0 flex-shrink items-center gap-1.5"
    >
      <CheckStatusIcon check={check} />
      <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
        <strong className="font-medium text-foreground/75">
          Check {check.checkNum || fallbackNumber}
        </strong>
        <span> · {getCheckState(check)}</span>
        {ago && <span className="text-muted-foreground/40"> · {ago}</span>}
      </span>
      <span className="mx-0.5 h-3 w-px flex-shrink-0 bg-border/70" />
    </span>
  );
}

function CheckHistoryRow({
  check,
  fallbackNumber,
  isLive,
  thinkingStreamTokenCount,
  thinkingStreamStartedAtMs,
}: {
  check: WaitForCheck;
  fallbackNumber: number;
  isLive: boolean;
  thinkingStreamTokenCount: number;
  thinkingStreamStartedAtMs?: number;
}) {
  if (!check.explore) {
    return (
      <div className="flex items-center gap-1.5 border-t border-border/40 px-3 py-2">
        <CheckLeadingContent check={check} fallbackNumber={fallbackNumber} />
      </div>
    );
  }

  return (
    <InlineExploreChip
      explore={check.explore}
      isLive={isLive}
      leadingContent={<CheckLeadingContent check={check} fallbackNumber={fallbackNumber} />}
      collapseTerminalResult
      thinkingStreamTokenCount={thinkingStreamTokenCount}
      thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
    />
  );
}

function CheckHistory({
  checks,
  liveCheck,
  thinkingStreamTokenCount,
  thinkingStreamStartedAtMs,
}: {
  checks: WaitForCheck[];
  liveCheck?: WaitForCheck;
  thinkingStreamTokenCount: number;
  thinkingStreamStartedAtMs?: number;
}) {
  const newestFirst = [...checks].reverse();
  return (
    <div className="border-t border-border/40">
      <div className="px-3 pb-1 pt-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
          Check History
        </span>
      </div>
      <div className="max-h-[400px] overflow-y-auto">
        {newestFirst.map((check, index) => (
          <CheckHistoryRow
            key={`check-${check.checkNum || index}-${check.timestamp || index}`}
            check={check}
            fallbackNumber={checks.length - index}
            isLive={check === liveCheck}
            thinkingStreamTokenCount={thinkingStreamTokenCount}
            thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
          />
        ))}
      </div>
    </div>
  );
}

export function WaitForConditionChip({
  description,
  isInProgress,
  isComplete,
  isError,
  conditionMet,
  checks,
  liveCheck,
  completedChecks,
  currentCheckNum,
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
  const toggleExpanded = useCallback(() => setIsExpanded((previous) => !previous), []);
  const checkCount =
    totalChecksCompleted ?? Math.max(completedChecks, currentCheckNum || 0, checks.length);
  const statusBadge = isComplete ? 'Complete' : isError ? 'Stopped' : nextCheckIn || 'Checking';
  const showHistory = isExpanded && checks.length > 0;

  return (
    <div className="min-w-0 max-w-full animate-in fade-in duration-300">
      <div className="min-w-0 max-w-full flex-1">
        <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-card/50 shadow-sm backdrop-blur-sm">
          <WaitForConditionHeader
            description={description}
            isInProgress={isInProgress}
            isComplete={isComplete}
            isError={isError}
            conditionMet={conditionMet}
            checkCount={checkCount}
            checkIntervalSeconds={checkIntervalSeconds}
            statusBadge={statusBadge}
            showExpandChevron={checks.length > 0}
            isExpanded={isExpanded}
            onToggle={toggleExpanded}
          />
          {showHistory && (
            <CheckHistory
              checks={checks}
              liveCheck={liveCheck}
              thinkingStreamTokenCount={thinkingStreamTokenCount}
              thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
            />
          )}
        </div>
      </div>
    </div>
  );
}
