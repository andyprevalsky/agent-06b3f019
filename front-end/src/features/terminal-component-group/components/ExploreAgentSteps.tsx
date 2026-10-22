import { ChevronRight, Globe, Lightbulb } from 'lucide-react';

import { cn } from '@/lib/utils';
import { userFacingMessageText } from '@/lib/userFacingMessage';
import { TOOL_ICONS } from '@/lib/toolIcons';

import type { ExploreStep } from '../types';
import { AgentTreeListing } from './agent-rows/AgentTreeListing';
import { buildAgentListing } from './agent-rows/agentTreeListing';

function isThinkingStep(step: ExploreStep): boolean {
  return (
    step.toolName === 'spawn_agent' && (step.title === 'Explore agent thinking' || !step.title)
  );
}

function getStepIcon(step: ExploreStep) {
  if (isThinkingStep(step)) return Lightbulb;
  if (step.toolName === 'web_search') return Globe;
  return (step.toolName && TOOL_ICONS[step.toolName]) || TOOL_ICONS.default;
}

function StepRow({
  step,
  index,
  isStepExpanded,
  onToggleStep,
}: {
  step: ExploreStep;
  index: number;
  isStepExpanded: boolean;
  onToggleStep: (index: number, event: React.MouseEvent) => void;
}) {
  const thinking = isThinkingStep(step);
  const visibleMessage = userFacingMessageText(step.message || '');
  // list_agents inside an explore agent renders the same structured tree.
  const listing = step.toolName === 'list_agents' ? buildAgentListing(step.agentTree) : null;
  const hasContent = Boolean(listing) || !!visibleMessage.trim();
  const StepIcon = getStepIcon(step);
  if (thinking) {
    return (
      <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground/60 py-0.5 px-1 -mx-1">
        <Lightbulb className="h-3 w-3 flex-shrink-0 text-amber-400/70 mt-0.5" />
        <span className="italic min-w-0 flex-1 break-words">
          {visibleMessage.trim() || 'Thinking...'}
        </span>
      </div>
    );
  }
  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1.5 text-[11px] text-muted-foreground/70 py-0.5 rounded px-1 -mx-1',
          hasContent && 'cursor-pointer hover:bg-foreground/5',
        )}
        onClick={hasContent ? (event) => onToggleStep(index, event) : undefined}
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
        <span className="min-w-0 flex-1 truncate">{step.title}</span>
      </div>
      {isStepExpanded && listing && (
        <div
          className="ml-4 mt-0.5 mb-1 max-h-[240px] min-w-0 overflow-y-auto overflow-x-hidden border-l border-border/30 pl-2"
          data-testid="explore-step-agent-tree"
        >
          <AgentTreeListing listing={listing} />
        </div>
      )}
      {isStepExpanded && !listing && hasContent && (
        <div className="ml-4 mt-0.5 mb-1 text-[11px] text-muted-foreground/50 whitespace-pre-wrap break-words max-h-[150px] overflow-y-auto border-l border-border/30 pl-2">
          {visibleMessage}
        </div>
      )}
    </div>
  );
}

export function ExploreAgentSteps({
  steps,
  expandedSteps,
  onToggleStep,
}: {
  steps: ExploreStep[];
  expandedSteps: Set<number>;
  onToggleStep: (index: number, event: React.MouseEvent) => void;
}) {
  return (
    <div className="mt-1 min-w-0 max-w-full space-y-0.5 overflow-y-auto overflow-x-hidden max-h-[300px]">
      {steps.map((step, index) => (
        <StepRow
          key={`${step.timestamp}-${index}`}
          step={step}
          index={index}
          isStepExpanded={expandedSteps.has(index)}
          onToggleStep={onToggleStep}
        />
      ))}
    </div>
  );
}
