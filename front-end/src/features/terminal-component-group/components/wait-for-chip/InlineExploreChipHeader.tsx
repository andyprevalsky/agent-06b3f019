/**
 * STATE MACHINE: InlineExploreChipHeader
 *
 * IN_PROGRESS → thinking animation + active-tool/thinking carousel + optional live badge
 * FINISHED    → green Sparkles + "Explored"
 * ERROR       → red Sparkles + "Explore Failed"
 * COLLAPSED ↔ EXPANDED is owned by InlineExploreChip and reflected by the chevron.
 */

import { ChevronRight, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import ThinkingAnimation from '@/components/ThinkingAnimation';
import { cn } from '@/lib/utils';
import type { ExploreStep, WaitForCheck } from '../../types';
import {
  ExploreActiveToolCarousel,
  type ExploreActiveToolCarouselItem,
} from '../ExploreActiveToolCarousel';
import { getExploreStepIcon, isThinkingStep } from './helpers';

type ExploreData = NonNullable<WaitForCheck['explore']>;

interface HeaderModel {
  isInProgress: boolean;
  isComplete: boolean;
  isError: boolean;
  titleText: string;
  carouselItems: ExploreActiveToolCarouselItem[];
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
  fallbackText: string,
  tokenCount: number,
  startedAtMs: number | undefined,
  showThinking: boolean,
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

  if (actionItems.length === 0 && !showThinking) {
    actionItems.push({
      key: `goal:${fallbackText}`,
      text: fallbackText.replace(/\n/g, ' '),
      icon: null,
    });
  }
  if (showThinking) {
    actionItems.push({
      key: 'thinking-stream',
      kind: 'thinking',
      tokenCount,
      startedAtMs,
      pauseMs: 10_000,
    });
  }
  return actionItems;
}

function buildHeaderModel(
  explore: ExploreData,
  thinkingStreamTokenCount: number,
  thinkingStreamStartedAtMs?: number,
): HeaderModel {
  const isInProgress = explore.status === 'IN_PROGRESS';
  const isComplete = explore.status === 'FINISHED';
  const isError = explore.status === 'ERROR';
  const activeActions = isInProgress ? getActiveActions(explore.steps) : [];
  const postToolThinkingStartedAtMs =
    isInProgress && activeActions.length === 0
      ? getLatestFinishedActionStartedAtMs(explore.steps)
      : undefined;
  const showThinking = thinkingStreamTokenCount > 0 || postToolThinkingStartedAtMs !== undefined;
  const displayActions = isInProgress
    ? activeActions.length > 0
      ? activeActions
      : showThinking
        ? []
        : getFallbackActions(explore.steps)
    : [];
  const goalText = explore.fullGoal || explore.title || 'Checking condition...';
  return {
    isInProgress,
    isComplete,
    isError,
    titleText: isInProgress ? 'Exploring' : isError ? 'Explore Failed' : 'Explored',
    carouselItems: isInProgress
      ? buildCarouselItems(
          displayActions,
          goalText,
          thinkingStreamTokenCount,
          getThinkingStartedAtMs(postToolThinkingStartedAtMs, thinkingStreamStartedAtMs),
          showThinking,
        )
      : [],
  };
}

function ExploreStatusIcon({ model }: { model: HeaderModel }) {
  if (model.isInProgress) {
    return (
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
    );
  }
  return (
    <Sparkles
      className={cn(
        'h-3.5 w-3.5 flex-shrink-0',
        model.isComplete && 'text-emerald-400',
        model.isError && 'text-red-400',
      )}
    />
  );
}

function ExploreHeaderTitle({ model }: { model: HeaderModel }) {
  return (
    <span className="flex min-w-0 flex-1 items-center text-[11px] text-foreground/70">
      <span className="flex-shrink-0">{model.titleText}</span>
      {model.carouselItems.length > 0 && (
        <>
          <span className="mx-1.5 flex-shrink-0 text-muted-foreground/40">|</span>
          <ExploreActiveToolCarousel
            items={model.carouselItems}
            iconClassName="mr-1 h-2.5 w-2.5 text-muted-foreground/40"
          />
        </>
      )}
    </span>
  );
}

export function InlineExploreChipHeader({
  explore,
  isLive,
  isExpanded,
  onToggle,
  leadingContent,
  thinkingStreamTokenCount,
  thinkingStreamStartedAtMs,
}: {
  explore: ExploreData;
  isLive: boolean;
  isExpanded: boolean;
  onToggle: (event: React.MouseEvent) => void;
  leadingContent?: ReactNode;
  thinkingStreamTokenCount: number;
  thinkingStreamStartedAtMs?: number;
}) {
  const model = buildHeaderModel(explore, thinkingStreamTokenCount, thinkingStreamStartedAtMs);
  return (
    <div
      className="flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 hover:bg-foreground/5"
      onClick={onToggle}
    >
      {leadingContent}
      <ExploreStatusIcon model={model} />
      <ExploreHeaderTitle model={model} />
      {isLive && model.isInProgress && (
        <span className="flex flex-shrink-0 items-center gap-1 text-[10px] text-emerald-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> live
        </span>
      )}
      <ChevronRight
        className={cn(
          'ml-auto h-2.5 w-2.5 flex-shrink-0 text-muted-foreground/40 transition-transform',
          isExpanded && 'rotate-90',
        )}
      />
    </div>
  );
}
