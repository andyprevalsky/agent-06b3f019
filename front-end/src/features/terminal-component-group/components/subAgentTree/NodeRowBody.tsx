import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { type TreeNode, getCircleState } from '../../hooks';
import { extractEmoji } from '../subAgentTree.helpers';
import { OutputChip } from './OutputChip';
import { FailureChip } from './FailureChip';

interface NodeRowBodyProps {
  node: TreeNode;
  /** Leading tree-drawing characters (indent + branch). */
  prefix: React.ReactNode;
  /** If set, goal text is clamped to this many characters (used for leaf rows). */
  goalMaxChars?: number;
  /** If true, allows goal to flex and truncate with ellipsis (used for full tree rows). */
  goalFlex?: boolean;
  /** Unset: nothing to open (no pointer, no hover, no chevron). */
  onClick?: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/**
 * Shared inner row rendering: prefix, circle, cost, output/failure chips, label, chevron.
 * Used by both TreeNodeRow (full tree) and LeafNodeRow (collapsed view).
 *
 * LABEL STATE:
 * [STRUCTURED CANONICAL NAME] -> show creator/item name
 * [ROW ITEM PRESENT]          -> show concise assigned item
 * [NO ROW ITEM]               -> show original agent goal text
 */
export function NodeRowBody({
  node,
  prefix,
  goalMaxChars,
  goalFlex,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: NodeRowBodyProps) {
  const circle = getCircleState(node);
  const hasSchema = !!node.outputSchema?.fields?.length;
  const outputForChip =
    node.status === 'FAILED'
      ? node.failureContext?.partial_structured_response || node.structuredOutput || undefined
      : node.structuredOutput;

  return (
    <div
      className={cn(
        'flex items-center gap-1 py-0.5 rounded',
        onClick && 'cursor-pointer hover:bg-gray-100 dark:hover:bg-[#2f2f2c]',
        node.status === 'COMPLETED' && 'text-gray-500',
        node.status === 'FAILED' && 'text-red-500',
        node.status === 'COST_LIMIT_REACHED' && 'text-amber-500',
        node.status === 'OUT_OF_CREDITS' && 'text-red-500',
      )}
      onClick={onClick}
      data-navigable={onClick ? 'true' : 'false'}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {prefix}
      <span
        className={cn(
          'w-4 text-center select-none transition-all duration-300',
          goalMaxChars && 'flex-shrink-0',
        )}
      >
        {circle}
      </span>
      <CostChip costCents={node.costCents} />
      {hasSchema && (
        <OutputChip
          schema={node.outputSchema}
          output={outputForChip}
          isPartial={node.status === 'FAILED'}
          failureReason={node.failureContext?.verifier_reasoning}
        />
      )}
      {node.status === 'FAILED' && node.failureContext && !hasSchema && (
        <FailureChip failureContext={node.failureContext} />
      )}
      <GoalText node={node} goalMaxChars={goalMaxChars} goalFlex={goalFlex} />
      {onClick && (
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400 dark:text-gray-500" />
      )}
    </div>
  );
}

function CostChip({ costCents }: { costCents: number }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-xs text-muted-foreground tabular-nums cursor-help">
            ${(costCents / 100).toFixed(2)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <span className="text-xs">Cumulative cost including all sub-agents</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function GoalText({
  node,
  goalMaxChars,
  goalFlex,
}: {
  node: TreeNode;
  goalMaxChars?: number;
  goalFlex?: boolean;
}) {
  const { emoji, text: rawGoalText } = extractEmoji(displayGoal(node));
  const goalText =
    goalMaxChars && rawGoalText.length > goalMaxChars
      ? rawGoalText.slice(0, goalMaxChars - 3) + '...'
      : rawGoalText;

  return (
    <span className={goalFlex ? 'flex-1 truncate' : undefined}>
      {emoji && (
        <span className="mr-1" style={{ filter: 'grayscale(1)' }}>
          {emoji}
        </span>
      )}
      <span
        className={cn(
          node.status !== 'COMPLETED' &&
            node.status !== 'FAILED' &&
            'animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent',
        )}
      >
        {goalText}
      </span>
    </span>
  );
}

function displayGoal(node: TreeNode): string {
  const canonicalName = node.structuredOutput?.canonical_name;
  if (typeof canonicalName === 'string' && canonicalName.trim()) return canonicalName.trim();

  const partialCanonicalName = node.failureContext?.partial_structured_response?.canonical_name;
  if (typeof partialCanonicalName === 'string' && partialCanonicalName.trim()) {
    return partialCanonicalName.trim();
  }

  const failedStructuredCanonicalName =
    node.status === 'FAILED' ? node.structuredOutput?.canonical_name : undefined;
  if (typeof failedStructuredCanonicalName === 'string' && failedStructuredCanonicalName.trim()) {
    return failedStructuredCanonicalName.trim();
  }

  const { goal } = node;
  const rowItem = goal.match(/(?:^|\n)Row item:\s*\n([^\n]+)/);
  if (rowItem?.[1]?.trim()) return rowItem[1].trim();
  return goal;
}
