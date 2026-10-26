/**
 * STATE MACHINE: ExploreAgentBubble
 *
 * Like the browser agent panel but inline as a chip.
 *
 * HEADER (always visible, clickable to expand/collapse):
 *   [ThinkingAnimation|Sparkles] {prefix} | [vertical carousel: active tool icon + action]    {N steps}  [chevron]
 *
 * Status drives icon + prefix:
 *   IN_PROGRESS → terminal ThinkingAnimation + "Exploring | [tool] {action}"
 *   FINISHED    → green Sparkles + "Explored"
 *   ERROR       → red Sparkles + "Explore Failed"
 *
 * actionOrGoal: while IN_PROGRESS, the title of the most recent non-thinking
 * step (e.g. "Grep: andy prevalsky"); falls back to the goal text when no
 * action has run yet. When FINISHED/ERROR, the title row only shows the
 * terminal state label.
 *
 * ACTIVE TOOL TRANSITION:
 *   first IN_PROGRESS for a toolCallId -> debounced slide to that tool
 *   FINISHED for a still-parallel toolCallId -> no immediate slide
 *   FINISHED for the last active toolCallId -> immediate "X.Ys · ↓ X tokens"
 *   Token counts spring in when ASSISTANT_STREAM/TOOL_STREAM updates arrive.
 *
 * RESULT (always visible when FINISHED/ERROR, fixed max-height):
 *   The concrete result from attempt_completion (plain text, no icon).
 *   Fast Mode / demo-cache plumbing copy is stripped before render.
 *
 * EXPANDED CONTENT (visible when expanded):
 *   TASK: Full untruncated task text, shown first.
 *   STEPS (fixed max-height with scroll):
 *     - Thinking steps: lightbulb icon, show thinking text inline
 *     - Web search: globe icon
 *     - Other tools: default icons from TOOL_ICONS
 *     - Steps with result text are expandable (chevron)
 */

import { ChevronRight, Lightbulb, Sparkles, Globe } from 'lucide-react';
import { memo, useState, useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import ThinkingAnimation from '@/components/ThinkingAnimation';
import { MarkdownText } from './MarkdownText';
import { TOOL_ICONS } from '@/lib/toolIcons';
import type { ExploreStep } from '../types';
import { ExploreAgentSteps } from './ExploreAgentSteps';
import {
  ExploreActiveToolCarousel,
  type ExploreActiveToolCarouselItem,
} from './ExploreActiveToolCarousel';

export type { ExploreStep } from '../types';

interface ExploreAgentBubbleProps {
  title: string;
  fullGoal?: string;
  message: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  stepHistory: ExploreStep[];
  thinkingStreamTokenCount?: number;
  thinkingStreamStartedAtMs?: number;
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

function getActiveActions(steps: ExploreStep[]): ExploreStep[] {
  return steps.filter((step) => !isThinkingStep(step) && step.status === 'IN_PROGRESS');
}

function getFallbackActions(steps: ExploreStep[]): ExploreStep[] {
  const mostRecentAction = [...steps].reverse().find((step) => !isThinkingStep(step));
  return mostRecentAction ? [mostRecentAction] : [];
}

function getLatestFinishedActionStartedAtMs(steps: ExploreStep[]): number | undefined {
  const latestFinished = [...steps]
    .reverse()
    .find((step) => !isThinkingStep(step) && step.status === 'FINISHED' && step.timestamp);
  if (!latestFinished?.timestamp) return undefined;

  const parsed = Date.parse(latestFinished.timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function getThinkingStartedAtMs(
  postToolThinkingStartedAtMs: number | undefined,
  streamStartedAtMs: number | undefined,
): number | undefined {
  if (!postToolThinkingStartedAtMs) return streamStartedAtMs;
  if (!streamStartedAtMs) return postToolThinkingStartedAtMs;
  return Math.min(postToolThinkingStartedAtMs, streamStartedAtMs);
}

function buildCarouselItems(
  actions: ExploreStep[],
  fallbackText?: string,
  thinkingStreamTokenCount: number = 0,
  thinkingStreamStartedAtMs?: number,
  showThinking: boolean = thinkingStreamTokenCount > 0,
): ExploreActiveToolCarouselItem[] {
  const actionItems = actions
    .map<ExploreActiveToolCarouselItem | null>((action, index) => {
      const text = action.title?.replace(/\n/g, ' ').trim();
      if (!text) return null;
      return {
        key:
          action.toolCallId || `${action.toolName || 'tool'}:${action.timestamp || index}:${text}`,
        text: truncate(text, 100),
        icon: getStepIcon(action),
      };
    })
    .filter((item): item is ExploreActiveToolCarouselItem => item !== null);

  const items: ExploreActiveToolCarouselItem[] = [...actionItems];

  if (items.length === 0 && fallbackText && !showThinking) {
    items.push({
      key: `goal:${fallbackText}`,
      text: truncate(fallbackText.replace(/\n/g, ' '), 100),
      icon: null,
    });
  }

  if (showThinking) {
    items.push({
      key: 'thinking-stream',
      kind: 'thinking',
      tokenCount: thinkingStreamTokenCount,
      startedAtMs: thinkingStreamStartedAtMs,
      pauseMs: 10_000,
    });
  }

  return items;
}

interface HeaderProps {
  status: ExploreAgentBubbleProps['status'];
  titleText: string;
  carouselItems: ExploreActiveToolCarouselItem[];
  stepCount: number;
  isExpanded: boolean;
  onToggle: () => void;
}

function Header({
  status,
  titleText,
  carouselItems,
  stepCount,
  isExpanded,
  onToggle,
}: HeaderProps) {
  const isInProgress = status === 'IN_PROGRESS';
  const isComplete = status === 'FINISHED';
  const isError = status === 'ERROR';
  return (
    <div
      className="flex items-center gap-2 min-h-[24px] cursor-pointer select-none"
      onClick={onToggle}
    >
      {isInProgress ? (
        <div
          data-testid="explore-thinking-icon"
          className="mr-1 flex h-4 w-4 flex-shrink-0 items-center justify-center"
        >
          <ThinkingAnimation
            dataUrl="/thinking_animations.txt"
            autoplay
            loop
            className="h-[14.4px] w-[14.4px]"
            style={{ width: 14.4, height: 14.4 }}
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
        <span className="text-xs font-medium text-foreground/80 flex items-center min-w-0">
          <span className="flex-shrink-0">{titleText}</span>
          {carouselItems.length > 0 && (
            <>
              <span className="mx-1.5 text-muted-foreground/40 flex-shrink-0">|</span>
              <ExploreActiveToolCarousel
                items={carouselItems}
                iconClassName="mr-1.5 h-3 w-3 text-muted-foreground/50"
              />
            </>
          )}
        </span>
      </div>
      {stepCount > 0 && (
        <span className="text-[10px] text-muted-foreground/50 tabular-nums flex-shrink-0">
          {stepCount} steps
        </span>
      )}
      <ChevronRight
        className={cn(
          'h-3 w-3 flex-shrink-0 transition-transform text-muted-foreground/40',
          isExpanded && 'rotate-90',
        )}
      />
    </div>
  );
}

const ExploreAgentBubble = memo(function ExploreAgentBubble({
  title,
  fullGoal,
  message,
  status,
  stepHistory,
  thinkingStreamTokenCount = 0,
  thinkingStreamStartedAtMs,
  onTypingComplete,
}: ExploreAgentBubbleProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
  const onTypingCompleteRef = useRef(onTypingComplete);

  useEffect(() => {
    if (onTypingCompleteRef.current) requestAnimationFrame(onTypingCompleteRef.current);
  }, []);

  const toggleExpanded = useCallback(() => setIsExpanded((prev) => !prev), []);

  const toggleStep = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const { isComplete, isError, isInProgress, steps, hasSteps, titleText, carouselItems } =
    deriveExplorePresentation({
      title,
      fullGoal,
      status,
      stepHistory,
      thinkingStreamTokenCount,
      thinkingStreamStartedAtMs,
    });

  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className="flex-1 min-w-0">
        <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-card/50 backdrop-blur-sm shadow-sm px-3 py-2">
          <Header
            status={status}
            titleText={titleText}
            carouselItems={carouselItems}
            stepCount={isInProgress ? steps.length : 0}
            isExpanded={isExpanded}
            onToggle={toggleExpanded}
          />
          {(isComplete || isError) && message && (
            <div className="mt-2 border-t border-border/40 pt-2">
              <div className="min-w-0 max-w-full overflow-y-auto overflow-x-hidden text-xs text-foreground/70 max-h-[200px]">
                <MarkdownText text={message} className="tool-message-markdown text-xs" />
              </div>
            </div>
          )}
          {isExpanded && (fullGoal || title) && (
            <div className="mt-2 border-t border-border/40 pt-2 pb-1.5">
              <div className="text-xs text-foreground/70 whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
                {fullGoal || title}
              </div>
            </div>
          )}
          {isExpanded && hasSteps && (
            <ExploreAgentSteps
              steps={steps}
              expandedSteps={expandedSteps}
              onToggleStep={toggleStep}
            />
          )}
        </div>
      </div>
    </div>
  );
});

function deriveExplorePresentation(
  props: Pick<
    ExploreAgentBubbleProps,
    | 'title'
    | 'fullGoal'
    | 'status'
    | 'stepHistory'
    | 'thinkingStreamTokenCount'
    | 'thinkingStreamStartedAtMs'
  >,
) {
  const isComplete = props.status === 'FINISHED';
  const isError = props.status === 'ERROR';
  const isInProgress = props.status === 'IN_PROGRESS';
  const goal = truncate(props.fullGoal || props.title || 'Researching...', 100);
  const steps = props.stepHistory;
  const activeActions = isInProgress ? getActiveActions(steps) : [];
  const postToolThinkingStartedAtMs =
    isInProgress && activeActions.length === 0
      ? getLatestFinishedActionStartedAtMs(steps)
      : undefined;
  const tokenCount = props.thinkingStreamTokenCount ?? 0;
  const showThinking = tokenCount > 0 || postToolThinkingStartedAtMs !== undefined;
  const thinkingStartedAtMs = getThinkingStartedAtMs(
    postToolThinkingStartedAtMs,
    props.thinkingStreamStartedAtMs,
  );
  const displayActions = isInProgress
    ? activeActions.length > 0
      ? activeActions
      : showThinking
        ? []
        : getFallbackActions(steps)
    : [];
  const titleText = isInProgress ? 'Exploring' : isError ? 'Explore Failed' : 'Explored';
  const carouselItems = isInProgress
    ? buildCarouselItems(displayActions, goal, tokenCount, thinkingStartedAtMs, showThinking)
    : [];
  return {
    isComplete,
    isError,
    isInProgress,
    steps,
    hasSteps: steps.length > 0,
    titleText,
    carouselItems,
  };
}

export default ExploreAgentBubble;
