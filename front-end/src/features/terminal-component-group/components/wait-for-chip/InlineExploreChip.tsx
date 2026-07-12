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

import { ChevronRight, Lightbulb } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { ExploreStep, WaitForCheck } from '../../types';
import { getExploreStepIcon, isThinkingStep } from './helpers';
import { MarkdownText } from '../MarkdownText';
import { InlineExploreChipHeader } from './InlineExploreChipHeader';

type ExploreData = NonNullable<WaitForCheck['explore']>;

interface InlineExploreChipProps {
  explore: ExploreData;
  isLive: boolean;
  leadingContent?: ReactNode;
  collapseTerminalResult?: boolean;
  thinkingStreamTokenCount?: number;
  thinkingStreamStartedAtMs?: number;
}

function ThinkingStepRow({ step, index }: { step: ExploreStep; index: number }) {
  const thinkingText = step.message?.trim();
  return (
    <div
      key={`${step.timestamp}-${index}`}
      className="flex items-start gap-1.5 text-[10px] text-muted-foreground/60 py-0.5"
    >
      <Lightbulb className="h-2.5 w-2.5 flex-shrink-0 text-amber-400/70 mt-0.5" />
      <span className="italic flex-1 min-w-0 break-words">{thinkingText || 'Thinking...'}</span>
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
        <span className="flex-1 min-w-0 break-words">{step.title?.replace(/\n/g, ' ')}</span>
      </div>

      {isExpanded && hasContent && (
        <div className="ml-4 mt-0.5 mb-1 text-[10px] text-muted-foreground/50 whitespace-pre-wrap break-words max-h-[120px] overflow-y-auto overflow-x-hidden border-l border-border/30 pl-2">
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
    <div className="px-3 pb-2 min-w-0 max-w-full space-y-0.5 overflow-y-auto overflow-x-hidden max-h-[250px]">
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
      <div className="text-[10px] text-foreground/60 whitespace-pre-wrap break-words max-h-[120px] overflow-y-auto overflow-x-hidden">
        <MarkdownText text={message} className="tool-message-markdown text-[10px]" />
      </div>
    </div>
  );
}

export function InlineExploreChip({
  explore,
  isLive,
  leadingContent,
  collapseTerminalResult = false,
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
    <div className="min-w-0 max-w-full overflow-hidden border-t border-border/40">
      <InlineExploreChipHeader
        explore={explore}
        isLive={isLive}
        isExpanded={isExpanded}
        onToggle={toggle}
        leadingContent={leadingContent}
        thinkingStreamTokenCount={thinkingStreamTokenCount}
        thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
      />

      {isExpanded && goalText && (
        <div className="px-3 pt-1.5 pb-1 border-t border-border/30">
          <div className="text-[10px] text-foreground/60 whitespace-pre-wrap break-words">
            {goalText}
          </div>
        </div>
      )}

      {isExpanded && explore.steps.length > 0 && (
        <ExploreStepsList
          steps={explore.steps}
          expandedSteps={expandedSteps}
          toggleStep={toggleStep}
        />
      )}

      {isTerminal && (!collapseTerminalResult || isExpanded) && (
        <TerminalResult message={explore.message} />
      )}
    </div>
  );
}
