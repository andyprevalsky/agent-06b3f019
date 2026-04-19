/**
 * STATE MACHINE: WaitForChip
 *
 * TWO MODES:
 *   Timestamp: simple one-liner with countdown, no expand
 *   Condition: expandable chip with check history + embedded explore agents
 *
 * CONDITION MODE STATES:
 *   [COLLAPSED] header + live explore (if check running)
 *       ↕ click header
 *   [EXPANDED] header + check history + live explore
 *
 * Explore chips within checks are independently expandable.
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

import { memo, useEffect } from 'react';
import type { WaitForCheck } from '../types';
import { WaitForConditionChip } from './wait-for-chip/WaitForConditionChip';
import { WaitForTimestampChip } from './wait-for-chip/WaitForTimestampChip';

export type { WaitForCheck } from '../types';

interface WaitForChipProps {
  title: string;
  message: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  checks: WaitForCheck[];
  metadata?: {
    waitForMode?: 'condition' | 'timestamp';
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
  onTypingComplete?: () => void;
}

function useFireTypingComplete(onTypingComplete?: () => void) {
  useEffect(() => {
    if (onTypingComplete) {
      requestAnimationFrame(() => onTypingComplete());
    }
    // Fire once on mount to mirror the legacy no-typing-animation contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const WaitForChip = memo(function WaitForChip({
  title,
  status,
  checks,
  metadata,
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
  const pastChecks = checks.filter((c) => c !== liveCheck);
  const completedChecks = checks.filter(
    (c) => c.status === 'FINISHED' || c.status === 'ERROR',
  ).length;
  const condition =
    metadata?.condition || title.replace(/^Waiting for /, '').replace(/^Polling: /, '');

  return (
    <WaitForConditionChip
      title={title}
      condition={condition}
      isInProgress={isInProgress}
      isComplete={isComplete}
      isError={isError}
      conditionMet={conditionMet}
      checks={checks}
      liveCheck={liveCheck}
      pastChecks={pastChecks}
      completedChecks={completedChecks}
      checkIntervalSeconds={metadata?.checkIntervalSeconds}
      totalChecksCompleted={metadata?.data?.checks_completed}
    />
  );
});

export default WaitForChip;
