/**
 * STATE MACHINE: InlineExploreChip
 *
 * EMBEDDED EXPLORE CONTEXT:
 * wait_for check -> explore metadata -> InlineExploreChip header + step list.
 *
 * HEADER ICON:
 * IN_PROGRESS uses thinking.svg while actively exploring.
 * FINISHED uses green Sparkles.
 * ERROR uses red Sparkles.
 *
 * EXPANSION:
 * [COLLAPSED] --click--> [EXPANDED goal + steps] --click--> [COLLAPSED]
 */

import { ChevronRight, Lightbulb, Sparkles } from 'lucide-react';
import { useCallback, useState } from 'react';
import { cn } from '@/lib/utils';
import thinkingIcon from '@/assets/thinking.svg';
import type { ExploreStep, WaitForCheck } from '../../types';
import { getExploreStepIcon, isThinkingStep } from './helpers';

type ExploreData = NonNullable<WaitForCheck['explore']>;

interface InlineExploreChipProps {
  explore: ExploreData;
  isLive: boolean;
}

function ExploreChipHeader({
  explore,
  isLive,
  isExpanded,
  onToggle,
}: {
  explore: ExploreData;
  isLive: boolean;
  isExpanded: boolean;
  onToggle: (e: React.MouseEvent) => void;
}) {
  const isInProgress = explore.status === 'IN_PROGRESS';
  const isComplete = explore.status === 'FINISHED';
  const isError = explore.status === 'ERROR';
  const mostRecentAction = [...explore.steps].reverse().find((s) => !isThinkingStep(s));
  const goalText = explore.fullGoal || explore.title || 'Checking condition...';
  const displayTitle = isInProgress && mostRecentAction?.title ? mostRecentAction.title : goalText;
  const prefix = isInProgress ? 'Exploring' : isError ? 'Explore failed' : 'Explored';

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-foreground/5 select-none"
      onClick={onToggle}
    >
      {isInProgress ? (
        <img
          src={thinkingIcon}
          alt=""
          aria-hidden="true"
          data-testid="explore-thinking-icon"
          className="h-3.5 w-3.5 flex-shrink-0"
        />
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
        {prefix} - {displayTitle.replace(/\n/g, ' ')}
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

export function InlineExploreChip({ explore, isLive }: InlineExploreChipProps) {
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

  return (
    <div className="border-t border-border/40">
      <ExploreChipHeader
        explore={explore}
        isLive={isLive}
        isExpanded={isExpanded}
        onToggle={toggle}
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
    </div>
  );
}
