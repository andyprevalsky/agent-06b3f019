import { memo, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownText } from './MarkdownText';

interface PlanData {
  title: string;
  content: string;
  tasks: string[];
  dependencies: Record<string, string[]> | null;
  join: 'all' | 'any';
  status: 'planning' | 'ready' | 'executing' | 'complete';
}

interface PlanChipProps {
  plan: PlanData;
  className?: string;
  /** Tool status - IN_PROGRESS shows shimmer effect on title */
  toolStatus?: 'IN_PROGRESS' | 'FINISHED';
}

interface TaskInfo {
  index: number;
  text: string;
  deps: string[];
}

interface StageGroup {
  level: number;
  tasks: TaskInfo[];
  isParallel: boolean;
  /** Common deps if all tasks share the same dependencies, null if they differ */
  commonDeps: string[] | null;
}

type StructureType = 'sequential' | 'parallel' | 'dag';

/**
 * Detect structure type from dependencies
 */
function detectStructure(tasks: string[], deps: Record<string, string[]> | null): StructureType {
  if (!deps || Object.keys(deps).length === 0) {
    return 'parallel';
  }
  
  // Check if simple chain: each task depends only on the previous one
  const n = tasks.length;
  let isChain = true;
  
  for (let i = 0; i < n; i++) {
    const taskDeps = deps[String(i)] || [];
    if (i === 0) {
      // First task should have no deps
      if (taskDeps.length > 0) {
        isChain = false;
        break;
      }
    } else {
      // Each subsequent task should depend only on previous
      if (taskDeps.length !== 1 || taskDeps[0] !== String(i - 1)) {
        isChain = false;
        break;
      }
    }
  }
  
  return isChain ? 'sequential' : 'dag';
}

/**
 * Group tasks by topological level (dependency depth)
 */
function groupByTopologicalLevel(
  tasks: string[],
  deps: Record<string, string[]> | null
): StageGroup[] {
  const n = tasks.length;
  const normalizedDeps = deps || {};
  
  // Calculate level for each task (max predecessor level + 1)
  const levels: number[] = new Array(n).fill(0);
  
  // We need multiple passes since deps may reference later tasks
  // Using iterative approach until stable
  let changed = true;
  let iterations = 0;
  const maxIterations = n + 1; // Safety limit
  
  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;
    
    for (let i = 0; i < n; i++) {
      const taskDeps = normalizedDeps[String(i)] || [];
      if (taskDeps.length > 0) {
        const maxPredLevel = Math.max(...taskDeps.map(d => levels[parseInt(d)] ?? 0));
        const newLevel = maxPredLevel + 1;
        if (newLevel > levels[i]) {
          levels[i] = newLevel;
          changed = true;
        }
      }
    }
  }
  
  // Group indices by level
  const groupMap = new Map<number, number[]>();
  levels.forEach((level, idx) => {
    if (!groupMap.has(level)) groupMap.set(level, []);
    groupMap.get(level)!.push(idx);
  });
  
  // Build stage groups
  const stages: StageGroup[] = Array.from(groupMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([level, indices]) => {
      const stageTasks: TaskInfo[] = indices.map(idx => ({
        index: idx,
        text: tasks[idx],
        deps: normalizedDeps[String(idx)] || [],
      }));
      
      const isParallel = indices.length > 1;
      
      // Check if all tasks in this stage share the same dependencies
      let commonDeps: string[] | null = null;
      if (stageTasks.length > 0) {
        const firstDeps = JSON.stringify(stageTasks[0].deps.slice().sort());
        const allSame = stageTasks.every(
          t => JSON.stringify(t.deps.slice().sort()) === firstDeps
        );
        if (allSame) {
          commonDeps = stageTasks[0].deps;
        }
      }
      
      return {
        level,
        tasks: stageTasks,
        isParallel,
        commonDeps,
      };
    });
  
  return stages;
}

/**
 * Format dependency indices as readable task references
 */
function formatDeps(deps: string[], tasks: string[]): string {
  if (deps.length === 0) return '';
  
  // Truncate task names for brevity
  const names = deps.map(d => {
    const idx = parseInt(d);
    const task = tasks[idx];
    if (!task) return `Task ${d}`;
    // Take first 20 chars
    return task.length > 20 ? task.slice(0, 20) + '...' : task;
  });
  
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/**
 * PlanChip - Expandable chip for displaying agent plans inline in the conversation.
 * 
 * Shows as a compact chip when collapsed, expands vertically to show full plan content.
 * Uses unified DAG-based planning with explicit dependencies and join semantics.
 */
export const PlanChip = memo(function PlanChip({ plan, className, toolStatus = 'FINISHED' }: PlanChipProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isStreaming = toolStatus === 'IN_PROGRESS';

  // Compute stages and structure
  const { stages, structure, headerText } = useMemo(() => {
    const tasks = plan.tasks || [];
    const deps = plan.dependencies;
    const join = plan.join;
    
    const structure = detectStructure(tasks, deps);
    const stages = groupByTopologicalLevel(tasks, deps);
    
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
      headerText = `${n} Tasks · Staged`;
    }
    
    return { stages, structure, headerText };
  }, [plan.tasks, plan.dependencies, plan.join]);

  const toggleExpanded = () => {
    if (plan.content) {
      setIsExpanded(!isExpanded);
    }
  };

  // Choose icon based on join type
  const taskIcon = plan.join === 'any' ? '◇' : '○';

  return (
    <div className={cn('w-full max-w-md', className)}>
      {/* Chip Container */}
      <motion.div
        layout
        className={cn(
          'rounded-lg border overflow-hidden transition-colors',
          'bg-muted/30 border-border/60',
          'hover:bg-muted/50 hover:border-border'
        )}
      >
        {/* Header - Always visible, clickable if has content */}
        <button
          onClick={toggleExpanded}
          className={cn(
            "w-full flex items-center justify-between px-3 py-2.5 text-left",
            !plan.content && "cursor-default"
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            {/* Plan icon */}
            <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            
            {/* Title - shimmer effect when streaming */}
            <span className={cn(
              "text-sm font-medium truncate",
              isStreaming && "animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent",
              !isStreaming && "text-foreground"
            )}>
              {plan.title}
            </span>
          </div>

          {/* Chevron indicator - only show if there's content to expand */}
          {plan.content && (
            <ChevronDown
              className={cn(
                'h-4 w-4 text-muted-foreground transition-transform duration-200 flex-shrink-0',
                isExpanded && 'rotate-180'
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
                  <MarkdownText
                    text={plan.content}
                    shouldAnimate={false}
                    className="prose-sm"
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Tasks Section - Always visible when FINISHED and has tasks */}
        {!isStreaming && stages.length > 0 && (
          <div className="px-3 pb-3 border-t border-border/50">
            {/* Section Header */}
            <div className="flex items-center justify-between pt-2 mb-2">
              <span className="text-xs text-muted-foreground font-medium">
                {headerText}
              </span>
            </div>

            {/* Staged Task List */}
            <div className="space-y-3">
              {stages.map((stage, stageIdx) => {
                const isFirstStage = stageIdx === 0;
                const showStageHeader = stages.length > 1;
                
                // Build stage label
                let stageLabel = '';
                if (showStageHeader) {
                  if (stage.isParallel && stage.commonDeps && stage.commonDeps.length > 0) {
                    stageLabel = `Stage ${stageIdx + 1} (parallel, after: ${formatDeps(stage.commonDeps, plan.tasks)})`;
                  } else if (stage.isParallel) {
                    stageLabel = `Stage ${stageIdx + 1} (parallel)`;
                  } else if (stage.commonDeps && stage.commonDeps.length > 0) {
                    stageLabel = `Stage ${stageIdx + 1} (after: ${formatDeps(stage.commonDeps, plan.tasks)})`;
                  } else {
                    stageLabel = `Stage ${stageIdx + 1}`;
                  }
                }
                
                return (
                  <div 
                    key={stageIdx}
                    className={cn(
                      !isFirstStage && 'pl-4 border-l border-border/40'
                    )}
                  >
                    {/* Stage header */}
                    {showStageHeader && (
                      <div className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                        {!isFirstStage && <span className="text-border">└─</span>}
                        <span>{stageLabel}</span>
                      </div>
                    )}
                    
                    {/* Tasks in this stage */}
                    <ul className="space-y-1.5">
                      {stage.tasks.map((task) => {
                        // Show inline deps only if stage has no common deps
                        const showInlineDeps = !stage.commonDeps && task.deps.length > 0;
                        
                        return (
                          <li
                            key={task.index}
                            className="flex items-start gap-2"
                          >
                            {/* Task icon */}
                            <span className="text-muted-foreground/60 flex-shrink-0 mt-0.5 text-sm">
                              {taskIcon}
                            </span>
                            {/* Task text */}
                            <span className="text-sm text-foreground leading-snug">
                              {task.text}
                              {showInlineDeps && (
                                <span className="text-xs text-muted-foreground ml-1">
                                  (after: {formatDeps(task.deps, plan.tasks)})
                                </span>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
});

export default PlanChip;
