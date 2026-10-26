/**
 * STATE MACHINE: WaitForChip
 *
 * TWO MODES:
 *   Timestamp: simple one-liner with countdown, no expand
 *   Condition: expandable chip with check history + embedded explore agents
 *
 * CONDITION MODE STATES:
 *   [COLLAPSED] compact header only
 *       ↕ click header
 *   [EXPANDED] header + all checks, each rendered by InlineExploreChip
 *
 * Explore chips within checks are independently expandable.
 * Live embedded explore chips receive active stream timing/counts so their
 * carousel can include the elapsed-time + spring-counted token item.
 *
 * EFFECTIVE STATUS (condition mode):
 *   The backend emits per-check FINISHED events (conditionMet=false) followed by
 *   re-establish IN_PROGRESS events. The chip treats per-check FINISHED as IN_PROGRESS
 *   to avoid flicker. Only conditionMet=true or ERROR are terminal states.
 *
 *   Raw status=FINISHED + conditionMet=true  → isComplete (green)
 *   Raw status=FINISHED + conditionMet=false  → isInProgress (still waiting)
 *   Raw status=ERROR                          → isError (exhausted)
 *   Raw status=IN_PROGRESS                    → isInProgress
 */

import { memo, useEffect, useState } from 'react';
import type { WaitForCheck } from '../types';
import type { SubAgentStreamingMetrics } from './useMessageFiltering';
import { WaitForConditionChip } from './wait-for-chip/WaitForConditionChip';
import { WaitForTimestampChip } from './wait-for-chip/WaitForTimestampChip';
import { localizeTimestamps } from '@/lib/localDateTime';

export type { WaitForCheck } from '../types';

interface WaitForChipProps {
  title: string;
  message: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  checks: WaitForCheck[];
  metadata?: {
    waitForMode?: 'condition' | 'timestamp';
    description?: string;
    condition?: string;
    untilTimestamp?: string;
    checkIntervalSeconds?: number;
    checkNum?: number;
    maxChecks?: number;
    durationSeconds?: number;
    conditionMet?: boolean;
    data?: {
      condition_met?: boolean;
      checks_completed?: number;
    };
  };
  startTimestamp?: string;
  thinkingStreamTokenCount?: number;
  thinkingStreamStartedAtMs?: number;
  streamingMetricsBySubAgentId?: Map<string, SubAgentStreamingMetrics>;
  onTypingComplete?: () => void;
}

function useFireTypingComplete(onTypingComplete?: () => void) {
  // Fire once on mount (the mount-time callback) to mirror the legacy
  // no-typing-animation contract.
  const [onMount] = useState(() => onTypingComplete);
  useEffect(() => {
    if (onMount) requestAnimationFrame(() => onMount());
  }, [onMount]);
}

const WaitForChip = memo(function WaitForChip({
  title,
  status,
  checks,
  metadata,
  thinkingStreamTokenCount = 0,
  thinkingStreamStartedAtMs,
  streamingMetricsBySubAgentId,
  onTypingComplete,
}: WaitForChipProps) {
  useFireTypingComplete(onTypingComplete);

  const isConditionMode = metadata?.waitForMode === 'condition';
  const isTimestampMode = metadata?.waitForMode === 'timestamp';

  const conditionMet = metadata?.conditionMet ?? metadata?.data?.condition_met;
  const isComplete = status === 'FINISHED' && (!isConditionMode || conditionMet === true);
  const isError = status === 'ERROR';
  const isInProgress = !isComplete && !isError;

  if (isTimestampMode) {
    return (
      <WaitForTimestampChip
        isInProgress={isInProgress}
        isComplete={isComplete}
        untilTimestamp={metadata?.untilTimestamp}
        durationSeconds={metadata?.durationSeconds}
      />
    );
  }

  const liveCheck = isInProgress
    ? [...checks].reverse().find((c) => c.status === 'IN_PROGRESS' && c.explore)
    : undefined;
  const completedChecks = checks.filter(
    (c) => c.status === 'FINISHED' || c.status === 'ERROR',
  ).length;
  const condition =
    metadata?.condition || title.replace(/^Waiting for /, '').replace(/^Polling: /, '');
  const description = localizeTimestamps(metadata?.description || condition);

  return (
    <WaitForConditionChip
      description={description}
      isInProgress={isInProgress}
      isComplete={isComplete}
      isError={isError}
      conditionMet={conditionMet}
      checks={checks}
      liveCheck={liveCheck}
      completedChecks={completedChecks}
      currentCheckNum={metadata?.checkNum}
      checkIntervalSeconds={metadata?.checkIntervalSeconds}
      totalChecksCompleted={metadata?.data?.checks_completed}
      thinkingStreamTokenCount={thinkingStreamTokenCount}
      thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
      streamingMetricsBySubAgentId={streamingMetricsBySubAgentId}
    />
  );
});

export default WaitForChip;
