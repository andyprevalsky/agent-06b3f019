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
 * - charCount: number (animated char counter shown during streaming)
 */

import { memo, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, FileText, ArrowDown, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownText } from './MarkdownText';
import { PlanTask } from '@/lib/realtime-types';
import { useAnimatedCounter } from '@/hooks/useAnimatedCounter';

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
}

interface TaskWithDeps {
  originalIndex: number;
  text: string;
  toolName: string;
  deps: number[];
}

/**
 * Topologically sort tasks by their dependencies.
 * Tasks with no dependencies come first, then tasks whose deps are satisfied.
 */
function topologicalSort(tasks: PlanTask[], deps: Record<string, string[]> | null): TaskWithDeps[] {
  const n = tasks.length;
  const normalizedDeps = deps || {};

  // Build task info with parsed deps
  const taskInfos: TaskWithDeps[] = tasks.map((task, idx) => ({
    originalIndex: idx,
    text: task.goal,
    toolName: task.tool_name,
    deps: (normalizedDeps[String(idx)] || []).map((d) => parseInt(d)),
  }));

  // Kahn's algorithm for topological sort
  const inDegree = new Map<number, number>();
  const adjList = new Map<number, number[]>();

  // Initialize
  for (let i = 0; i < n; i++) {
    inDegree.set(i, 0);
    adjList.set(i, []);
  }

  // Build graph
  for (const task of taskInfos) {
    for (const dep of task.deps) {
      if (dep >= 0 && dep < n) {
        adjList.get(dep)!.push(task.originalIndex);
        inDegree.set(task.originalIndex, (inDegree.get(task.originalIndex) || 0) + 1);
      }
    }
  }

  // Find all nodes with no incoming edges
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (inDegree.get(i) === 0) {
      queue.push(i);
    }
  }

  // Sort within each "level" by original index for stability
  queue.sort((a, b) => a - b);

  const sorted: number[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);

    const neighbors = adjList.get(node) || [];
    const nextLevel: number[] = [];

    for (const neighbor of neighbors) {
      inDegree.set(neighbor, (inDegree.get(neighbor) || 0) - 1);
      if (inDegree.get(neighbor) === 0) {
        nextLevel.push(neighbor);
      }
    }

    // Sort next level by original index and add to queue
    nextLevel.sort((a, b) => a - b);
    queue.push(...nextLevel);
  }

  // If we couldn't sort all nodes, there's a cycle - fall back to original order
  if (sorted.length !== n) {
    return taskInfos;
  }

  // Return tasks in sorted order
  return sorted.map((idx) => taskInfos[idx]);
}

/**
 * Detect structure type from dependencies
 */
function detectStructure(
  tasks: PlanTask[],
  deps: Record<string, string[]> | null,
): 'sequential' | 'parallel' | 'dag' {
  if (!deps || Object.keys(deps).length === 0) {
    return 'parallel';
  }

  // Check if all tasks have no deps
  const hasDeps = Object.values(deps).some((d) => d.length > 0);
  if (!hasDeps) {
    return 'parallel';
  }

  // Check if simple chain: each task depends only on the previous one
  const n = tasks.length;
  let isChain = true;

  for (let i = 0; i < n; i++) {
    const taskDeps = deps[String(i)] || [];
    if (i === 0) {
      if (taskDeps.length > 0) {
        isChain = false;
        break;
      }
    } else {
      if (taskDeps.length !== 1 || taskDeps[0] !== String(i - 1)) {
        isChain = false;
        break;
      }
    }
  }

  return isChain ? 'sequential' : 'dag';
}

/**
 * Format dependency indices as "→ after 1, 2" notation
 */
function formatDeps(deps: number[]): string {
  if (deps.length === 0) return '';

  // Sort deps and convert to 1-based display numbers
  const sorted = [...deps].sort((a, b) => a - b);
  const displayNums = sorted.map((d) => d + 1);

  return `→ after ${displayNums.join(', ')}`;
}

/**
 * Format tool name for display.
 * Converts snake_case tool names to readable labels.
 * e.g., "spawn_browser_agent_v3" → "Browser Agent"
 */
function formatToolName(toolName: string): string {
  if (!toolName) return '';

  return (
    toolName
      // Remove spawn_ prefix
      .replace(/^spawn_/, '')
      // Remove version suffixes like _v3, _v2
      .replace(/_v\d+$/, '')
      // Replace underscores with spaces
      .replace(/_/g, ' ')
      // Title case each word
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
  );
}

/**
 * PlanChip - Expandable chip for displaying agent plans inline in the conversation.
 *
 * Shows as a compact chip when collapsed, expands vertically to show full plan content.
 * Displays tasks as a flat numbered list in topological order with inline dependency notation.
 */
export const PlanChip = memo(function PlanChip({
  plan,
  className,
  toolStatus = 'FINISHED',
  charCount = 0,
}: PlanChipProps) {
  const isError = toolStatus === 'ERROR';
  const [isExpanded, setIsExpanded] = useState(isError); // Auto-expand on error to show message
  const isStreaming = toolStatus === 'IN_PROGRESS';
  const animatedCharCount = useAnimatedCounter(charCount, 0.3);

  // Compute sorted tasks and header text
  const { sortedTasks, headerText } = useMemo(() => {
    const tasks = plan.tasks || [];
    const deps = plan.dependencies;
    const join = plan.join;

    const structure = detectStructure(tasks, deps);
    const sortedTasks = topologicalSort(tasks, deps);

    // Build header text based on structure and join
    let headerText: string;
    const n = tasks.length;

    if (join === 'any') {
      headerText = `${n} Hypotheses`;
    } else if (structure === 'sequential') {
      headerText = `${n} Tasks · Sequential`;
    } else if (structure === 'parallel') {
      headerText = `${n} Tasks · Parallel`;
    } else {
      headerText = `${n} Tasks`;
    }

    return { sortedTasks, headerText };
  }, [plan.tasks, plan.dependencies, plan.join]);

  const toggleExpanded = () => {
    if (plan.content) {
      setIsExpanded(!isExpanded);
    }
  };

  return (
    <div className={cn('w-full max-w-lg overflow-hidden', className)}>
      {/* Chip Container */}
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
        {/* Header - Always visible, clickable if has content */}
        <button
          onClick={toggleExpanded}
          className={cn(
            'w-full flex items-center justify-between px-3 py-2.5 text-left',
            !plan.content && 'cursor-default',
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            {/* Plan icon (error icon when failed) */}
            {isError ? (
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0" />
            ) : (
              <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            )}

            {/* Title - shimmer effect when streaming */}
            <span
              className={cn(
                'text-sm font-medium truncate',
                isError && 'text-destructive',
                isStreaming &&
                  'animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent',
                !isStreaming && !isError && 'text-foreground',
              )}
            >
              {plan.title}
            </span>

            {/* Char counter - shown during streaming */}
            {isStreaming && charCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground ml-auto">
                <ArrowDown className="w-3 h-3" />
                <span className="tabular-nums">{animatedCharCount.toLocaleString()}</span>
              </span>
            )}
          </div>

          {/* Chevron indicator - only show if there's content to expand */}
          {plan.content && (
            <ChevronDown
              className={cn(
                'h-4 w-4 text-muted-foreground transition-transform duration-200 flex-shrink-0',
                isExpanded && 'rotate-180',
              )}
            />
          )}
        </button>

        {/* Expandable Content - Plan description/content (appears between header and items) */}
        <AnimatePresence initial={false}>
          {isExpanded && plan.content && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <div className="px-3 pb-3">
                {/* Content Section */}
                <div className="text-sm text-muted-foreground border-t border-border/50 pt-3">
                  <MarkdownText text={plan.content} shouldAnimate={false} className="prose-sm" />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Tasks Section - Always visible when FINISHED and has tasks */}
        {!isStreaming && sortedTasks.length > 0 && (
          <div className="px-3 pb-3 border-t border-border/50">
            {/* Section Header */}
            <div className="flex items-center justify-between pt-2 mb-2">
              <span className="text-xs text-muted-foreground font-medium">{headerText}</span>
            </div>

            {/* Flat Task List */}
            <ul className="space-y-1.5">
              {sortedTasks.map((task, displayIndex) => {
                const isHypothesis = plan.join === 'any';
                const hasDeps = task.deps.length > 0;

                return (
                  <li key={task.originalIndex} className="flex items-start gap-2">
                    {/* Task number or hypothesis icon */}
                    <span className="text-muted-foreground/60 flex-shrink-0 mt-0.5 text-sm tabular-nums min-w-[1.25rem]">
                      {isHypothesis ? '◇' : `${displayIndex + 1}.`}
                    </span>
                    {/* Task text with inline deps and action subtext */}
                    <div className="leading-snug">
                      <span className="text-sm text-foreground">
                        {task.text}
                        {hasDeps && (
                          <span className="text-muted-foreground ml-1.5">
                            {formatDeps(task.deps)}
                          </span>
                        )}
                      </span>
                      {task.toolName && (
                        <div className="text-xs text-muted-foreground/60 mt-0.5">
                          {formatToolName(task.toolName)}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </motion.div>
    </div>
  );
});

export default PlanChip;
