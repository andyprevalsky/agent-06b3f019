/**
 * STATE MACHINE: PlanChip
 *
 * EXPANSION STATE:
 * [COLLAPSED] <-- isExpanded: false (shows title only)
 *     |
 *     | (click)
 *     v
 * [EXPANDED] <-- isExpanded: true (shows full plan with tasks)
 *     |
 *     | (click)
 *     v
 * [COLLAPSED]
 *
 * ERROR STATE:
 * [EXPANDED] <-- auto-expanded, red border, AlertCircle icon, error message as content
 *
 * Props determine visual state:
 * - plan.status: 'planning' | 'ready' | 'executing' | 'complete' | 'error'
 * - toolStatus: 'IN_PROGRESS' | 'FINISHED' | 'ERROR' (shimmer effect / error state)
 * - charCount: number (converted to animated token estimate during streaming)
 * - streamStartedAtMs: LLM request start timestamp for elapsed timer
 */

import { memo, useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useAnimatedCounter, type PlanTask } from '../hooks';
import { buildHeaderText, topologicalSort } from './planChip/helpers';
import { PlanChipHeader } from './planChip/PlanChipHeader';
import { PlanChipExpandedContent } from './planChip/PlanChipExpandedContent';
import { PlanChipTasks } from './planChip/PlanChipTasks';

interface PlanData {
  title: string;
  content: string;
  tasks: PlanTask[];
  dependencies: Record<string, string[]> | null;
  join: 'all' | 'any';
  status: 'planning' | 'ready' | 'executing' | 'complete' | 'error';
}

interface PlanChipProps {
  plan: PlanData;
  className?: string;
  /** Tool status - IN_PROGRESS shows shimmer effect on title, ERROR shows error state */
  toolStatus?: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  /** Character count to display with spring animation when streaming */
  charCount?: number;
  /** LLM request start timestamp for streaming elapsed time */
  streamStartedAtMs?: number;
}

/**
 * PlanChip - Expandable chip for displaying agent plans inline in the conversation.
 *
 * Shows as a compact chip when collapsed, expands vertically to show full plan content.
 * Displays tasks as a flat numbered list in topological execution order with inline dependency notation.
 */
export const PlanChip = memo(function PlanChip({
  plan,
  className,
  toolStatus = 'FINISHED',
  charCount = 0,
  streamStartedAtMs,
}: PlanChipProps) {
  const isError = toolStatus === 'ERROR';
  const [isExpanded, setIsExpanded] = useState(isError);
  const isStreaming = toolStatus === 'IN_PROGRESS';
  const tokenCount = Math.round(charCount / 4);
  const animatedTokenCount = useAnimatedCounter(tokenCount, 0.3);

  const { sortedTasks, headerText } = useMemo(() => {
    const tasks = plan.tasks || [];
    return {
      sortedTasks: topologicalSort(tasks, plan.dependencies),
      headerText: buildHeaderText(tasks, plan.dependencies, plan.join),
    };
  }, [plan.tasks, plan.dependencies, plan.join]);

  const toggleExpanded = () => {
    if (plan.content) setIsExpanded(!isExpanded);
  };

  return (
    <div className={cn('w-full max-w-lg overflow-hidden', className)}>
      <motion.div
        layout
        className={cn(
          'rounded-lg border overflow-hidden transition-colors backdrop-blur-[12px]',
          isError
            ? 'bg-destructive/10 dark:bg-destructive/10 border-destructive/40'
            : 'bg-[#EEEFF2]/60 dark:bg-[#1a1a1a]/60 border-border/60',
          !isError && 'hover:bg-[#EEEFF2]/80 dark:hover:bg-[#1a1a1a]/80 hover:border-border',
        )}
        style={{ backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
      >
        <PlanChipHeader
          title={plan.title}
          hasContent={Boolean(plan.content)}
          isExpanded={isExpanded}
          isError={isError}
          isStreaming={isStreaming}
          tokenCount={tokenCount}
          animatedTokenCount={animatedTokenCount}
          streamStartedAtMs={streamStartedAtMs}
          onToggle={toggleExpanded}
        />

        <PlanChipExpandedContent isExpanded={isExpanded} content={plan.content} />

        {!isStreaming && (
          <PlanChipTasks
            tasks={sortedTasks}
            headerText={headerText}
            isHypothesis={plan.join === 'any'}
          />
        )}
      </motion.div>
    </div>
  );
});

export default PlanChip;
