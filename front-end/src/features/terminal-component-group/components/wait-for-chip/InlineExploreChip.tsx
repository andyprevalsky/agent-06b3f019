/**
 * STATE MACHINE: InlineExploreChip
 *
 * EMBEDDED EXPLORE CONTEXT:
 * wait_for check -> explore metadata -> InlineExploreChip header + step list.
 *
 * HEADER ICON:
 * IN_PROGRESS uses the terminal ThinkingAnimation while actively exploring.
 * The active tool icon appears immediately after the "|" separator.
 * Active tool changes slide through a vertical carousel.
 * first IN_PROGRESS for a toolCallId slides to that tool with a one-second
 * debounce. FINISHED for a non-last tool does not force a slide; FINISHED for
 * the last active tool immediately shows the elapsed-time + token spring item.
 * FINISHED uses green Sparkles.
 * ERROR uses red Sparkles.
 *
 * TERMINAL RESULT:
 * FINISHED/ERROR always render the explore tool result at the bottom of the
 * chip through MarkdownText, matching the standalone explore chip.
 *
 * EXPANSION:
 * [COLLAPSED] --click--> [EXPANDED goal + steps] --click--> [COLLAPSED]
 */

import { ChevronRight, Lightbulb, Sparkles } from 'lucide-react';
import { useCallback, useState } from 'react';
import { cn } from '@/lib/utils';
import ThinkingAnimation from '@/components/ThinkingAnimation';
import type { ExploreStep, WaitForCheck } from '../../types';
import { getExploreStepIcon, isThinkingStep } from './helpers';
import { MarkdownText } from '../MarkdownText';
import {
  ExploreActiveToolCarousel,
  type ExploreActiveToolCarouselItem,
} from '../ExploreActiveToolCarousel';

type ExploreData = NonNullable<WaitForCheck['explore']>;

interface InlineExploreChipProps {
  explore: ExploreData;
  isLive: boolean;
  thinkingStreamTokenCount?: number;
  thinkingStreamStartedAtMs?: number;
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
    .map((action, index) => {
      const text = action.title?.replace(/\n/g, ' ').trim();
      if (!text) return null;
      return {
        key:
          action.toolCallId || `${action.toolName || 'tool'}:${action.timestamp || index}:${text}`,
        text,
        icon: getExploreStepIcon(action.toolName),
      };
    })
    .filter((item): item is ExploreActiveToolCarouselItem => item !== null);

  const items: ExploreActiveToolCarouselItem[] = [...actionItems];

  if (items.length === 0 && fallbackText && !showThinking) {
    items.push({
      key: `goal:${fallbackText}`,
      text: fallbackText.replace(/\n/g, ' '),
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

function ExploreChipHeader({
  explore,
  isLive,
  isExpanded,
  onToggle,
  thinkingStreamTokenCount,
  thinkingStreamStartedAtMs,
}: {
  explore: ExploreData;
  isLive: boolean;
  isExpanded: boolean;
  onToggle: (e: React.MouseEvent) => void;
  thinkingStreamTokenCount: number;
  thinkingStreamStartedAtMs?: number;
}) {
  const isInProgress = explore.status === 'IN_PROGRESS';
  const isComplete = explore.status === 'FINISHED';
  const isError = explore.status === 'ERROR';
  const goalText = explore.fullGoal || explore.title || 'Checking condition...';
  const activeActions = isInProgress ? getActiveActions(explore.steps) : [];
  const postToolThinkingStartedAtMs =
    isInProgress && activeActions.length === 0
      ? getLatestFinishedActionStartedAtMs(explore.steps)
      : undefined;
  const showThinking = thinkingStreamTokenCount > 0 || postToolThinkingStartedAtMs !== undefined;
  const thinkingStartedAtMs = getThinkingStartedAtMs(
    postToolThinkingStartedAtMs,
    thinkingStreamStartedAtMs,
  );
  const displayActions = isInProgress
    ? activeActions.length > 0
      ? activeActions
      : showThinking
        ? []
        : getFallbackActions(explore.steps)
    : [];
  const titleText = isInProgress ? 'Exploring' : isError ? 'Explore Failed' : 'Explored';
  const carouselItems = isInProgress
    ? buildCarouselItems(
        displayActions,
        goalText,
        thinkingStreamTokenCount,
        thinkingStartedAtMs,
        showThinking,
      )
    : [];

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-foreground/5 select-none"
      onClick={onToggle}
    >
      {isInProgress ? (
        <div
          data-testid="explore-thinking-icon"
          className="mr-1 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center"
        >
          <ThinkingAnimation
            dataUrl="/thinking_animations.txt"
            autoplay
            loop
            className="h-[12.6px] w-[12.6px]"
            style={{ width: 12.6, height: 12.6 }}
          />
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

      <span className="text-[11px] text-foreground/70 flex-1 min-w-0 flex items-center">
        <span className="flex-shrink-0">{titleText}</span>
        {carouselItems.length > 0 && (
          <>
            <span className="mx-1.5 text-muted-foreground/40 flex-shrink-0">|</span>
            <ExploreActiveToolCarousel
              items={carouselItems}
              iconClassName="mr-1 h-2.5 w-2.5 text-muted-foreground/40"
            />
          </>
        )}
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
  );
}

function ThinkingStepRow({ step, index }: { step: ExploreStep; index: number }) {
  const thinkingText = step.message?.trim();
  return (
    <div
      key={`${step.timestamp}-${index}`}
      className="flex items-start gap-1.5 text-[10px] text-muted-foreground/60 py-0.5"
    >
      <Lightbulb className="h-2.5 w-2.5 flex-shrink-0 text-amber-400/70 mt-0.5" />
      <span className="italic flex-1">{thinkingText || 'Thinking...'}</span>
    </div>
  );
}

function ToolStepRow({
  step,
  index,
  isExpanded,
  onToggle,
}: {
  step: ExploreStep;
  index: number;
  isExpanded: boolean;
  onToggle: (i: number, e: React.MouseEvent) => void;
}) {
  const hasContent = !!step.message?.trim();
  const StepIcon = getExploreStepIcon(step.toolName);

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1.5 text-[10px] text-muted-foreground/60 py-0.5',
          hasContent && 'cursor-pointer hover:bg-foreground/5 rounded',
        )}
        onClick={hasContent ? (e) => onToggle(index, e) : undefined}
      >
        <StepIcon className="h-2.5 w-2.5 flex-shrink-0 text-muted-foreground/40" />
        {hasContent && (
          <ChevronRight
            className={cn(
              'h-2 w-2 flex-shrink-0 transition-transform text-muted-foreground/40',
              isExpanded && 'rotate-90',
            )}
          />
        )}
        <span className="flex-1">{step.title?.replace(/\n/g, ' ')}</span>
      </div>

      {isExpanded && hasContent && (
        <div className="ml-4 mt-0.5 mb-1 text-[10px] text-muted-foreground/50 whitespace-pre-wrap max-h-[120px] overflow-y-auto border-l border-border/30 pl-2">
          {step.message}
        </div>
      )}
    </div>
  );
}

function ExploreStepsList({
  steps,
  expandedSteps,
  toggleStep,
}: {
  steps: ExploreStep[];
  expandedSteps: Set<number>;
  toggleStep: (i: number, e: React.MouseEvent) => void;
}) {
  return (
    <div className="px-3 pb-2 space-y-0.5 max-h-[250px] overflow-y-auto">
      {steps.map((step, i) =>
        isThinkingStep(step) ? (
          <ThinkingStepRow key={`${step.timestamp}-${i}`} step={step} index={i} />
        ) : (
          <ToolStepRow
            key={`${step.timestamp}-${i}`}
            step={step}
            index={i}
            isExpanded={expandedSteps.has(i)}
            onToggle={toggleStep}
          />
        ),
      )}
    </div>
  );
}

function TerminalResult({ message }: { message: string }) {
  if (!message.trim()) return null;

  return (
    <div className="border-t border-border/30 px-3 py-2">
      <div className="text-[10px] text-foreground/60 whitespace-pre-wrap max-h-[120px] overflow-y-auto">
        <MarkdownText text={message} className="text-[10px]" />
      </div>
    </div>
  );
}

export function InlineExploreChip({
  explore,
  isLive,
  thinkingStreamTokenCount = 0,
  thinkingStreamStartedAtMs,
}: InlineExploreChipProps) {
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
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const goalText = explore.fullGoal || explore.title;
  const isTerminal = explore.status === 'FINISHED' || explore.status === 'ERROR';

  return (
    <div className="border-t border-border/40">
      <ExploreChipHeader
        explore={explore}
        isLive={isLive}
        isExpanded={isExpanded}
        onToggle={toggle}
        thinkingStreamTokenCount={thinkingStreamTokenCount}
        thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
      />

      {isExpanded && goalText && (
        <div className="px-3 pt-1.5 pb-1 border-t border-border/30">
          <div className="text-[10px] text-foreground/60 whitespace-pre-wrap">{goalText}</div>
        </div>
      )}

      {isExpanded && explore.steps.length > 0 && (
        <ExploreStepsList
          steps={explore.steps}
          expandedSteps={expandedSteps}
          toggleStep={toggleStep}
        />
      )}

      {isTerminal && <TerminalResult message={explore.message} />}
    </div>
  );
}
