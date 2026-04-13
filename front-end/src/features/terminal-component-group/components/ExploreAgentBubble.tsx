/**
 * STATE MACHINE: ExploreAgentBubble
 *
 * Like the browser agent panel but inline as a chip.
 *
 * HEADER (always visible, clickable to expand/collapse):
 *   [ThinkingSvg|Sparkles] Exploring - {goal, truncated 100 chars}    {N steps}  [chevron]
 *                          {subtitle: current IN_PROGRESS tool title}
 *
 * Status drives the icon:
 *   IN_PROGRESS → ThinkingSvg (animated)
 *   FINISHED    → green Sparkles
 *   ERROR       → red Sparkles
 *
 * GOAL: Set once from the init spawn_agent message title. Never changes.
 *
 * RESULT (always visible when FINISHED/ERROR, fixed max-height):
 *   The concrete result from attempt_completion (plain text, no icon).
 *   Shown directly below header — no expand needed.
 *
 * EXPANDED CONTENT (visible when expanded):
 *   TASK: Full untruncated task text, shown first.
 *   STEPS (fixed max-height with scroll):
 *     - Thinking steps: lightbulb icon, show thinking text inline
 *     - Web search: globe icon (not magnifying glass)
 *     - Other tools: default icons from TOOL_ICONS
 *     - Steps with result text are expandable (chevron)
 */

import { ChevronRight, Lightbulb, Sparkles, Globe } from 'lucide-react';
import { memo, useState, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import ThinkingAnimation from '@/components/ThinkingAnimation';
import { MarkdownText } from './MarkdownText';
import { TOOL_ICONS } from '@/lib/toolIcons';
import type { ExploreStep } from '../types';

export type { ExploreStep } from '../types';

interface ExploreAgentBubbleProps {
  title: string;
  fullGoal?: string;
  message: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  stepHistory: ExploreStep[];
  onTypingComplete?: () => void;
}

/** Truncate to maxLen chars, adding ellipsis if needed */
function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '\u2026';
}

/** Check if a step is a thinking step (from explore_post_message) */
function isThinkingStep(step: ExploreStep): boolean {
  return (
    step.toolName === 'spawn_agent' && (step.title === 'Explore agent thinking' || !step.title)
  );
}

/** Get the right icon for an explore step */
function getStepIcon(step: ExploreStep) {
  if (isThinkingStep(step)) return Lightbulb;
  if (step.toolName === 'web_search') return Globe;
  return (step.toolName && TOOL_ICONS[step.toolName]) || TOOL_ICONS.default;
}

const ExploreAgentBubble = memo(function ExploreAgentBubble({
  title,
  fullGoal,
  message,
  status,
  stepHistory,
  onTypingComplete,
}: ExploreAgentBubbleProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
  const isComplete = status === 'FINISHED';
  const isError = status === 'ERROR';
  const isInProgress = status === 'IN_PROGRESS';

  useEffect(() => {
    if (onTypingComplete) {
      requestAnimationFrame(() => onTypingComplete());
    }
  }, []);

  const toggleExpanded = useCallback(() => {
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

  // Goal: from the init message title. Truncate to 100 chars. Never changes.
  const goal = truncate(fullGoal || title || 'Researching...', 100);

  // Steps are already sorted chronologically by MessageList (newest at bottom).
  const steps = stepHistory;
  const hasSteps = steps.length > 0;

  // Subtitle: title of the most recent IN_PROGRESS step (current action)
  const subtitle = isInProgress
    ? [...steps].reverse().find((s) => s.status === 'IN_PROGRESS')?.title
    : undefined;

  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className="flex-1">
        <div className="rounded-xl border border-border bg-card/50 backdrop-blur-sm shadow-sm px-3 py-2">
          {/* Header - clickable to expand/collapse */}
          <div
            className="flex items-center gap-2 min-h-[24px] cursor-pointer select-none"
            onClick={toggleExpanded}
          >
            {isInProgress ? (
              <div className="h-4 w-4 flex-shrink-0">
                <ThinkingAnimation
                  autoplay
                  loop
                  playbackSpeed={1}
                  style={{ width: 16, height: 16 }}
                />
              </div>
            ) : (
              <Sparkles
                className={cn(
                  'h-4 w-4 flex-shrink-0',
                  isComplete && 'text-emerald-400',
                  isError && 'text-red-400',
                )}
              />
            )}

            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium text-foreground/80 truncate block">
                Exploring - {goal}
              </span>
              {subtitle && (
                <span className="text-[11px] text-muted-foreground/50 truncate block">
                  {subtitle}
                </span>
              )}
            </div>

            {hasSteps && (
              <span className="text-[10px] text-muted-foreground/50 tabular-nums flex-shrink-0">
                {steps.length} steps
              </span>
            )}

            <ChevronRight
              className={cn(
                'h-3 w-3 flex-shrink-0 transition-transform text-muted-foreground/40',
                isExpanded && 'rotate-90',
              )}
            />
          </div>

          {/* Result: always visible when FINISHED/ERROR */}
          {(isComplete || isError) && message && (
            <div className="mt-2 border-t border-border/40 pt-2">
              <div className="text-xs text-foreground/70 max-h-[200px] overflow-y-auto">
                <MarkdownText text={message} className="text-xs" />
              </div>
            </div>
          )}

          {/* Expanded content: full task + steps */}
          {isExpanded && (fullGoal || title) && (
            <div className="mt-2 border-t border-border/40 pt-2 pb-1.5">
              <div className="text-xs text-foreground/70 whitespace-pre-wrap max-h-[200px] overflow-y-auto">
                {fullGoal || title}
              </div>
            </div>
          )}

          {/* Steps: visible when expanded, fixed max-height */}
          {isExpanded && hasSteps && (
            <div className="mt-1 space-y-0.5 max-h-[300px] overflow-y-auto">
              {steps.map((step, i) => {
                const thinking = isThinkingStep(step);
                const hasContent = !!step.message?.trim();
                const isStepExpanded = expandedSteps.has(i);
                const StepIcon = getStepIcon(step);

                // Thinking steps: show the thinking text inline (not as expandable)
                if (thinking) {
                  const thinkingText = step.message?.trim();
                  return (
                    <div key={`${step.timestamp}-${i}`}>
                      <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground/60 py-0.5 px-1 -mx-1">
                        <Lightbulb className="h-3 w-3 flex-shrink-0 text-amber-400/70 mt-0.5" />
                        <span className="italic">{thinkingText || 'Thinking...'}</span>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={`${step.timestamp}-${i}`}>
                    <div
                      className={cn(
                        'flex items-center gap-1.5 text-[11px] text-muted-foreground/70 py-0.5 rounded px-1 -mx-1',
                        hasContent && 'cursor-pointer hover:bg-foreground/5',
                      )}
                      onClick={hasContent ? (e) => toggleStep(i, e) : undefined}
                    >
                      <StepIcon className="h-3 w-3 flex-shrink-0 text-muted-foreground/50" />
                      {hasContent && (
                        <ChevronRight
                          className={cn(
                            'h-2.5 w-2.5 flex-shrink-0 transition-transform text-muted-foreground/40',
                            isStepExpanded && 'rotate-90',
                          )}
                        />
                      )}
                      <span className="truncate">{step.title}</span>
                    </div>

                    {isStepExpanded && hasContent && (
                      <div className="ml-4 mt-0.5 mb-1 text-[11px] text-muted-foreground/50 whitespace-pre-wrap max-h-[150px] overflow-y-auto border-l border-border/30 pl-2">
                        {step.message}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default ExploreAgentBubble;
