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
 *
 * HEADER:
 *   IN_PROGRESS → ThinkingAnimation + "Waiting for {condition}" + N checks · next in XmYs
 *   FINISHED    → CheckCircle (green) + "Waited for {condition}" + N checks
 *   ERROR       → XCircle (red) + title + N checks
 *
 * LIVE EXPLORE:
 *   Shown when latest check has status=IN_PROGRESS and has explore data
 *   Flush to bottom/sides of card, separated by border-t
 */

import {
  ChevronRight,
  CheckCircle,
  XCircle,
  Clock,
  Search,
  Sparkles,
  Lightbulb,
  Globe,
} from 'lucide-react';
import { memo, useState, useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import ThinkingAnimation from '@/components/ThinkingAnimation';
import { TOOL_ICONS } from '@/lib/toolIcons';
import type { ExploreStep, WaitForCheck } from '../types';

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

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Format seconds to human-readable: "42s", "3m 42s", "1h 30m", "3d 2h" */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    if (s === 0) return `${m}m`;
    return `${m}m ${s}s`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.round((seconds % 86400) / 3600);
  if (h === 0) return `${d}d`;
  return `${d}d ${h}h`;
}

/** Relative time: "3m ago", "1h ago" */
function timeAgo(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSec < 60) return 'just now';
  return `${formatDuration(diffSec)} ago`;
}

/** Get icon component for an explore step */
function getExploreStepIcon(toolName?: string) {
  if (!toolName) return Search;
  if (toolName === 'web_search') return Globe;
  if (toolName === 'spawn_agent') return Lightbulb;
  return TOOL_ICONS[toolName] || Search;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Inline Explore Chip (rendered within check history)
// ═══════════════════════════════════════════════════════════════════════════════

function InlineExploreChip({
  explore,
  isLive,
}: {
  explore: NonNullable<WaitForCheck['explore']>;
  isLive: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded((prev) => !prev);
  }, []);

  const toggleStep = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      next.has(index) ? next.delete(index) : next.add(index);
      return next;
    });
  }, []);

  const isInProgress = explore.status === 'IN_PROGRESS';
  const isComplete = explore.status === 'FINISHED';
  const isError = explore.status === 'ERROR';
  const displayTitle = explore.title || 'Checking condition...';

  /** Check if a step is a thinking step (matches ExploreAgentBubble pattern) */
  const isThinkingStep = (step: ExploreStep) =>
    step.toolName === 'spawn_agent' && (step.title === 'Explore agent thinking' || !step.title);

  return (
    <div className="border-t border-border/40">
      {/* Explore chip header */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-foreground/5 select-none"
        onClick={toggle}
      >
        {isInProgress ? (
          <div className="h-3.5 w-3.5 flex-shrink-0">
            <ThinkingAnimation autoplay loop playbackSpeed={1} style={{ width: 14, height: 14 }} />
          </div>
        ) : (
          <Sparkles
            className={cn(
              'h-3.5 w-3.5 flex-shrink-0',
              isComplete && 'text-emerald-400',
              isError && 'text-red-400',
            )}
          />
        )}

        <span className="text-[11px] text-foreground/70 flex-1 truncate">
          {isInProgress ? 'Exploring' : 'Explored'} - {displayTitle.replace(/\n/g, ' ')}
        </span>

        {isLive && isInProgress && (
          <span className="flex items-center gap-1 text-[10px] text-emerald-400 flex-shrink-0">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            live
          </span>
        )}

        <ChevronRight
          className={cn(
            'h-2.5 w-2.5 flex-shrink-0 transition-transform text-muted-foreground/40 ml-auto',
            isExpanded && 'rotate-90',
          )}
        />
      </div>

      {/* Expanded: full goal + steps (matches ExploreAgentBubble rendering) */}
      {isExpanded && (explore.fullGoal || explore.title) && (
        <div className="px-3 pt-1.5 pb-1 border-t border-border/30">
          <div className="text-[10px] text-foreground/60 whitespace-pre-wrap">
            {explore.fullGoal || explore.title}
          </div>
        </div>
      )}

      {isExpanded && explore.steps.length > 0 && (
        <div className="px-3 pb-2 space-y-0.5 max-h-[250px] overflow-y-auto">
          {explore.steps.map((step, i) => {
            const thinking = isThinkingStep(step);
            const hasContent = !!step.message?.trim();
            const isStepExpanded = expandedSteps.has(i);
            const StepIcon = getExploreStepIcon(step.toolName);

            // Thinking steps: show actual thinking text inline
            if (thinking) {
              const thinkingText = step.message?.trim();
              return (
                <div
                  key={`${step.timestamp}-${i}`}
                  className="flex items-start gap-1.5 text-[10px] text-muted-foreground/60 py-0.5"
                >
                  <Lightbulb className="h-2.5 w-2.5 flex-shrink-0 text-amber-400/70 mt-0.5" />
                  <span className="italic flex-1">{thinkingText || 'Thinking...'}</span>
                </div>
              );
            }

            // Tool steps: expandable chevron when content available
            return (
              <div key={`${step.timestamp}-${i}`}>
                <div
                  className={cn(
                    'flex items-center gap-1.5 text-[10px] text-muted-foreground/60 py-0.5',
                    hasContent && 'cursor-pointer hover:bg-foreground/5 rounded',
                  )}
                  onClick={hasContent ? (e) => toggleStep(i, e) : undefined}
                >
                  <StepIcon className="h-2.5 w-2.5 flex-shrink-0 text-muted-foreground/40" />
                  {hasContent && (
                    <ChevronRight
                      className={cn(
                        'h-2 w-2 flex-shrink-0 transition-transform text-muted-foreground/40',
                        isStepExpanded && 'rotate-90',
                      )}
                    />
                  )}
                  <span className="flex-1">{step.title?.replace(/\n/g, ' ')}</span>
                </div>

                {isStepExpanded && hasContent && (
                  <div className="ml-4 mt-0.5 mb-1 text-[10px] text-muted-foreground/50 whitespace-pre-wrap max-h-[120px] overflow-y-auto border-l border-border/30 pl-2">
                    {step.message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// WaitForChip Component
// ═══════════════════════════════════════════════════════════════════════════════

const WaitForChip = memo(function WaitForChip({
  title,
  message,
  status,
  checks,
  metadata,
  startTimestamp,
  onTypingComplete,
}: WaitForChipProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [nextCheckIn, setNextCheckIn] = useState('');
  const [, setTick] = useState(0); // force re-render for timeAgo updates
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  const isConditionMode = metadata?.waitForMode === 'condition';
  const isTimestampMode = metadata?.waitForMode === 'timestamp';

  // Effective status: in condition mode, per-check FINISHED (conditionMet=false)
  // is NOT terminal — only conditionMet=true means overall completion
  const conditionMet = metadata?.conditionMet ?? metadata?.data?.condition_met;
  const isComplete = status === 'FINISHED' && (!isConditionMode || conditionMet === true);
  const isError = status === 'ERROR';
  const isInProgress = !isComplete && !isError;

  // Fire onTypingComplete immediately (no typing animation)
  useEffect(() => {
    if (onTypingComplete) {
      requestAnimationFrame(() => onTypingComplete());
    }
  }, []);

  // Determine the live check (latest IN_PROGRESS check with explore data)
  const liveCheck = isInProgress
    ? [...checks].reverse().find((c) => c.status === 'IN_PROGRESS' && c.explore)
    : undefined;

  // Past checks (all non-live, chronological: Check 1 at top, Check N at bottom)
  const pastChecks = checks.filter((c) => c !== liveCheck);

  // Completed check count (FINISHED or ERROR checks)
  const completedChecks = checks.filter(
    (c) => c.status === 'FINISHED' || c.status === 'ERROR',
  ).length;

  // Update next-check countdown every second
  useEffect(() => {
    const update = () => {
      const now = Date.now();

      // Next check countdown (condition mode, in progress)
      if (isInProgress && isConditionMode && metadata?.checkIntervalSeconds) {
        // Find the latest FINISHED check to compute countdown from
        const latestFinished = [...checks].reverse().find((c) => c.status === 'FINISHED');

        if (liveCheck) {
          // Currently running a check (explore active)
          setNextCheckIn('checking...');
        } else if (latestFinished?.timestamp) {
          // Between checks: countdown from last finished check + interval
          const lastCheckTime = new Date(latestFinished.timestamp).getTime();
          const nextCheckTime = lastCheckTime + metadata.checkIntervalSeconds * 1000;
          const remaining = Math.max(0, Math.floor((nextCheckTime - now) / 1000));
          setNextCheckIn(remaining > 0 ? `next in ${formatDuration(remaining)}` : 'checking...');
        } else if (checks.some((c) => c.status === 'IN_PROGRESS')) {
          // First check is running (no finished checks yet)
          setNextCheckIn('checking...');
        } else {
          // Before first check starts
          setNextCheckIn('checking...');
        }
      }

      // Tick for timeAgo recalculation
      setTick((t) => t + 1);
    };

    update();
    if (isInProgress) {
      intervalRef.current = setInterval(update, 1000);
      return () => clearInterval(intervalRef.current);
    }
  }, [isInProgress, isConditionMode, metadata?.checkIntervalSeconds, checks, liveCheck]);

  const toggleExpanded = useCallback(() => {
    if (isConditionMode) {
      setIsExpanded((prev) => !prev);
    }
  }, [isConditionMode]);

  // Extract condition text
  const condition =
    metadata?.condition || title.replace(/^Waiting for /, '').replace(/^Polling: /, '');

  // ─── Timestamp mode: simple one-liner ──────────────────────────────────────
  if (isTimestampMode) {
    const targetDate = metadata?.untilTimestamp ? new Date(metadata.untilTimestamp) : null;
    const formattedTarget = targetDate
      ? targetDate.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : null;

    // Countdown to target
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

              <span className="text-xs font-medium text-foreground/80 flex-1">
                {isComplete
                  ? `Waited until ${formattedTarget || 'target time'}`
                  : `Waiting for ${formattedTarget || 'target time'}`}
              </span>

              {countdown && (
                <span className="text-[10px] text-muted-foreground/50 tabular-nums flex-shrink-0 whitespace-nowrap">
                  {countdown}
                </span>
              )}
              {isComplete && metadata?.durationSeconds && (
                <span className="text-[10px] text-muted-foreground/50 tabular-nums flex-shrink-0 whitespace-nowrap">
                  {formatDuration(metadata.durationSeconds)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Condition mode ────────────────────────────────────────────────────────

  // Build right-side info: "X checks · next in YmZs"
  const rightParts: string[] = [];
  if (isInProgress) {
    if (completedChecks > 0) {
      rightParts.push(`${completedChecks} check${completedChecks !== 1 ? 's' : ''}`);
    }
    if (nextCheckIn) rightParts.push(nextCheckIn);
  }
  if (isComplete || isError) {
    const total = metadata?.data?.checks_completed || completedChecks;
    rightParts.push(`${total} check${total !== 1 ? 's' : ''}`);
  }

  // Header display title
  const headerTitle = isComplete
    ? `Waited for ${condition}`
    : isError
      ? title || `Error waiting for ${condition}`
      : `Waiting for ${condition}`;

  return (
    <div className="animate-in fade-in duration-300">
      <div className="flex-1">
        <div className="rounded-xl border border-border bg-card/50 backdrop-blur-sm shadow-sm overflow-hidden">
          {/* ── Header ── */}
          <div
            className={cn(
              'flex items-start gap-2 min-h-[24px] px-3 py-2',
              isConditionMode && 'cursor-pointer select-none',
            )}
            onClick={toggleExpanded}
          >
            {/* Status icon */}
            {isInProgress ? (
              <div className="h-4 w-4 flex-shrink-0 mt-0.5">
                <ThinkingAnimation
                  autoplay
                  loop
                  playbackSpeed={1}
                  style={{ width: 16, height: 16 }}
                />
              </div>
            ) : isError ? (
              <XCircle className="h-4 w-4 flex-shrink-0 text-red-400 mt-0.5" />
            ) : conditionMet ? (
              <CheckCircle className="h-4 w-4 flex-shrink-0 text-emerald-400 mt-0.5" />
            ) : (
              <Clock className="h-4 w-4 flex-shrink-0 text-amber-400 mt-0.5" />
            )}

            {/* Title */}
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium text-foreground/80">
                {headerTitle.replace(/\n/g, ' ')}
              </span>
            </div>

            {/* Right info: X checks · next in YmZs */}
            {rightParts.length > 0 && (
              <span className="text-[10px] text-muted-foreground/50 tabular-nums flex-shrink-0 whitespace-nowrap mt-0.5">
                {rightParts.join(' \u00b7 ')}
              </span>
            )}

            {/* Expand chevron (condition mode only) */}
            {isConditionMode && pastChecks.length > 0 && (
              <ChevronRight
                className={cn(
                  'h-3 w-3 flex-shrink-0 transition-transform text-muted-foreground/40 mt-0.5',
                  isExpanded && 'rotate-90',
                )}
              />
            )}
          </div>

          {/* ── Expanded: Check History ── */}
          {isExpanded && pastChecks.length > 0 && (
            <div className="border-t border-border/40">
              {/* Section label */}
              <div className="px-3 pt-2 pb-1">
                <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">
                  Check History
                </span>
              </div>

              {/* Past checks in chronological order */}
              <div className="max-h-[400px] overflow-y-auto">
                {pastChecks.map((check, i) => {
                  const isError = check.status === 'ERROR';
                  const checkPassed = check.conditionMet === true;
                  const checkFailed = check.conditionMet === false;
                  const checkLabel = `Check ${check.checkNum || i + 1}`;
                  const ago = check.timestamp ? timeAgo(check.timestamp) : '';

                  return (
                    <div key={`check-${check.timestamp}-${i}`}>
                      {/* Check status row */}
                      <div className="flex items-center gap-1.5 px-3 py-1.5">
                        {checkPassed ? (
                          <CheckCircle className="h-3 w-3 flex-shrink-0 text-emerald-400/70" />
                        ) : isError ? (
                          <XCircle className="h-3 w-3 flex-shrink-0 text-red-400/50" />
                        ) : checkFailed ? (
                          <XCircle className="h-3 w-3 flex-shrink-0 text-red-400/50" />
                        ) : (
                          <span className="h-3 w-3 flex-shrink-0 rounded-full border border-muted-foreground/30" />
                        )}
                        <span className="text-[11px] text-muted-foreground/70 flex-1">
                          {checkLabel}
                          {ago && <span className="text-muted-foreground/40"> · {ago}</span>}
                        </span>
                      </div>

                      {/* Embedded explore chip (flush to sides) */}
                      {check.explore && (
                        <InlineExploreChip explore={check.explore} isLive={false} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Live explore (current check) ── */}
          {liveCheck?.explore && (
            <>
              {isExpanded && pastChecks.length > 0 && (
                <div className="border-t border-border/40 px-3 pt-2 pb-1">
                  <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">
                    Current Check
                  </span>
                </div>
              )}
              <InlineExploreChip explore={liveCheck.explore} isLive={true} />
            </>
          )}
        </div>
      </div>
    </div>
  );
});

export default WaitForChip;
